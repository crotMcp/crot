/** Per-SID loopback control using the fixed Windows system tool, never a shell. */
import path from "node:path";
import { CrotError } from "../../core/errors.js";
import { runTool, type ToolRunner } from "../windows-acl.js";
import { validateWindowsPath } from "../validation.js";
import type { TokenFfi } from "./restricted-token.js";
import type { AppContainerNetworkNative } from "./network.js";
interface NetworkFfi extends TokenFfi {
  decode(pointer: unknown, type: string, length?: number): unknown;
}
export interface LoopbackEntry {
  readonly sid: string;
  readonly attributes: number;
}
export interface LoopbackControl {
  list(): readonly LoopbackEntry[];
  change(sid: string, add: boolean): Promise<void>;
}
const fail = (stage: string, code?: number) =>
  new CrotError("CONFINEMENT_FAILED", `Windows loopback: ${stage} failed.`, {
    stage,
    ...(code === undefined ? {} : { nativeCode: code >>> 0 }),
  });
const packageSid = (sid: string) =>
  /^S-1-15-2-(?:[0-9]+-){6}[0-9]+$/.test(sid) &&
  sid
    .split("-")
    .slice(4)
    .every((n) => Number(n) <= 0xffffffff && String(Number(n)) === n);
const foreign = (entries: readonly LoopbackEntry[], sid: string) =>
  JSON.stringify(
    entries
      .filter((e) => e.sid !== sid)
      .map((e) => `${e.sid}:${e.attributes}`)
      .sort(),
  );

/** Serialises our own clients; does NOT claim a global atomic list CAS. */
export function createAppContainerNetworkNative(control: LoopbackControl): AppContainerNetworkNative {
  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T>(action: () => Promise<T>): Promise<T> => {
    const result = tail.then(action);
    tail = result.catch(() => undefined);
    return result;
  };
  const list = (sid: string) => {
    if (!packageSid(sid)) throw fail("package SID admission");
    const entries = control.list();
    if (new Set(entries.map((e) => e.sid)).size !== entries.length) throw fail("duplicate config SID");
    return entries;
  };
  const change = (sid: string, add: boolean) =>
    serial(async () => {
      const before = list(sid),
        present = before.some((e) => e.sid === sid);
      if (present === add) return;
      // -a/-d targets one SID. Never restore a saved global configuration snapshot.
      // A concurrent third-party configuration change is detected, not overwritten
      // by a compensating old-list write. The lease remains open on ambiguity.
      await control.change(sid, add);
      const after = list(sid);
      if (after.some((e) => e.sid === sid) !== add) throw fail("target readback");
      if (foreign(before, sid) !== foreign(after, sid)) throw fail("concurrent foreign configuration change");
    });
  return {
    contains: (sid) => serial(async () => list(sid).some((e) => e.sid === sid)),
    add: (sid) => change(sid, true),
    remove: (sid) => change(sid, false),
  };
}

const COUNT = "CROT_NETWORK_COUNT",
  OUTPUT = "CROT_NETWORK_OUTPUT",
  ENTRY = "CROT_NETWORK_SID_ATTRIBUTES";
const declared = new WeakSet<object>();
export function bindAppContainerNetworkNative(
  ffi: NetworkFfi,
  systemRoot: string,
  run: ToolRunner = runTool,
): AppContainerNetworkNative {
  validateWindowsPath(systemRoot);
  if (!/^[A-Za-z]:\\/.test(systemRoot)) throw fail("system path admission");
  if (!declared.has(ffi)) {
    ffi.struct(COUNT, { value: "uint32_t" });
    ffi.struct(OUTPUT, { value: "void *" });
    ffi.struct(ENTRY, { Sid: "void *", Attributes: "uint32_t" });
    declared.add(ffi);
  }
  if (ffi.sizeof(ENTRY) !== 16 || ffi.sizeof(OUTPUT) !== 8) throw fail("64-bit ABI admission");
  const system32 = path.win32.join(systemRoot, "System32"),
    kernel = ffi.load(path.win32.join(system32, "kernel32.dll")),
    advapi = ffi.load(path.win32.join(system32, "advapi32.dll")),
    firewall = ffi.load(path.win32.join(system32, "FirewallAPI.dll"));
  const get = firewall.func(
      `uint32_t __stdcall NetworkIsolationGetAppContainerConfig(_Out_ ${COUNT} *count, _Out_ ${OUTPUT} *entries)`,
    ),
    heap = kernel.func("void * __stdcall GetProcessHeap(void)"),
    heapFree = kernel.func("int __stdcall HeapFree(void *heap, uint32_t flags, void *allocation)"),
    localFree = kernel.func("void * __stdcall LocalFree(void *allocation)"),
    valid = advapi.func("int __stdcall IsValidSid(void *sid)"),
    text = advapi.func(`int __stdcall ConvertSidToStringSidW(void *sid, _Out_ ${OUTPUT} *text)`);
  const missing = (v: unknown) => v === undefined || v === null || v === 0 || v === 0n;
  const ok = (v: unknown) => v === true || (typeof v === "number" && v !== 0);
  const retainedHeap = new Set<unknown>(),
    retainedLocal = new Set<unknown>();
  // Unknown output bounds cannot be traversed/freed safely; retain and block.
  const retainedUnknown = new Set<object>();
  const release = () => {
    for (const p of retainedLocal) {
      if (!missing(localFree(p))) throw fail("SID text release");
      retainedLocal.delete(p);
    }
    for (const p of retainedHeap) {
      if (!ok(heapFree(heap(), 0, p))) throw fail("configuration release");
      retainedHeap.delete(p);
    }
    if (retainedUnknown.size) throw fail("unknown configuration output");
  };
  return createAppContainerNetworkNative({
    list: () => {
      release();
      const count: { value?: number } = {},
        output: { value?: unknown } = {};
      const status = Number(get(count, output));
      if (
        status !== 0 ||
        !Number.isInteger(count.value) ||
        count.value! < 0 ||
        count.value! > 4096 ||
        (count.value! > 0 && missing(output.value))
      ) {
        if (!missing(output.value)) retainedUnknown.add({ pointer: output.value, count: count.value });
        throw fail("configuration query", status);
      }
      if (!missing(output.value)) retainedHeap.add(output.value);
      let rows: { Sid: unknown; Attributes: number }[];
      try {
        rows = count.value === 0 ? [] : (ffi.decode(output.value, ENTRY, count.value) as typeof rows);
      } catch {
        // Unknown inner pointers remain owned but cannot be safely traversed.
        retainedHeap.delete(output.value);
        retainedUnknown.add({ pointer: output.value, count: count.value });
        throw fail("configuration array decode");
      }
      // Free each SID first, outer array last, matching the Windows API sample.
      retainedHeap.delete(output.value);
      for (const row of rows) if (!missing(row.Sid)) retainedHeap.add(row.Sid);
      if (!missing(output.value)) retainedHeap.add(output.value);
      try {
        return rows.map((row) => {
          if (missing(row.Sid) || !ok(valid(row.Sid))) throw fail("configuration SID");
          const out: { value?: unknown } = {};
          try {
            if (!ok(text(row.Sid, out)) || missing(out.value)) throw fail("configuration SID text");
            const sid = ffi.decode(out.value, "char16_t", -1);
            if (typeof sid !== "string" || !/^S-1-\d+(?:-\d+)+$/.test(sid)) throw fail("configuration SID format");
            return { sid, attributes: row.Attributes };
          } finally {
            if (!missing(out.value)) retainedLocal.add(out.value);
          }
        });
      } finally {
        release();
      }
    },
    change: async (sid, add) => {
      try {
        await run(path.win32.join(system32, "CheckNetIsolation.exe"), [
          "LoopbackExempt",
          add ? "-a" : "-d",
          `-p=${sid}`,
        ]);
      } catch {
        throw fail("per-SID loopback change (host preparation or privilege required)");
      }
    },
  });
}
let loaded: Promise<AppContainerNetworkNative> | undefined;
export function loadAppContainerNetworkNative(): Promise<AppContainerNetworkNative> {
  if (process.platform !== "win32" || !["x64", "arm64"].includes(process.arch))
    return Promise.reject(new CrotError("CONFINEMENT_UNAVAILABLE", "Windows network requires native 64-bit Windows."));
  loaded ??= import("koffi").then((m) =>
    bindAppContainerNetworkNative(m.default ?? m, process.env.SystemRoot ?? "C:\\Windows"),
  );
  return loaded;
}
