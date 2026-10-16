/**
 * Recovery building block: positively inventory same-user AppContainer actors,
 * pin each process before querying its real token, terminate ONLY the exact
 * package SID, wait for death and require two complete empty inventories.
 * Never treats a missing Job/parent/PID as proof that the package is drained.
 * The caller MUST first validate a durable fresh-profile ownership receipt and
 * exclude new launch admissions. This module does not adopt profiles or grant L1.
 */
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { CrotError } from "../../core/errors.js";
import { validateSid, validateWindowsPath } from "../validation.js";
import type { TokenFfi } from "./restricted-token.js";
export interface ActorInventory {
  /** Complete same-user inventory. Any unknown/denied identity is an error. */
  candidates(): readonly number[];
  /** A disappeared PID means rescan, not success. A token mismatch is not killed. */
  inspect(pid: number): { state: "foreign" | "gone" | "owned"; terminateAndWait(): void; close(): void };
}
const fail = (stage: string, code?: number) =>
  new CrotError("CONFINEMENT_FAILED", `Windows actor drain: ${stage} failed.`, {
    stage,
    ...(code === undefined ? {} : { nativeCode: code >>> 0 }),
  });
export async function drainAppContainerActors(inventory: ActorInventory) {
  let empty = 0,
    terminated = 0;
  const deadline = Date.now() + 10000;
  for (let scan = 1; scan <= 32 && Date.now() < deadline; scan++) {
    const pids = inventory.candidates();
    if (
      pids.length > 65536 ||
      new Set(pids).size !== pids.length ||
      pids.some((p) => !Number.isInteger(p) || p <= 0 || p > 0xffffffff)
    )
      throw fail("inventory shape");
    let changed = false;
    for (const pid of pids) {
      if (Date.now() >= deadline) throw fail("drain deadline");
      const actor = inventory.inspect(pid);
      try {
        if (actor.state === "gone") changed = true;
        if (actor.state === "owned") {
          actor.terminateAndWait();
          changed = true;
          terminated++;
        }
      } finally {
        actor.close();
      }
    }
    empty = changed ? 0 : empty + 1;
    if (empty === 2) return { terminated, scans: scan, emptyScans: 2 as const };
    await delay(10);
  }
  throw fail("stable empty inventory deadline");
}
interface ActorFfi extends TokenFfi {
  decode(pointer: unknown, type: string, length?: number): unknown;
}
const OUT = "CROT_ACTOR_OUTPUT",
  DWORD = "CROT_ACTOR_DWORD",
  ROW = "CROT_ACTOR_WTS_PROCESS",
  declared = new WeakSet<object>();
const absent = (p: unknown) => p === undefined || p === null || p === 0 || p === 0n;
const okay = (p: unknown) => p === true || (typeof p === "number" && p !== 0);

/** All enumeration/token handles remain owned on failed cleanup. No elevation. */
export function bindAppContainerActorDrain(ffi: ActorFfi, root: string) {
  root = validateWindowsPath(root);
  if (!/^[A-Za-z]:\\/.test(root)) throw fail("system path");
  if (!declared.has(ffi)) {
    ffi.struct(OUT, { value: "void *" });
    ffi.struct(DWORD, { value: "uint32_t" });
    ffi.struct(ROW, { session: "uint32_t", pid: "uint32_t", name: "void *", user: "void *" });
    declared.add(ffi);
  }
  if (ffi.sizeof(ROW) !== 24 || ffi.sizeof(OUT) !== 8) throw fail("64-bit ABI");
  const dll = (name: string) => path.win32.join(root, "System32", name),
    k = ffi.load(dll("kernel32.dll")),
    a = ffi.load(dll("advapi32.dll")),
    w = ffi.load(dll("wtsapi32.dll"));
  const enumerate = w.func(
      `int __stdcall WTSEnumerateProcessesExW(void *server, _Inout_ ${DWORD} *level, uint32_t session, _Out_ ${OUT} *rows, _Out_ ${DWORD} *count)`,
    ),
    freeWts = w.func("int __stdcall WTSFreeMemoryExW(int type, void *rows, uint32_t count)"),
    convert = a.func(`int __stdcall ConvertStringSidToSidW(str16 sid, _Out_ ${OUT} *value)`),
    valid = a.func("int __stdcall IsValidSid(void *sid)"),
    equal = a.func("int __stdcall EqualSid(void *left, void *right)"),
    openToken = a.func(`int __stdcall OpenProcessToken(void *process, uint32_t access, _Out_ ${OUT} *token)`),
    information = a.func(
      `int __stdcall GetTokenInformation(void *token, int kind, _Out_ uint8_t *data, uint32_t size, _Out_ ${DWORD} *returned)`,
    ),
    open = k.func("void * __stdcall OpenProcess(uint32_t access, int inherit, uint32_t pid)"),
    terminate = k.func("int __stdcall TerminateProcess(void *process, uint32_t code)"),
    wait = k.func("uint32_t __stdcall WaitForSingleObject(void *process, uint32_t milliseconds)"),
    close = k.func("int __stdcall CloseHandle(void *handle)"),
    free = k.func("void * __stdcall LocalFree(void *allocation)"),
    last = k.func("uint32_t __stdcall GetLastError(void)");
  const handles = new Set<unknown>(),
    memory = new Set<unknown>(),
    arrays = new Set<{ pointer: unknown; count: number }>(),
    unknown = new Set<object>();
  const release = (h: unknown) => {
    if (!okay(close(h))) throw fail("handle release", Number(last()));
    handles.delete(h);
  };
  const releaseInventory = (p: { pointer: unknown; count: number }) => {
    if (!okay(freeWts(0, p.pointer, p.count))) throw fail("inventory release", Number(last()));
    arrays.delete(p);
  };
  const retry = () => {
    for (const h of handles) release(h);
    for (const p of memory) {
      if (!absent(free(p))) throw fail("SID release");
      memory.delete(p);
    }
    for (const p of arrays) {
      if (!okay(freeWts(0, p.pointer, p.count))) throw fail("inventory release", Number(last()));
      arrays.delete(p);
    }
    if (unknown.size) throw fail("unbounded inventory output");
  };
  const execute = async (ownerSid: string, packageSid: string) => {
    validateSid(ownerSid);
    validateSid(packageSid);
    if (!/^S-1-5-21-(?:\d+-){3}\d+$/.test(ownerSid) || !/^S-1-15-2-(?:\d+-){6}\d+$/.test(packageSid))
      throw fail("owner/package SID admission");
    retry();
    const owner: { value?: unknown } = {},
      pkg: { value?: unknown } = {};
    const read = (token: unknown, kind: number) => {
      const b = Buffer.alloc(65536),
        out: { value?: number } = {};
      if (
        !okay(information(token, kind, b, b.length, out)) ||
        !Number.isInteger(out.value) ||
        out.value! < 4 ||
        out.value! > b.length
      )
        throw fail("token query", Number(last()));
      return b.subarray(0, out.value);
    };
    const matches = (process: unknown): boolean => {
      const out: { value?: unknown } = {};
      let fault: unknown,
        matched = false;
      try {
        const result = openToken(process, 8, out);
        if (!absent(out.value)) handles.add(out.value);
        if (!okay(result) || absent(out.value)) throw fail("token open", Number(last()));
        const user = read(out.value, 1);
        if (user.length < 16) throw fail("token user ABI");
        const sid = ffi.decode(user, "void *");
        if (absent(sid) || !okay(valid(sid)) || !okay(equal(sid, owner.value)))
          throw fail("inventory/token owner mismatch");
        const app = read(out.value, 29).readUInt32LE(0);
        if (app !== 0 && app !== 1) throw fail("token AppContainer flag");
        if (app === 1) {
          const b = read(out.value, 31);
          if (b.length < 8) throw fail("package token ABI");
          const actual = ffi.decode(b, "void *");
          if (absent(actual) || !okay(valid(actual))) throw fail("package token SID");
          matched = okay(equal(actual, pkg.value));
        }
      } catch (cause) {
        fault = cause;
      }
      if (!absent(out.value))
        try {
          release(out.value);
        } catch (cause) {
          fault ??= cause;
        }
      if (fault) throw fault;
      return matched;
    };
    try {
      for (const [sid, out] of [
        [ownerSid, owner],
        [packageSid, pkg],
      ] as const) {
        const result = convert(sid, out);
        if (!absent(out.value)) memory.add(out.value);
        if (!okay(result) || absent(out.value) || !okay(valid(out.value))) throw fail("SID conversion", Number(last()));
      }
      return await drainAppContainerActors({
        candidates: () => {
          const level = { value: 0 },
            count: { value?: number } = {},
            output: { value?: unknown } = {};
          const result = enumerate(null, level, 0xfffffffe, output, count);
          if (
            !okay(result) ||
            level.value !== 0 ||
            !Number.isInteger(count.value) ||
            count.value! < 0 ||
            count.value! > 65536 ||
            (count.value! > 0 && absent(output.value))
          ) {
            if (!absent(output.value)) unknown.add({ pointer: output.value, count: count.value });
            throw fail("complete process inventory (prepared host required)", Number(last()));
          }
          const allocation = { pointer: output.value, count: count.value! };
          if (!absent(output.value)) arrays.add(allocation);
          try {
            const rows =
              count.value === 0 ? [] : (ffi.decode(output.value, ROW, count.value) as { pid: number; user: unknown }[]);
            const pids: number[] = [];
            for (const row of rows) {
              if (row.pid === 0 || row.pid === 4) continue;
              if (absent(row.user) || !okay(valid(row.user))) throw fail("unknown inventory user SID");
              if (okay(equal(row.user, owner.value))) pids.push(row.pid);
            }
            return pids;
          } finally {
            if (!absent(output.value)) releaseInventory(allocation);
          }
        },
        inspect: (pid) => {
          const h = open(0x101000, 0, pid);
          if (absent(h)) {
            if (Number(last()) === 87)
              return {
                state: "gone",
                terminateAndWait: () => {
                  throw fail("gone process use");
                },
                close: () => {},
              };
            throw fail("process identity open", Number(last()));
          }
          handles.add(h);
          let closed = false;
          const dispose = () => {
            if (!closed) {
              release(h);
              closed = true;
            }
          };
          try {
            const observed = Number(wait(h, 0));
            if (observed !== 0 && observed !== 258) throw fail("process observation", Number(last()));
            const state = observed === 0 ? "gone" : matches(h) ? "owned" : "foreign";
            return {
              state,
              close: dispose,
              terminateAndWait: () => {
                if (state !== "owned") throw fail("foreign process termination");
                const target = open(0x101001, 0, pid);
                if (absent(target)) throw fail("owned actor termination open", Number(last()));
                handles.add(target);
                try {
                  if (!matches(target)) throw fail("termination token identity changed");
                  if (!okay(terminate(target, 1))) throw fail("owned actor termination", Number(last()));
                  if (Number(wait(target, 5000)) !== 0) throw fail("owned actor death wait", Number(last()));
                } finally {
                  release(target);
                }
              },
            };
          } catch (cause) {
            dispose();
            throw cause;
          }
        },
      });
    } finally {
      retry();
    }
  };
  let tail: Promise<unknown> = Promise.resolve();
  return (ownerSid: string, packageSid: string) => {
    const result = tail.then(() => execute(ownerSid, packageSid));
    tail = result.catch(() => undefined);
    return result;
  };
}
export async function loadAppContainerActorDrain() {
  if (process.platform !== "win32" || !["x64", "arm64"].includes(process.arch))
    throw new CrotError("CONFINEMENT_UNAVAILABLE", "Windows actor recovery requires native 64-bit Windows.");
  const m = await import("koffi");
  return bindAppContainerActorDrain(m.default ?? m, process.env.SystemRoot ?? "C:\\Windows");
}
