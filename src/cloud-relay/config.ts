/**
 * Cloud Relay configuration (WP-29). A JSON file read by
 * `crot-cloud-relay --config <file>`; deployment environments are WP-38
 * (staging) and WP-39 (production).
 */
import { versionAtLeast } from "./versions.js";
import { relayLimits, type RelayLimits } from "./limits.js";
import { isRelayHost } from "../identity/device-id.js";
import { isClientId, isIssuer } from "../identity/environment.js";
import { DEFAULT_EXCHANGE_DEADLINE_MS, MIN_EXCHANGE_DEADLINE_MS } from "../tunnel/protocol.js";

export interface RelayConfig {
  readonly artifactDirectory?: string;
  readonly relayHost: string;
  readonly limits: RelayLimits;
  readonly issuer: string;
  /** `client_id` of the environment's pairing client; only its tokens register devices (AD-22 point 4). */
  readonly pairingClientId: string;
  readonly environment: string;
  readonly host: string;
  readonly port: number;
  readonly registryFile: string;
  readonly accountFile: string;
  readonly portalClientIds: readonly string[];
  readonly minimumDeviceVersion?: string;
  readonly minimumClientVersion?: string;
  readonly billing?: {
    secretKeyFile: string;
    webhookSecretFile: string;
    prices: { pro: string; team: string };
    returnUrl: string;
  };
  readonly workosSecretFile?: string;
  readonly metricsTokenFile?: string;
  readonly tls?: { readonly certFile: string; readonly keyFile: string };
  readonly exchangeDeadlineMs: number;
}

const FIELDS = [
  "artifactDirectory",
  "accountFile",
  "portalClientIds",
  "billing",
  "workosSecretFile",
  "metricsTokenFile",
  "minimumDeviceVersion",
  "minimumClientVersion",
  "limits",
  "relayHost",
  "issuer",
  "pairingClientId",
  "environment",
  "host",
  "port",
  "registryFile",
  "tls",
  "exchangeDeadlineMs",
];

/** Validate a configuration object; throws with the first problem. */
export function parseRelayConfig(value: unknown): RelayConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("not a JSON object");
  const v = value as Record<string, unknown>;
  const unknown = Object.keys(v).filter((k) => !FIELDS.includes(k));
  if (unknown.length > 0) throw new Error(`unknown field(s): ${unknown.join(", ")}`);
  if (!isRelayHost(v.relayHost)) throw new Error("relayHost must be a lowercase DNS name without port");
  if (!isIssuer(v.issuer)) throw new Error("issuer must be an HTTPS origin");
  if (!isClientId(v.pairingClientId)) throw new Error("pairingClientId must be a non-empty client id without spaces");
  const environment = v.environment ?? "development";
  if (typeof environment !== "string" || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(environment))
    throw new Error("environment must be a short lowercase name");
  const host = v.host ?? "0.0.0.0";
  if (typeof host !== "string" || host.length === 0) throw new Error("host must be an address");
  const port = v.port ?? 8443;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error("port is invalid");
  if (typeof v.registryFile !== "string" || v.registryFile.length === 0) throw new Error("registryFile is required");
  let tls: RelayConfig["tls"];
  if (v.tls !== undefined) {
    const t = v.tls as Record<string, unknown>;
    if (typeof t !== "object" || t === null || typeof t.certFile !== "string" || typeof t.keyFile !== "string")
      throw new Error("tls must name certFile and keyFile");
    tls = { certFile: t.certFile, keyFile: t.keyFile };
  }
  const deadline = v.exchangeDeadlineMs ?? DEFAULT_EXCHANGE_DEADLINE_MS;
  if (
    typeof deadline !== "number" ||
    !Number.isInteger(deadline) ||
    deadline < MIN_EXCHANGE_DEADLINE_MS ||
    deadline > DEFAULT_EXCHANGE_DEADLINE_MS
  )
    throw new Error("exchangeDeadlineMs must be between 60000 and 900000 (AD-22 point 12)");
  const accountFile = v.accountFile ?? `${v.registryFile}.accounts`;
  if (typeof accountFile !== "string" || !accountFile || accountFile === v.registryFile)
    throw new Error("accountFile must be a distinct file");
  const portalClientIds = v.portalClientIds ?? [];
  if (!Array.isArray(portalClientIds) || portalClientIds.length > 16 || !portalClientIds.every(isClientId))
    throw new Error("invalid portalClientIds");
  for (const key of ["minimumDeviceVersion", "minimumClientVersion"] as const)
    if (v[key] !== undefined && !versionAtLeast(v[key], String(v[key])))
      throw new Error("invalid minimum software version");
  if (v.workosSecretFile !== undefined && (typeof v.workosSecretFile !== "string" || !v.workosSecretFile))
    throw new Error("invalid workosSecretFile");
  if (v.metricsTokenFile !== undefined && (typeof v.metricsTokenFile !== "string" || !v.metricsTokenFile))
    throw new Error("invalid metricsTokenFile");
  let billing: RelayConfig["billing"];
  if (v.billing !== undefined) {
    const b = v.billing as NonNullable<RelayConfig["billing"]>;
    if (
      !b ||
      Object.keys(b).sort().join(",") !== "prices,returnUrl,secretKeyFile,webhookSecretFile" ||
      typeof b.secretKeyFile !== "string" ||
      !b.secretKeyFile ||
      typeof b.webhookSecretFile !== "string" ||
      !b.webhookSecretFile ||
      !b.prices ||
      Object.keys(b.prices).sort().join(",") !== "pro,team" ||
      typeof b.prices.pro !== "string" ||
      typeof b.prices.team !== "string" ||
      typeof b.returnUrl !== "string" ||
      !/^https:\/\//.test(b.returnUrl)
    )
      throw new Error("invalid billing configuration");
    billing = b;
  }
  if (v.artifactDirectory !== undefined && (typeof v.artifactDirectory !== "string" || !v.artifactDirectory))
    throw new Error("invalid artifactDirectory");
  return {
    artifactDirectory: v.artifactDirectory as string | undefined,
    accountFile,
    portalClientIds,
    billing,
    workosSecretFile: v.workosSecretFile as string | undefined,
    metricsTokenFile: v.metricsTokenFile as string | undefined,
    minimumDeviceVersion: v.minimumDeviceVersion as string | undefined,
    minimumClientVersion: v.minimumClientVersion as string | undefined,
    limits: relayLimits(v.limits),
    relayHost: v.relayHost,
    issuer: v.issuer,
    pairingClientId: v.pairingClientId,
    environment,
    host,
    port,
    registryFile: v.registryFile,
    ...(tls ? { tls } : {}),
    exchangeDeadlineMs: deadline,
  };
}
