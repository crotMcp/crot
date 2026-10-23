/**
 * Secrets of the CROT service (WP-21, ARCHITECTURE.md §27 AD-17, AD-18).
 *
 * The service is the only owner of these secrets. They are stored in a
 * SecretBackend chosen once per state directory (OS secure storage where
 * available, owner-only files otherwise) and never reach Core, the audit log,
 * logs, the browser, child processes or outbound requests.
 */
import { CrotError } from "../../core/errors.js";

/**
 * Names of the stored secrets. `device-key` is the seed of the device
 * credential (WP-28, AD-21): created at pairing, removed at unpairing, never
 * shown and never rotated by `crot-mcp secrets rotate` (a new key needs a new
 * pairing, so the CROT cloud learns it).
 */
export const SECRET_NAMES = [
  "service-token",
  "control-token",
  "browser-token",
  "http-token",
  "device-key",
  "product-key",
] as const;
export type SecretName = (typeof SECRET_NAMES)[number];

/** Secrets `crot-mcp secrets rotate` may replace (the device key changes only by pairing). */
export const ROTATABLE_SECRET_NAMES: readonly SecretName[] = Object.freeze(
  SECRET_NAMES.filter((n) => n !== "device-key" && n !== "product-key"),
);

export function isSecretName(value: string): value is SecretName {
  return (SECRET_NAMES as readonly string[]).includes(value);
}

/**
 * keychain: macOS Keychain (generic passwords, through /usr/bin/security);
 * dpapi: Windows DPAPI (CurrentUser scope) encrypted files in <state>/secrets;
 * libsecret: Secret Service (GNOME Keyring, KWallet) through secret-tool;
 * file: owner-only files in the state directory (0600 / owner-only ACL).
 */
export const SECRET_BACKENDS = ["keychain", "dpapi", "libsecret", "file"] as const;
export type SecretBackendId = (typeof SECRET_BACKENDS)[number];

/** `secrets.store` in the configuration. */
export const SECRET_STORE_PREFERENCES = ["auto", "os", "file"] as const;
export type SecretStorePreference = (typeof SECRET_STORE_PREFERENCES)[number];

export interface SecretBackend {
  readonly id: SecretBackendId;
  /** Human-readable location, e.g. "macOS Keychain (login keychain)". Never contains a secret. */
  readonly description: string;
  /** The stored value, or undefined when there is none. */
  get(name: SecretName): Promise<string | undefined>;
  /** Store (create or replace) a value. */
  set(name: SecretName, value: string): Promise<void>;
  /** Remove a value; removing a missing value is not an error. */
  delete(name: SecretName): Promise<void>;
  /** Files or directories holding this backend's secret material (empty for keychains). */
  readonly paths: readonly string[];
}

/** Every generated secret: 256 random bits, base64url. */
const GENERATED = /^[A-Za-z0-9_-]{43,256}$/;
/** An HTTP token migrated from a legacy token file may be any printable token of at least 32 characters. */
const HTTP_TOKEN = /^[\x21-\x7e]{32,1024}$/;

/** Whether a stored value is acceptable for `name`. */
export function isValidSecret(name: SecretName, value: string): boolean {
  if (name === "http-token") return HTTP_TOKEN.test(value);
  if (name === "browser-token") return /^[A-Za-z0-9_-]{32,256}$/.test(value);
  // An Ed25519 seed: exactly 32 bytes, base64url.
  if (name === "device-key") return /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(value);
  return GENERATED.test(value);
}

export function invalidSecret(name: SecretName, where: string): CrotError {
  return new CrotError(
    "CONFIG_ERROR",
    `The CROT ${name} in ${where} is not valid; replace it with 'crot-mcp secrets rotate ${name}' (with the service stopped).`,
  );
}
