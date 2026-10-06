/**
 * `crot-mcp secrets status | show http-token | rotate` (WP-21, AD-18).
 *
 * - status: the backend and location of the secrets, which secrets exist and
 *   any plaintext leftover; never a value.
 * - show http-token: prints the HTTP access token, the only secret a user
 *   needs outside CROT (to configure an HTTP client). The channel and bridge
 *   credentials are never shown.
 * - rotate: replaces secrets with new random values. Only while the service
 *   is stopped (it holds the current values and derives endpoints from them),
 *   under the secrets lock (a service starting meanwhile waits).
 */
import { stat } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_HTTP_TOKEN_FILE_NAME } from "../adapters/http/auth.js";
import { expandHome } from "../core/config/paths.js";
import { HttpAuthConfigSchema, type CrotConfigInput } from "../core/config/schema.js";
import { CrotError } from "../core/errors.js";
import type { PrivateFileProtection } from "../core/platform/types.js";
import { ControlClient } from "../service/control-client.js";
import { isListening, secretCredentialStore, serviceEndpoint } from "../service/endpoints.js";
import { readSecretFile, secretFile, writePrivateFileAtomic } from "../service/secrets/backends.js";
import {
  generateSecret,
  openSecretStore,
  readSecretsMarker,
  withSecretsLock,
  type SecretStoreHost,
} from "../service/secrets/store.js";
import { SECRET_NAMES, type SecretName } from "../service/secrets/types.js";

export interface SecretsCliOptions {
  readonly stateDir: string;
  readonly privateFiles: PrivateFileProtection;
  readonly config?: CrotConfigInput;
  readonly host?: SecretStoreHost;
  readonly windows?: boolean;
}

interface HttpTokenSettings {
  readonly storage: "secret-store" | "token-file";
  /** Plaintext token file: the storage (token-file) or a legacy file still to be migrated. */
  readonly file?: string;
}

function httpSettings(options: SecretsCliOptions): HttpTokenSettings {
  const http = (options.config as { http?: { auth?: unknown } } | undefined)?.http;
  const parsed = HttpAuthConfigSchema.safeParse(http?.auth ?? {});
  if (!parsed.success) throw new CrotError("CONFIG_ERROR", `Invalid http.auth configuration: ${parsed.error.message}`);
  const auth = parsed.data;
  const configured = auth.tokenFile !== undefined ? path.resolve(expandHome(auth.tokenFile)) : undefined;
  if (auth.storage === "token-file")
    return {
      storage: "token-file",
      file: configured ?? path.join(options.stateDir, DEFAULT_HTTP_TOKEN_FILE_NAME),
    };
  return { storage: "secret-store", ...(configured ? { file: configured } : {}) };
}

const exists = async (file: string) => (await stat(file).catch(() => undefined)) !== undefined;

/** Whether a CROT service of this state directory is running. */
async function serviceRunning(options: SecretsCliOptions): Promise<boolean> {
  const client = await ControlClient.connect({
    stateDir: options.stateDir,
    privateFiles: options.privateFiles,
    ...(options.windows !== undefined ? { windows: options.windows } : {}),
    ...(options.host
      ? { credentials: secretCredentialStore(options.stateDir, options.privateFiles, { host: options.host }) }
      : {}),
  }).catch(() => undefined);
  if (client) {
    client.close();
    return true;
  }
  const credential = await secretCredentialStore(options.stateDir, options.privateFiles, {
    ...(options.host ? { host: options.host } : {}),
  })
    .read("service")
    .catch(() => undefined);
  if (credential === undefined) return false;
  return isListening(serviceEndpoint(options.stateDir, "service", credential, options.windows).path);
}

export async function secretsStatus(options: SecretsCliOptions): Promise<string> {
  const { stateDir, privateFiles } = options;
  const marker = await readSecretsMarker(stateDir);
  const store = await openSecretStore(stateDir, privateFiles, options.host);
  const lines = [
    `secret store: ${store.backend.id} — ${store.backend.description}${marker ? "" : " (not set up yet: chosen at the next service start)"}`,
  ];
  if (marker?.fallbackReason) lines.push(`  OS secure storage was unavailable at setup: ${marker.fallbackReason}`);
  for (const name of SECRET_NAMES) {
    let state: string;
    try {
      state = (await store.read(name)) !== undefined ? "present" : "not created";
    } catch (error) {
      state = `error: ${(error as Error).message}`;
    }
    lines.push(`  ${name}: ${state}`);
  }
  if (store.backend.id !== "file") {
    for (const name of SECRET_NAMES) {
      const file = secretFile(stateDir, name);
      if (await exists(file))
        lines.push(`warning: plaintext ${name} file ${file} (migrated and removed at the next service start)`);
    }
  }
  const http = httpSettings(options);
  if (http.storage === "token-file") {
    lines.push(
      `http token: plaintext file ${http.file!} (http.auth.storage "token-file", compatibility mode)${(await exists(http.file!)) ? "" : " — not created yet"}`,
    );
  } else {
    lines.push("http token: secret store");
    if (http.file && (await exists(http.file)))
      lines.push(
        `warning: http.auth.tokenFile ${http.file} still exists (migrated and removed at the next service start)`,
      );
  }
  return lines.join("\n") + "\n";
}

/** The HTTP access token; CONFIG_ERROR when none exists yet. */
export async function showHttpToken(options: SecretsCliOptions): Promise<{ token: string; note?: string }> {
  const http = httpSettings(options);
  if (http.storage === "token-file") {
    const token = await readSecretFile(http.file!);
    if (token === undefined)
      throw new CrotError(
        "CONFIG_ERROR",
        `No HTTP access token yet: ${http.file!} does not exist. Start CROT with HTTP enabled once.`,
      );
    return { token, note: `read from the plaintext token file ${http.file!} (compatibility mode)` };
  }
  const store = await openSecretStore(options.stateDir, options.privateFiles, options.host);
  const stored = await store.read("http-token");
  if (stored !== undefined) return { token: stored };
  const legacy = http.file ?? secretFile(options.stateDir, "http-token");
  const pending = await readSecretFile(legacy).catch(() => undefined);
  if (pending !== undefined)
    return { token: pending, note: `read from ${legacy}; it moves into the secret store at the next service start` };
  throw new CrotError(
    "CONFIG_ERROR",
    `No HTTP access token yet in ${store.backend.description}. Start CROT with HTTP enabled once; it creates the token.`,
  );
}

export async function rotateSecrets(options: SecretsCliOptions, names: readonly SecretName[]): Promise<string> {
  const { stateDir, privateFiles } = options;
  const refuse = () =>
    new CrotError(
      "OPERATION_FAILED",
      "The CROT service is running; stop it first ('crot-mcp service stop'), then rotate. It holds the current secrets.",
    );
  if (await serviceRunning(options)) throw refuse();
  await privateFiles.ensureDirectory(stateDir);
  const http = httpSettings(options);
  return withSecretsLock(stateDir, async () => {
    if (await serviceRunning(options)) throw refuse();
    const store = await openSecretStore(stateDir, privateFiles, options.host);
    const lines: string[] = [];
    for (const name of names) {
      if (name === "http-token" && http.storage === "token-file") {
        await writePrivateFileAtomic(http.file!, `${generateSecret()}\n`, privateFiles);
        lines.push(`rotated ${name} in the plaintext token file ${http.file!} (compatibility mode)`);
        continue;
      }
      await store.write(name, generateSecret());
      lines.push(`rotated ${name} in ${store.backend.description}`);
    }
    if (names.includes("http-token")) lines.push("HTTP clients need the new token: crot-mcp secrets show http-token");
    if (names.includes("browser-token"))
      lines.push(
        "the browser relay picks up the new bridge token at its next start (reload the CROT Browser Extension)",
      );
    return lines.join("\n") + "\n";
  });
}
