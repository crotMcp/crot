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

export interface AuthContext {
  readonly principal: Principal;
  /** Optional correlation id supplied by the adapter. */
  readonly requestId?: string;
}

export function localPrincipal(transport: string, client?: ClientInfo): Principal {
  return client ? { id: "local-user", kind: "local", transport, client } : { id: "local-user", kind: "local", transport };
}
