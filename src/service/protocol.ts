/**
 * Messages of the service channels (WP-20, AD-17), carried inside
 * AuthenticatedChannel frames. Pure data: no credentials, no policy.
 *
 * Shim channel (one stdio MCP connection per channel):
 *   shim -> service: hello { version, configDigest, pid, environment? }, mcp { line }, bye
 *   service -> shim: welcome { service, logs }, refused { reason, message },
 *                    mcp { data }, log { line }, bye { reason }
 * Control channel (owner tools: the CLI and the tray, AD-17 point 7, AD-19 point 2):
 *   client -> service: request { id, method, params? }
 *     ping | status | shutdown (WP-20);
 *     overview | approvals.subscribe | approvals.unsubscribe | approvals.decide |
 *     preset.set | remote.setMode | remote.setFullControl | remote.resetExposure |
 *     remote.revokeClient | pairing.start (WP-22)
 *   service -> client: response { id, result } | response { id, error }
 *     and, only to connections that subscribed: event { event, ... }
 *     (approval.requested, approval.resolved, state.changed)
 * The control channel carries no MCP traffic and exposes no tools. It makes no
 * permission decision and creates no principal, grant or scope.
 */
import type { UntrustedContentSetting } from "../core/approvals/exposure.js";
import type { PresentedApproval, TerminalApprovalStatus } from "../core/approvals/types.js";
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

export const CONTROL_METHODS = [
  "ping",
  "status",
  "shutdown",
  "overview",
  "approvals.subscribe",
  "approvals.unsubscribe",
  "approvals.decide",
  "preset.set",
  "remote.setMode",
  "remote.setFullControl",
  "remote.resetExposure",
  "remote.revokeClient",
  "pairing.start",
] as const;
export type ControlMethod = (typeof CONTROL_METHODS)[number];

/** Preset values a control request may name (AD-16 point 17); availability is decided by the service. */
export const PRESET_VALUES = ["require-approval", "autonomous-browser", "off"] as const;
export type PresetValue = (typeof PRESET_VALUES)[number];

export interface RemoteClientParams {
  readonly accountId: string;
  readonly deviceId: string;
  readonly clientId: string;
}

export type ControlRequest =
  | {
      readonly t: "request";
      readonly id: number;
      readonly method: Exclude<
        ControlMethod,
        | "approvals.decide"
        | "preset.set"
        | "remote.setMode"
        | "remote.setFullControl"
        | "remote.resetExposure"
        | "remote.revokeClient"
      >;
    }
  | {
      readonly t: "request";
      readonly id: number;
      readonly method: "approvals.decide";
      readonly params: {
        readonly requestId: string;
        readonly decision: "approve" | "reject";
        readonly subjectDigest?: string;
      };
    }
  | {
      readonly t: "request";
      readonly id: number;
      readonly method: "preset.set";
      readonly params: { readonly value: PresetValue };
    }
  | {
      readonly t: "request";
      readonly id: number;
      readonly method: "remote.setMode" | "remote.setFullControl";
      readonly params: { readonly enabled: boolean };
    }
  | {
      readonly t: "request";
      readonly id: number;
      readonly method: "remote.resetExposure" | "remote.revokeClient";
      readonly params: RemoteClientParams;
    };

/** Service-to-client events, sent only to connections that called approvals.subscribe. */
export type ControlEvent =
  | { readonly t: "event"; readonly event: "approval.requested"; readonly approval: PresentedApproval }
  | {
      readonly t: "event";
      readonly event: "approval.resolved";
      readonly requestId: string;
      readonly status: TerminalApprovalStatus;
    }
  | { readonly t: "event"; readonly event: "state.changed"; readonly overview: ControlOverview };

/** A refused or failed device-control request: nothing changed. */
export interface ControlRefusal {
  readonly ok: false;
  readonly reason: string;
  readonly message: string;
}

export interface RemoteClientView {
  readonly accountId: string;
  readonly deviceId: string;
  readonly clientId: string;
  readonly firstSeen: string;
  readonly lastSeen: string;
  readonly revokedAt?: string;
  /** Persisted exposure of the client's scope (AD-15 point 8); unknown when the exposure state failed closed or is absent. */
  readonly exposure: "exposed" | "clean" | "unknown";
}

/** Result of `overview` and payload of `state.changed` (AD-19 point 10). */
export interface ControlOverview {
  readonly service: {
    readonly state: ServiceStatus["state"];
    readonly pid: number;
    readonly version: string;
    readonly launch: ServiceStatus["launch"];
    readonly uptimeMs: number;
  };
  readonly mode: string;
  readonly workspace: string;
  readonly preset: {
    readonly effective: UntrustedContentSetting;
    /** device: chosen in the tray; configuration: from the configuration file; fail-closed: the device state is unreadable. */
    readonly source: "device" | "configuration" | "fail-closed";
    readonly configured: UntrustedContentSetting;
    readonly selectable: readonly PresetValue[];
    readonly unavailable: readonly { readonly value: PresetValue; readonly reason: string }[];
    /** Why a change would be refused right now (busy Core), if it would. */
    readonly blockedBy?: string;
  };
  readonly remote: {
    readonly mode: boolean;
    readonly fullControl: boolean;
    readonly fullControlNote: string;
    readonly tunnel: string;
    readonly clients: readonly RemoteClientView[];
    /** Device state that cannot be read (settings, client list); remote requests are then refused. */
    readonly errors: readonly string[];
  };
  readonly agents: {
    readonly stdio: number;
    readonly httpSessions: number;
    readonly httpSessionlessInFlight: number;
    readonly remoteClients: number;
  };
  readonly browser: {
    readonly state: string;
    readonly name?: string;
    readonly version?: string;
    readonly extensionVersion?: string;
    readonly connectionId?: string;
  };
  readonly approvals: { readonly trays: number; readonly pending: number };
  readonly confinement: { readonly available: false; readonly reason: string };
  readonly cdp: { readonly available: false; readonly reason: string };
  readonly pairing: { readonly available: false; readonly reason: string };
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

const MAX_REQUEST_ID_LENGTH = 128;
const MAX_REMOTE_ID_LENGTH = 512;
const isRemoteId = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= MAX_REMOTE_ID_LENGTH && !v.includes("\0");
const onlyKeys = (params: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(params).every((k) => keys.includes(k));

/**
 * Strict parsing: an unknown method, unexpected parameters or invalid values
 * make the request malformed (the connection is then closed, AD-19 point 2).
 */
export function parseControlRequest(value: unknown): ControlRequest | undefined {
  if (!isRecord(value) || value.t !== "request" || typeof value.id !== "number" || !Number.isSafeInteger(value.id))
    return undefined;
  if (!onlyKeys(value, ["t", "id", "method", "params"])) return undefined;
  const method = value.method;
  if (typeof method !== "string" || !(CONTROL_METHODS as readonly string[]).includes(method)) return undefined;
  const id = value.id;
  const params = value.params;
  if (params !== undefined && !isRecord(params)) return undefined;
  const p = params ?? {};
  switch (method as ControlMethod) {
    case "approvals.decide": {
      if (!onlyKeys(p, ["requestId", "decision", "subjectDigest"])) return undefined;
      if (typeof p.requestId !== "string" || p.requestId.length === 0 || p.requestId.length > MAX_REQUEST_ID_LENGTH)
        return undefined;
      if (p.decision !== "approve" && p.decision !== "reject") return undefined;
      if (
        p.subjectDigest !== undefined &&
        (typeof p.subjectDigest !== "string" || !/^[0-9a-f]{64}$/.test(p.subjectDigest))
      )
        return undefined;
      if (p.decision === "approve" && p.subjectDigest === undefined) return undefined;
      return {
        t: "request",
        id,
        method: "approvals.decide",
        params: {
          requestId: p.requestId,
          decision: p.decision,
          ...(p.subjectDigest !== undefined ? { subjectDigest: p.subjectDigest as string } : {}),
        },
      };
    }
    case "preset.set":
      if (
        !onlyKeys(p, ["value"]) ||
        typeof p.value !== "string" ||
        !(PRESET_VALUES as readonly string[]).includes(p.value)
      )
        return undefined;
      return { t: "request", id, method: "preset.set", params: { value: p.value as PresetValue } };
    case "remote.setMode":
    case "remote.setFullControl":
      if (!onlyKeys(p, ["enabled"]) || typeof p.enabled !== "boolean") return undefined;
      return { t: "request", id, method: method as "remote.setMode", params: { enabled: p.enabled } };
    case "remote.resetExposure":
    case "remote.revokeClient":
      if (!onlyKeys(p, ["accountId", "deviceId", "clientId"])) return undefined;
      if (!isRemoteId(p.accountId) || !isRemoteId(p.deviceId) || !isRemoteId(p.clientId)) return undefined;
      return {
        t: "request",
        id,
        method: method as "remote.revokeClient",
        params: { accountId: p.accountId, deviceId: p.deviceId, clientId: p.clientId },
      };
    default:
      if (Object.keys(p).length > 0) return undefined;
      return {
        t: "request",
        id,
        method: method as Exclude<ControlMethod, "approvals.decide">,
      } as ControlRequest;
  }
}

/** Parse a service-to-client event (control clients that subscribed). */
export function parseControlEvent(value: unknown): ControlEvent | undefined {
  if (!isRecord(value) || value.t !== "event" || typeof value.event !== "string") return undefined;
  switch (value.event) {
    case "approval.requested":
      return isRecord(value.approval) && typeof value.approval.requestId === "string"
        ? { t: "event", event: "approval.requested", approval: value.approval as unknown as PresentedApproval }
        : undefined;
    case "approval.resolved":
      return typeof value.requestId === "string" && typeof value.status === "string"
        ? {
            t: "event",
            event: "approval.resolved",
            requestId: value.requestId,
            status: value.status as TerminalApprovalStatus,
          }
        : undefined;
    case "state.changed":
      return isRecord(value.overview)
        ? { t: "event", event: "state.changed", overview: value.overview as unknown as ControlOverview }
        : undefined;
    default:
      return undefined;
  }
}

export function parseControlResponse(value: unknown): ControlResponse | undefined {
  if (!isRecord(value) || value.t !== "response" || typeof value.id !== "number") return undefined;
  if (isRecord(value.error) && typeof value.error.code === "string" && typeof value.error.message === "string")
    return { t: "response", id: value.id, error: { code: value.error.code, message: value.error.message } };
  if (!("result" in value)) return undefined;
  return { t: "response", id: value.id, result: value.result };
}
