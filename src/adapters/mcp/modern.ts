import { CLIENT_INFO_META_KEY, McpServer as ModernMcpServer, type ServerContext } from "@modelcontextprotocol/server";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ClientInfo } from "../../core/auth/principal.js";
import type { CrotCore } from "../../core/crot-core.js";
import type { ContextResolver } from "./context.js";
import { invokeTool } from "./invoke.js";
import { instructions, MCP_SERVER_NAME } from "./server.js";
import { TOOLS, type ToolDefinition } from "./tools.js";

/**
 * MCP protocol revisions served sessionless by createCrotModernMcpServer
 * (ARCHITECTURE.md §27, AD-15 point 3).
 */
export const MODERN_PROTOCOL_VERSIONS: readonly string[] = Object.freeze(["2026-07-28"]);

export interface CrotModernMcpServerOptions {
  /** Builds the Core AuthContext of the request; supplied by the entry point for this one request. */
  readonly resolveContext: ContextResolver;
}

/**
 * Self-reported client info from the request's `_meta` envelope; informational
 * only. The SDK lifts the reserved envelope keys off `_meta` before dispatch
 * and exposes them (untyped) as `ctx.mcpReq.envelope`.
 */
function envelopeClient(ctx: ServerContext): ClientInfo | undefined {
  const envelope = (ctx.mcpReq as { readonly envelope?: Readonly<Record<string, unknown>> }).envelope;
  const info: unknown = envelope?.[CLIENT_INFO_META_KEY] ?? ctx.mcpReq._meta?.[CLIENT_INFO_META_KEY];
  if (typeof info !== "object" || info === null) return undefined;
  const { name, version } = info as { name?: unknown; version?: unknown };
  if (typeof name !== "string") return undefined;
  return typeof version === "string" ? { name, version } : { name };
}

/**
 * Create the CROT MCP server for the sessionless 2026-07-28 revision (MCP SDK
 * v2). One instance serves exactly one request (AD-15 point 3): there is no
 * `initialize`, no session id and no state from earlier requests; the
 * execution context is built from this request alone by `resolveContext`.
 *
 * It exposes the same tools, input schemas, annotations and instructions as
 * createCrotMcpServer and calls Core through the same invokeTool path, so
 * the ExecutionGuard, PermissionEngine, approval gates and audit apply
 * unchanged. CROT issues no server-to-client requests (AD-15 point 3, C6).
 */
export function createCrotModernMcpServer(core: CrotCore, options: CrotModernMcpServerOptions): ModernMcpServer {
  const status = core.status();
  const server = new ModernMcpServer(
    { name: MCP_SERVER_NAME, version: status.version },
    { capabilities: { tools: {} }, instructions: instructions(core) },
  );

  // Registration publishes each tool and its Core input schema through tools/list.
  const definitions = new Map<string, ToolDefinition>();
  for (const definition of TOOLS) {
    definitions.set(definition.name, definition);
    server.registerTool(
      definition.name,
      {
        title: definition.title,
        description: definition.description,
        inputSchema: definition.inputSchema,
        annotations: definition.annotations,
      },
      // Never used: tools/call is served below.
      () => ({ isError: true, content: [] }),
    );
  }

  // As in createCrotMcpServer, tools/call is served here so that invalid input reaches
  // CROT's validation and error format (INVALID_INPUT) instead of the SDK's.
  server.server.setRequestHandler("tools/call", async (request, ctx) => {
    const definition = definitions.get(request.params.name);
    if (!definition) {
      return { isError: true, content: [{ type: "text", text: `Tool ${request.params.name} not found` }] };
    }
    const client = envelopeClient(ctx);
    const authInfo = ctx.http?.authInfo;
    const result: CallToolResult = await invokeTool(core, options.resolveContext, {
      definition,
      args: request.params.arguments ?? {},
      request: {
        ...(authInfo !== undefined ? { authInfo } : {}),
        ...(client ? { client } : {}),
      },
      // The request's own signal: aborted when its HTTP response closes.
      signal: ctx.mcpReq.signal,
    });
    return result as never;
  });
  return server;
}
