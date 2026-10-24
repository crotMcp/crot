/**
 * The secret store of the CROT service (WP-21, ARCHITECTURE.md §27 AD-18).
 *
 * One backend per state directory, chosen once by the service and recorded in
 * the non-secret marker <state>/secrets.json (protected from modification
 * through CROT tools). Readers (the stdio shim, the control client, the
 * browser relay) follow the marker; without a marker the secrets are in the
 * owner-only files of the state directory (the layout of earlier versions).
 *
 * Choice (`secrets.store`): auto (default) keeps the recorded backend, or on
 * first use probes the OS secure storage (macOS Keychain, Windows DPAPI,
 * Secret Service) and falls back to owner-only files when it is unavailable;
 * os requires OS secure storage; file uses owner-only files. A backend that
 * fails later is an error, never a silent switch to another backend.
 *
 * Migration (service start, under the secrets lock): when the chosen backend
 * differs from the recorded one, every secret is copied, read back and
 * compared, the marker is switched, and only then is the old copy removed.
 * Plaintext files of earlier versions (and a configured http.auth.tokenFile)
 * found next to an OS store are imported the same way and deleted. Conflicting
 * values, a failed read-back or a file that cannot be removed stop the service
 * with a message naming the file; nothing falls back to plaintext.
 */
import { randomBytes } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { CrotError } from "../../core/errors.js";
import type { PrivateFileProtection } from "../../core/platform/types.js";
import { acquireDirectoryLock, refreshDirectoryLock, releaseDirectoryLock } from "../locks.js";
import {
  createFileBackend,
  createKeychainBackend,
  createLibsecretBackend,
  findExecutable,
  readSecretFile,
  removeFile,
  secretFile,
  SECURITY_TOOL,
  writePrivateFileAtomic,
} from "./backends.js";
import { createDpapiBackend, dpapiDirectory, loadDpapi, type Dpapi } from "./dpapi.js";
import type { SecretToolRunner } from "./tool.js";
import {
  invalidSecret,
  isValidSecret,
  SECRET_BACKENDS,
  SECRET_NAMES,
  type SecretBackend,
  type SecretBackendId,
  type SecretName,
  type SecretStorePreference,
} from "./types.js";

export const SECRETS_MARKER_FILE_NAME = "secrets.json";
export const SECRETS_LOCK_NAME = "secrets.lock";
const MARKER_VERSION = 1;
const LOCK_WAIT_MS = 30_000;
const LOCK_REFRESH_MS = 2_000;
const PROBE_TIMEOUT_MS = 5_000;

/** The non-secret record of the chosen backend. */
export interface SecretsMarker {
  readonly version: 1;
  readonly backend: SecretBackendId;
  /** keychain: the keychain file, when not the default keychain (tests). */
  readonly keychain?: string;
  /** Why OS secure storage is not used (backend "file" chosen by auto). */
  readonly fallbackReason?: string;
}

/** Test seams and platform inputs of the store. */
export interface SecretStoreHost {
  readonly platform?: NodeJS.Platform;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly run?: SecretToolRunner;
  readonly loadDpapi?: () => Promise<Dpapi>;
  /** macOS: keychain file to use instead of the default keychain (recorded in the marker). */
  readonly keychain?: string;
  /** Linux: secret-tool to use instead of the one on PATH. */
  readonly secretTool?: string;
}

export function secretsMarkerFile(stateDir: string): string {
  return path.join(stateDir, SECRETS_MARKER_FILE_NAME);
}

export async function readSecretsMarker(stateDir: string): Promise<SecretsMarker | undefined> {
  const file = secretsMarkerFile(stateDir);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new CrotError("CONFIG_ERROR", `Cannot read ${file}: ${(error as Error).message}`);
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = undefined;
  }
  const marker = data as Partial<SecretsMarker> | undefined;
  if (
    !marker ||
    typeof marker !== "object" ||
    marker.version !== MARKER_VERSION ||
    !(SECRET_BACKENDS as readonly unknown[]).includes(marker.backend) ||
    (marker.keychain !== undefined && typeof marker.keychain !== "string")
  ) {
    throw new CrotError(
      "CONFIG_ERROR",
      `${file} is not a valid CROT secret store record. Restore it, or remove it together with the secrets of this state directory.`,
    );
  }
  return marker as SecretsMarker;
}

async function writeSecretsMarker(
  stateDir: string,
  marker: SecretsMarker,
  privateFiles: PrivateFileProtection,
): Promise<void> {
  await writePrivateFileAtomic(secretsMarkerFile(stateDir), `${JSON.stringify(marker, null, 2)}\n`, privateFiles);
}

/** A new random secret: 256 bits, base64url. */
export function generateSecret(): string {
  return randomBytes(32).toString("base64url");
}

/** Secrets of one state directory in one backend. Values are validated on every read. */
export class SecretStore {
  constructor(
    readonly stateDir: string,
    readonly backend: SecretBackend,
  ) {}

  async read(name: SecretName): Promise<string | undefined> {
    const value = await this.backend.get(name);
    if (value === undefined) return undefined;
    if (!isValidSecret(name, value)) throw invalidSecret(name, this.backend.description);
    return value;
  }

  /** Store a value and verify it by reading it back. */
  async write(name: SecretName, value: string): Promise<void> {
    if (!isValidSecret(name, value)) throw new CrotError("INVALID_INPUT", `Not a valid value for ${name}.`);
    await this.backend.set(name, value);
    const back = await this.backend.get(name);
    if (back !== value)
      throw new CrotError(
        "OPERATION_FAILED",
        `${name} could not be verified in ${this.backend.description} after writing it.`,
      );
  }

  /** Read a secret, creating a new random one when none exists (service side). */
  async readOrCreate(name: SecretName): Promise<string> {
    const existing = await this.read(name);
    if (existing !== undefined) return existing;
    const value = generateSecret();
    await this.write(name, value);
    return value;
  }
}

/**
 * Paths that may hold secret material in a state directory: the owner-only
 * files (current file backend and earlier versions) and the DPAPI directory.
 * CROT tools may not read or modify them in any mode.
 */
export function stateSecretPaths(stateDir: string): string[] {
  return [
    ...SECRET_NAMES.map((n) => secretFile(stateDir, n)),
    dpapiDirectory(stateDir),
    path.join(stateDir, "product-vault.enc"),
    path.join(stateDir, "product-state.json"),
    path.join(stateDir, "client-tokens.json"),
  ];
}

/** Non-secret files of the store that CROT tools may not modify. */
export function secretStoreProtectedPaths(stateDir: string): string[] {
  return [secretsMarkerFile(stateDir), path.join(stateDir, SECRETS_LOCK_NAME)];
}

const describe = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).split(/\r?\n/)[0]!.slice(0, 300);

/** The backend recorded in the marker (or the file backend without a marker). */
async function backendFor(
  id: SecretBackendId,
  marker: SecretsMarker | undefined,
  stateDir: string,
  privateFiles: PrivateFileProtection,
  host: SecretStoreHost,
): Promise<SecretBackend> {
  switch (id) {
    case "file":
      return createFileBackend(stateDir, privateFiles);
    case "keychain":
      return createKeychainBackend(stateDir, {
        ...(marker?.keychain !== undefined ? { keychain: marker.keychain } : {}),
        ...(host.run ? { run: host.run } : {}),
      });
    case "libsecret": {
      const tool = host.secretTool ?? (await findExecutable("secret-tool", host.env ?? process.env));
      if (!tool)
        throw new CrotError(
          "CONFIG_ERROR",
          "The CROT secrets of this state directory are in the Secret Service, but secret-tool (libsecret-tools) is not on PATH.",
        );
      return createLibsecretBackend(stateDir, {
        tool,
        ...(host.run ? { run: host.run } : {}),
        ...(host.env ? { env: host.env } : {}),
      });
    }
    case "dpapi": {
      let dpapi: Dpapi;
      try {
        dpapi = await (host.loadDpapi ?? loadDpapi)();
      } catch (error) {
        throw new CrotError(
          "CONFIG_ERROR",
          `The CROT secrets of this state directory are protected with Windows DPAPI, which is not usable here: ${describe(error)}`,
        );
      }
      return createDpapiBackend(stateDir, privateFiles, dpapi);
    }
  }
}

/** Open the store of a state directory for reading (shim, control client, browser relay, CLI). */
export async function openSecretStore(
  stateDir: string,
  privateFiles: PrivateFileProtection,
  host: SecretStoreHost = {},
): Promise<SecretStore> {
  const marker = await readSecretsMarker(stateDir);
  return new SecretStore(stateDir, await backendFor(marker?.backend ?? "file", marker, stateDir, privateFiles, host));
}

/** Store, read back and remove a probe value. */
async function roundTrip(backend: SecretBackend): Promise<void> {
  // The probe uses the slot of a real secret only when that slot is empty, and leaves it empty.
  const slot: SecretName = "http-token";
  const value = generateSecret();
  const existing = await backend.get(slot);
  if (existing !== undefined) return; // readable and holding data: usable
  try {
    await backend.set(slot, value);
    if ((await backend.get(slot)) !== value) throw new Error("the stored probe value did not read back");
  } finally {
    await backend.delete(slot).catch(() => undefined);
  }
}

const withTimeout = <T>(promise: Promise<T>, ms: number, what: string): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} did not answer within ${ms} ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });

/**
 * The OS secure storage of this platform, verified with a round trip, or the
 * reason why it is not available.
 */
export async function probeOsBackend(
  stateDir: string,
  privateFiles: PrivateFileProtection,
  host: SecretStoreHost = {},
): Promise<{ backend: SecretBackend; marker: SecretsMarker } | { reason: string }> {
  const platform = host.platform ?? process.platform;
  const env = host.env ?? process.env;
  try {
    if (platform === "darwin") {
      if (!host.run && !(await stat(SECURITY_TOOL).catch(() => undefined)))
        return { reason: `${SECURITY_TOOL} not found` };
      const marker: SecretsMarker = {
        version: 1,
        backend: "keychain",
        ...(host.keychain !== undefined ? { keychain: host.keychain } : {}),
      };
      const backend = await backendFor("keychain", marker, stateDir, privateFiles, host);
      await withTimeout(roundTrip(backend), PROBE_TIMEOUT_MS * 2, "the macOS Keychain");
      return { backend, marker };
    }
    if (platform === "win32") {
      const backend = await backendFor("dpapi", undefined, stateDir, privateFiles, host);
      return { backend, marker: { version: 1, backend: "dpapi" } };
    }
    if (platform === "linux" || platform === "freebsd" || platform === "openbsd") {
      const tool = host.secretTool ?? (await findExecutable("secret-tool", env));
      if (!tool) return { reason: "secret-tool (libsecret) is not installed" };
      const bus =
        env.DBUS_SESSION_BUS_ADDRESS !== undefined ||
        (env.XDG_RUNTIME_DIR !== undefined &&
          (await stat(path.join(env.XDG_RUNTIME_DIR, "bus")).catch(() => undefined)) !== undefined);
      if (!bus) return { reason: "no D-Bus session (Secret Service unreachable)" };
      const backend = await backendFor("libsecret", undefined, stateDir, privateFiles, { ...host, secretTool: tool });
      await withTimeout(roundTrip(backend), PROBE_TIMEOUT_MS * 3, "the Secret Service");
      return { backend, marker: { version: 1, backend: "libsecret" } };
    }
    return { reason: `no OS secure storage is supported on ${platform}` };
  } catch (error) {
    return { reason: describe(error) };
  }
}

/** Take the secrets lock of a state directory (waits for a concurrent holder). */
export async function withSecretsLock<T>(stateDir: string, action: () => Promise<T>): Promise<T> {
  const lock = path.join(stateDir, SECRETS_LOCK_NAME);
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (!(await acquireDirectoryLock(lock))) {
    if (Date.now() > deadline)
      throw new CrotError(
        "OPERATION_FAILED",
        `The CROT secret store is locked by another process (${lock}); retry, or remove the directory if no CROT process is running.`,
      );
    await new Promise((r) => setTimeout(r, 100));
  }
  const heartbeat = setInterval(() => void refreshDirectoryLock(lock), LOCK_REFRESH_MS);
  heartbeat.unref();
  try {
    return await action();
  } finally {
    clearInterval(heartbeat);
    await releaseDirectoryLock(lock);
  }
}

/** How the HTTP token is kept (http.auth). */
export interface HttpTokenSource {
  /**
   * secret-store: the token is in the secret store; a configured `file` is a
   * legacy file to migrate. token-file: compatibility mode, `file` is used as
   * the plaintext storage and left alone.
   */
  readonly storage: "secret-store" | "token-file";
  /** Configured http.auth.tokenFile (absolute), if any. */
  readonly file?: string;
}

export interface PrepareSecretStoreOptions {
  readonly stateDir: string;
  readonly privateFiles: PrivateFileProtection;
  readonly preference: SecretStorePreference;
  readonly httpToken?: HttpTokenSource;
  /** Diagnostics; receives names and paths only, never values. */
  readonly log?: (message: string) => void;
  readonly host?: SecretStoreHost;
}

export interface SecretStoreInfo {
  readonly backend: SecretBackendId;
  readonly description: string;
  /** Why OS secure storage is not used (file backend chosen by auto). */
  readonly fallbackReason?: string;
}

export interface PreparedSecretStore {
  readonly store: SecretStore;
  readonly info: SecretStoreInfo;
}

/**
 * Service side: choose the backend, migrate secrets into it and remove
 * plaintext leftovers. Runs under the secrets lock. Throws CONFIG_ERROR with
 * a message naming the file or backend when anything cannot be completed
 * safely; the secrets are then left where they were (or in both places, never
 * in neither).
 */
export async function prepareSecretStore(options: PrepareSecretStoreOptions): Promise<PreparedSecretStore> {
  const { stateDir, privateFiles, preference } = options;
  const host = options.host ?? {};
  const log = options.log ?? (() => undefined);
  await privateFiles.ensureDirectory(stateDir);
  return withSecretsLock(stateDir, async () => {
    const marker = await readSecretsMarker(stateDir);
    const currentId = marker?.backend ?? "file";
    const current = await backendFor(currentId, marker, stateDir, privateFiles, host);

    let target = current;
    let targetMarker: SecretsMarker = marker ?? { version: 1, backend: currentId };
    if (preference === "file" && currentId !== "file") {
      target = createFileBackend(stateDir, privateFiles);
      targetMarker = { version: 1, backend: "file" };
    } else if (currentId === "file" && (preference === "os" || (preference === "auto" && marker === undefined))) {
      const probe = await probeOsBackend(stateDir, privateFiles, host);
      if ("backend" in probe) {
        target = probe.backend;
        targetMarker = probe.marker;
      } else if (preference === "os") {
        throw new CrotError(
          "CONFIG_ERROR",
          `secrets.store is "os", but no OS secure storage is usable: ${probe.reason}. Use "auto" or "file" to keep the secrets in owner-only files.`,
        );
      } else {
        targetMarker = { version: 1, backend: "file", fallbackReason: probe.reason };
        log(`note: secrets: OS secure storage unavailable (${probe.reason}); using owner-only files in ${stateDir}`);
      }
    }

    const legacyHttp =
      options.httpToken?.storage === "token-file"
        ? path.resolve(options.httpToken.file ?? secretFile(stateDir, "http-token"))
        : undefined;
    // In the token-file compatibility mode the file backend's http-token file may be the configured plaintext storage.
    const keepHttpFile = legacyHttp !== undefined && samePath(legacyHttp, secretFile(stateDir, "http-token"));
    const names = (backend: SecretBackend) =>
      SECRET_NAMES.filter((n) => !(keepHttpFile && n === "http-token" && backend.id === "file"));

    if (target.id !== current.id) {
      await migrateBackend(current, target, names(current), (m) => log(m));
      await writeSecretsMarker(stateDir, targetMarker, privateFiles);
      for (const name of names(current)) {
        try {
          await current.delete(name);
        } catch (error) {
          throw new CrotError(
            "CONFIG_ERROR",
            `The CROT secrets were moved to ${target.description}, but the old copy of ${name} in ${current.description} could not be removed: ${describe(error)}. Remove it, then start CROT again.`,
          );
        }
      }
      log(`secrets: moved from ${current.description} to ${target.description}`);
    } else if (!marker) {
      await writeSecretsMarker(stateDir, targetMarker, privateFiles);
    }

    const store = new SecretStore(stateDir, target);
    if (target.id !== "file") {
      // Plaintext files of earlier versions next to an OS store (e.g. written by an older CROT).
      for (const name of names(createFileBackend(stateDir, privateFiles))) {
        await importLegacyFile(store, name, secretFile(stateDir, name), log);
      }
    }
    const configured = options.httpToken?.file;
    if (options.httpToken?.storage !== "token-file" && configured !== undefined) {
      const file = path.resolve(configured);
      if (!(target.id === "file" && samePath(file, secretFile(stateDir, "http-token")))) {
        await importLegacyFile(store, "http-token", file, log, "http.auth.tokenFile");
      }
    }
    return {
      store,
      info: {
        backend: target.id,
        description: target.description,
        ...(targetMarker.fallbackReason ? { fallbackReason: targetMarker.fallbackReason } : {}),
      },
    };
  });
}

const samePath = (a: string, b: string) =>
  process.platform === "win32" || process.platform === "darwin"
    ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
    : path.resolve(a) === path.resolve(b);

/** Copy every secret to `target` and verify it there; on failure remove what was copied. */
async function migrateBackend(
  source: SecretBackend,
  target: SecretBackend,
  names: readonly SecretName[],
  log: (message: string) => void,
): Promise<void> {
  const copied: SecretName[] = [];
  try {
    for (const name of names) {
      const value = await source.get(name);
      if (value === undefined) continue;
      if (!isValidSecret(name, value)) throw invalidSecret(name, source.description);
      const existing = await target.get(name);
      if (existing !== undefined && existing !== value)
        throw new CrotError(
          "CONFIG_ERROR",
          `${target.description} already holds a different ${name} for this state directory.`,
        );
      if (existing === undefined) {
        await target.set(name, value);
        copied.push(name);
      }
      if ((await target.get(name)) !== value)
        throw new CrotError("OPERATION_FAILED", `${name} could not be verified in ${target.description}.`);
      log(`secrets: ${name} copied to ${target.description}`);
    }
  } catch (error) {
    for (const name of copied) await target.delete(name).catch(() => undefined);
    throw new CrotError(
      "CONFIG_ERROR",
      `Moving the CROT secrets from ${source.description} to ${target.description} failed: ${describe(error)}. Nothing was changed; the secrets remain in ${source.description}.`,
    );
  }
}

/**
 * Import a plaintext secret file into the store and delete it. Same value in
 * the store: the file is only deleted. Different value: CONFIG_ERROR (the
 * operator decides which one is current).
 */
async function importLegacyFile(
  store: SecretStore,
  name: SecretName,
  file: string,
  log: (message: string) => void,
  what = "plaintext secret file",
): Promise<void> {
  if (!(await stat(file).catch(() => undefined))) return;
  const value = await readSecretFile(file);
  if (value !== undefined) {
    if (!isValidSecret(name, value))
      throw new CrotError(
        "CONFIG_ERROR",
        `The ${what} ${file} does not contain a valid ${name}; it was not migrated. Remove it (or fix it) and start CROT again.`,
      );
    let stored: string | undefined;
    try {
      stored = await store.read(name);
      if (stored === undefined) {
        await store.write(name, value);
        stored = value;
        log(`secrets: ${name} migrated from ${file} to ${store.backend.description}`);
      }
    } catch (error) {
      throw new CrotError(
        "CONFIG_ERROR",
        `Migrating ${name} from ${file} to ${store.backend.description} failed: ${describe(error)}. The file was left unchanged.`,
      );
    }
    if (stored !== value)
      throw new CrotError(
        "CONFIG_ERROR",
        `The ${what} ${file} holds a different ${name} than ${store.backend.description}. ` +
          "CROT uses the stored value: remove the file (after updating any client that still uses its value), then start CROT again.",
      );
  }
  try {
    await removeFile(file);
  } catch (error) {
    throw new CrotError(
      "CONFIG_ERROR",
      `${name} is now in ${store.backend.description}, but the ${what} ${file} could not be removed: ${describe(error)}. Remove it, then start CROT again.`,
    );
  }
  log(`secrets: removed the plaintext file ${file}`);
}
