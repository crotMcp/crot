/**
 * Owned NUL standard handles for suspended restricted-process creation.
 * Inherits exactly one harmless device handle, never the service's handles.
 * Does not make the MIC-only launcher a production confinement backend.
 */
import { CrotError } from "../../core/errors.js";
import { ownedStdioHandles, type NativeByteStdio } from "./byte-stdio.js";
import type { TokenFfi, TokenLibraries } from "./restricted-token.js";

const SIZE = "CROT_L1_STDIO_SIZE";
const STARTUP = "CROT_L1_STDIO_STARTUP";
const EXTENDED = "CROT_L1_STDIO_EXTENDED";
const INFORMATION = "CROT_L1_STDIO_INFORMATION";
const declared = new WeakSet<object>();
const ok = (value: unknown) => value === true || (typeof value === "number" && value !== 0);
const invalidHandle = (h: unknown) =>
  h === undefined || h === null || h === 0 || h === 0n || h === -1n || h === 0xffffffffffffffffn;

function declareStdio(ffi: TokenFfi): void {
  if (!declared.has(ffi)) {
    ffi.struct(SIZE, { value: "size_t" });
    ffi.struct(STARTUP, {
      cb: "uint32_t",
      lpReserved: "void *",
      lpDesktop: "void *",
      lpTitle: "void *",
      dwX: "uint32_t",
      dwY: "uint32_t",
      dwXSize: "uint32_t",
      dwYSize: "uint32_t",
      dwXCountChars: "uint32_t",
      dwYCountChars: "uint32_t",
      dwFillAttribute: "uint32_t",
      dwFlags: "uint32_t",
      wShowWindow: "uint16_t",
      cbReserved2: "uint16_t",
      lpReserved2: "void *",
      hStdInput: "void *",
      hStdOutput: "void *",
      hStdError: "void *",
    });
    ffi.struct(EXTENDED, { startup: STARTUP, attributes: "void *" });
    ffi.struct(INFORMATION, { hProcess: "void *", hThread: "void *", dwProcessId: "uint32_t", dwThreadId: "uint32_t" });
    declared.add(ffi);
  }
  if (ffi.sizeof(STARTUP) !== 104 || ffi.sizeof(EXTENDED) !== 112 || ffi.sizeof(INFORMATION) !== 24)
    throw new CrotError("OPERATION_FAILED", "Restricted stdio requires the 64-bit native ABI.");
}

export function bindNulProcessCreation(ffi: TokenFfi, libraries: TokenLibraries) {
  declareStdio(ffi);
  const kernel = ffi.load(libraries.kernel32);
  const advapi = ffi.load(libraries.advapi32);
  const lastError = kernel.func("uint32_t __stdcall GetLastError(void)");
  const open = kernel.func(
    "void * __stdcall CreateFileW(str16 name, uint32_t access, uint32_t share, void *security, uint32_t creation, uint32_t flags, void *template)",
  );
  const inherit = kernel.func("int __stdcall SetHandleInformation(void *handle, uint32_t mask, uint32_t flags)");
  const close = kernel.func("int __stdcall CloseHandle(void *handle)");
  const initialize = kernel.func(
    `int __stdcall InitializeProcThreadAttributeList(void *list, uint32_t count, uint32_t flags, _Inout_ ${SIZE} *size)`,
  );
  const update = kernel.func(
    "int __stdcall UpdateProcThreadAttribute(void *list, uint32_t flags, size_t attribute, void *value, size_t size, void *previous, void *returned)",
  );
  const remove = kernel.func("void __stdcall DeleteProcThreadAttributeList(void *list)");
  const create = advapi.func(
    `int __stdcall CreateProcessAsUserW(void *token, str16 application, void *command, void *processAttributes, void *threadAttributes, int inherit, uint32_t flags, void *environment, str16 cwd, ${EXTENDED} *startup, _Out_ ${INFORMATION} *out)`,
  );
  const failure = (stage: string, code = lastError()) =>
    new CrotError("OPERATION_FAILED", `Restricted stdio: ${stage} failed (code ${code}).`);
  return (
    token: unknown,
    executable: string,
    command: Buffer,
    flags: number,
    environment: Buffer,
    cwd: string,
    info: object,
    desktop?: Buffer,
  ): void => {
    let handle: unknown;
    let attributes: Buffer | undefined;
    let initialized = false;
    let failed: { cause: unknown } | undefined;
    try {
      // A fixed device, not a caller-selected host file or pipe. Initially
      // noninheritable; the attribute list permits only this one handle.
      handle = open("\\\\.\\NUL", 0xc0000000, 3, null, 3, 0x80, null);
      if (invalidHandle(handle)) throw failure("open NUL");
      if (!ok(inherit(handle, 1, 1))) throw failure("mark owned NUL inheritable");
      const size: { value?: number | bigint } = { value: 0 };
      const first = initialize(null, 1, 0, size);
      const code = lastError();
      const bytes = Number(size.value);
      if (ok(first) || code !== 122 || !Number.isSafeInteger(bytes) || bytes < 1 || bytes > 65536)
        throw failure("attribute sizing", code);
      attributes = Buffer.alloc(bytes);
      if (!ok(initialize(attributes, 1, 0, size))) throw failure("attribute initialization");
      initialized = true;
      const handles = Buffer.alloc(8);
      ffi.encode(handles, "void *", handle);
      if (!ok(update(attributes, 0, 0x20002, handles, handles.length, null, null)))
        throw failure("explicit handle allowlist");
      const startup = {
        startup: {
          cb: 112,
          dwFlags: 0x100 | ((flags & 0x10) !== 0 ? 1 : 0),
          ...((flags & 0x10) !== 0 ? { wShowWindow: 0 } : {}),
          hStdInput: handle,
          hStdOutput: handle,
          hStdError: handle,
          ...(desktop ? { lpDesktop: desktop } : {}),
        },
        attributes,
      };
      // SUSPENDED and the validated console mode remain set by the caller. No unrestricted
      // fallback exists if extended startup/handle allowlisting is unsupported.
      if (!ok(create(token, executable, command, null, null, 1, flags | 0x80000, environment, cwd, startup, info)))
        throw failure("CreateProcessAsUserW");
    } catch (cause) {
      failed = { cause };
    } finally {
      try {
        if (initialized) remove(attributes);
      } catch (cause) {
        failed ??= { cause };
      }
      try {
        if (!invalidHandle(handle) && !ok(close(handle))) failed ??= { cause: failure("owned NUL close") };
      } catch (cause) {
        failed ??= { cause };
      }
    }
    if (failed) throw failed.cause;
  };
}

/** Child std handles come exclusively from the private owned-transport registry. */
export function bindPipeProcessCreation(ffi: TokenFfi, libraries: TokenLibraries) {
  declareStdio(ffi);
  const k = ffi.load(libraries.kernel32),
    a = ffi.load(libraries.advapi32);
  const last = k.func("uint32_t __stdcall GetLastError(void)");
  const inherit = k.func("int __stdcall SetHandleInformation(void *handle, uint32_t mask, uint32_t flags)");
  const initialize = k.func(
    `int __stdcall InitializeProcThreadAttributeList(void *list, uint32_t count, uint32_t flags, _Inout_ ${SIZE} *size)`,
  );
  const update = k.func(
    "int __stdcall UpdateProcThreadAttribute(void *list, uint32_t flags, size_t attribute, void *value, size_t size, void *previous, void *returned)",
  );
  const remove = k.func("void __stdcall DeleteProcThreadAttributeList(void *list)");
  const create = a.func(
    `int __stdcall CreateProcessAsUserW(void *token, str16 application, void *command, void *processAttributes, void *threadAttributes, int inherit, uint32_t flags, void *environment, str16 cwd, ${EXTENDED} *startup, _Out_ ${INFORMATION} *out)`,
  );
  const failure = (stage: string, code = last()) =>
    new CrotError("OPERATION_FAILED", `Restricted pipe startup: ${stage} failed (code ${code}).`);
  return (
    token: unknown,
    executable: string,
    command: Buffer,
    flags: number,
    environment: Buffer,
    cwd: string,
    info: object,
    stdio: NativeByteStdio,
    desktop?: Buffer,
  ): void => {
    const child = ownedStdioHandles(stdio);
    if (child.length !== 3 || child.some(invalidHandle)) throw failure("owned handle validation", 0);
    const inherited: unknown[] = [];
    let attributes: Buffer | undefined;
    let initialized = false;
    let failed: { cause: unknown } | undefined;
    try {
      const size: { value?: number | bigint } = { value: 0 };
      const first = initialize(null, 1, 0, size),
        code = last(),
        bytes = Number(size.value);
      if (ok(first) || code !== 122 || !Number.isSafeInteger(bytes) || bytes < 1 || bytes > 65536)
        throw failure("attribute sizing", code);
      attributes = Buffer.alloc(bytes);
      if (!ok(initialize(attributes, 1, 0, size))) throw failure("attribute initialization");
      initialized = true;
      const list = Buffer.alloc(24);
      child.forEach((handle, i) => ffi.encode(list.subarray(i * 8), "void *", handle));
      if (!ok(update(attributes, 0, 0x20002, list, list.length, null, null))) throw failure("handle allowlist");
      // No await or event-loop yield exists between marking the three owned
      // handles and clearing inheritance. Parent ends are never inheritable.
      for (const handle of child) {
        if (!ok(inherit(handle, 1, 1))) throw failure("child inheritance");
        inherited.push(handle);
      }
      const startup = {
        startup: {
          cb: 112,
          dwFlags: 0x100 | ((flags & 0x10) !== 0 ? 1 : 0),
          ...((flags & 0x10) !== 0 ? { wShowWindow: 0 } : {}),
          hStdInput: child[0],
          hStdOutput: child[1],
          hStdError: child[2],
          ...(desktop ? { lpDesktop: desktop } : {}),
        },
        attributes,
      };
      if (!ok(create(token, executable, command, null, null, 1, flags | 0x80000, environment, cwd, startup, info)))
        throw failure("CreateProcessAsUserW");
    } catch (cause) {
      failed = { cause };
    } finally {
      for (const handle of inherited) {
        try {
          if (!ok(inherit(handle, 1, 0))) failed ??= { cause: failure("clear child inheritance") };
        } catch (cause) {
          failed ??= { cause };
        }
      }
      try {
        if (initialized) remove(attributes);
      } catch (cause) {
        failed ??= { cause };
      }
    }
    if (failed) throw failed.cause;
  };
}
