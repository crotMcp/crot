/**
 * Identity of the caller on whose behalf an operation runs.
 *
 * Every Core operation receives an AuthContext. Today the only principal is the
 * local user connected over a local transport (stdio). Remote transports and
 * the MCP authorization model will produce authenticated principals through the
 * same interface, without changes to Core services.
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
  /** Transport the request arrived on (e.g. "stdio"). */
  readonly transport: string;
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
