#!/usr/bin/env node
/**
 * CROT MCP stdio entry point.
 *
 * Wires configuration -> CrotCore -> MCP adapter -> stdio transport.
 * stdout is reserved for the MCP protocol; all diagnostics go to stderr.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { localContextResolver } from "../adapters/mcp/context.js";
import { createCrotMcpServer } from "../adapters/mcp/server.js";
import { parseCli, USAGE } from "../cli/options.js";
import { CORE_VERSION, CrotCore } from "../core/crot-core.js";
import { CrotError } from "../core/errors.js";

const log = (message: string) => process.stderr.write(`crot: ${message}\n`);

async function main(): Promise<void> {
  const command = await parseCli(process.argv.slice(2));
  if (command.kind === "help") {
    process.stdout.write(USAGE);
    return;
  }
  if (command.kind === "version") {
    process.stdout.write(`${CORE_VERSION}\n`);
    return;
  }

  const core = await CrotCore.create(command.config);
  const status = core.status();
  log(`CROT ${status.version} — mode: ${status.mode}, workspace: ${status.workspace.root}`);
  log(`platform: ${status.platform.os} ${status.platform.arch}, shells: ${status.platform.shells.map((s) => s.id).join(", ")}`);
  if (status.mode === "full_control") {
    log("WARNING: FULL CONTROL mode — the connected agent can access everything this process can.");
  }
  log(`audit: ${status.audit.sink}${status.audit.path ? ` (${status.audit.path})` : ""}`);

  const server = createCrotMcpServer(core, { resolveContext: localContextResolver("stdio") });
  const transport = new StdioServerTransport();

  let closing = false;
  const shutdown = async (code: number) => {
    if (closing) return;
    closing = true;
    try {
      await server.close();
    } catch {
      // Transport may already be closed.
    }
    await core.shutdown();
    process.exit(code);
  };
  transport.onclose = () => void shutdown(0);
  process.stdin.on("end", () => void shutdown(0));
  process.on("SIGINT", () => void shutdown(0));
  process.on("SIGTERM", () => void shutdown(0));

  await server.connect(transport);
}

main().catch((error: unknown) => {
  log(error instanceof CrotError ? error.message : `fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  process.exit(1);
});
