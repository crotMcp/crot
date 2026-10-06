/**
 * The thin stdio shim (WP-20, AD-17): what `crot-mcp` is in stdio mode.
 *
 * It connects to the user's CROT service (starting it when needed), proves
 * the shim credential, and carries stdio MCP unchanged: stdin lines go to the
 * service, the service's MCP output goes to stdout, and diagnostics go to
 * stderr. It holds no Core, no permissions and no policy; the service gives
 * every shim connection its own MCP server and exposure scope.
 *
 * When the service goes away unexpectedly the shim exits (status 1) instead of
 * reconnecting: a new connection would be a new exposure scope, and the MCP
 * client restarts the server like after any crash.
 */
import { spawn } from "node:child_process";
import { closeSync, openSync, readSync, statSync } from "node:fs";
import path from "node:path";
import type { ServeCommand } from "../cli/options.js";
import { flushStream, installLifecycle, type LifecycleHost } from "../cli/lifecycle.js";
import { parseConfig } from "../core/config/load.js";
import { CrotError } from "../core/errors.js";
import type { PrivateFileProtection } from "../core/platform/types.js";
import { ChannelError, connectChannel, MAX_SERVER_FRAME_BYTES, type AuthenticatedChannel } from "./channel.js";
import { configDigest } from "./config-digest.js";
import { environmentFingerprint } from "./environment.js";
import {
  acquireDirectoryLock,
  refreshDirectoryLock,
  secretCredentialStore,
  releaseDirectoryLock,
  SERVICE_LOG_FILE_NAME,
  SERVICE_START_LOCK_NAME,
  serviceEndpoint,
} from "./endpoints.js";
import { parseServiceMessage, SERVICE_PROTOCOL_VERSION, type ServiceToShim } from "./protocol.js";

/** The SDK stdio transport's read limit: a longer line closes the connection. */
export const MAX_STDIN_LINE_BYTES = 10 * 1024 * 1024;
const CONNECT_DEADLINE_MS = 20_000;
const WELCOME_TIMEOUT_MS = 60_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;
const MAX_SERVICE_LOG_BYTES = 1024 * 1024;

export interface ShimOptions {
  readonly command: ServeCommand;
  /** Arguments of this `crot-mcp` invocation (serve flags), passed on to an on-demand service. */
  readonly argv: readonly string[];
  /** Absolute path of the crot-mcp entry script. */
  readonly entry: string;
  readonly stateDir: string;
  readonly privateFiles: PrivateFileProtection;
  readonly log: (message: string) => void;
  readonly signals: readonly string[];
  readonly windows?: boolean;
}

type Welcome = Extract<ServiceToShim, { t: "welcome" }>;

/** How often a held start lock is refreshed (well below the stale age of the lock). */
const LOCK_REFRESH_MS = 2_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Connect to the service, starting it on demand; resolves with the welcomed channel. */
export async function connectToService(
  options: ShimOptions,
): Promise<{ channel: AuthenticatedChannel; welcome: Welcome }> {
  const { command, stateDir } = options;
  // Configuration errors are reported here, before a service is involved.
  parseConfig(command.config);
  const digest = configDigest(command.configFile ?? "", command.config);
  const store = secretCredentialStore(stateDir, options.privateFiles);
  const windows = options.windows ?? process.platform === "win32";
  const deadline = Date.now() + CONNECT_DEADLINE_MS;
  let started: Awaited<ReturnType<typeof startService>> | undefined;
  let delay = 25;
  let lastError: unknown;
  const lock = path.join(stateDir, SERVICE_START_LOCK_NAME);
  let lockHeld = false;
  // A held start lock is kept fresh, so a slow service start never makes it look stale to another shim.
  const heartbeat = setInterval(() => {
    if (lockHeld) void refreshDirectoryLock(lock);
  }, LOCK_REFRESH_MS);
  heartbeat.unref();
  try {
    return await connectLoop();
  } finally {
    clearInterval(heartbeat);
    if (lockHeld) await releaseDirectoryLock(lock);
  }

  async function connectLoop(): Promise<{ channel: AuthenticatedChannel; welcome: Welcome }> {
    for (;;) {
      const credential = await store.read("service");
      if (credential !== undefined) {
        const endpoint = serviceEndpoint(stateDir, "service", credential, windows);
        try {
          const channel = await connectChannel(endpoint.path, {
            channel: "service",
            credential,
            maxFrameBytes: MAX_SERVER_FRAME_BYTES,
          });
          const answer = await hello(channel, digest);
          if (answer.t === "welcome") return { channel, welcome: answer };
          if (answer.reason === "config_mismatch" || answer.reason === "version_mismatch")
            throw new CrotError("CONFIG_ERROR", answer.message);
          // restarting / shutting_down: wait until the old service has released its endpoint.
          lastError = new Error(answer.message);
          if (Date.now() <= deadline) {
            await sleep(100);
            continue;
          }
        } catch (error) {
          if (error instanceof CrotError) throw error;
          lastError = error;
        }
      }
      if (Date.now() > deadline) {
        const detail = lastError instanceof Error ? lastError.message : "no response";
        throw new CrotError(
          "OPERATION_FAILED",
          `Cannot reach the CROT service (${detail}). See ${path.join(stateDir, SERVICE_LOG_FILE_NAME)}.`,
        );
      }
      if (started === undefined || (await started.exited())) {
        // Nobody (alive) is serving: start the service, unless another shim is starting it right now.
        // The lock is held until this shim is connected (or gives up), so concurrent shims spawn only one service.
        await options.privateFiles.ensureDirectory(stateDir);
        if (lockHeld || (await acquireDirectoryLock(lock))) {
          lockHeld = true;
          if (started !== undefined) {
            const failure = started.failure();
            if (failure) throw failure;
          }
          started = await startService(options);
        }
      }
      await sleep(delay);
      delay = Math.min(delay * 2, 250);
    }
  }
}

/** Send hello; wait for welcome or refused. */
function hello(
  channel: AuthenticatedChannel,
  digest: string,
): Promise<Welcome | Extract<ServiceToShim, { t: "refused" }>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      channel.destroy();
      reject(new ChannelError("timeout", "The CROT service did not answer."));
    }, WELCOME_TIMEOUT_MS);
    channel.onmessage = (value) => {
      const message = parseServiceMessage(value);
      if (message?.t === "welcome" || message?.t === "refused") {
        clearTimeout(timer);
        // Later messages wait (queued) until the relay is set up.
        channel.pause();
        channel.onmessage = undefined;
        channel.onclose = undefined;
        if (message.t === "refused") channel.destroy();
        resolve(message);
      } else {
        clearTimeout(timer);
        channel.destroy();
        reject(new ChannelError("protocol", "Unexpected message from the CROT service."));
      }
    };
    channel.onclose = () => {
      clearTimeout(timer);
      reject(new ChannelError("closed", "The CROT service closed the connection."));
    };
    channel.start();
    channel.send({
      t: "hello",
      version: SERVICE_PROTOCOL_VERSION,
      configDigest: digest,
      pid: process.pid,
      environment: environmentFingerprint(),
    });
  });
}

/**
 * Start an on-demand service: detached (it outlives this shim and serves the
 * other clients), output to the service log in the private state directory.
 * Credentials are never passed: the service reads or creates them itself.
 */
async function startService(options: ShimOptions) {
  const logFile = path.join(options.stateDir, SERVICE_LOG_FILE_NAME);
  let size = 0;
  try {
    size = statSync(logFile).size;
  } catch {
    // No log yet.
  }
  const mode = options.privateFiles.fileMode ?? 0o600;
  const fd = openSync(logFile, size > MAX_SERVICE_LOG_BYTES ? "w" : "a", mode);
  // Owner-only like the other state files (POSIX: the mode above; Windows: an owner-only ACL).
  if (options.privateFiles.protectFile) await options.privateFiles.protectFile(logFile).catch(() => undefined);
  const startOffset = size > MAX_SERVICE_LOG_BYTES ? 0 : size;
  let exitCode: number | null | undefined;
  let spawnError: Error | undefined;
  try {
    const child = spawn(
      process.execPath,
      [...process.execArgv, options.entry, "service", "run", "--on-demand", ...options.argv],
      {
        detached: true,
        stdio: ["ignore", fd, fd],
        windowsHide: true,
        env: process.env,
      },
    );
    child.once("error", (error) => {
      spawnError = error;
      exitCode = null;
    });
    child.once("exit", (code) => {
      exitCode = code;
    });
    child.unref();
  } finally {
    closeSync(fd);
  }
  return {
    /** Whether the started service has already exited. */
    exited: async () => {
      await sleep(0);
      return exitCode !== undefined;
    },
    /** Why the service could not start (its log output), when it exited with an error. */
    failure: (): Error | undefined => {
      if (exitCode === 0) return undefined;
      if (spawnError) return new CrotError("OPERATION_FAILED", `Cannot start the CROT service: ${spawnError.message}`);
      return new CrotError(
        "OPERATION_FAILED",
        `The CROT service exited during startup (status ${String(exitCode)}).${serviceLogTail(logFile, startOffset)}`,
      );
    },
  };
}

function serviceLogTail(file: string, offset: number): string {
  try {
    const fd = openSync(file, "r");
    try {
      const size = statSync(file).size;
      const length = Math.min(size - offset, 8192);
      if (length <= 0) return "";
      const buffer = Buffer.alloc(length);
      readSync(fd, buffer, 0, length, size - length);
      return `\n${buffer.toString("utf8").trimEnd()}`;
    } finally {
      closeSync(fd);
    }
  } catch {
    return "";
  }
}

/** Run `crot-mcp` in stdio mode as a shim. */
export async function runShim(options: ShimOptions, host: LifecycleHost = process): Promise<void> {
  const { log } = options;
  const { channel, welcome } = await connectToService(options);
  for (const line of welcome.logs) log(line);

  let serviceGone = false;
  const lifecycle = installLifecycle({
    host,
    signals: options.signals,
    timeoutMs: SHUTDOWN_TIMEOUT_MS,
    log,
    shutdown: async (reason) => {
      if (!serviceGone) {
        log(`shutting down (${reason})`);
        channel.send({ t: "bye" });
        await Promise.race([channel.drained(), sleep(1_000)]);
        serviceGone = true;
        await channel.close();
      }
      process.stdin.pause();
      await Promise.all([flushStream(process.stdout), flushStream(process.stderr)]);
    },
    emergency: () => channel.destroy(),
    exit: (code) => process.exit(code),
  });

  channel.onmessage = (value) => {
    const message = parseServiceMessage(value);
    if (message?.t === "mcp") {
      // The client went away: writing to stdout fails with EPIPE (handled below).
      process.stdout.write(message.data);
    } else if (message?.t === "log") {
      log(message.line);
    } else if (message?.t === "bye") {
      serviceGone = true;
      log(`the CROT service stopped (${message.reason}); shutting down`);
      lifecycle.stop("service stopped", 0);
    } else {
      channel.destroy();
    }
  };
  channel.onclose = () => {
    if (serviceGone) return;
    serviceGone = true;
    log("lost the connection to the CROT service; exiting (the MCP client can restart CROT)");
    lifecycle.stop("service connection lost", 1);
  };
  channel.start();
  if (channel.isClosed) channel.onclose();

  // stdin -> service, line by line (the SDK stdio framing), with backpressure.
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  process.stdin.on("data", (chunk: Buffer) => {
    let start = 0;
    for (let i = chunk.indexOf(0x0a); i !== -1; i = chunk.indexOf(0x0a, start)) {
      pending.push(chunk.subarray(start, i));
      const line = Buffer.concat(pending).toString("utf8");
      pending = [];
      pendingBytes = 0;
      start = i + 1;
      if (!channel.send({ t: "mcp", line })) {
        process.stdin.pause();
        void channel.drained().then(() => process.stdin.resume());
      }
    }
    if (start < chunk.length) {
      pending.push(chunk.subarray(start));
      pendingBytes += chunk.length - start;
      // Same limit as the SDK stdio transport, which closes the transport.
      if (pendingBytes > MAX_STDIN_LINE_BYTES) {
        log(`stdin: a message exceeded ${MAX_STDIN_LINE_BYTES} bytes`);
        lifecycle.stop("transport closed", 0);
      }
    }
  });
  process.stdin.on("end", () => lifecycle.stop("stdin closed", 0));
  process.stdout.on("error", () => lifecycle.stop("stdout closed", 0));
}
