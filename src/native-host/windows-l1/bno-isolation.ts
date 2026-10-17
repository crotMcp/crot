/** AD-25 owned native named-object prefix. Not a confinement availability proof. */
import { randomBytes } from "node:crypto";
import { CrotError } from "../../core/errors.js";
import type { TokenFfi, TokenLibraries } from "./restricted-token.js";
export interface BnoIsolation {
  readonly kind: "owned-bno-isolation";
}
const owned = new WeakMap<BnoIsolation, string>();
export function createBnoIsolation(): BnoIsolation {
  const capability: BnoIsolation = Object.freeze({ kind: "owned-bno-isolation" });
  owned.set(capability, `crot-bno-${randomBytes(24).toString("hex")}`);
  return capability;
}
const failure = (stage: string, nativeCode?: number) =>
  new CrotError("OPERATION_FAILED", `Owned BNO isolation: ${stage} failed.`, {
    stage,
    ...(nativeCode === undefined ? {} : { nativeCode }),
  });
function prefix(capability: BnoIsolation): string {
  const value = owned.get(capability);
  if (!value) throw failure("unowned capability");
  return value;
}
/** BOOL followed by WCHAR[136]; exactly 276 bytes on both supported 64-bit ABIs. */
export function bnoIsolationAttribute(capability: BnoIsolation): Buffer {
  const buffer = Buffer.alloc(276);
  buffer.writeUInt32LE(1);
  buffer.write(prefix(capability), 4, "utf16le");
  return buffer;
}
interface ReadFfi extends TokenFfi {
  decode(buffer: Buffer, type: string): unknown;
  address(pointer: unknown): bigint;
}
const bound = new WeakMap<object, Map<string, ReturnType<typeof bindVerifier>>>();
const declared = new WeakSet<object>();
const HANDLE = "CROT_BNO_TOKEN_HANDLE",
  DWORD = "CROT_BNO_DWORD";
const validHandle = (h: unknown) =>
  h !== undefined && h !== null && h !== 0 && h !== 0n && h !== -1n && h !== 0xffffffffffffffffn;
const ok = (n: unknown) => n === true || (typeof n === "number" && n !== 0);
function bindVerifier(ffi: ReadFfi, libraries: TokenLibraries) {
  if (!declared.has(ffi)) {
    ffi.struct(HANDLE, { value: "void *" });
    ffi.struct(DWORD, { value: "uint32_t" });
    declared.add(ffi);
  }
  if (ffi.sizeof("void *") !== 8 || typeof ffi.decode !== "function" || typeof ffi.address !== "function")
    throw failure("64-bit read-back ABI");
  const a = ffi.load(libraries.advapi32),
    k = ffi.load(libraries.kernel32);
  const open = a.func(`int __stdcall OpenProcessToken(void *process, uint32_t access, _Out_ ${HANDLE} *token)`);
  const query = a.func(
    `int __stdcall GetTokenInformation(void *token, int kind, void *data, uint32_t size, _Out_ ${DWORD} *returned)`,
  );
  const restricted = a.func("int __stdcall IsTokenRestricted(void *token)");
  const close = k.func("int __stdcall CloseHandle(void *handle)");
  const last = k.func("uint32_t __stdcall GetLastError(void)");
  const pending = new Set<unknown>();
  const release = (token: unknown) => {
    if (!ok(close(token))) {
      pending.add(token);
      throw failure("token CloseHandle", Number(last()));
    }
    pending.delete(token);
  };
  const retry = () => {
    let failure: unknown;
    for (const token of pending) {
      try {
        release(token);
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure) throw failure;
  };
  return {
    retry,
    verify: (process: unknown, capability: BnoIsolation) => {
      const expected = prefix(capability);
      retry();
      const token: { value?: unknown } = {};
      let error: unknown;
      try {
        if (!ok(open(process, 8, token)) || !validHandle(token.value))
          throw failure("owned child token", Number(last()));
        if (!ok(restricted(token.value))) throw failure("restricted child token");
        const size: { value?: number } = {};
        const first = query(token.value, 44, null, 0, size),
          code = Number(last());
        if (ok(first) || code !== 122 || !Number.isSafeInteger(size.value) || size.value! < 16 || size.value! > 4096)
          throw failure("read-back sizing", code);
        const data = Buffer.alloc(size.value!);
        if (
          !ok(query(token.value, 44, data, data.length, size)) ||
          !Number.isSafeInteger(size.value) ||
          size.value! < 16 ||
          size.value! > data.length
        )
          throw failure("read-back query", Number(last()));
        const pointer = ffi.decode(data, "void *");
        if (!validHandle(pointer) || data[8] !== 1) throw failure("kernel isolation flag");
        const offset = Number(ffi.address(pointer) - ffi.address(data));
        const bytes = Buffer.from(expected + "\0", "utf16le");
        if (
          !Number.isSafeInteger(offset) ||
          offset < 16 ||
          offset % 2 !== 0 ||
          offset + bytes.length > size.value! ||
          !data.subarray(offset, offset + bytes.length).equals(bytes)
        )
          throw failure("kernel isolation prefix");
      } catch (cause) {
        error = cause;
      } finally {
        if (validHandle(token.value)) {
          try {
            release(token.value);
          } catch (cause) {
            error ??= cause;
          }
        }
      }
      if (error) throw error;
    },
  };
}
export function bindBnoIsolationVerifier(ffi: TokenFfi, libraries: TokenLibraries) {
  const key = `${libraries.advapi32}\0${libraries.kernel32}`;
  let bindings = bound.get(ffi);
  if (!bindings) {
    bindings = new Map();
    bound.set(ffi, bindings);
  }
  let verifier = bindings.get(key);
  if (!verifier) {
    verifier = bindVerifier(ffi as ReadFfi, libraries);
    bindings.set(key, verifier);
  }
  return verifier;
}
