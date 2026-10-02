import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { localPrincipal, type AuthContext, type ClientInfo } from "../../core/auth/principal.js";

/** Transport-level facts about one MCP request, used to build the Core AuthContext. */
export interface McpRequestInfo {
  readonly requestId: string;
  readonly sessionId?: string;
  /** Present when the transport authenticated the request (e.g. future HTTP + MCP authorization). */
  readonly authInfo?: AuthInfo;
  readonly client?: ClientInfo;
}

/**
 * Maps an MCP request to the Core AuthContext. This is the single seam where
 * future authenticated transports plug in: they supply a resolver that derives
 * the principal from `authInfo`; tools and Core stay unchanged.
 */
export type ContextResolver = (request: McpRequestInfo) => AuthContext;

/** Resolver for local transports (stdio): the caller is the local user. */
export function localContextResolver(transport: string): ContextResolver {
  return (request) => ({ principal: localPrincipal(transport, request.client), requestId: request.requestId });
}
