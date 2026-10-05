/**
 * Environment fingerprint of a shim and of the service (WP-20, AD-17 point 5).
 *
 * All stdio clients of a user share one service, and the service has one
 * process environment: the supervisor's (managed) or that of the shim that
 * started it (on demand). The CROT configuration never depends on it (the
 * configuration digest covers the configuration file, the flags and every
 * path, all resolved before the digest), but a few variables are inputs of the
 * platform layer: the startup PATH and shell detection (PATH, SHELL; on
 * Windows Path, PATHEXT, ComSpec) and the home directory. When a client's
 * values differ from the service's, the client is told on stderr instead of
 * silently getting another environment. Only SHA-256 digests of the values
 * are exchanged, never the values.
 */
import { createHash } from "node:crypto";

const POSIX_VARIABLES = ["PATH", "SHELL", "HOME"] as const;
const WINDOWS_VARIABLES = ["PATH", "PATHEXT", "COMSPEC", "USERPROFILE"] as const;

/** Digest of each platform-relevant variable (names upper-case; "-" when unset). */
export function environmentFingerprint(
  env: Readonly<Record<string, string | undefined>> = process.env,
  windows = process.platform === "win32",
): Record<string, string> {
  const lookup = (name: string): string | undefined => {
    if (!windows) return env[name];
    // Windows variable names are case-insensitive.
    for (const [key, value] of Object.entries(env)) if (key.toUpperCase() === name) return value;
    return undefined;
  };
  const out: Record<string, string> = {};
  for (const name of windows ? WINDOWS_VARIABLES : POSIX_VARIABLES) {
    const value = lookup(name);
    out[name] = value === undefined ? "-" : createHash("sha256").update(value, "utf8").digest("hex");
  }
  return out;
}

/** Names of the variables whose digests differ (only names both sides report). */
export function environmentDifferences(
  service: Readonly<Record<string, string>>,
  client: Readonly<Record<string, string>> | undefined,
): string[] {
  if (!client) return [];
  return Object.keys(service).filter((name) => name in client && client[name] !== service[name]);
}

/** Valid wire form: at most 16 names, each mapped to a digest or "-". */
export function parseEnvironmentFingerprint(value: unknown): Record<string, string> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 16) return undefined;
  const out: Record<string, string> = {};
  for (const [name, digest] of entries) {
    if (!/^[A-Z_][A-Z0-9_]{0,63}$/.test(name)) return undefined;
    if (typeof digest !== "string" || !(digest === "-" || /^[0-9a-f]{64}$/.test(digest))) return undefined;
    out[name] = digest;
  }
  return out;
}
