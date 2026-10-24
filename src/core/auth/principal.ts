import { randomUUID } from "node:crypto";

/**
 * Identity of the caller on whose behalf an operation runs.
 *
 * Every Core operation receives an AuthContext (ARCHITECTURE.md §27, AD-15
 * point 7: the execution context of one request). The principal kind is set
 * only by the entry point the request arrived on, never by token contents,
 * client info, headers or tool arguments (AD-15 point 6):
 *
 * - `local`: stdio, and the loopback HTTP endpoint with the local token — a
 *   channel only programs on the user's own machine can reach;
 * - `remote`: the relay tunnel with an OAuth access token issued for this
 *   device — a request from the internet.
 *
 * Core services and the PermissionEngine do not change with the transport or
 * the authentication method.
 */
export type PrincipalKind = "local" | "remote";

export interface ClientInfo {
  readonly name: string;
  readonly version?: string;
}

export interface Principal {
  /** Stable identifier of the principal (e.g. "local-user", or a subject from a token). */
  readonly id: string;
  readonly kind: PrincipalKind;
  /** Transport the request arrived on (e.g. "stdio", "http"). */
  readonly transport: string;
  /**
   * How a remote principal was authenticated (e.g. "local-token"). Recorded in
   * audit events; informational only, never used for authorization. Never
   * contains credential material.
   */
  readonly authMethod?: string;
  /** Self-reported client application (e.g. an MCP client's name). Informational only, never trusted for authorization. */
  readonly client?: ClientInfo;
  /**
   * Remote principals only (AD-15 point 6): the verified account, device and
   * client identifiers from the access token (`clientId` is the client
   * identifier from the token, not the self-reported client name). Used only
   * for the exposure scope and for audit; they never grant anything.
   */
  readonly accountId?: string;
  readonly deviceId?: string;
  readonly clientId?: string;
  /** Verified named loopback credential binding; never taken from MCP arguments/client metadata. */
  readonly tokenAccess?: {
    readonly id: string;
    readonly generation: string;
    readonly scopes: readonly ("files" | "terminal" | "browser")[];
  };
}

/**
 * The key under which session exposure (AD-12) is recorded: the exposure
 * scope of AD-15 point 8. Created only by transport adapters from the entry
 * point and the verified principal — never from request content.
 *
 * - Local scopes (no `remoteKey`) are compared by identity and kept in memory:
 *   the stdio connection, a legacy loopback HTTP session, or the local-token
 *   principal of sessionless loopback requests for the lifetime of the process.
 * - Remote scopes carry a `remoteKey` derived from (accountId, deviceId,
 *   clientId). They are compared by that key, independent of sessions,
 *   protocol versions and tokens, and their exposure is persisted.
 */
export interface ExposureScope {
  /** Random or derived diagnostic id; carries no authority. */
  readonly id: string;
  /** Remote scopes only: the stable (account, device, client) key. */
  readonly remoteKey?: string;
}

/**
 * One client session for session-scoped Core state (ARCHITECTURE.md §27,
 * AD-12: session exposure). Created only by transport adapters (stdio: one
 * per MCP server instance; HTTP: one per MCP session, which is bound to its
 * authenticated principal) and compared by identity, never by `id`. Tool
 * arguments, the client, the browser and page content can never set it.
 */
export interface SessionRef extends ExposureScope {
  /** Random diagnostic id; carries no authority. */
  readonly id: string;
}

export function newSession(): SessionRef {
  return Object.freeze({ id: randomUUID() });
}

/** A new local exposure scope (compared by identity, in memory). */
export function newLocalExposureScope(): ExposureScope {
  return Object.freeze({ id: randomUUID() });
}

/**
 * The exposure scope of a remote principal (AD-15 point 8): the triple
 * (accountId, deviceId, clientId). Two calls with the same triple describe the
 * same scope, so a new session, a repeated `initialize`, a refreshed token or a
 * reconnected tunnel never yields a clean scope.
 */
export function remoteExposureScope(accountId: string, deviceId: string, clientId: string): ExposureScope {
  const remoteKey = JSON.stringify([accountId, deviceId, clientId]);
  return Object.freeze({ id: `remote:${remoteKey}`, remoteKey });
}

export interface AuthContext {
  readonly principal: Principal;
  /**
   * The exposure scope of the request (AD-15 point 8), supplied by the
   * adapter. Takes precedence over `session`.
   */
  readonly exposureScope?: ExposureScope;
  /**
   * The session the request belongs to (AD-12), supplied by the adapter; used
   * as the exposure scope when `exposureScope` is absent. Absent as well
   * (embedding, tests): Core treats the whole process as one scope.
   *
   * MCP adapters always supply it: the stdio connection, the legacy HTTP
   * session, or — for a sessionless 2026-07-28 request — a session of this
   * request alone. Invariant: a session never spans more than one exposure
   * scope (the ExecutionGuard keys exposure snapshots by session).
   */
  readonly session?: SessionRef;
  /**
   * Correlation id supplied by the adapter: generated per request, unique per
   * CROT process (AD-15 point 7). Correlates audit events only.
   */
  readonly requestId?: string;
  /** Service-created product identifiers for durable audit filtering; never tool arguments. */
  readonly productContext?: { readonly project: string; readonly agent: string };
  /**
   * Aborted when the caller gives up (MCP cancellation, transport closed).
   * Supplied by adapters; a pending approval request is then cancelled.
   */
  readonly signal?: AbortSignal;
}

export function localPrincipal(transport: string, client?: ClientInfo): Principal {
  return client
    ? { id: "local-user", kind: "local", transport, client }
    : { id: "local-user", kind: "local", transport };
}

/**
 * A remote principal from verified facts (AD-15 point 6). Built only by an
 * entry point that verified an OAuth access token for this device.
 */
export function remotePrincipal(facts: {
  readonly id: string;
  readonly transport: string;
  readonly authMethod: string;
  readonly accountId: string;
  readonly deviceId: string;
  readonly clientId: string;
  readonly client?: ClientInfo;
}): Principal {
  const { client, ...rest } = facts;
  return client ? { ...rest, kind: "remote", client } : { ...rest, kind: "remote" };
}
