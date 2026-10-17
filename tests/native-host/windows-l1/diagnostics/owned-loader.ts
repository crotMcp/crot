/**
 * Test-only loader snaps for one just-created owned suspended child. Never an
 * arbitrary PID endpoint; no raw strings, addresses, environment or paths leave
 * this helper. Does not alter IFEO, system registry or any user's executable.
 */
import type { TokenFfi } from "../../../../src/native-host/windows-l1/restricted-token.js";
export interface LoaderRow {
  readonly functions: string[];
  readonly modules: string[];
  readonly statuses: string[];
}
export function loaderTokens(text: string): LoaderRow[] {
  return text
    .split(/\r?\n/)
    .filter((line) => /ERROR|FAIL|DENIED|0xc[0-9a-f]{7}\b/i.test(line))
    .flatMap((line) => {
      const functions = [...new Set(line.match(/\b(?:Ldrp?|Rtl)[A-Za-z0-9_]+\b/g) ?? [])].slice(0, 4);
      const modules = [
        ...new Set([...line.matchAll(/(?:^|[\\/"\s])([A-Za-z0-9_.-]+\.dll)\b/gi)].map((m) => m[1]!.toLowerCase())),
      ].slice(0, 4);
      const statuses = [...new Set(line.match(/\b0x(?:c[0-9a-f]{7}|8000000[34])\b/gi) ?? [])]
        .map((s) => s.toLowerCase())
        .slice(0, 4);
      return functions.length || modules.length || statuses.length ? [{ functions, modules, statuses }] : [];
    })
    .slice(0, 64);
}
interface DebugFfi extends TokenFfi {
  decode(buffer: Buffer, type: string): unknown;
  address(pointer: unknown): bigint;
}
export interface OwnedLoaderTrace {
  collect(): Promise<{
    exited: boolean;
    exitCode: number | null;
    events: number;
    rows: LoaderRow[];
    exceptions: string[];
  }>;
  close(): void;
}
export function startOwnedLoaderTrace(ffi: DebugFfi, pid: number): OwnedLoaderTrace {
  if (!Number.isSafeInteger(pid) || pid <= 0 || ffi.sizeof("void *") !== 8)
    throw new Error("Invalid owned loader trace ABI/identity.");
  const k = ffi.load("kernel32.dll"),
    nt = ffi.load("ntdll.dll");
  const open = k.func("void * __stdcall OpenProcess(uint32_t access, int inherit, uint32_t pid)");
  const release = k.func("int __stdcall CloseHandle(void *handle)");
  const lastError = k.func("uint32_t __stdcall GetLastError(void)");
  const stop = k.func("int __stdcall DebugActiveProcessStop(uint32_t pid)");
  const read = k.func(
    "int __stdcall ReadProcessMemory(void *process, void *address, void *data, size_t size, void *count)",
  );
  const write = k.func(
    "int __stdcall WriteProcessMemory(void *process, void *address, void *data, size_t size, void *count)",
  );
  const query = nt.func(
    "int32_t __stdcall NtQueryInformationProcess(void *process, uint32_t kind, void *data, uint32_t size, void *count)",
  );
  const wait = k.func("int __stdcall WaitForDebugEventEx(void *event, uint32_t ms)");
  const resume = k.func("int __stdcall ContinueDebugEvent(uint32_t pid, uint32_t tid, uint32_t status)");
  const pointer = (address: bigint) => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(address);
    return ffi.decode(b, "void *");
  };
  const proc = open(0x400 | 0x10 | 0x20 | 0x8, 0, pid);
  if (!proc) {
    stop(pid);
    throw new Error("Owned loader process open failed.");
  }
  let attached = true,
    closed = false;
  const close = () => {
    if (closed) return;
    if (attached && !stop(pid)) throw new Error("Owned loader detach failed.");
    attached = false;
    if (!release(proc)) throw new Error("Owned loader handle close failed.");
    closed = true;
  };
  try {
    const basic = Buffer.alloc(48);
    if (query(proc, 0, basic, basic.length, null) !== 0) throw new Error("Owned loader basic query failed.");
    const peb = basic.readBigUInt64LE(8);
    if (!peb) throw new Error("Owned loader PEB missing.");
    const flags = Buffer.alloc(4),
      count = Buffer.alloc(8),
      address = pointer(peb + 0xbcn);
    if (!read(proc, address, flags, 4, count) || count.readBigUInt64LE() !== 4n)
      throw new Error("Owned loader flag read failed.");
    flags.writeUInt32LE(flags.readUInt32LE() | 2);
    if (!write(proc, address, flags, 4, count) || count.readBigUInt64LE() !== 4n)
      throw new Error("Owned loader flag write failed.");
  } catch (error) {
    try {
      close();
    } catch {
      /* preserve setup error */
    }
    throw error;
  }
  return {
    close,
    collect: async () => {
      const deadline = Date.now() + 15000;
      const rows: LoaderRow[] = [],
        exceptions: string[] = [];
      let events = 0,
        exited = false,
        exitCode: number | null = null;
      while (Date.now() < deadline && events < 30000) {
        const event = Buffer.alloc(176);
        if (!wait(event, 0)) {
          const error = Number(lastError());
          if (error !== 121) throw new Error(`Owned loader wait failed (${error}).`);
          await new Promise((r) => setTimeout(r, 1));
          continue;
        }
        events++;
        const kind = event.readUInt32LE(0),
          processId = event.readUInt32LE(4),
          threadId = event.readUInt32LE(8);
        let status = 0x10002;
        let failure: unknown;
        try {
          if (processId !== pid) throw new Error("Unexpected debug process identity.");
          if (kind === 8) {
            const unicode = event.readUInt16LE(24) !== 0;
            const length = Math.min(event.readUInt16LE(26), 4096) * (unicode ? 2 : 1);
            if (length) {
              const text = Buffer.alloc(length),
                count = Buffer.alloc(8);
              if (read(proc, pointer(event.readBigUInt64LE(16)), text, length, count))
                rows.push(
                  ...loaderTokens(
                    text.subarray(0, Number(count.readBigUInt64LE())).toString(unicode ? "utf16le" : "latin1"),
                  ),
                );
              if (rows.length > 96) rows.splice(0, rows.length - 96);
            }
          } else if (kind === 1) {
            const code = event.readUInt32LE(16);
            if (exceptions.length < 32) exceptions.push(`0x${code.toString(16).padStart(8, "0")}`);
            if (![0x80000003, 0x80000004].includes(code)) status = 0x80010001;
          } else if (kind === 3 || kind === 6) {
            const file = event.readBigUInt64LE(16);
            if (file && file !== 0xffffffffffffffffn && !release(pointer(file)))
              throw new Error("Owned loader image handle close failed.");
          } else if (kind === 5) {
            exited = true;
            exitCode = event.readUInt32LE(16);
          }
        } catch (error) {
          failure = error;
        } finally {
          try {
            if (!resume(processId, threadId, status)) failure ??= new Error("Owned loader continue failed.");
          } catch (error) {
            failure ??= error;
          }
        }
        if (failure) throw failure;
        if (exited) {
          attached = false;
          break;
        }
        if (events % 64 === 0) await new Promise((r) => setImmediate(r));
      }
      return { exited, exitCode, events, rows, exceptions };
    },
  };
}
