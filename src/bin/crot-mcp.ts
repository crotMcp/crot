#!/usr/bin/env node
/**
 * CROT MCP entry point.
 *
 * Wires configuration -> Native Host -> browser bridge (optional) -> CrotCore -> MCP adapter -> transport.
 * The transport is stdio (default, local user) or Streamable HTTP (--http,
 * loopback, authenticated local principal; 2026-07-28 sessionless and legacy
 * sessions); both use the same Core.
 * The browser bridge is only a transport for the CROT Browser Extension: every
 * browser tool call is authorized by Core's PermissionEngine.
 * In stdio mode stdout is reserved for the MCP protocol; all diagnostics go to stderr.
 * `crot-mcp browser install` registers the CROT Host with Chromium browsers and exits.
 */
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DEFAULT_HTTP_TOKEN_FILE_NAME, LocalTokenVerifier, loadOrCreateLocalToken } from "../adapters/http/auth.js";
import { CrotHttpServer } from "../adapters/http/server.js";
import { localContextResolver } from "../adapters/mcp/context.js";
import { createCrotMcpServer } from "../adapters/mcp/server.js";
import type { BrowserBridge } from "../browser-bridge/server.js";
import { browserProtectedPaths, startBrowserBridge } from "../cli/browser.js";
import { formatInstallResult, installBrowserHost, regExeWriter } from "../cli/browser-install.js";
import { flushStream, installLifecycle } from "../cli/lifecycle.js";
import { parseCli, USAGE } from "../cli/options.js";
import { REMOTE_EXPOSURE_FILE_NAME } from "../core/approvals/index.js";
import { parseConfig } from "../core/config/load.js";
import { expandHome } from "../core/config/paths.js";
import { CORE_VERSION, CrotCore } from "../core/crot-core.js";
import { CrotError } from "../core/errors.js";
import { hostDirectories, osFamily } from "../core/platform/node-platform.js";
import { createPrivateFileProtection } from "../core/platform/private-files.js";
import { NativeHost } from "../native-host/native-host.js";

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
  if (command.kind === "browser-install") {
    await installBrowser();
    return;
  }

  for (const warning of command.warnings) log(`warning: ${warning}`);
  if (command.configSource === "default") log(`config: ${command.configFile} (default location)`);

  const parsed = parseConfig(command.config);
  const http = parsed.http;
  const stateDir = hostDirectories(process.env).state;
  const tokenFile = http.enabled
    ? path.resolve(expandHome(http.auth.tokenFile ?? path.join(stateDir, DEFAULT_HTTP_TOKEN_FILE_NAME)))
    : undefined;
  // Persisted exposure of remote principals (AD-15): only HTTP can carry remote principals.
  const remoteExposureFile = http.enabled ? path.join(stateDir, REMOTE_EXPOSURE_FILE_NAME) : undefined;
  // The configuration, the HTTP token file and the browser bridge token file can never be modified through CROT tools.
  const protectedPaths = [
    command.configFile,
    tokenFile,
    ...browserProtectedPaths(parsed.browser.enabled, stateDir),
  ].filter((p): p is string => p !== undefined);

  // Native resources first; Core is built on the Native Host platform (same startup PATH policy as Core's own platform).
  const native = await NativeHost.start({ startupPath: parsed.environment.path });
  for (const note of native.status().notes) log(`note: native host: ${note}`);
  // The browser bridge never stops CROT: when it cannot start, CROT runs without it (warning on stderr).
  const bridge = await startBrowserBridge({
    enabled: parsed.browser.enabled,
    stateDir,
    privateFiles: native.platform.privateFiles,
    log,
  });
  let core: CrotCore;
  try {
    core = await CrotCore.create(command.config, {
      ...(protectedPaths.length > 0 ? { protectedPaths } : {}),
      ...(remoteExposureFile ? { remoteExposureFile } : {}),
      platform: native.platform,
      ...(bridge ? { browser: bridge } : {}),
    });
  } catch (error) {
    await bridge?.close();
    await native.close();
    throw error;
  }
  const status = core.status();
  log(`CROT ${status.version} — mode: ${status.mode}, workspace: ${status.workspace.root}`);
  log(
    `platform: ${status.platform.os} ${status.platform.arch}, shells: ${status.platform.shells.map((s) => s.id).join(", ")}`,
  );
  const control = core.platform.info.processControl;
  log(
    `native host: process trees ${control.treeTermination}, private files ${core.platform.info.privateFiles.mechanism}`,
  );
  const startupPath = status.platform.startupPath;
  if (startupPath.source === "login-shell" || startupPath.added.length > 0) {
    log(
      `PATH: ${startupPath.source === "login-shell" ? `from login shell ${startupPath.shell}` : "inherited"}, ${startupPath.added.length} entries added`,
    );
  }
  if (startupPath.note) log(`warning: PATH: ${startupPath.note}; using the inherited PATH`);
  if (status.mode === "full_control") {
    log("WARNING: FULL CONTROL mode — the connected agent can access everything this process can.");
  }
  log(`audit: ${status.audit.sink}${status.audit.path ? ` (${status.audit.path})` : ""}`);
  const protection = status.audit.protection;
  if (protection && protection.ownerOnly === false) log(`warning: audit log ${protection.detail}`);
  if (protection && protection.ownerOnly === null) log(`note: audit log ${protection.detail}`);
  log(`browser: ${status.browser.state}`);

  if (tokenFile !== undefined) {
    await serveHttp(core, native, bridge, http, tokenFile);
    return;
  }

  const server = createCrotMcpServer(core, { resolveContext: localContextResolver("stdio") });
  const transport = new StdioServerTransport();

  const lifecycle = installLifecycle({
    host: process,
    signals: status.platform.shutdownSignals,
    timeoutMs: SHUTDOWN_TIMEOUT_MS,
    log,
    // One shutdown path: transport -> Core (terminates process trees, aborts browser requests) -> browser bridge -> Native Host -> flush.
    shutdown: async (reason) => {
      log(`shutting down (${reason})`);
      try {
        await server.close();
      } catch {
        // Transport may already be closed.
      }
      await core.shutdown();
      await bridge?.close();
      await native.close();
      await Promise.all([flushStream(process.stdout), flushStream(process.stderr)]);
    },
    emergency: () => {
      core.terminateProcessesSync();
      native.closeSync();
    },
    exit: (code) => process.exit(code),
  });
  transport.onclose = () => lifecycle.stop("transport closed", 0);
  process.stdin.on("end", () => lifecycle.stop("stdin closed", 0));
  // The client went away: writing to stdout fails with EPIPE.
  process.stdout.on("error", () => lifecycle.stop("stdout closed", 0));

  await server.connect(transport);
}

/** `crot-mcp browser install`: register this CROT installation as the native-messaging host for the current user. */
async function installBrowser(): Promise<void> {
  const windows = process.platform === "win32";
  const result = await installBrowserHost({
    os: osFamily(process.platform),
    home: os.homedir(),
    env: process.env,
    stateDir: hostDirectories(process.env).state,
    nodePath: process.execPath,
    // dist/bin/crot-browser-relay.js next to this file.
    relayScript: fileURLToPath(new URL("./crot-browser-relay.js", import.meta.url)),
    privateFiles: createPrivateFileProtection(windows),
    ...(windows ? { registry: regExeWriter(process.env.SystemRoot ?? "C:\\Windows") } : {}),
  });
  process.stdout.write(formatInstallResult(result));
}

async function serveHttp(
  core: CrotCore,
  native: NativeHost,
  bridge: BrowserBridge | undefined,
  http: ReturnType<typeof parseConfig>["http"],
  tokenFile: string,
): Promise<void> {
  let server: CrotHttpServer;
  try {
    const { token, created } = await loadOrCreateLocalToken(tokenFile, core.platform.privateFiles);
    const verifier = new LocalTokenVerifier(token);
    log(
      `http: access token ${created ? "created in" : "read from"} ${tokenFile} (fingerprint ${verifier.fingerprint})`,
    );
    const tokenProtection = await core.platform.privateFiles.inspect(tokenFile);
    if (tokenProtection.ownerOnly === false) log(`warning: HTTP token file ${tokenProtection.detail}`);
    if (tokenProtection.ownerOnly === null) log(`note: HTTP token file ${tokenProtection.detail}`);
    server = await CrotHttpServer.start(core, { config: http, verifier, log });
  } catch (error) {
    await core.shutdown();
    await bridge?.close();
    await native.close();
    throw error;
  }

  installLifecycle({
    host: process,
    signals: core.platform.info.shutdownSignals,
    timeoutMs: SHUTDOWN_TIMEOUT_MS,
    log,
    // One shutdown path: stop HTTP (no new requests, sessions closed) -> Core -> browser bridge -> Native Host -> flush.
    shutdown: async (reason) => {
      log(`shutting down (${reason})`);
      await server.close();
      await core.shutdown();
      await bridge?.close();
      await native.close();
      await Promise.all([flushStream(process.stdout), flushStream(process.stderr)]);
    },
    emergency: () => {
      core.terminateProcessesSync();
      native.closeSync();
    },
    exit: (code) => process.exit(code),
  });
  log(`http: listening on ${server.url} (loopback only; bearer token required)`);
}

main().catch((error: unknown) => {
  log(
    error instanceof CrotError
      ? error.message
      : `fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
  );
  process.exit(1);
});
