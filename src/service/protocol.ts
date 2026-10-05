/**
 * Messages of the service channels (WP-20, AD-17), carried inside
 * AuthenticatedChannel frames. Pure data: no credentials, no policy.
 *
 * Shim channel (one stdio MCP connection per channel):
 *   shim -> service: hello { version, configDigest, pid, environment? }, mcp { line }, bye
 *   service -> shim: welcome { service, logs }, refused { reason, message },
 *                    mcp { data }, log { line }, bye { reason }
 * Control channel (owner tools: CLI today, tray / ApprovalProvider later):
 *   client -> service: request { id, method, params? }    method: ping | status | shutdown
 *   service -> client: response { id, result } | response { id, error }
 * The control channel carries no MCP traffic and exposes no tools.
 */
import type { ServiceStatus } from "../core/service-status.js";
import { parseEnvironmentFingerprint } from "./environment.js";

export const SERVICE_PROTOCOL_VERSION = 1;

export type RefusalReason = "config_mismatch" | "version_mismatch" | "shutting_down" | "restarting";

export type ShimToService =
  | {
      readonly t: "hello";
      readonly version: number;
      readonly configDigest: string;
      readonly pid: number;
      /** Digests of the shim's platform-relevant environment variables (environment.ts). */
      readonly environment?: Readonly<Record<string, string>>;
    }
  | { readonly t: "mcp"; readonly line: string }
  | { readonly t: "bye" };

export type ServiceToShim =
  | {
      readonly t: "welcome";
      readonly service: { readonly pid: number; readonly version: string; readonly launch: ServiceStatus["launch"] };
      /** Startup diagnostics of the service (banner), replayed to every shim's stderr. */
      readonly logs: readonly string[];
    }
  | { readonly t: "refused"; readonly reason: RefusalReason; readonly message: string }
  | { readonly t: "mcp"; readonly data: string }
  | { readonly t: "log"; readonly line: string }
  | { readonly t: "bye"; readonly reason: string };

export const CONTROL_METHODS = ["ping", "status", "shutdown"] as const;
export type ControlMethod = (typeof CONTROL_METHODS)[number];

export interface ControlRequest {
  readonly t: "request";
  readonly id: number;
  readonly method: ControlMethod;
}

export type ControlResponse =
  | { readonly t: "response"; readonly id: number; readonly result: unknown }
  | {
      readonly t: "response";
      readonly id: number;
      readonly error: { readonly code: string; readonly message: string };
    };

/** Result of `status` on the control channel. */
export interface ControlStatus {
  readonly service: ServiceStatus;
  readonly version: string;
  readonly mode: string;
  readonly workspace: string;
  readonly browser: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function parseShimMessage(value: unknown): ShimToService | undefined {
  if (!isRecord(value)) return undefined;
  switch (value.t) {
    case "hello": {
      if (
        typeof value.version !== "number" ||
        typeof value.configDigest !== "string" ||
        !/^[0-9a-f]{64}$/.test(value.configDigest) ||
        typeof value.pid !== "number"
      )
        return undefined;
      const environment = value.environment === undefined ? undefined : parseEnvironmentFingerprint(value.environment);
      if (value.environment !== undefined && !environment) return undefined;
      return {
        t: "hello",
        version: value.version,
        configDigest: value.configDigest,
        pid: value.pid,
        ...(environment ? { environment } : {}),
      };
    }
    case "mcp":
      return typeof value.line === "string" ? { t: "mcp", line: value.line } : undefined;
    case "bye":
      return { t: "bye" };
    default:
      return undefined;
  }
}

export function parseServiceMessage(value: unknown): ServiceToShim | undefined {
  if (!isRecord(value)) return undefined;
  switch (value.t) {
    case "welcome": {
      const service = value.service;
      if (!isRecord(service) || typeof service.pid !== "number" || typeof service.version !== "string")
        return undefined;
      const logs = Array.isArray(value.logs) ? value.logs.filter((l): l is string => typeof l === "string") : [];
      return {
        t: "welcome",
        service: {
          pid: service.pid,
          version: service.version,
          launch: service.launch === "managed" ? "managed" : "on-demand",
        },
        logs,
      };
    }
    case "refused": {
      const reasons: readonly string[] = ["config_mismatch", "version_mismatch", "shutting_down", "restarting"];
      return typeof value.reason === "string" && reasons.includes(value.reason) && typeof value.message === "string"
        ? { t: "refused", reason: value.reason as RefusalReason, message: value.message }
        : undefined;
    }
    case "mcp":
      return typeof value.data === "string" ? { t: "mcp", data: value.data } : undefined;
    case "log":
      return typeof value.line === "string" ? { t: "log", line: value.line } : undefined;
    case "bye":
      return { t: "bye", reason: typeof value.reason === "string" ? value.reason : "service stopped" };
    default:
      return undefined;
  }
}

export function parseControlRequest(value: unknown): ControlRequest | undefined {
  if (!isRecord(value) || value.t !== "request" || typeof value.id !== "number" || !Number.isSafeInteger(value.id))
    return undefined;
  const method = value.method;
  if (typeof method !== "string" || !(CONTROL_METHODS as readonly string[]).includes(method)) return undefined;
  return { t: "request", id: value.id, method: method as ControlMethod };
}

export function parseControlResponse(value: unknown): ControlResponse | undefined {
  if (!isRecord(value) || value.t !== "response" || typeof value.id !== "number") return undefined;
  if (isRecord(value.error) && typeof value.error.code === "string" && typeof value.error.message === "string")
    return { t: "response", id: value.id, error: { code: value.error.code, message: value.error.message } };
  if (!("result" in value)) return undefined;
  return { t: "response", id: value.id, result: value.result };
}
