/**
 * The identity environment of a CROT build (ARCHITECTURE.md §27, AD-21
 * point 1): the WorkOS AuthKit issuer, the relay host of the device resource
 * URI, and the public OAuth client the device uses to pair itself.
 *
 * AD-21 pins the relay host (and with it the issuer) in the CROT *release*
 * configuration, never in the user configuration, the relay or a request.
 * Release environments are created by WP-38 (staging) and WP-39
 * (production); until one is pinned below, a build has no release
 * environment.
 *
 * Development and tests (WP-28): a WorkOS development environment can be
 * named with the environment variable `CROT_IDENTITY_DEV_ENVIRONMENT` (path
 * to a JSON file, docs/IDENTITY.md). It is reported as a development
 * environment everywhere it is shown, it is ignored whenever a release
 * environment is pinned, and a pairing records the environment it was made
 * in: a device paired in one environment accepts no token while another is
 * active (fail closed), so changing the variable never moves an existing
 * pairing to another issuer.
 */
import { readFile } from "node:fs/promises";
import { isRelayHost } from "./device-id.js";
import { RELEASE_IDENTITY_ENVIRONMENT } from "./release-environment.js";
export { RELEASE_IDENTITY_ENVIRONMENT } from "./release-environment.js";

export const DEV_ENVIRONMENT_VARIABLE = "CROT_IDENTITY_DEV_ENVIRONMENT";
/** Largest accepted development environment file. */
const MAX_ENVIRONMENT_FILE_BYTES = 16 * 1024;

export interface IdentityEnvironment {
  /** Short name, shown to the user (e.g. "development", "staging"). */
  readonly id: string;
  /** release: pinned in this build (WP-38/WP-39); development: CROT_IDENTITY_DEV_ENVIRONMENT. */
  readonly kind: "release" | "development";
  /** The authorization server's issuer: an HTTPS origin, compared byte for byte (AD-21 point 2). */
  readonly issuer: string;
  /** The relay host of the canonical device resource URI (AD-21 point 5). */
  readonly relayHost: string;
  /** The public OAuth client the device pairs itself with (authorization code + PKCE S256). */
  readonly pairing: {
    readonly clientId: string;
    /** Port of the loopback redirect URI `http://127.0.0.1:<port>/callback`; 0 = any free port (RFC 8252). */
    readonly redirectPort: number;
    /** `scope` of the pairing request. */
    readonly scope: string;
  };
}

export type ResolvedEnvironment =
  | { readonly ok: true; readonly environment: IdentityEnvironment; readonly notes: readonly string[] }
  | { readonly ok: false; readonly reason: string; readonly notes: readonly string[] };

/** Whether `value` is an issuer this device accepts: `https://<lowercase DNS name>`, nothing else. */
export function isIssuer(value: unknown): value is string {
  if (typeof value !== "string" || !value.startsWith("https://")) return false;
  return isRelayHost(value.slice("https://".length));
}

export const isClientId = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= 512 && /^[\x21-\x7e]+$/.test(v);

/** Validate an environment description; returns the reason when it is not acceptable. */
export function validateEnvironment(value: unknown, kind: IdentityEnvironment["kind"]): IdentityEnvironment | string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "not a JSON object";
  const v = value as Record<string, unknown>;
  const allowed = ["id", "issuer", "relayHost", "pairingClientId", "pairingRedirectPort", "pairingScope"];
  const unknown = Object.keys(v).filter((k) => !allowed.includes(k));
  if (unknown.length > 0) return `unknown field(s): ${unknown.join(", ")}`;
  if (!isIssuer(v.issuer)) return "issuer must be an HTTPS origin with a lowercase host name and no port or path";
  if (!isRelayHost(v.relayHost)) return "relayHost must be a lowercase DNS name without port";
  if (!isClientId(v.pairingClientId)) return "pairingClientId must be a non-empty client id";
  const port = v.pairingRedirectPort ?? 0;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 0 || port > 65535)
    return "pairingRedirectPort must be a port number (0: any free port)";
  const scope = v.pairingScope ?? "openid";
  if (typeof scope !== "string" || !/^[\x21\x23-\x5b\x5d-\x7e]+(?: [\x21\x23-\x5b\x5d-\x7e]+)*$/.test(scope))
    return "pairingScope must be a space-separated list of scope tokens";
  const id = v.id ?? kind;
  if (typeof id !== "string" || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(id)) return "id must be a short lowercase name";
  return {
    id,
    kind,
    issuer: v.issuer,
    relayHost: v.relayHost,
    pairing: { clientId: v.pairingClientId, redirectPort: port, scope },
  };
}

/**
 * The identity environment of this process: the pinned release environment,
 * otherwise the development environment named by CROT_IDENTITY_DEV_ENVIRONMENT,
 * otherwise none (pairing and remote tokens are then unavailable).
 */
export async function resolveIdentityEnvironment(
  options: {
    readonly env?: NodeJS.ProcessEnv;
    readonly release?: IdentityEnvironment;
    readonly read?: (file: string) => Promise<string>;
  } = {},
): Promise<ResolvedEnvironment> {
  const env = options.env ?? process.env;
  const release = "release" in options ? options.release : RELEASE_IDENTITY_ENVIRONMENT;
  const file = env[DEV_ENVIRONMENT_VARIABLE];
  if (release) {
    const notes = file ? [`${DEV_ENVIRONMENT_VARIABLE} is ignored: this build pins the ${release.id} environment`] : [];
    return { ok: true, environment: release, notes };
  }
  if (!file)
    return {
      ok: false,
      reason:
        "This build has no identity environment: staging is configured by WP-38 and production by WP-39. " +
        `For development, name a WorkOS development environment with ${DEV_ENVIRONMENT_VARIABLE} (docs/IDENTITY.md).`,
      notes: [],
    };
  let text: string;
  try {
    text = await (options.read ?? ((f) => readFile(f, "utf8")))(file);
  } catch (error) {
    return {
      ok: false,
      reason: `${DEV_ENVIRONMENT_VARIABLE}: cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`,
      notes: [],
    };
  }
  if (Buffer.byteLength(text, "utf8") > MAX_ENVIRONMENT_FILE_BYTES)
    return { ok: false, reason: `${DEV_ENVIRONMENT_VARIABLE}: ${file} is too large`, notes: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: `${DEV_ENVIRONMENT_VARIABLE}: ${file} is not valid JSON`, notes: [] };
  }
  const environment = validateEnvironment(parsed, "development");
  if (typeof environment === "string")
    return { ok: false, reason: `${DEV_ENVIRONMENT_VARIABLE}: ${file}: ${environment}`, notes: [] };
  return {
    ok: true,
    environment,
    notes: [`development environment '${environment.id}' (${environment.issuer}); not a release environment`],
  };
}
