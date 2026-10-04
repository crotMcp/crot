import { randomUUID } from "node:crypto";

/**
 * Identity of the caller on whose behalf an operation runs.
 *
 * Every Core operation receives an AuthContext. Local transports (stdio)
 * produce the local user; authenticated transports (HTTP) produce a remote
 * principal derived from a verified credential. Both go through the same
 * interface, and Core services and the PermissionEngine do not change with the
 * transport or the authentication method.
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
}

/**
 * One client session for session-scoped Core state (ARCHITECTURE.md §27,
 * AD-12: session exposure). Created only by transport adapters (stdio: one
 * per MCP server instance; HTTP: one per MCP session, which is bound to its
 * authenticated principal) and compared by identity, never by `id`. Tool
 * arguments, the client, the browser and page content can never set it.
 */
export interface SessionRef {
  /** Random diagnostic id; carries no authority. */
  readonly id: string;
}

export function newSession(): SessionRef {
  return Object.freeze({ id: randomUUID() });
}

export interface AuthContext {
  readonly principal: Principal;
  /**
   * The session the request belongs to, supplied by the adapter. Absent
   * (embedding, tests): Core treats the whole process as one session.
   */
  readonly session?: SessionRef;
  /** Optional correlation id supplied by the adapter. */
  readonly requestId?: string;
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
