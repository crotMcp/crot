import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import {
  newLocalExposureScope,
  remoteExposureScope,
  remotePrincipal,
  type AuthContext,
  type ClientInfo,
  type ExposureScope,
  type Principal,
} from "../../core/auth/principal.js";
import type { ContextResolver } from "../mcp/context.js";

/** `transport` of principals from the loopback HTTP endpoint. */
export const HTTP_TRANSPORT = "http";
/** `transport` of principals from the relay tunnel (AD-15 point 6). */
export const RELAY_TRANSPORT = "relay";

/**
 * Where an HTTP request entered CROT (AD-15 point 1). The entry point alone
 * decides the principal kind (AD-15 point 6):
 *
 * - `loopback`: the loopback HTTP endpoint with the local token -> `local`;
 * - `relay`: the relay tunnel with an OAuth access token for this device ->
 *   `remote`. The tunnel itself is WP-30; this entry point is the pipeline it
 *   reuses (constraint C4).
 */
export type HttpEntryPoint = "loopback" | "relay";

/** Authentication method of the local token (AD-13 point 6); never accepted on the relay entry point. */
const LOCAL_TOKEN_AUTH_METHOD = "local-token";
/** Authentication method of OAuth access tokens for this device (AD-21 point 3); the only one accepted on the relay entry point, never on loopback. */
const OAUTH_AUTH_METHOD = "oauth";

const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.length > 0;

/**
 * Derive the Core principal from verified authentication facts and the entry
 * point. The credential itself (AuthInfo.token) is never copied into the
 * principal, so it cannot reach Core or the audit log. Returns undefined when
 * the facts are not sufficient for this entry point (the request is then
 * rejected as unauthenticated, before it reaches the MCP server or Core).
 *
 * Conventions for AuthInfo.extra (set by the verifier, never by the client):
 * - subject: stable principal id (falls back to clientId)
 * - authMethod: how the principal was authenticated
 * - accountId, deviceId: remote principals only, verified from the token;
 *   the client identifier of a remote principal is AuthInfo.clientId.
 */
export function principalFromAuthInfo(
  entry: HttpEntryPoint,
  authInfo: AuthInfo,
  client?: ClientInfo,
): Principal | undefined {
  const extra = authInfo.extra ?? {};
  const subject = nonEmpty(extra.subject) ? extra.subject : authInfo.clientId;
  const authMethod = nonEmpty(extra.authMethod) ? extra.authMethod : "bearer";
  if (!nonEmpty(subject)) return undefined;
  if (entry === "loopback") {
    // An OAuth token for this device is refused on loopback (AD-21 point 8, last row).
    if (authMethod === OAUTH_AUTH_METHOD) return undefined;
    let tokenAccess: Principal["tokenAccess"];
    if (authMethod === "scoped-token") {
      if (
        !nonEmpty(extra.tokenId) ||
        !nonEmpty(extra.tokenGeneration) ||
        authInfo.scopes.length === 0 ||
        authInfo.scopes.some((s) => !["files", "terminal", "browser"].includes(s))
      )
        return undefined;
      tokenAccess = Object.freeze({
        id: extra.tokenId,
        generation: extra.tokenGeneration,
        scopes: Object.freeze([...authInfo.scopes]) as readonly ("files" | "terminal" | "browser")[],
      });
    }
    return client
      ? {
          ...(tokenAccess ? { tokenAccess } : {}),
          id: subject,
          kind: "local",
          transport: HTTP_TRANSPORT,
          authMethod,
          client,
        }
      : { ...(tokenAccess ? { tokenAccess } : {}), id: subject, kind: "local", transport: HTTP_TRANSPORT, authMethod };
  }
  // Relay: only an OAuth access token for this device (AD-15 point 4, AD-21
  // point 3) — never the local token or another credential — and a remote
  // principal needs its verified account, device and client.
  if (authMethod === LOCAL_TOKEN_AUTH_METHOD || authMethod !== OAUTH_AUTH_METHOD) return undefined;
  const { accountId, deviceId } = extra;
  const clientId = authInfo.clientId;
  if (!nonEmpty(accountId) || !nonEmpty(deviceId) || !nonEmpty(clientId)) return undefined;
  return remotePrincipal({
    id: subject,
    transport: RELAY_TRANSPORT,
    authMethod,
    accountId,
    deviceId,
    clientId,
    ...(client ? { client } : {}),
  });
}

/**
 * Key that binds a legacy MCP session to the principal that opened it. Only a
 * request authenticated as the same principal (same kind, id and, for remote
 * principals, account, device and client) can use the session.
 */
export function sessionOwnerKey(principal: Principal): string {
  return JSON.stringify([
    principal.kind,
    principal.id,
    principal.accountId ?? null,
    principal.deviceId ?? null,
    principal.clientId ?? null,
    principal.tokenAccess?.id ?? null,
    principal.tokenAccess?.generation ?? null,
  ]);
}

/**
 * Exposure scopes of sessionless loopback requests (AD-15 point 8): one per
 * local-token principal for the lifetime of the CROT process. Owned by the
 * HTTP server of that process; never derived from request content.
 */
export class LocalPrincipalScopes {
  private readonly scopes = new Map<string, ExposureScope>();

  scopeFor(principal: Principal): ExposureScope {
    const key = sessionOwnerKey(principal);
    let scope = this.scopes.get(key);
    if (!scope) {
      scope = newLocalExposureScope();
      this.scopes.set(key, scope);
    }
    return scope;
  }
}

/**
 * The exposure scope of an HTTP request (AD-15 point 8):
 *
 * - remote principals: (accountId, deviceId, clientId), for every protocol
 *   version and independent of sessions and tokens;
 * - loopback, sessionless (2026-07-28): the local-token principal for the
 *   lifetime of the process;
 * - loopback, legacy session: undefined — the MCP server instance's session
 *   is the scope (unchanged, AD-12).
 */
export function exposureScopeFor(
  principal: Principal,
  mode: "session" | "sessionless",
  localScopes: LocalPrincipalScopes,
): ExposureScope | undefined {
  if (principal.kind === "remote") {
    // principalFromAuthInfo guarantees the fields of a remote principal.
    return remoteExposureScope(principal.accountId!, principal.deviceId!, principal.clientId!);
  }
  return mode === "sessionless" ? localScopes.scopeFor(principal) : undefined;
}

/**
 * Context resolver for HTTP requests: the principal and exposure scope were
 * derived by the HTTP pipeline from the authenticated request and the entry
 * point; only the self-reported (informational) client info and the adapter's
 * request id are added per request.
 */
export function httpContextResolver(principal: Principal, exposureScope?: ExposureScope): ContextResolver {
  return (request): AuthContext => {
    const p: Principal = request.client ? { ...principal, client: request.client } : principal;
    return exposureScope
      ? { principal: p, exposureScope, requestId: request.requestId }
      : { principal: p, requestId: request.requestId };
  };
}
