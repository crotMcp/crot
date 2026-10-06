/**
 * Secret backends of the CROT service (WP-21): owner-only files, the macOS
 * Keychain and the Linux Secret Service. Windows DPAPI is in dpapi.ts.
 *
 * Every backend keeps the secrets of one CROT state directory apart from the
 * secrets of other state directories (other CROT installations or test runs
 * of the same user) through a key derived from the state directory path.
 */
import { createHash, randomBytes } from "node:crypto";
import { access, constants, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { CrotError } from "../../core/errors.js";
import type { PrivateFileProtection } from "../../core/platform/types.js";
import { runSecretTool, toolDiagnostic, type SecretToolRunner, type ToolResult } from "./tool.js";
import type { SecretBackend, SecretName } from "./types.js";

/** Stable key of a state directory in shared OS stores (16 hex digits of SHA-256 of its absolute path). */
export function stateKey(stateDir: string): string {
  return createHash("sha256").update(path.resolve(stateDir), "utf8").digest("hex").slice(0, 16);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Write `content` to `file` atomically through a private temporary file: it
 * is created owner-only (mode 0600; on platforms that restrict files after
 * creation it is restricted while still empty), filled and renamed over the
 * target. Readers never see a partial value. Failure to restrict is an error,
 * never a silent downgrade.
 */
export async function writePrivateFileAtomic(
  file: string,
  content: string,
  privateFiles: PrivateFileProtection,
): Promise<void> {
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  const mode = privateFiles.fileMode !== undefined ? { mode: privateFiles.fileMode } : {};
  try {
    if (privateFiles.protectFile) {
      await writeFile(tmp, "", { flag: "wx", ...mode });
      await privateFiles.protectFile(tmp);
      await writeFile(tmp, content, { encoding: "utf8", flag: "r+" });
    } else {
      await writeFile(tmp, content, { encoding: "utf8", flag: "wx", ...mode });
    }
    // Windows: a reader holding the target open makes the replacement fail briefly.
    for (let attempt = 0; ; attempt++) {
      try {
        await rename(tmp, file);
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (attempt >= 20 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw error;
        await sleep(50);
      }
    }
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Remove a file; retries briefly where Windows reports a file in use. Missing files are fine. */
export async function removeFile(file: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rm(file, { force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 20 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw error;
      await sleep(50);
    }
  }
}

/** Read a one-line secret file; undefined when it does not exist (or is empty). */
export async function readSecretFile(file: string): Promise<string | undefined> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new CrotError("CONFIG_ERROR", `Cannot read ${file}: ${(error as Error).message}`);
  }
  const value = text.trim();
  return value === "" ? undefined : value;
}

/** File of a secret in the file backend (the pre-WP-21 locations, so existing installations keep working). */
export function secretFile(stateDir: string, name: SecretName): string {
  return path.join(stateDir, name);
}

/**
 * Owner-only files in the state directory: mode 0600 in a 0700 directory on
 * macOS/Linux; on Windows an owner-only ACL where the platform restricts
 * files (Native Host), otherwise the ACL of the per-user state directory.
 * This is the documented fallback where no OS secure storage is available.
 */
export function createFileBackend(stateDir: string, privateFiles: PrivateFileProtection): SecretBackend {
  const files = (["service-token", "control-token", "browser-token", "http-token"] as const).map((n) =>
    secretFile(stateDir, n),
  );
  return {
    id: "file",
    description: `owner-only files in ${stateDir}`,
    paths: files,
    get: (name) => readSecretFile(secretFile(stateDir, name)),
    set: async (name, value) => {
      await privateFiles.ensureDirectory(stateDir);
      await writePrivateFileAtomic(secretFile(stateDir, name), `${value}\n`, privateFiles);
    },
    delete: (name) => removeFile(secretFile(stateDir, name)),
  };
}

// ---- macOS Keychain ---------------------------------------------------------------------------

export const SECURITY_TOOL = "/usr/bin/security";
/** `security` exits with 44 when an item is not found. */
const ERR_SEC_ITEM_NOT_FOUND = 44;

export interface KeychainOptions {
  /** Keychain file; default: the user's default keychain (normally the login keychain). Tests use a temporary keychain. */
  readonly keychain?: string;
  readonly run?: SecretToolRunner;
  readonly tool?: string;
}

/**
 * macOS Keychain generic passwords (service "crot-mcp:<state key>", account =
 * secret name), through /usr/bin/security. Values are written in its
 * interactive mode (`security -i`, command on stdin, value hex-encoded with
 * -X), so they never appear in an argument vector. The items' access control
 * list trusts /usr/bin/security, so CROT reads them without a prompt.
 */
export function createKeychainBackend(stateDir: string, options: KeychainOptions = {}): SecretBackend {
  const run = options.run ?? runSecretTool;
  const tool = options.tool ?? SECURITY_TOOL;
  const service = `crot-mcp:${stateKey(stateDir)}`;
  const keychain = options.keychain;
  if (keychain !== undefined && !/^[^"\\\r\n]+$/.test(keychain))
    throw new CrotError("CONFIG_ERROR", `Unsupported keychain path: ${keychain}`);
  const trailing = keychain !== undefined ? [keychain] : [];
  const fail = (what: string, result: ToolResult) =>
    new CrotError("OPERATION_FAILED", `macOS Keychain: cannot ${what}: ${toolDiagnostic(result, "security")}`);
  return {
    id: "keychain",
    description: keychain !== undefined ? `macOS Keychain (${keychain})` : "macOS Keychain (default keychain)",
    paths: [],
    get: async (name) => {
      const result = await run(tool, ["find-generic-password", "-s", service, "-a", name, "-w", ...trailing]);
      if (result.code === ERR_SEC_ITEM_NOT_FOUND) return undefined;
      if (result.code !== 0) throw fail(`read ${name}`, result);
      const value = result.stdout.replace(/\r?\n$/, "");
      return value === "" ? undefined : value;
    },
    set: async (name, value) => {
      const hex = Buffer.from(value, "utf8").toString("hex");
      const target = keychain !== undefined ? ` "${keychain}"` : "";
      const input = `add-generic-password -U -s ${service} -a ${name} -l "CROT ${name}" -X ${hex}${target}\n`;
      const result = await run(tool, ["-i"], { input });
      // `security -i` reports failures of a command on stderr and may still exit 0.
      if (result.code !== 0 || result.stderr.trim() !== "") throw fail(`store ${name}`, result);
    },
    delete: async (name) => {
      const result = await run(tool, ["delete-generic-password", "-s", service, "-a", name, ...trailing]);
      if (result.code !== 0 && result.code !== ERR_SEC_ITEM_NOT_FOUND) throw fail(`remove ${name}`, result);
    },
  };
}

// ---- Linux Secret Service (libsecret) ---------------------------------------------------------

export interface LibsecretOptions {
  /** Absolute path of secret-tool. */
  readonly tool: string;
  readonly run?: SecretToolRunner;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/** Find secret-tool on PATH (absolute path) or undefined. */
export async function findExecutable(
  name: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<string | undefined> {
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, name);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // next
    }
  }
  return undefined;
}

/**
 * Secret Service items (GNOME Keyring, KWallet, KeePassXC) with the
 * attributes application=crot-mcp, crot-state=<state key>, crot-secret=<name>,
 * through secret-tool (libsecret). Values go through stdin and stdout only.
 */
export function createLibsecretBackend(stateDir: string, options: LibsecretOptions): SecretBackend {
  const run = options.run ?? runSecretTool;
  const key = stateKey(stateDir);
  const attributes = (name: SecretName) => ["application", "crot-mcp", "crot-state", key, "crot-secret", name];
  const env = options.env ? { env: options.env } : {};
  const fail = (what: string, result: ToolResult) =>
    new CrotError("OPERATION_FAILED", `Secret Service: cannot ${what}: ${toolDiagnostic(result, "secret-tool")}`);
  // secret-tool exits 1 without a message when nothing matches.
  const notFound = (r: ToolResult) => r.code === 1 && r.stderr.trim() === "" && r.stdout === "";
  return {
    id: "libsecret",
    description: `Secret Service (libsecret, ${options.tool})`,
    paths: [],
    get: async (name) => {
      const result = await run(options.tool, ["lookup", ...attributes(name)], env);
      if (notFound(result)) return undefined;
      if (result.code !== 0) throw fail(`read ${name}`, result);
      const value = result.stdout.replace(/\r?\n$/, "");
      return value === "" ? undefined : value;
    },
    set: async (name, value) => {
      const result = await run(options.tool, ["store", `--label=CROT ${name}`, ...attributes(name)], {
        ...env,
        input: value,
      });
      if (result.code !== 0) throw fail(`store ${name}`, result);
    },
    delete: async (name) => {
      const result = await run(options.tool, ["clear", ...attributes(name)], env);
      if (result.code !== 0 && !notFound(result)) throw fail(`remove ${name}`, result);
    },
  };
}
