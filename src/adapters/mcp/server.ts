import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CrotCore } from "../../core/crot-core.js";
import type { ContextResolver } from "./context.js";
import { toToolError, toToolResult } from "./results.js";
import { TOOLS } from "./tools.js";

export const MCP_SERVER_NAME = "crot";

export interface CrotMcpServerOptions {
  /** Builds the Core AuthContext for each request; supplied by the transport entry point. */
  readonly resolveContext: ContextResolver;
}

/**
 * Create the CROT MCP server: a thin, transport-independent adapter that
 * exposes CROT Core operations as MCP tools. Connect it to any MCP transport
 * (stdio today).
 */
export function createCrotMcpServer(core: CrotCore, options: CrotMcpServerOptions): McpServer {
  const status = core.status();
  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: status.version },
    { capabilities: { tools: {} }, instructions: instructions(core) },
  );

  for (const definition of TOOLS) {
    server.registerTool(
      definition.name,
      {
        title: definition.title,
        description: definition.description,
        inputSchema: definition.inputSchema,
        annotations: definition.annotations,
      },
      async (args: unknown, extra) => {
        try {
          const clientInfo = server.server.getClientVersion();
          const context = options.resolveContext({
            requestId: String(extra.requestId),
            ...(extra.sessionId !== undefined ? { sessionId: extra.sessionId } : {}),
            ...(extra.authInfo !== undefined ? { authInfo: extra.authInfo } : {}),
            ...(clientInfo ? { client: { name: clientInfo.name, version: clientInfo.version } } : {}),
          });
          return toToolResult(await definition.call(core, context, args));
        } catch (error) {
          return toToolError(error);
        }
      },
    );
  }
  return server;
}

function instructions(core: CrotCore): string {
  const s = core.status();
  const granted = s.capabilities.filter((c) => c.granted).map((c) => c.capability);
  const p = s.platform;
  return [
    "CROT gives you access to the user's local computer.",
    `Operating system: ${p.os} (${p.arch}); path style: ${p.pathStyle}; default shell for shell_run: ${p.defaultShell}; available shells: ${p.shells.map((x) => x.id).join(", ")}.`,
    `Permission mode: ${s.mode}. Workspace: ${s.workspace.root}.`,
    "Relative paths and the default working directory resolve against the workspace root.",
    s.mode === "sandbox"
      ? "Paths and working directories outside the workspace are denied."
      : "Full control: paths outside the workspace are allowed.",
    `Granted capabilities: ${granted.join(", ") || "none"}.`,
    "Call crot_status for details. Every operation is audited locally.",
  ].join(" ");
}
