#!/usr/bin/env node
/**
 * CROT MCP entry point.
 *
 * One CROT service per OS user (WP-20, ARCHITECTURE.md §27 AD-17) owns
 * configuration -> Native Host -> browser bridge (optional) -> CrotCore ->
 * MCP adapters (stdio connections from shims; Streamable HTTP on loopback).
 *
 * - `crot-mcp [options]` (stdio): a thin shim. It connects to the service
 *   (starting it on demand) and carries stdio MCP to it; it holds no Core and
 *   no policy. stdout is reserved for the MCP protocol; diagnostics go to stderr.
 * - `crot-mcp --http [options]` and `crot-mcp service run [options]`: run the
 *   service in the foreground (terminal, systemd user unit, launchd agent,
 *   Task Scheduler). Stdio shims of the same user attach to it.
 * - `crot-mcp service status|stop`: the authenticated local control channel.
 * - `crot-mcp secrets status|show http-token|rotate`: the secret store (WP-21).
 * - `crot-mcp browser install` registers the CROT Host with Chromium browsers and exits.
 * The browser bridge is only a transport for the CROT Browser Extension: every
 * browser tool call is authorized by Core's PermissionEngine.
 */
import os from "node:os";
import { runUpdate } from "../cli/update.js";
import { fileURLToPath } from "node:url";
import {
  formatInstallResult,
  installBrowserHost,
  regExeDeleter,
  regExeWriter,
  uninstallBrowserHost,
} from "../cli/browser-install.js";
import { flushStream, installLifecycle } from "../cli/lifecycle.js";
import { autostartStatus, installAutostart, removeAutostart } from "../installer/autostart.js";
import { parseCli, USAGE, type SecretsCommand, type ServeCommand } from "../cli/options.js";
import { rotateSecrets, secretsStatus, showHttpToken } from "../cli/secrets.js";
import { parseConfig } from "../core/config/load.js";
import { CORE_VERSION } from "../core/crot-core.js";
import { CrotError } from "../core/errors.js";
import { hostDirectories, osFamily } from "../core/platform/node-platform.js";
import { createServicePrivateFiles } from "../service/private-files.js";
import { ControlClient, waitForServiceExit } from "../service/control-client.js";
import { secretCredentialStore } from "../service/endpoints.js";
import type { ControlStatus } from "../service/protocol.js";
import { CrotService } from "../service/service.js";
import { runShim } from "../service/shim.js";

const log = (message: string) => process.stderr.write(`crot: ${message}\n`);

/** Deadline for a graceful shutdown (Windows terminates a closed console's processes after about 5-10 s). */
const SHUTDOWN_TIMEOUT_MS = 5_000;
const windows = process.platform === "win32";
/** Signals that stop CROT gracefully (the Core platform reports the same set). */
const SHUTDOWN_SIGNALS = windows ? ["SIGINT", "SIGTERM", "SIGBREAK", "SIGHUP"] : ["SIGINT", "SIGTERM", "SIGHUP"];

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === "update") return runUpdate(argv.slice(1));
  const command = await parseCli(argv);
  switch (command.kind) {
    case "help":
      process.stdout.write(USAGE);
      return;
    case "version":
      process.stdout.write(`${CORE_VERSION}\n`);
      return;
    case "browser-install":
      return installBrowser();
    case "browser-uninstall":
      return uninstallBrowser();
    case "service-status":
      return serviceStatus();
    case "service-stop":
      return serviceStop();
    case "service-autostart":
      return serviceAutostart(command.action);
    case "secrets":
      return secrets(command);
    case "service-run":
      return runService(command.serve, command.onDemand ? "on-demand" : "managed");
    case "serve":
      // With HTTP this process is the service; on stdio it is a shim of the service.
      if (parseConfig(command.config).http.enabled) return runService(command, "managed");
      return shim(command, argv);
  }
}

function startupNotes(command: ServeCommand): void {
  for (const warning of command.warnings) log(`warning: ${warning}`);
  if (command.configSource === "default") log(`config: ${command.configFile} (default location)`);
}

async function shim(command: ServeCommand, argv: readonly string[]): Promise<void> {
  startupNotes(command);
  await runShim({
    command,
    argv,
    entry: fileURLToPath(import.meta.url),
    stateDir: hostDirectories(process.env).state,
    privateFiles: createServicePrivateFiles(windows),
    log,
    signals: SHUTDOWN_SIGNALS,
  });
}

async function runService(command: ServeCommand, launch: "on-demand" | "managed"): Promise<void> {
  startupNotes(command);
  let stop: (reason: string) => void = () => undefined;
  const started = await CrotService.start({
    command,
    launch,
    stateDir: hostDirectories(process.env).state,
    privateFiles: createServicePrivateFiles(windows),
    log,
    requestStop: (reason) => stop(reason),
  });
  if (started === "already_running") {
    // Two shims started a service at the same time: the other one serves them both.
    if (launch === "on-demand") return;
    throw new CrotError(
      "OPERATION_FAILED",
      "A CROT service is already running for this user (see 'crot-mcp service status'); stop it with 'crot-mcp service stop' first.",
    );
  }
  const service = started;
  // Every path of the configuration is absolute by now: the service does not keep the working
  // directory of the shim or terminal that started it (it would pin that directory).
  try {
    process.chdir(os.homedir());
  } catch {
    // Keep the inherited directory; nothing depends on it.
  }
  const lifecycle = installLifecycle({
    host: process,
    signals: service.core.platform.info.shutdownSignals,
    timeoutMs: SHUTDOWN_TIMEOUT_MS,
    log,
    // One shutdown path (AD-7): endpoints and connections -> HTTP -> Core -> browser bridge -> Native Host -> flush.
    shutdown: async (reason) => {
      log(`shutting down (${reason})`);
      await service.shutdown(reason);
      await Promise.all([flushStream(process.stdout), flushStream(process.stderr)]);
    },
    emergency: () => service.emergency(),
    exit: (code) => process.exit(code),
  });
  stop = (reason) => lifecycle.stop(reason, 0);
  if (launch === "on-demand") {
    // Detached from any terminal: a closed stdout/stderr (log file) never stops the service.
    process.stdout.on("error", () => undefined);
    process.stderr.on("error", () => undefined);
  }
}

async function controlClient(): Promise<ControlClient | undefined> {
  return ControlClient.connect({
    stateDir: hostDirectories(process.env).state,
    privateFiles: createServicePrivateFiles(windows),
  });
}

/** `crot-mcp service status`: exit 0 when running, 3 when not running. */
async function serviceStatus(): Promise<void> {
  const client = await controlClient();
  if (!client) {
    process.stdout.write("CROT service: not running\n");
    process.exitCode = 3;
    return;
  }
  try {
    const status = (await client.request("status")) as ControlStatus;
    const s = status.service;
    const lines = [
      `CROT service: ${s.state} (pid ${s.pid}, ${s.launch}, up ${Math.round(s.uptimeMs / 1000)} s)`,
      `version: ${status.version}, mode: ${status.mode}, workspace: ${status.workspace}`,
      `clients: ${s.clients.stdio} stdio, ${s.clients.control} control; endpoints: ${s.endpoints.kind}`,
      `http: ${s.http.enabled ? `${s.http.url ?? ""}${s.http.sessionless ? ` (sessionless ${s.http.sessionless.inFlight}/${s.http.sessionless.limit} in flight, ${s.http.sessionless.rejected} rejected)` : ""}` : "disabled"}`,
      `browser: ${status.browser}`,
      `secrets: ${s.secrets.store} (${s.secrets.location})${s.secrets.httpToken === "token-file" ? "; WARNING: HTTP token in a plaintext token file (compatibility mode)" : ""}`,
      `resumes detected: ${s.power.resumes}${s.power.lastResumeAt ? ` (last ${s.power.lastResumeAt})` : ""}`,
    ];
    process.stdout.write(lines.join("\n") + "\n");
  } finally {
    client.close();
  }
}

/** `crot-mcp service stop`: graceful shutdown through the control channel; waits until it has exited. */
async function serviceStop(): Promise<void> {
  const client = await controlClient();
  if (!client) {
    process.stdout.write("CROT service: not running\n");
    return;
  }
  let pid: number | undefined;
  try {
    pid = ((await client.request("shutdown")) as { pid?: number }).pid;
  } finally {
    client.close();
  }
  const stateDir = hostDirectories(process.env).state;
  const credential = await secretCredentialStore(stateDir, createServicePrivateFiles(windows)).read("service");
  const stopped = await waitForServiceExit(stateDir, credential, 15_000);
  if (!stopped) throw new CrotError("OPERATION_FAILED", `The CROT service (pid ${String(pid)}) did not stop in time.`);
  process.stdout.write(`CROT service stopped (pid ${String(pid)})\n`);
}

/** `crot-mcp secrets status | show http-token | rotate <name>...` (WP-21). */
async function secrets(command: SecretsCommand): Promise<void> {
  const options = {
    stateDir: hostDirectories(process.env).state,
    privateFiles: createServicePrivateFiles(windows),
    ...(command.config ? { config: command.config } : {}),
  };
  switch (command.action) {
    case "status":
      process.stdout.write(await secretsStatus(options));
      return;
    case "show": {
      const { token, note } = await showHttpToken(options);
      if (note) log(`note: ${note}`);
      process.stdout.write(`${token}\n`);
      return;
    }
    case "rotate":
      process.stdout.write(await rotateSecrets(options, command.names));
      return;
  }
}

/** `crot-mcp browser install`: register this CROT installation as the native-messaging host for the current user. */
async function installBrowser(): Promise<void> {
  const result = await installBrowserHost({
    os: osFamily(process.platform),
    home: os.homedir(),
    env: process.env,
    stateDir: hostDirectories(process.env).state,
    nodePath: process.execPath,
    // dist/bin/crot-browser-relay.js next to this file.
    relayScript: fileURLToPath(new URL("./crot-browser-relay.js", import.meta.url)),
    privateFiles: createServicePrivateFiles(windows),
    ...(windows ? { registry: regExeWriter(process.env.SystemRoot ?? "C:\\Windows") } : {}),
  });
  process.stdout.write(formatInstallResult(result));
}

async function uninstallBrowser(): Promise<void> {
  const directories = hostDirectories(process.env);
  await uninstallBrowserHost({
    os: osFamily(process.platform),
    home: os.homedir(),
    stateDir: directories.state,
    env: process.env,
    ...(windows ? { registry: regExeDeleter(process.env.SystemRoot ?? "C:\\Windows") } : {}),
  });
  process.stdout.write("CROT native-messaging host removed.\n");
}

async function serviceAutostart(action: "install" | "status" | "remove"): Promise<void> {
  const executable = process.execPath;
  const spec = {
    os: osFamily(process.platform),
    home: os.homedir(),
    executable,
    script: fileURLToPath(import.meta.url),
    ...(process.env.CROT_CONFIG ? { configFile: process.env.CROT_CONFIG } : {}),
    env: process.env,
  };
  if (action === "install") {
    await installAutostart(spec);
    process.stdout.write("CROT service autostart installed.\n");
    return;
  }
  if (action === "remove") {
    await removeAutostart(spec);
    process.stdout.write("CROT service autostart removed.\n");
    return;
  }
  process.stdout.write((await autostartStatus(spec)) ? "enabled\n" : "disabled\n");
}

main().catch((error: unknown) => {
  log(
    error instanceof CrotError
      ? error.message
      : `fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
  );
  process.exit(1);
});
