/**
 * AD-29 native object-handle transactions for a durable lease. NOT a complete
 * LeaseRecoveryNative: scope admission, guards, actor draining, profile receipt
 * and new-descendant cleanup remain separate mandatory native responsibilities.
 */
import path from "node:path";
import { CrotError } from "../../core/errors.js";
import { validateSid, validateWindowsPath } from "../validation.js";
import type { TokenFfi } from "./restricted-token.js";
import type { LeaseObject } from "./lease-journal.js";
import type { PinnedLeaseObject } from "./lease-recovery.js";
interface AclFfi extends TokenFfi {
  decode(pointer: unknown, type: string, length: number): unknown;
}
const fail = (stage: string) => new CrotError("CONFINEMENT_FAILED", `Windows lease ACL: ${stage} failed.`, { stage });
const valid = (v: unknown) =>
  v !== undefined && v !== null && v !== 0 && v !== 0n && v !== -1n && v !== -1 && v !== 0xffffffffffffffffn;
const okay = (v: unknown) => v === true || (typeof v === "number" && v !== 0);
const SID = /^S-1-15-2-(?:[0-9]+-){6}[0-9]+$/;
const VOLUME = /^\\\\\?\\Volume\{([0-9a-f-]{36})\}\\$/i;
const CONTROLLED = 0x1500;
const declared = new WeakSet<object>();

/** Bounds-check all relative sections BEFORE passing any journal bytes to NT. */
export function leaseDescriptor(bytes: Buffer) {
  if (bytes.length < 20 || bytes.length > 65536 || bytes[0] !== 1 || (bytes.readUInt16LE(2) & 0x8000) === 0)
    throw fail("relative descriptor");
  const spans: [number, number, boolean][] = [];
  const section = (position: number, acl: boolean): Buffer => {
    const offset = bytes.readUInt32LE(position);
    if (offset === 0) return Buffer.alloc(0);
    if (offset < 20 || offset % 4 !== 0 || offset + 8 > bytes.length) throw fail("descriptor section bounds");
    let length: number;
    if (acl) {
      if (![2, 4].includes(bytes[offset]!)) throw fail("ACL revision");
      length = bytes.readUInt16LE(offset + 2);
      if (length < 8 || offset + length > bytes.length) throw fail("ACL bounds");
      const count = bytes.readUInt16LE(offset + 4);
      let cursor = 8;
      for (let i = 0; i < count; i++) {
        if (cursor + 4 > length) throw fail("ACE header");
        const size = bytes.readUInt16LE(offset + cursor + 2);
        if (size < 4 || size % 4 !== 0 || cursor + size > length) throw fail("ACE bounds");
        const aceOffset = offset + cursor,
          type = bytes[aceOffset]!;
        // NT APIs receive only bounded known layouts, never an undersized SID
        // hidden behind an otherwise valid ACE header. Preserve opaque callback
        // application data, but validate the SID preceding it.
        if (type > 21 || type === 4) throw fail("unsupported ACE layout");
        let sidOffset = 8;
        if ([5, 6, 7, 8, 11, 12, 15, 16].includes(type)) {
          if (size < 12) throw fail("object ACE header");
          const flags = bytes.readUInt32LE(aceOffset + 8);
          if (flags & ~3) throw fail("object ACE flags");
          sidOffset = 12 + (flags & 1 ? 16 : 0) + (flags & 2 ? 16 : 0);
        }
        if (
          sidOffset + 8 > size ||
          bytes[aceOffset + sidOffset] !== 1 ||
          bytes[aceOffset + sidOffset + 1]! > 15 ||
          sidOffset + 8 + 4 * bytes[aceOffset + sidOffset + 1]! > size
        )
          throw fail("ACE SID bounds");
        cursor += size;
      }
      // ACLs may include reserved unused tail bytes. Preserve them exactly.
    } else {
      if (bytes[offset] !== 1 || bytes[offset + 1]! > 15) throw fail("SID shape");
      length = 8 + 4 * bytes[offset + 1]!;
      if (offset + length > bytes.length) throw fail("SID bounds");
    }
    for (const [a, b, isAcl] of spans)
      if (offset < b && offset + length > a && !(offset === a && offset + length === b && !acl && !isAcl))
        throw fail("overlapping descriptor sections");
    spans.push([offset, offset + length, acl]);
    return bytes.subarray(offset, offset + length);
  };
  const owner = section(4, false),
    group = section(8, false),
    sacl = section(12, true),
    dacl = section(16, true);
  const control = bytes.readUInt16LE(2);
  if (!owner.length || !group.length || !dacl.length || !(control & 4)) throw fail("descriptor owner/group/DACL");
  if (sacl.length && !(control & 0x10)) throw fail("SACL presence");
  return { control, rmControl: bytes[1]!, owner, group, sacl, dacl };
}
const same = (a: ReturnType<typeof leaseDescriptor>, b: ReturnType<typeof leaseDescriptor>) =>
  a.control === b.control &&
  a.rmControl === b.rmControl &&
  a.owner.equals(b.owner) &&
  a.group.equals(b.group) &&
  a.sacl.equals(b.sacl) &&
  a.dacl.equals(b.dacl);
function repack(original: Buffer, dacl: Buffer): Buffer {
  const parsed = leaseDescriptor(original),
    sections = [parsed.owner, parsed.group, parsed.sacl, dacl];
  const size = 20 + sections.reduce((n, b) => n + ((b.length + 3) & ~3), 0),
    result = Buffer.alloc(size);
  original.copy(result, 0, 0, 4);
  let offset = 20;
  sections.forEach((s, i) => {
    if (!s.length) return;
    result.writeUInt32LE(offset, 4 + i * 4);
    s.copy(result, offset);
    offset += (s.length + 3) & ~3;
  });
  leaseDescriptor(result);
  return result;
}

/**
 * Pure cleanup transaction for a newly-created workspace node AFTER actor drain
 * and original-parent restore. Removes only trustee ACEs of the exact fresh
 * package SID, preserving all foreign ACE bytes/order, unused tail and control.
 * Scope/tree admission is NOT inferred from a pathname or this role string.
 */
export function prepareNewWorkspaceSidRemoval(object: LeaseObject, sid: string): LeaseObject {
  if (object.role !== "workspace-node") throw fail("new workspace cleanup role");
  validateSid(sid);
  if (
    !SID.test(sid) ||
    sid
      .split("-")
      .slice(3)
      .some((v) => Number(v) > 0xffffffff || String(Number(v)) !== v)
  )
    throw fail("cleanup package SID");
  const subAuthorities = sid.split("-").slice(3).map(Number),
    binarySid = Buffer.alloc(8 + subAuthorities.length * 4);
  binarySid[0] = 1;
  binarySid[1] = subAuthorities.length;
  binarySid[7] = 15;
  subAuthorities.forEach((value, i) => binarySid.writeUInt32LE(value, 8 + i * 4));
  const original = Buffer.from(object.original, "base64"),
    parsed = leaseDescriptor(original),
    acl = parsed.dacl,
    kept: Buffer[] = [];
  let cursor = 8,
    removed = 0;
  for (let i = 0; i < acl.readUInt16LE(4); i++) {
    const size = acl.readUInt16LE(cursor + 2),
      ace = acl.subarray(cursor, cursor + size),
      type = ace[0]!;
    let sidOffset = 8;
    if ([5, 6, 7, 8, 11, 12, 15, 16].includes(type)) {
      const flags = ace.readUInt32LE(8);
      sidOffset = 12 + (flags & 1 ? 16 : 0) + (flags & 2 ? 16 : 0);
    }
    const bytes = 8 + 4 * ace[sidOffset + 1]!;
    if (ace.subarray(sidOffset, sidOffset + bytes).equals(binarySid)) removed++;
    else kept.push(ace);
    cursor += size;
  }
  if (!removed) return { ...object, identity: { ...object.identity }, planned: object.original };
  const next = Buffer.concat([acl.subarray(0, 8), ...kept, acl.subarray(cursor)]);
  next.writeUInt16LE(next.length, 2);
  next.writeUInt16LE(kept.length, 4);
  const desired = repack(original, next);
  return { ...object, identity: { ...object.identity }, planned: desired.toString("base64") };
}

/** Win10 SDK FILE_ID_DESCRIPTOR: header 8 + max(union FILE_ID_128) 16. */
export function leaseFileIdDescriptor(fileId: string): Buffer {
  if (!/^[0-9a-f]{16}$/.test(fileId)) throw fail("file ID shape");
  const id = Buffer.alloc(24);
  id.writeUInt32LE(24); // FileIdType = 0.
  id.writeBigUInt64LE(BigInt(`0x${fileId}`), 8);
  return id;
}

export function bindLeaseAclObjects(ffi: AclFfi, libraries: { kernel32: string; advapi32: string }) {
  const H = "CROT_LEASE_ACL_OUTPUT",
    T = "CROT_LEASE_TRUSTEE",
    E = "CROT_LEASE_EXPLICIT";
  if (!declared.has(ffi)) {
    ffi.struct(H, { value: "void *" });
    ffi.struct(T, { multiple: "void *", operation: "int", form: "int", type: "int", name: "void *" });
    ffi.struct(E, { permissions: "uint32_t", mode: "int", inheritance: "uint32_t", trustee: T });
    declared.add(ffi);
  }
  if (ffi.sizeof("void *") !== 8 || ffi.sizeof(T) !== 32 || ffi.sizeof(E) !== 48) throw fail("64-bit ABI");
  const k = ffi.load(libraries.kernel32),
    a = ffi.load(libraries.advapi32);
  const file = k.func(
    "void * __stdcall CreateFileW(str16 path,uint32_t access,uint32_t share,void *security,uint32_t disposition,uint32_t flags,void *templateFile)",
  );
  const byId = k.func(
    "void * __stdcall OpenFileById(void *volume,void *identity,uint32_t access,uint32_t share,void *security,uint32_t flags)",
  );
  const info = k.func("int __stdcall GetFileInformationByHandle(void *object,_Out_ uint8_t *info)");
  const extendedInfo = k.func(
    "int __stdcall GetFileInformationByHandleEx(void *object,int kind,_Out_ uint8_t *info,uint32_t length)",
  );
  const finalPath = k.func(
    "uint32_t __stdcall GetFinalPathNameByHandleW(void *object,_Out_ uint8_t *path,uint32_t count,uint32_t flags)",
  );
  const volumeInfo = k.func(
    "int __stdcall GetVolumeInformationByHandleW(void *object,void *name,uint32_t nameSize,void *serial,void *maxComponent,_Out_ uint8_t *flags,_Out_ uint8_t *filesystem,uint32_t filesystemSize)",
  );
  const close = k.func("int __stdcall CloseHandle(void *object)");
  const lastError = k.func("uint32_t __stdcall GetLastError()");
  const nativeFail = (stage: string) =>
    new CrotError("CONFINEMENT_FAILED", `Windows lease ACL: ${stage} failed.`, {
      stage,
      nativeCode: Number(lastError()),
    });
  const free = k.func("void * __stdcall LocalFree(void *memory)");
  const get = a.func(
    "int __stdcall GetKernelObjectSecurity(void *object,uint32_t sections,_Out_ uint8_t *descriptor,uint32_t capacity,_Out_ uint8_t *needed)",
  );
  const initialize = a.func("int __stdcall InitializeSecurityDescriptor(void *descriptor,uint32_t revision)");
  const setDacl = a.func(
    "int __stdcall SetSecurityDescriptorDacl(void *descriptor,int present,void *acl,int defaulted)",
  );
  const setControl = a.func(
    "int __stdcall SetSecurityDescriptorControl(void *descriptor,uint16_t mask,uint16_t value)",
  );
  const set = a.func("int __stdcall SetKernelObjectSecurity(void *object,uint32_t sections,void *descriptor)");
  const convert = a.func(`int __stdcall ConvertStringSidToSidW(str16 text,_Out_ ${H} *sid)`);
  const compose = a.func(
    `uint32_t __stdcall SetEntriesInAclW(uint32_t count,void *entries,void *oldAcl,_Out_ ${H} *next)`,
  );
  const pendingHandles = new Set<unknown>(),
    pendingMemory = new Set<unknown>();
  const release = (h: unknown) => {
    if (!okay(close(h))) throw fail("handle release");
    pendingHandles.delete(h);
  };
  const releaseMemory = (h: unknown) => {
    if (valid(free(h))) {
      pendingMemory.add(h);
      throw fail("memory release");
    }
    pendingMemory.delete(h);
  };
  const retry = () => {
    for (const h of pendingHandles) release(h);
    for (const m of pendingMemory) releaseMemory(m);
  };
  const disposeSetup = (h: unknown) => {
    try {
      release(h);
    } catch {
      pendingHandles.add(h);
    }
  };
  const admitVolume = (handle: unknown) => {
    const filesystem = Buffer.alloc(64),
      flags = Buffer.alloc(4);
    if (!okay(volumeInfo(handle, null, 0, null, null, flags, filesystem, filesystem.length / 2)))
      throw nativeFail("filesystem query");
    if (filesystem.toString("utf16le").split("\0")[0] !== "NTFS" || !(flags.readUInt32LE(0) & 8))
      throw fail("unsupported filesystem");
  };
  const query = (handle: unknown) => {
    const bytes = Buffer.alloc(65536),
      needed = Buffer.alloc(4);
    if (!okay(get(handle, 0x17, bytes, bytes.length, needed))) throw nativeFail("descriptor query");
    const count = needed.readUInt32LE(0);
    if (count < 20 || count > bytes.length) throw fail("descriptor length");
    const result = Buffer.from(bytes.subarray(0, count));
    leaseDescriptor(result);
    return result;
  };
  const inspect = (handle: unknown) => {
    const bytes = Buffer.alloc(52);
    if (!okay(info(handle, bytes)) || bytes.readUInt32LE(0) & 0x400) throw fail("object identity query/reparse");
    if (bytes.readUInt32LE(0) & 0x10) {
      const flags = Buffer.alloc(4);
      if (!okay(extendedInfo(handle, 23, flags, flags.length)) || flags.readUInt32LE(0) !== 0)
        throw fail("case-sensitive directory not qualified");
    }
    return {
      fileId:
        bytes.readUInt32LE(44).toString(16).padStart(8, "0") + bytes.readUInt32LE(48).toString(16).padStart(8, "0"),
      creationTime:
        bytes.readUInt32LE(8).toString(16).padStart(8, "0") + bytes.readUInt32LE(4).toString(16).padStart(8, "0"),
      directory: Boolean(bytes.readUInt32LE(0) & 0x10),
      links: bytes.readUInt32LE(40),
    };
  };
  const write = (handle: unknown, desired: Buffer) => {
    const target = leaseDescriptor(desired),
      current = leaseDescriptor(query(handle)),
      absolute = Buffer.alloc(40);
    if (!target.owner.equals(current.owner) || !target.group.equals(current.group) || !target.sacl.equals(current.sacl))
      throw fail("foreign owner/group/label");
    if (!okay(initialize(absolute, 1)) || !okay(setDacl(absolute, 1, target.dacl, target.control & 8 ? 1 : 0)))
      throw fail("absolute descriptor");
    let bits = target.control & CONTROLLED;
    if (target.control & 0x400) bits |= 0x100;
    if (!okay(setControl(absolute, CONTROLLED, bits))) throw fail("restore control request");
    let sections = 4;
    if ((current.control & 0x1000) !== (target.control & 0x1000))
      sections = (sections | (target.control & 0x1000 ? 0x80000000 : 0x20000000)) >>> 0;
    if (!okay(set(handle, sections, absolute))) throw nativeFail("nonpropagating DACL write");
    if (!same(leaseDescriptor(query(handle)), target)) throw fail("DACL/control readback");
  };
  return {
    /**
     * By-ID lifetime guard and path observation. A data/list access bit is
     * essential: metadata-only handles do not enforce DELETE sharing on NTFS.
     * No ACL mutation, pathname fallback or reparse traversal occurs here.
     */
    hold(object: LeaseObject, denyRename = true) {
      retry();
      const identity = object.identity;
      if (
        !VOLUME.test(identity.volume) ||
        !/^[0-9a-f]{16}$/.test(identity.fileId) ||
        !/^[0-9a-f]{16}$/.test(identity.creationTime)
      )
        throw fail("guard identity");
      const root = file(identity.volume, 0x120080, 7, null, 3, 0x02200000, null);
      if (!valid(root)) throw nativeFail("guard volume open");
      let handle: unknown, failure: unknown;
      try {
        inspect(root);
        admitVolume(root);
        handle = byId(
          root,
          leaseFileIdDescriptor(identity.fileId),
          denyRename ? 0x160081 : 0x120080,
          denyRename ? 3 : 7,
          null,
          0x02200000,
        );
        if (!valid(handle)) throw nativeFail("guard by ID open");
        if (denyRename) {
          // OpenFileById is the identity anchor, not a qualified sharing guard:
          // NTFS permits rename through that open on Server 2025. Acquire a
          // data-bearing Win32 open of its observed current name, then verify
          // the SAME identity before releasing the anchor. No saved-path fallback.
          const buffer = Buffer.alloc(65536);
          const length = Number(finalPath(handle, buffer, buffer.length / 2, 0));
          if (length < 1 || length >= buffer.length / 2) throw fail("guard current path");
          const guarded = file(
            buffer.subarray(0, length * 2).toString("utf16le"),
            0x80060000,
            3,
            null,
            3,
            0x02200000,
            null,
          );
          if (!valid(guarded)) throw nativeFail("guard current-name data open");
          const anchored = handle;
          handle = guarded;
          try {
            release(anchored);
          } catch (cause) {
            pendingHandles.add(anchored);
            throw cause;
          }
        }
        const observed = inspect(handle);
        if (
          observed.fileId !== identity.fileId ||
          observed.creationTime !== identity.creationTime ||
          observed.directory !== identity.directory
        )
          throw fail("guard identity changed");
      } catch (cause) {
        failure = cause;
      }
      try {
        release(root);
      } catch (cause) {
        pendingHandles.add(root);
        failure ??= cause;
      }
      if (failure) {
        if (valid(handle)) disposeSetup(handle);
        throw failure;
      }
      let closed = false;
      const snapshot = () => {
        if (closed) throw fail("closed guard");
        const observed = inspect(handle);
        if (
          observed.fileId !== identity.fileId ||
          observed.creationTime !== identity.creationTime ||
          observed.directory !== identity.directory
        )
          throw fail("guard identity changed");
        const names: string[] = [];
        for (const flags of [0, 1]) {
          const buffer = Buffer.alloc(65536),
            n = Number(finalPath(handle, buffer, buffer.length / 2, flags));
          if (n < 1 || n >= buffer.length / 2) throw fail("guard final path");
          names.push(buffer.subarray(0, n * 2).toString("utf16le"));
        }
        if (!names[1]!.toLowerCase().startsWith(identity.volume.toLowerCase())) throw fail("guard volume changed");
        return {
          dosPath: names[0]!,
          volumePath: names[1]!,
          descriptor: query(handle).toString("base64"),
          links: observed.links,
        };
      };
      try {
        snapshot();
      } catch (cause) {
        disposeSetup(handle);
        throw cause;
      }
      return {
        snapshot,
        /** Revocation only, on this guarded object; no pathname/foreign ACL replacement. */
        stripOwnSid: (sid: string) => {
          const before = snapshot().descriptor;
          const cleanup = prepareNewWorkspaceSidRemoval(
            { role: "workspace-node", identity: { ...identity }, original: before, planned: before },
            sid,
          );
          if (cleanup.planned === before) return;
          if (query(handle).toString("base64") !== before) throw fail("new-node descriptor race");
          write(handle, Buffer.from(cleanup.planned, "base64"));
        },
        close: () => {
          if (!closed) {
            release(handle);
            closed = true;
          }
        },
      };
    },
    /** Capture a trusted local object; never called with an actor-supplied plan. */
    capture(
      target: string,
      role: LeaseObject["role"],
      sid: string,
      rights: number,
      deny = false,
      inherit = false,
    ): LeaseObject {
      retry();
      validateWindowsPath(target);
      validateSid(sid);
      if (
        !/^[A-Za-z]:\\/.test(target) ||
        !SID.test(sid) ||
        !Number.isInteger(rights) ||
        rights < 0 ||
        rights > 0x1f01ff
      )
        throw fail("capture input");
      const handle = file(target, 0x120080, 7, null, 3, 0x02200000, null);
      if (!valid(handle)) throw nativeFail("capture open");
      const allocatedSid: { value?: unknown } = {},
        next: { value?: unknown } = {};
      let result: LeaseObject | undefined, failure: unknown;
      try {
        admitVolume(handle);
        const observed = inspect(handle);
        if (!observed.directory && observed.links !== 1 && rights !== 0) throw fail("unqualified multi-link capture");
        const original = query(handle),
          destination = Buffer.alloc(65536);
        const length = Number(finalPath(handle, destination, destination.length / 2, 1));
        if (length < 1 || length >= destination.length / 2) throw fail("volume name query");
        const name = destination.subarray(0, length * 2).toString("utf16le"),
          match = /^\\\\\?\\Volume\{([0-9a-f-]{36})\}\\/i.exec(name);
        if (!match) throw fail("volume identity");
        if (rights === 0) {
          result = {
            role,
            identity: {
              volume: `\\\\?\\Volume{${match[1]!.toLowerCase()}}\\`,
              fileId: observed.fileId,
              creationTime: observed.creationTime,
              directory: observed.directory,
            },
            original: original.toString("base64"),
            planned: original.toString("base64"),
          };
        } else {
          if (!okay(convert(sid, allocatedSid)) || !valid(allocatedSid.value)) throw fail("package SID conversion");
          const entries = Buffer.alloc(48);
          ffi.encode(entries, E, {
            permissions: rights,
            mode: deny ? 3 : 1,
            inheritance: inherit ? 3 : 0,
            trustee: { multiple: null, operation: 0, form: 0, type: 0, name: allocatedSid.value },
          });
          if (compose(1, entries, leaseDescriptor(original).dacl, next) !== 0 || !valid(next.value))
            throw fail("planned ACL composition");
          const head = Buffer.from(ffi.decode(next.value, "uint8_t", 8) as Uint8Array),
            size = head.readUInt16LE(2);
          if (size < 8 || size > 65535) throw fail("planned ACL size");
          const acl = Buffer.from(ffi.decode(next.value, "uint8_t", size) as Uint8Array),
            planned = repack(original, acl);
          result = {
            role,
            identity: {
              volume: `\\\\?\\Volume{${match[1]!.toLowerCase()}}\\`,
              fileId: observed.fileId,
              creationTime: observed.creationTime,
              directory: observed.directory,
            },
            original: original.toString("base64"),
            planned: planned.toString("base64"),
          };
        }
      } catch (error) {
        failure = error;
      }
      // Attempt every release even when one fails, retaining exact ownership.
      for (const value of [next.value, allocatedSid.value])
        if (valid(value))
          try {
            releaseMemory(value);
          } catch (error) {
            failure ??= error;
          }
      try {
        release(handle);
      } catch (error) {
        pendingHandles.add(handle);
        failure ??= error;
      }
      if (failure) throw failure;
      return result!;
    },
    pin(object: LeaseObject): PinnedLeaseObject {
      retry();
      const { identity } = object,
        volume = VOLUME.exec(identity.volume);
      if (!volume || !/^[0-9a-f]{16}$/.test(identity.fileId) || !/^[0-9a-f]{16}$/.test(identity.creationTime))
        throw fail("saved identity");
      const originalBytes = Buffer.from(object.original, "base64"),
        plannedBytes = Buffer.from(object.planned, "base64");
      const original = leaseDescriptor(originalBytes),
        planned = leaseDescriptor(plannedBytes);
      if (
        original.rmControl !== planned.rmControl ||
        !original.owner.equals(planned.owner) ||
        !original.group.equals(planned.group) ||
        !original.sacl.equals(planned.sacl) ||
        (original.control ^ planned.control) & ~CONTROLLED
      )
        throw fail("plan changes non-DACL sections");
      const root = file(identity.volume, 0x120080, 7, null, 3, 0x02200000, null);
      if (!valid(root)) throw nativeFail("saved volume open");
      let handle: unknown, failure: unknown;
      const verifyIdentity = (value: unknown) => {
        const observed = inspect(value);
        if (
          observed.fileId !== identity.fileId ||
          observed.creationTime !== identity.creationTime ||
          observed.directory !== identity.directory ||
          (!observed.directory && observed.links !== 1)
        )
          throw fail("file identity/reparse/links changed");
      };
      try {
        inspect(root);
        admitVolume(root);
        const id = leaseFileIdDescriptor(identity.fileId);
        handle = byId(root, id, 0x60080, 7, null, 0x02200000);
        if (!valid(handle)) throw nativeFail("open saved file ID");
        verifyIdentity(handle);
      } catch (error) {
        failure = error;
      }
      try {
        release(root);
      } catch (error) {
        pendingHandles.add(root);
        failure ??= error;
      }
      if (failure) {
        if (valid(handle)) disposeSetup(handle);
        throw failure;
      }
      let closed = false;
      const state = (): ReturnType<PinnedLeaseObject["state"]> => {
        if (closed) throw fail("closed object");
        verifyIdentity(handle);
        const actual = leaseDescriptor(query(handle));
        return same(actual, original) ? "original" : same(actual, planned) ? "planned" : "conflict";
      };
      const change = (wanted: "original" | "planned") => {
        if (state() === "conflict") throw fail("foreign descriptor changed");
        if (state() === wanted) return;
        write(handle, wanted === "original" ? originalBytes : plannedBytes);
      };
      return {
        state,
        apply: () => change("planned"),
        restore: () => change("original"),
        close: () => {
          if (closed) return;
          release(handle);
          closed = true;
        },
      };
    },
  };
}
export async function loadLeaseAclObjects() {
  if (process.platform !== "win32" || !["x64", "arm64"].includes(process.arch))
    throw new CrotError("CONFINEMENT_UNAVAILABLE", "Windows lease ACLs require native 64-bit Windows.");
  const root = validateWindowsPath(process.env.SystemRoot ?? "C:\\Windows");
  if (!/^[A-Za-z]:\\/.test(root)) throw fail("system directory");
  const name: string = "koffi",
    loaded = await import(name),
    ffi = (loaded.default ?? loaded) as AclFfi;
  return bindLeaseAclObjects(ffi, {
    kernel32: path.win32.join(root, "System32", "kernel32.dll"),
    advapi32: path.win32.join(root, "System32", "advapi32.dll"),
  });
}
