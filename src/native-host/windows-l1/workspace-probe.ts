/**
 * WP-23c research only: a fixed filesystem capability, NOT a production
 * permission engine, shell launcher or transparent filesystem projection.
 * The trusted caller chooses the root; requests cannot choose another root.
 */
import { CrotError } from "../../core/errors.js";
import type { TokenFfi } from "./restricted-token.js";

export const MAX_PROBE_WRITE = 32 * 1024;
export type WorkspaceProbeRequest =
  | { op: "create" | "write"; path: string; text: string }
  | { op: "remove"; path: string }
  | { op: "rename"; path: string; destination: string };
const deny = (stage = "request", status?: number) =>
  new CrotError("PERMISSION_DENIED", "Workspace probe request refused.", { stage, status });

/** No normalization/repair: one spelling, no streams, namespaces or DOS aliases. */
export function probeRelativePath(value: unknown): string[] {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) throw deny();
  const parts = value.split("/");
  if (
    parts.length > 32 ||
    parts.some(
      (p) =>
        p.length === 0 ||
        p.length > 255 ||
        p === "." ||
        p === ".." ||
        /[\u0000-\u001f\u007f\uD800-\uDFFF\\:*?"<>|~]/u.test(p) ||
        /[. ]$/.test(p) ||
        /^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/iu.test(p),
    )
  )
    throw deny();
  return parts;
}

export function parseWorkspaceProbeRequest(value: unknown): WorkspaceProbeRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw deny();
  const r = value as Record<string, unknown>;
  probeRelativePath(r.path);
  let keys: string[];
  switch (r.op) {
    case "create":
    case "write":
      if (typeof r.text !== "string" || Buffer.byteLength(r.text, "utf8") > MAX_PROBE_WRITE) throw deny();
      keys = ["op", "path", "text"];
      break;
    case "remove":
      keys = ["op", "path"];
      break;
    case "rename":
      probeRelativePath(r.destination);
      keys = ["op", "path", "destination"];
      break;
    default:
      throw deny();
  }
  if (Object.keys(r).length !== keys.length || keys.some((key) => !Object.hasOwn(r, key))) throw deny();
  return r as WorkspaceProbeRequest;
}

export interface WorkspaceProbe {
  execute(request: unknown): void;
  close(): void;
}
const declared = new WeakSet<object>();

export async function loadWorkspaceProbe(root: string): Promise<WorkspaceProbe> {
  if (process.platform !== "win32" || !["x64", "arm64"].includes(process.arch)) throw deny();
  const name: string = "koffi";
  const imported = await import(name);
  const ffi = (imported.default ?? imported) as TokenFfi;
  if (!declared.has(ffi)) {
    ffi.struct("CROT_WS_UNICODE", { Length: "uint16_t", MaximumLength: "uint16_t", Buffer: "void *" });
    ffi.struct("CROT_WS_OBJECT", {
      Length: "uint32_t",
      RootDirectory: "void *",
      ObjectName: "void *",
      Attributes: "uint32_t",
      SecurityDescriptor: "void *",
      SecurityQualityOfService: "void *",
    });
    ffi.struct("CROT_WS_HANDLE", { value: "void *" });
    ffi.struct("CROT_WS_COUNT", { value: "uint32_t" });
    declared.add(ffi);
  }
  if (ffi.sizeof("CROT_WS_UNICODE") !== 16 || ffi.sizeof("CROT_WS_OBJECT") !== 48) throw deny();
  const k = ffi.load("kernel32.dll");
  const nt = ffi.load("ntdll.dll");
  const file = k.func(
    "void * __stdcall CreateFileW(str16 name, uint32_t access, uint32_t share, void *security, uint32_t disposition, uint32_t flags, void *templateFile)",
  );
  const open = nt.func(
    "int32_t __stdcall NtCreateFile(_Out_ CROT_WS_HANDLE *out, uint32_t access, void *attributes, void *status, void *allocation, uint32_t fileAttributes, uint32_t share, uint32_t disposition, uint32_t options, void *ea, uint32_t eaSize)",
  );
  const info = k.func("int __stdcall GetFileInformationByHandle(void *handle, _Out_ uint8_t *info)");
  const set = nt.func(
    "int32_t __stdcall NtSetInformationFile(void *handle, void *status, void *buffer, uint32_t size, uint32_t kind)",
  );
  const write = k.func(
    "int __stdcall WriteFile(void *handle, uint8_t *bytes, uint32_t size, _Out_ CROT_WS_COUNT *count, void *overlapped)",
  );
  const eof = k.func("int __stdcall SetEndOfFile(void *handle)");
  const close = k.func("int __stdcall CloseHandle(void *handle)");
  const valid = (h: unknown) =>
    h !== null && h !== undefined && h !== 0 && h !== 0n && h !== -1n && h !== 0xffffffffffffffffn;
  const held: unknown[] = [];
  const release = (handles: unknown[]) => {
    let failed = false;
    for (const h of handles.reverse()) if (!close(h)) failed = true;
    if (failed) throw deny();
  };
  const inspect = (h: unknown, directory: boolean) => {
    const bytes = Buffer.alloc(52); // BY_HANDLE_FILE_INFORMATION, identical on x64/ARM64.
    if (!info(h, bytes)) throw deny("metadata");
    const attributes = bytes.readUInt32LE(0);
    if (
      (attributes & 0x400) !== 0 || // Never operate on a reparse point.
      Boolean(attributes & 0x10) !== directory ||
      (!directory && bytes.readUInt32LE(40) !== 1) // Reject existing hard-link aliases.
    )
      throw deny("object-type-or-links", bytes.readUInt32LE(40));
  };
  const relative = (parent: unknown, component: string, directory: boolean, create = false) => {
    const text = Buffer.from(component + "\0", "utf16le");
    const unicode = Buffer.alloc(16);
    ffi.encode(unicode, "CROT_WS_UNICODE", {
      Length: text.length - 2,
      MaximumLength: text.length,
      Buffer: text,
    });
    const attributes = Buffer.alloc(48);
    ffi.encode(attributes, "CROT_WS_OBJECT", {
      Length: 48,
      RootDirectory: parent,
      ObjectName: unicode,
      Attributes: 0x1040, // OBJ_DONT_REPARSE | OBJ_CASE_INSENSITIVE
      SecurityDescriptor: null,
      SecurityQualityOfService: null,
    });
    const out: { value?: unknown } = {};
    // No destructive disposition: inspect the opened object BEFORE any write.
    const status = open(
      out,
      directory ? 0x1000a0 : 0x110083, // sync + attributes + traverse OR read/write/delete
      attributes,
      Buffer.alloc(16),
      null,
      0,
      // Rename internally opens parent directories for writes. Allow write
      // sharing, but NEVER delete sharing: directory identity remains pinned.
      // Reparse traversal is independently refused on handle-relative opens.
      directory ? 3 : 0,
      create ? 2 : 1, // FILE_CREATE (never overwrite) / FILE_OPEN
      0x200020 | (directory ? 1 : 0x40), // no reparse processing, synchronous, correct type
      null,
      0,
    );
    if (Number(status) < 0 || !valid(out.value)) throw deny("open", Number(status));
    try {
      inspect(out.value, directory);
      return out.value;
    } catch (e) {
      close(out.value);
      throw e;
    }
  };
  // Research accepts local drive roots only. Pin EVERY ancestor starting at
  // the drive; opening the full workspace string would follow parent reparses.
  if (!/^[A-Za-z]:\\/.test(root) || /[\u0000-\u001f/*?"<>|]/.test(root) || root.slice(2).includes(":")) throw deny();
  const rootParts = root.slice(3).replace(/\\$/, "").split("\\");
  if (rootParts.some((p) => !p || p === "." || p === ".." || /[. ]$/.test(p))) throw deny();
  let rootHandle: unknown;
  try {
    rootHandle = file(root.slice(0, 3), 0x1000a0, 3, null, 3, 0x02200000, null);
    if (!valid(rootHandle)) throw deny();
    held.push(rootHandle);
    inspect(rootHandle, true);
    for (const part of rootParts) {
      rootHandle = relative(rootHandle, part, true);
      held.push(rootHandle);
    }
  } catch (e) {
    release(held);
    throw e;
  }
  let closed = false;
  return {
    execute(value) {
      if (closed) throw deny();
      const request = parseWorkspaceProbeRequest(value);
      const handles: unknown[] = [];
      const parent = (parts: string[]) => {
        let h = rootHandle;
        for (const part of parts.slice(0, -1)) {
          h = relative(h, part, true);
          handles.push(h);
        }
        return h;
      };
      try {
        const parts = probeRelativePath(request.path);
        const sourceParent = parent(parts);
        const h = relative(sourceParent, parts.at(-1)!, false, request.op === "create");
        handles.push(h);
        if (request.op === "create" || request.op === "write") {
          const bytes = Buffer.from(request.text, "utf8");
          const count: { value?: number } = {};
          if (!write(h, bytes, bytes.length, count, null) || count.value !== bytes.length || !eof(h))
            throw deny("write");
        } else if (request.op === "remove") {
          const status = Number(set(h, Buffer.alloc(16), Buffer.from([1]), 1, 13));
          if (status < 0) throw deny("remove", status);
        } else if (request.op === "rename") {
          const destination = probeRelativePath(request.destination);
          const destinationParent = parent(destination);
          const text = Buffer.from(destination.at(-1)! + "\0", "utf16le");
          // FILE_RENAME_INFORMATION: replace=false, root HANDLE at 8,
          // byte length at 16, UTF-16 filename at 20. No string-based rename.
          const buffer = Buffer.alloc(20 + text.length);
          ffi.encode(buffer.subarray(8), "CROT_WS_HANDLE", { value: destinationParent });
          buffer.writeUInt32LE(text.length - 2, 16);
          text.copy(buffer, 20);
          const status = Number(set(h, Buffer.alloc(16), buffer, buffer.length, 10));
          if (status < 0) throw deny("rename", status);
        }
      } finally {
        release(handles);
      }
    },
    close() {
      if (closed) return;
      closed = true;
      release(held);
    },
  };
}
