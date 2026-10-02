#!/usr/bin/env node
/**
 * CROT MCP entry point.
 *
 * Wires configuration -> CrotCore -> MCP adapter -> transport. The transport
 * is stdio (default, local user) or Streamable HTTP (--http, loopback,
 * authenticated remote principal); both use the same Core.
 * In stdio mode stdout is reserved for the MCP protocol; all diagnostics go to stderr.
 */
import path from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DEFAULT_HTTP_TOKEN_FILE_NAME, LocalTokenVerifier, loadOrCreateLocalToken } from "../adapters/http/auth.js";
import { CrotHttpServer } from "../adapters/http/server.js";
import { localContextResolver } from "../adapters/mcp/context.js";
import { createCrotMcpServer } from "../adapters/mcp/server.js";
import { flushStream, installLifecycle } from "../cli/lifecycle.js";
import { parseCli, USAGE } from "../cli/options.js";
import { parseConfig } from "../core/config/load.js";
import { expandHome } from "../core/config/paths.js";
import { CORE_VERSION, CrotCore } from "../core/crot-core.js";
import { CrotError } from "../core/errors.js";
import { hostDirectories } from "../core/platform/node-platform.js";

const log = (message: string) => process.stderr.write(`crot: ${message}\n`);

/** Deadline for a graceful shutdown (Windows terminates a closed console's processes after about 5-10 s). */
const SHUTDOWN_TIMEOUT_MS = 5_000;

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

  for (const warning of command.warnings) log(`warning: ${warning}`);
  if (command.configSource === "default") log(`config: ${command.configFile} (default location)`);

  const http = parseConfig(command.config).http;
  const tokenFile = http.enabled
    ? path.resolve(expandHome(http.auth.tokenFile ?? path.join(hostDirectories(process.env).state, DEFAULT_HTTP_TOKEN_FILE_NAME)))
    : undefined;
  // The configuration and the HTTP token file can never be modified through CROT tools.
  const protectedPaths = [command.configFile, tokenFile].filter((p): p is string => p !== undefined);
  const core = await CrotCore.create(command.config, protectedPaths.length > 0 ? { protectedPaths } : {});
  const status = core.status();
  log(`CROT ${status.version} — mode: ${status.mode}, workspace: ${status.workspace.root}`);
  log(`platform: ${status.platform.os} ${status.platform.arch}, shells: ${status.platform.shells.map((s) => s.id).join(", ")}`);
  const startupPath = status.platform.startupPath;
  if (startupPath.source === "login-shell" || startupPath.added.length > 0) {
    log(`PATH: ${startupPath.source === "login-shell" ? `from login shell ${startupPath.shell}` : "inherited"}, ${startupPath.added.length} entries added`);
  }
  if (startupPath.note) log(`warning: PATH: ${startupPath.note}; using the inherited PATH`);
  if (status.mode === "full_control") {
    log("WARNING: FULL CONTROL mode — the connected agent can access everything this process can.");
  }
  log(`audit: ${status.audit.sink}${status.audit.path ? ` (${status.audit.path})` : ""}`);
  const protection = status.audit.protection;
  if (protection && protection.ownerOnly === false) log(`warning: audit log ${protection.detail}`);
  if (protection && protection.ownerOnly === null) log(`note: audit log ${protection.detail}`);

  if (tokenFile !== undefined) {
    await serveHttp(core, http, tokenFile);
    return;
  }

  const server = createCrotMcpServer(core, { resolveContext: localContextResolver("stdio") });
  const transport = new StdioServerTransport();

  const lifecycle = installLifecycle({
    host: process,
    signals: status.platform.shutdownSignals,
    timeoutMs: SHUTDOWN_TIMEOUT_MS,
    log,
    shutdown: async (reason) => {
      log(`shutting down (${reason})`);
      try {
        await server.close();
      } catch {
        // Transport may already be closed.
      }
      await core.shutdown();
      await Promise.all([flushStream(process.stdout), flushStream(process.stderr)]);
    },
    emergency: () => core.terminateProcessesSync(),
    exit: (code) => process.exit(code),
  });
  transport.onclose = () => lifecycle.stop("transport closed", 0);
  process.stdin.on("end", () => lifecycle.stop("stdin closed", 0));
  // The client went away: writing to stdout fails with EPIPE.
  process.stdout.on("error", () => lifecycle.stop("stdout closed", 0));

  await server.connect(transport);
}

async function serveHttp(core: CrotCore, http: ReturnType<typeof parseConfig>["http"], tokenFile: string): Promise<void> {
  let server: CrotHttpServer;
  try {
    const { token, created } = await loadOrCreateLocalToken(tokenFile, core.platform.privateFiles);
    const verifier = new LocalTokenVerifier(token);
    log(`http: access token ${created ? "created in" : "read from"} ${tokenFile} (fingerprint ${verifier.fingerprint})`);
    const tokenProtection = await core.platform.privateFiles.inspect(tokenFile);
    if (tokenProtection.ownerOnly === false) log(`warning: HTTP token file ${tokenProtection.detail}`);
    if (tokenProtection.ownerOnly === null) log(`note: HTTP token file ${tokenProtection.detail}`);
    server = await CrotHttpServer.start(core, { config: http, verifier, log });
  } catch (error) {
    await core.shutdown();
    throw error;
  }

  installLifecycle({
    host: process,
    signals: core.platform.info.shutdownSignals,
    timeoutMs: SHUTDOWN_TIMEOUT_MS,
    log,
    // One shutdown path: stop HTTP (no new requests, sessions closed) -> Core -> flush.
    shutdown: async (reason) => {
      log(`shutting down (${reason})`);
      await server.close();
      await core.shutdown();
      await Promise.all([flushStream(process.stdout), flushStream(process.stderr)]);
    },
    emergency: () => core.terminateProcessesSync(),
    exit: (code) => process.exit(code),
  });
  log(`http: listening on ${server.url} (loopback only; bearer token required)`);
}

main().catch((error: unknown) => {
  log(error instanceof CrotError ? error.message : `fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  process.exit(1);
});
