/**
 * Browser-bridge IPC server of the CROT Host (ARCHITECTURE.md §16).
 *
 *   CROT Browser Extension <-native messaging-> crot-browser-relay <-IPC-> BrowserBridge -> BrowserService (Core)
 *
 * BrowserBridge implements Core's BrowserConnection and is only a transport:
 * - It performs no authorization. Every request it sends was issued by
 *   BrowserService after the PermissionEngine authorized the operation, and
 *   every result it returns is validated by BrowserService.
 * - The browser side can never initiate an operation: after the handshake the
 *   only messages accepted are responses to requests this bridge sent.
 *   Anything else closes the connection.
 *
 * Connection lifecycle:
 * 1. The relay connects to the endpoint and sends `auth` with the bridge
 *    token (constant-time comparison); then the extension's `hello` arrives.
 *    Both must arrive within the handshake timeout, in frames of at most
 *    MAX_HANDSHAKE_FRAME_BYTES. The bridge answers `welcome`.
 * 2. Only one extension is connected at a time; further connections are
 *    refused while one is active.
 * 3. On disconnect every pending request fails with BROWSER_NOT_CONNECTED.
 *
 * Ownership is exclusive (one CROT instance per user owns the endpoint). When
 * another live instance owns it, this bridge reports in_use: browser
 * operations fail with BROWSER_BRIDGE_IN_USE while the instance keeps running
 * normally, and the bridge retries periodically so it takes over when the
 * owner exits. A socket file left behind by a crashed instance is removed
 * (POSIX) once a connection attempt has shown that nobody listens on it.
 */
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, rmdir, stat, unlink } from "node:fs/promises";
import net from "node:net";
import type {
  BrowserCommand,
  BrowserCommandParams,
  BrowserConnection,
  BrowserConnectionState,
  BrowserRequestOptions,
} from "../core/capabilities/browser/connection.js";
import type { BrowserInfo } from "../core/capabilities/browser/schemas.js";
import { CrotError, type CrotErrorCode } from "../core/errors.js";
import type { PrivateFileProtection } from "../core/platform/types.js";
import { bridgeEndpoint, bridgeTokenFile, loadOrCreateBridgeToken, tokensEqual, type BridgeEndpoint } from "./endpoint.js";
import {
  BRIDGE_PROTOCOL_VERSION,
  BrowserProtocolError,
  MAX_BROWSER_TO_HOST_FRAME_BYTES,
  MAX_HANDSHAKE_FRAME_BYTES,
  MessageReader,
  createRequest,
  encodeHostMessage,
  parseBrowserMessage,
  parseRelayAuth,
} from "./protocol.js";

export const BRIDGE_HANDSHAKE_TIMEOUT_MS = 5_000;
export const BRIDGE_OWNERSHIP_RETRY_MS = 5_000;
export const BRIDGE_MAX_PENDING_REQUESTS = 16;
/** Connections still in the handshake at the same time. */
const MAX_HANDSHAKES = 4;
/** Ids of requests Core gave up on whose late answers are discarded. */
const MAX_ABANDONED = 256;
const LIVENESS_TIMEOUT_MS = 1_000;
const TAKEOVER_LOCK_STALE_MS = 10_000;
const MAX_ERROR_MESSAGE = 500;

/**
 * Codes an extension error may carry. Authorization and bridge-state codes are
 * not among them: the extension cannot claim them. Anything else becomes
 * OPERATION_FAILED.
 */
const EXTENSION_ERROR_CODES: ReadonlySet<string> = new Set<CrotErrorCode>([
  "NOT_FOUND",
  "INVALID_INPUT",
  "TIMEOUT",
  "LIMIT_EXCEEDED",
  "RESOURCE_BUSY",
  "OPERATION_FAILED",
  "BROWSER_PAGE_RESTRICTED",
]);

export interface BrowserBridgeOptions {
  /** Private state directory (token file, POSIX socket). */
  readonly stateDir: string;
  readonly privateFiles: PrivateFileProtection;
  /** Diagnostics (never receives the token or page data). */
  readonly log?: (message: string) => void;
  readonly handshakeTimeoutMs?: number;
  /** How often an in_use bridge tries to take over the endpoint. */
  readonly ownershipRetryMs?: number;
  readonly maxPendingRequests?: number;
}

export interface BrowserBridgeStatus {
  readonly state: BrowserConnectionState["kind"] | "closed";
  readonly endpoint: BridgeEndpoint;
  readonly tokenFile: string;
  readonly browser?: BrowserInfo;
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: CrotError) => void;
  readonly cleanup: () => void;
}

interface ConnectedExtension {
  readonly socket: net.Socket;
  readonly browser: BrowserInfo;
}

const notConnected = () => new CrotError("BROWSER_NOT_CONNECTED", "The CROT Browser Extension is not connected.");
const inUse = () =>
  new CrotError("BROWSER_BRIDGE_IN_USE", "Another CROT instance owns the browser bridge; browser operations are unavailable in this instance.");

export class BrowserBridge implements BrowserConnection {
  private server: net.Server | undefined;
  private extension: ConnectedExtension | undefined;
  private readonly handshakes = new Set<net.Socket>();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly abandoned = new Set<string>();
  private retryTimer: ReturnType<typeof setInterval> | undefined;
  private acquiring = false;
  private lastRetryError: string | undefined;
  private closed = false;
  private readonly log: (message: string) => void;
  private readonly handshakeTimeoutMs: number;
  private readonly ownershipRetryMs: number;
  private readonly maxPending: number;

  private constructor(
    readonly endpoint: BridgeEndpoint,
    readonly tokenFile: string,
    private readonly token: string,
    options: BrowserBridgeOptions,
  ) {
    this.log = options.log ?? (() => undefined);
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? BRIDGE_HANDSHAKE_TIMEOUT_MS;
    this.ownershipRetryMs = options.ownershipRetryMs ?? BRIDGE_OWNERSHIP_RETRY_MS;
    this.maxPending = options.maxPendingRequests ?? BRIDGE_MAX_PENDING_REQUESTS;
  }

  /**
   * Create the token (if needed) and try to own the endpoint. Resolves in the
   * waiting state when this instance owns it, in the in_use state when another
   * live instance does; never fails because of another instance.
   */
  static async start(options: BrowserBridgeOptions): Promise<BrowserBridge> {
    await options.privateFiles.ensureDirectory(options.stateDir);
    const tokenFile = bridgeTokenFile(options.stateDir);
    const { token } = await loadOrCreateBridgeToken(tokenFile, options.privateFiles);
    const bridge = new BrowserBridge(bridgeEndpoint(options.stateDir, token), tokenFile, token, options);
    if (bridge.endpoint.kind === "unix-socket") await bridge.checkDirectory(options.stateDir);
    if (!(await bridge.acquire())) bridge.startRetrying();
    return bridge;
  }

  state(): BrowserConnectionState {
    if (this.extension) return { kind: "connected", browser: this.extension.browser };
    return this.server || this.closed ? { kind: "waiting" } : { kind: "in_use" };
  }

  status(): BrowserBridgeStatus {
    const browser = this.extension?.browser;
    return {
      state: this.closed ? "closed" : this.state().kind,
      endpoint: this.endpoint,
      tokenFile: this.tokenFile,
      ...(browser ? { browser } : {}),
    };
  }

  request<C extends BrowserCommand>(command: C, params: BrowserCommandParams[C], options: BrowserRequestOptions): Promise<unknown> {
    if (this.closed) return Promise.reject(new CrotError("BROWSER_NOT_CONNECTED", "The browser bridge is closed."));
    const extension = this.extension;
    if (!extension || extension.socket.destroyed) return Promise.reject(this.server ? notConnected() : inUse());
    if (options.signal.aborted) return Promise.reject(cancelled());
    if (this.pending.size >= this.maxPending) {
      return Promise.reject(new CrotError("RESOURCE_BUSY", "Too many browser requests in flight (at most " + this.maxPending + ")."));
    }
    const id = randomUUID();
    let frames: Uint8Array[];
    try {
      frames = encodeHostMessage(createRequest(id, command, params));
    } catch (error) {
      return Promise.reject(new CrotError("LIMIT_EXCEEDED", "The browser request cannot be sent: " + (error as Error).message));
    }
    return new Promise<unknown>((resolve, reject) => {
      const onAbort = () => this.abandon(id, cancelled());
      const timer = setTimeout(
        () => this.abandon(id, new CrotError("TIMEOUT", "The browser did not answer " + command + " within " + options.timeoutMs + " ms.")),
        options.timeoutMs,
      );
      timer.unref?.();
      const cleanup = () => {
        clearTimeout(timer);
        options.signal.removeEventListener("abort", onAbort);
      };
      this.pending.set(id, { resolve, reject, cleanup });
      options.signal.addEventListener("abort", onAbort, { once: true });
      // All frames of one request are written consecutively (chunked requests must not interleave).
      for (const frame of frames) extension.socket.write(frame);
    });
  }

  /** Stop listening, disconnect the extension and fail pending requests. Idempotent. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.retryTimer) clearInterval(this.retryTimer);
    this.retryTimer = undefined;
    this.failPending(new CrotError("BROWSER_NOT_CONNECTED", "The browser bridge is closed."));
    for (const socket of this.handshakes) socket.destroy();
    this.handshakes.clear();
    this.extension?.socket.destroy();
    this.extension = undefined;
    const server = this.server;
    this.server = undefined;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  // ---------------------------------------------------------------- ownership

  private async checkDirectory(dir: string): Promise<void> {
    const info = await stat(dir).catch(() => undefined);
    if (info && (info.mode & 0o077) !== 0) {
      const mode = (info.mode & 0o777).toString(8).padStart(4, "0");
      this.log(
        "warning: browser bridge: state directory " + dir + " has mode " + mode +
          "; the socket is restricted to the owner (0600) and connections must present the bridge token",
      );
    }
  }

  /** Try to own the endpoint. Returns false when another live instance owns it. */
  private async acquire(): Promise<boolean> {
    if (this.closed) return false;
    const first = await this.listen();
    if (first !== "in_use") return this.adopt(first);
    if (this.endpoint.kind === "named-pipe") return false;
    const socketPath = this.endpoint.path;
    if (await isListening(socketPath)) return false;
    // Nobody answered: the socket file is stale. Remove it under a lock so two
    // starting instances cannot remove each other's fresh socket.
    const lock = socketPath + ".lock";
    if (!(await acquireLock(lock))) return false;
    try {
      if (await isListening(socketPath)) return false;
      await removeStaleSocket(socketPath);
      const second = await this.listen();
      return second === "in_use" ? false : this.adopt(second);
    } finally {
      await rmdir(lock).catch(() => undefined);
    }
  }

  private listen(): Promise<net.Server | "in_use"> {
    const endpoint = this.endpoint;
    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => this.accept(socket));
      const onError = (error: NodeJS.ErrnoException) => {
        // A pipe created by another user can also surface as EACCES.
        if (error.code === "EADDRINUSE" || (endpoint.kind === "named-pipe" && error.code === "EACCES")) resolve("in_use");
        else reject(new CrotError("OPERATION_FAILED", "Cannot listen on the browser bridge endpoint " + endpoint.path + ": " + error.message));
      };
      server.once("error", onError);
      server.listen(endpoint.path, () => {
        server.off("error", onError);
        resolve(server);
      });
    });
  }

  private async adopt(server: net.Server): Promise<boolean> {
    if (this.endpoint.kind === "unix-socket") {
      try {
        await chmod(this.endpoint.path, 0o600);
      } catch (error) {
        server.close();
        throw new CrotError("OPERATION_FAILED", "Cannot restrict the browser bridge socket " + this.endpoint.path + ": " + (error as Error).message);
      }
    }
    if (this.closed) {
      server.close();
      return false;
    }
    server.on("error", (error) => this.log("browser bridge: server error: " + error.message));
    this.server = server;
    return true;
  }

  private startRetrying(): void {
    this.log("browser bridge: another CROT instance owns " + this.endpoint.path + "; browser operations are unavailable in this instance until it exits");
    this.retryTimer = setInterval(() => {
      if (this.acquiring || this.closed) return;
      this.acquiring = true;
      this.acquire()
        .then(
          (owned) => {
            if (!owned) return;
            if (this.retryTimer) clearInterval(this.retryTimer);
            this.retryTimer = undefined;
            this.log("browser bridge: now listening on " + this.endpoint.path);
          },
          (error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            if (message !== this.lastRetryError) this.log("browser bridge: " + message);
            this.lastRetryError = message;
          },
        )
        .finally(() => {
          this.acquiring = false;
        });
    }, this.ownershipRetryMs);
    this.retryTimer.unref?.();
  }

  // ---------------------------------------------------------------- connections

  private accept(socket: net.Socket): void {
    // Socket errors (EPIPE, ECONNRESET) end in 'close'.
    socket.on("error", () => undefined);
    if (this.closed || this.handshakes.size >= MAX_HANDSHAKES) {
      socket.destroy();
      return;
    }
    this.handshakes.add(socket);
    const reader = new MessageReader(MAX_HANDSHAKE_FRAME_BYTES);
    let phase: "auth" | "hello" | "ready" = "auth";
    const timer = setTimeout(() => socket.destroy(), this.handshakeTimeoutMs);
    timer.unref?.();
    const refuse = (reason: string) => {
      this.log("browser bridge: closed a connection: " + reason);
      socket.destroy();
    };

    socket.on("close", () => {
      clearTimeout(timer);
      this.handshakes.delete(socket);
      if (this.extension?.socket === socket) this.disconnected();
    });

    socket.on("data", (chunk: Buffer) => {
      if (socket.destroyed) return;
      let messages: unknown[];
      try {
        messages = reader.push(chunk);
      } catch (error) {
        refuse(describe(error));
        return;
      }
      for (const message of messages) {
        if (socket.destroyed) return;
        try {
          if (phase === "auth") {
            const auth = parseRelayAuth(message);
            if (auth.protocol !== BRIDGE_PROTOCOL_VERSION) throw new BrowserProtocolError("Unsupported relay protocol version " + auth.protocol + ".");
            if (!tokensEqual(auth.token, this.token)) {
              refuse("invalid bridge token");
              return;
            }
            phase = "hello";
          } else if (phase === "hello") {
            const hello = parseBrowserMessage(message);
            if (hello.type !== "hello") throw new BrowserProtocolError("Expected hello.");
            if (hello.protocol !== BRIDGE_PROTOCOL_VERSION) throw new BrowserProtocolError("Unsupported extension protocol version " + hello.protocol + ".");
            if (this.extension) {
              refuse("a browser extension is already connected");
              return;
            }
            clearTimeout(timer);
            this.handshakes.delete(socket);
            this.extension = { socket, browser: hello.browser };
            phase = "ready";
            reader.maxFrameBytes = MAX_BROWSER_TO_HOST_FRAME_BYTES;
            for (const frame of encodeHostMessage({ type: "welcome", protocol: BRIDGE_PROTOCOL_VERSION })) socket.write(frame);
            const b = hello.browser;
            this.log("browser bridge: connected to " + clean(b.name) + " " + clean(b.version) + " (CROT Browser Extension " + clean(b.extensionVersion) + ")");
          } else {
            this.receive(message);
          }
        } catch (error) {
          refuse(describe(error));
          return;
        }
      }
    });
  }

  /** A message on the connected extension's socket: only answers to requests this bridge sent are accepted. */
  private receive(message: unknown): void {
    const response = parseBrowserMessage(message);
    if (response.type !== "response") throw new BrowserProtocolError("Unexpected " + response.type + " after the handshake.");
    const pending = this.pending.get(response.id);
    if (!pending) {
      // Late answer to a request Core already gave up on.
      if (this.abandoned.delete(response.id)) return;
      throw new BrowserProtocolError("Response to an unknown request.");
    }
    this.pending.delete(response.id);
    pending.cleanup();
    if (response.ok) pending.resolve(response.result);
    else pending.reject(extensionError(response.error.code, response.error.message));
  }

  private abandon(id: string, error: CrotError): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    pending.cleanup();
    this.abandoned.add(id);
    if (this.abandoned.size > MAX_ABANDONED) {
      const oldest = this.abandoned.values().next().value;
      if (oldest !== undefined) this.abandoned.delete(oldest);
    }
    pending.reject(error);
  }

  private disconnected(): void {
    this.extension = undefined;
    this.abandoned.clear();
    this.failPending(new CrotError("BROWSER_NOT_CONNECTED", "The CROT Browser Extension disconnected."));
    if (!this.closed) this.log("browser bridge: browser extension disconnected");
  }

  private failPending(error: CrotError): void {
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const request of pending) {
      request.cleanup();
      request.reject(error);
    }
  }
}

const cancelled = () => new CrotError("OPERATION_FAILED", "Browser request cancelled.");

/** Single-line text without control characters, bounded. */
function clean(text: string, max = MAX_ERROR_MESSAGE): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").trim().slice(0, max);
}

const describe = (error: unknown): string => clean(error instanceof Error ? error.message : String(error), 200);

/** Error reported by the extension: allowlisted code, sanitized and bounded message, no details. */
function extensionError(code: string, message: string): CrotError {
  const text = clean(message) || "unknown error";
  if (EXTENSION_ERROR_CODES.has(code)) return new CrotError(code as CrotErrorCode, text);
  return new CrotError("OPERATION_FAILED", clean("Browser error " + code + ": " + text));
}

/** Whether a process accepts connections on the socket. A timeout counts as alive (never remove a socket that may be in use). */
function isListening(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(socketPath);
    const done = (live: boolean) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(live);
    };
    const timer = setTimeout(() => done(true), LIVENESS_TIMEOUT_MS);
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/** Exclusive lock for the stale-socket takeover (atomic mkdir). A lock older than TAKEOVER_LOCK_STALE_MS is broken. */
async function acquireLock(lock: string): Promise<boolean> {
  try {
    await mkdir(lock, { mode: 0o700 });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const info = await stat(lock).catch(() => undefined);
  if (!info || Date.now() - info.mtimeMs <= TAKEOVER_LOCK_STALE_MS) return false;
  await rmdir(lock).catch(() => undefined);
  try {
    await mkdir(lock, { mode: 0o700 });
    return true;
  } catch {
    return false;
  }
}

async function removeStaleSocket(socketPath: string): Promise<void> {
  const info = await lstat(socketPath).catch(() => undefined);
  if (!info) return;
  if (!info.isSocket()) {
    throw new CrotError("CONFIG_ERROR", socketPath + " exists and is not a socket; CROT does not remove it. Remove it to enable the browser bridge.");
  }
  await unlink(socketPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}
