/**
 * Cloud Relay configuration (WP-29). A JSON file read by
 * `crot-cloud-relay --config <file>`; deployment environments are WP-38
 * (staging) and WP-39 (production).
 */
import { relayLimits, type RelayLimits } from "./limits.js";
import { isRelayHost } from "../identity/device-id.js";
import { isClientId, isIssuer } from "../identity/environment.js";
import { DEFAULT_EXCHANGE_DEADLINE_MS, MIN_EXCHANGE_DEADLINE_MS } from "../tunnel/protocol.js";

export interface RelayConfig {
  readonly relayHost: string;
  readonly limits: RelayLimits;
  readonly issuer: string;
  /** `client_id` of the environment's pairing client; only its tokens register devices (AD-22 point 4). */
  readonly pairingClientId: string;
  readonly environment: string;
  readonly host: string;
  readonly port: number;
  readonly registryFile: string;
  readonly tls?: { readonly certFile: string; readonly keyFile: string };
  readonly exchangeDeadlineMs: number;
}

const FIELDS = [
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
  return {
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
