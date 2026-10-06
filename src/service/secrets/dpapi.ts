/**
 * Windows DPAPI secret backend (WP-21).
 *
 * Each secret is encrypted with CryptProtectData in the CurrentUser scope
 * (the key is derived from the user's logon credentials; other users,
 * including other accounts on the machine, cannot decrypt it) with a fixed
 * per-secret entropy, and stored base64-encoded in <state>/secrets/<name>.dpapi
 * (owner-only where the platform restricts files). crypt32 is called through
 * the koffi FFI module (an optional dependency CROT already uses for Job
 * Objects); no PowerShell is started, so readers such as the stdio shim and
 * the browser relay stay fast.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { CrotError } from "../../core/errors.js";
import type { PrivateFileProtection } from "../../core/platform/types.js";
import { removeFile, writePrivateFileAtomic } from "./backends.js";
import type { SecretBackend, SecretName } from "./types.js";

export const DPAPI_DIRECTORY_NAME = "secrets";
const CRYPTPROTECT_UI_FORBIDDEN = 0x1;
const BLOB_STRUCT = "CROT_DATA_BLOB";

export interface Dpapi {
  protect(data: Buffer, entropy: Buffer): Buffer;
  unprotect(blob: Buffer, entropy: Buffer): Buffer;
}

/** Test seam: loads the FFI module. */
export type DpapiFfiLoader = () => Promise<unknown>;

type NativeFunction = (...args: unknown[]) => unknown;
interface FfiModule {
  load(name: string): { func(signature: string): NativeFunction };
  struct(name: string, members: Record<string, string>): unknown;
  view(pointer: unknown, length: number): ArrayBuffer;
}

const FFI_MODULE: string = "koffi";
const defaultLoader: DpapiFfiLoader = () => import(FFI_MODULE);
const describe = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).split(/\r?\n/)[0]!.slice(0, 200);
const succeeded = (r: unknown) => r !== 0 && r !== 0n && r !== false && r !== null && r !== undefined;

/** koffi type names are global: the struct is declared once per FFI module, bindings once per library pair. */
const declared = new WeakSet<object>();
const bound = new WeakMap<object, Map<string, Dpapi>>();

/**
 * Bind CryptProtectData / CryptUnprotectData. `libraries` replaces the DLL
 * names (tests on other platforms use a stand-in library with the same ABI).
 */
export function bindDpapi(ffi: FfiModule, libraries = { crypt32: "crypt32.dll", kernel32: "kernel32.dll" }): Dpapi {
  const key = `${libraries.crypt32}\u0000${libraries.kernel32}`;
  let perModule = bound.get(ffi);
  if (!perModule) {
    perModule = new Map();
    bound.set(ffi, perModule);
  }
  const hit = perModule.get(key);
  if (hit) return hit;
  if (!declared.has(ffi)) {
    ffi.struct(BLOB_STRUCT, { cbData: "uint32_t", pbData: "void *" });
    declared.add(ffi);
  }
  const crypt32 = ffi.load(libraries.crypt32);
  const kernel32 = ffi.load(libraries.kernel32);
  const protectData = crypt32.func(
    `int __stdcall CryptProtectData(${BLOB_STRUCT} *dataIn, void *description, ${BLOB_STRUCT} *entropy, void *reserved, void *prompt, uint32_t flags, _Out_ ${BLOB_STRUCT} *dataOut)`,
  );
  const unprotectData = crypt32.func(
    `int __stdcall CryptUnprotectData(${BLOB_STRUCT} *dataIn, void *description, ${BLOB_STRUCT} *entropy, void *reserved, void *prompt, uint32_t flags, _Out_ ${BLOB_STRUCT} *dataOut)`,
  );
  const localFree = kernel32.func("void * __stdcall LocalFree(void *memory)");
  const call = (fn: NativeFunction, what: string, input: Buffer, entropy: Buffer): Buffer => {
    const out: { cbData?: number; pbData?: unknown } = {};
    const ok = fn(
      { cbData: input.length, pbData: input },
      null,
      { cbData: entropy.length, pbData: entropy },
      null,
      null,
      CRYPTPROTECT_UI_FORBIDDEN,
      out,
    );
    if (!succeeded(ok) || !out.pbData || typeof out.cbData !== "number")
      throw new CrotError("OPERATION_FAILED", `DPAPI ${what} failed.`);
    try {
      // Copy out of the buffer DPAPI allocated before it is freed.
      return Buffer.from(new Uint8Array(ffi.view(out.pbData, out.cbData)));
    } finally {
      localFree(out.pbData);
    }
  };
  const api: Dpapi = {
    protect: (data, entropy) => call(protectData, "encryption", data, entropy),
    unprotect: (blob, entropy) => call(unprotectData, "decryption", blob, entropy),
  };
  perModule.set(key, api);
  return api;
}

let loaded: Promise<Dpapi> | undefined;

/**
 * DPAPI of this process, verified with a round trip. Throws OPERATION_FAILED
 * where it is unavailable (not Windows, koffi missing or unusable).
 */
export function loadDpapi(load: DpapiFfiLoader = defaultLoader): Promise<Dpapi> {
  if (load !== defaultLoader) return loadWith(load);
  loaded ??= loadWith(load).catch((error: unknown) => {
    loaded = undefined;
    throw error;
  });
  return loaded;
}

async function loadWith(load: DpapiFfiLoader): Promise<Dpapi> {
  if (process.platform !== "win32") throw new CrotError("OPERATION_FAILED", "DPAPI is only available on Windows.");
  let module: unknown;
  try {
    module = await load();
  } catch (error) {
    throw new CrotError("OPERATION_FAILED", `the koffi FFI module is not available: ${describe(error)}`);
  }
  const candidate = ((module as { default?: unknown } | null | undefined)?.default ?? module) as
    Partial<FfiModule> | null | undefined;
  if (
    !candidate ||
    typeof candidate.load !== "function" ||
    typeof candidate.struct !== "function" ||
    typeof candidate.view !== "function"
  )
    throw new CrotError("OPERATION_FAILED", "the koffi FFI module has an unexpected shape.");
  try {
    const api = bindDpapi(candidate as FfiModule);
    const probe = Buffer.from("crot-dpapi-probe", "utf8");
    const entropy = Buffer.from("crot-mcp:probe", "utf8");
    if (!api.unprotect(api.protect(probe, entropy), entropy).equals(probe))
      throw new Error("round trip returned other data");
    return api;
  } catch (error) {
    throw new CrotError("OPERATION_FAILED", `DPAPI could not be initialized: ${describe(error)}`);
  }
}

export function dpapiDirectory(stateDir: string): string {
  return path.join(stateDir, DPAPI_DIRECTORY_NAME);
}

const entropyOf = (name: SecretName) => Buffer.from(`crot-mcp:${name}`, "utf8");

export function createDpapiBackend(stateDir: string, privateFiles: PrivateFileProtection, dpapi: Dpapi): SecretBackend {
  const dir = dpapiDirectory(stateDir);
  const file = (name: SecretName) => path.join(dir, `${name}.dpapi`);
  return {
    id: "dpapi",
    description: `Windows DPAPI (current user) in ${dir}`,
    paths: [dir],
    get: async (name) => {
      let text: string;
      try {
        text = (await readFile(file(name), "utf8")).trim();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw new CrotError("CONFIG_ERROR", `Cannot read ${file(name)}: ${(error as Error).message}`);
      }
      if (text === "") return undefined;
      let plain: Buffer;
      try {
        plain = dpapi.unprotect(Buffer.from(text, "base64"), entropyOf(name));
      } catch (error) {
        throw new CrotError(
          "CONFIG_ERROR",
          `Cannot decrypt ${file(name)} (DPAPI, current user): ${describe(error)}. It was written by another Windows user or its key is unavailable; replace it with 'crot-mcp secrets rotate ${name}'.`,
        );
      }
      return plain.toString("utf8");
    },
    set: async (name, value) => {
      await privateFiles.ensureDirectory(stateDir);
      await privateFiles.ensureDirectory(dir);
      const blob = dpapi.protect(Buffer.from(value, "utf8"), entropyOf(name));
      await writePrivateFileAtomic(file(name), `${blob.toString("base64")}\n`, privateFiles);
    },
    delete: (name) => removeFile(file(name)),
  };
}
