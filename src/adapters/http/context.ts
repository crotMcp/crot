import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { AuthContext, ClientInfo, Principal } from "../../core/auth/principal.js";
import type { ContextResolver } from "../mcp/context.js";

export const HTTP_TRANSPORT = "http";

/**
 * Derive the Core principal from verified authentication facts. The
 * credential itself (AuthInfo.token) is never copied into the principal, so
 * it cannot reach Core or the audit log.
 */
export function principalFromAuthInfo(transport: string, authInfo: AuthInfo, client?: ClientInfo): Principal {
  const extra = authInfo.extra ?? {};
  const subject = typeof extra.subject === "string" && extra.subject.length > 0 ? extra.subject : authInfo.clientId;
  const authMethod = typeof extra.authMethod === "string" && extra.authMethod.length > 0 ? extra.authMethod : "bearer";
  return client ? { id: subject, kind: "remote", transport, authMethod, client } : { id: subject, kind: "remote", transport, authMethod };
}

/**
 * Context resolver for an authenticated HTTP session. Uses the AuthInfo the
 * transport attached to the request, or the AuthInfo the session was opened
 * with (every request of a session is authenticated as the same principal).
 */
export function httpContextResolver(sessionAuth: AuthInfo, transport: string = HTTP_TRANSPORT): ContextResolver {
  return (request): AuthContext => ({
    principal: principalFromAuthInfo(transport, request.authInfo ?? sessionAuth, request.client),
    requestId: request.requestId,
  });
}
