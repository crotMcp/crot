/**
 * Local endpoints and credentials of the supervised CROT service (WP-20,
 * ARCHITECTURE.md §24 and §27 AD-17).
 *
 * The service listens on two per-user endpoints in the CROT state directory:
 *
 * | Endpoint | POSIX                    | Windows                                  | Carries                         |
 * | -------- | ------------------------ | ---------------------------------------- | ------------------------------- |
 * | service  | <state>/service.sock     | \\.\pipe\crot-service-<digest of token>  | stdio MCP of the shim           |
 * | control  | <state>/control.sock     | \\.\pipe\crot-control-<digest of token>  | local control (no MCP, no tools) |
 *
 * Each endpoint has its own credential, a 256-bit random secret kept in the
 * secret store of the state directory (WP-21: macOS Keychain, Windows DPAPI,
 * Secret Service, or owner-only files <state>/service-token and
 * <state>/control-token where no OS secure storage is available), reached
 * only through `CredentialStore`. The credential is never sent: peers prove
 * possession in a challenge-response handshake (channel.ts).
 *
 * Owner-only access is enforced in layers: the POSIX socket is created in the
 * owner-only state directory and restricted to 0600; a Windows named pipe
 * created by Node.js grants write access only to its creator, LocalSystem and
 * Administrators, and its name is derived from the credential so other users
 * cannot predict it. On top of that every connection must complete the
 * credential handshake.
 *
 * The service endpoint is also the singleton lock of the service: exactly one
 * process per user can listen on it (POSIX bind / Windows first pipe
 * instance), so concurrent starts never produce two service owners.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { chmod, lstat, stat, unlink } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { CrotError } from "../core/errors.js";
import type { PrivateFileProtection } from "../core/platform/types.js";
import { acquireDirectoryLock, releaseDirectoryLock } from "./locks.js";
import { openSecretStore, type SecretStore, type SecretStoreHost } from "./secrets/store.js";
import type { SecretName } from "./secrets/types.js";

export { acquireDirectoryLock, refreshDirectoryLock, releaseDirectoryLock } from "./locks.js";

export type ServiceChannel = "service" | "control";

export const SERVICE_TOKEN_FILE_NAME = "service-token";
export const CONTROL_TOKEN_FILE_NAME = "control-token";
export const SERVICE_SOCKET_FILE_NAME = "service.sock";
export const CONTROL_SOCKET_FILE_NAME = "control.sock";
export const SERVICE_LOG_FILE_NAME = "service.log";
/** Directory lock taken by a shim while it starts the service on demand. */
export const SERVICE_START_LOCK_NAME = "service-start.lock";
/** Longest Unix socket path accepted (macOS allows 104 bytes including the terminating NUL; Linux 108). */
export const MAX_SOCKET_PATH_BYTES = 103;

const TOKEN = /^[A-Za-z0-9_-]{43,256}$/;
const LIVENESS_TIMEOUT_MS = 1_000;

export interface ServiceEndpoint {
  readonly channel: ServiceChannel;
  readonly kind: "unix-socket" | "named-pipe";
  /** Socket path or pipe name, as passed to net.Server.listen / net.connect. */
  readonly path: string;
}

export function credentialFile(stateDir: string, channel: ServiceChannel): string {
  return path.join(stateDir, channel === "service" ? SERVICE_TOKEN_FILE_NAME : CONTROL_TOKEN_FILE_NAME);
}

/** Files of the service that CROT tools may never modify (credentials and the service log). */
export function serviceProtectedPaths(stateDir: string): string[] {
  return [
    credentialFile(stateDir, "service"),
    credentialFile(stateDir, "control"),
    path.join(stateDir, SERVICE_LOG_FILE_NAME),
  ];
}

/** Endpoint of a channel for a state directory and its credential. */
export function serviceEndpoint(
  stateDir: string,
  channel: ServiceChannel,
  credential: string,
  windows: boolean = process.platform === "win32",
): ServiceEndpoint {
  if (windows) {
    const digest = createHash("sha256")
      .update(`crot-${channel}-pipe\u0000${credential}`, "utf8")
      .digest("hex")
      .slice(0, 32);
    return { channel, kind: "named-pipe", path: `\\\\.\\pipe\\crot-${channel}-${digest}` };
  }
  const socket = path.join(stateDir, channel === "service" ? SERVICE_SOCKET_FILE_NAME : CONTROL_SOCKET_FILE_NAME);
  const bytes = Buffer.byteLength(socket, "utf8");
  if (bytes > MAX_SOCKET_PATH_BYTES) {
    throw new CrotError(
      "CONFIG_ERROR",
      `The CROT ${channel} socket path is too long (${bytes} bytes, at most ${MAX_SOCKET_PATH_BYTES}): ${socket}`,
    );
  }
  return { channel, kind: "unix-socket", path: socket };
}

export function isCredential(value: unknown): value is string {
  return typeof value === "string" && TOKEN.test(value);
}

/** Constant-time comparison of two byte strings of possibly different length. */
export function constantTimeEqual(a: Buffer, b: Buffer): boolean {
  const digest = (value: Buffer) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(a), digest(b));
}

/**
 * Where the channel credentials live: the secret store of the state directory
 * (WP-21, secrets/store.ts: OS secure storage or owner-only files).
 * Credentials never reach Core, the audit log, logs, the browser or child
 * processes.
 */
export interface CredentialStore {
  /** The credential, or undefined when none exists yet (never creates one). */
  read(channel: ServiceChannel): Promise<string | undefined>;
  /** Read the credential, creating it when it does not exist (service side only). */
  readOrCreate(channel: ServiceChannel): Promise<string>;
}

const credentialName = (channel: ServiceChannel): SecretName =>
  channel === "service" ? "service-token" : "control-token";

/**
 * Credentials in the secret store of `stateDir`. Readers (shim, control
 * client) reopen the store on every read, so they follow a migration done by
 * the service in the meantime. `store` is the service's prepared store.
 */
export function secretCredentialStore(
  stateDir: string,
  privateFiles: PrivateFileProtection,
  options: { readonly store?: SecretStore; readonly host?: SecretStoreHost } = {},
): CredentialStore {
  const open = async () => options.store ?? (await openSecretStore(stateDir, privateFiles, options.host));
  return {
    read: async (channel) => (await open()).read(credentialName(channel)),
    readOrCreate: async (channel) => (await open()).readOrCreate(credentialName(channel)),
  };
}

/** Whether something accepts connections on a POSIX socket path or Windows pipe. */
export function isListening(endpointPath: string, timeoutMs = LIVENESS_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(endpointPath);
    const done = (live: boolean) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(live);
    };
    const timer = setTimeout(() => done(true), timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

function listenOnce(
  endpoint: ServiceEndpoint,
  onConnection: (socket: net.Socket) => void,
): Promise<net.Server | "in_use"> {
  return new Promise((resolve, reject) => {
    const server = net.createServer(onConnection);
    const onError = (error: NodeJS.ErrnoException) => {
      // A pipe created by another user can also surface as EACCES.
      if (error.code === "EADDRINUSE" || (endpoint.kind === "named-pipe" && error.code === "EACCES")) resolve("in_use");
      else
        reject(
          new CrotError(
            "OPERATION_FAILED",
            `Cannot listen on the CROT ${endpoint.channel} endpoint ${endpoint.path}: ${error.message}`,
          ),
        );
    };
    server.once("error", onError);
    server.listen(endpoint.path, () => {
      server.off("error", onError);
      resolve(server);
    });
  });
}

/**
 * Listen on `endpoint` exclusively. Resolves to the server, or "in_use" when
 * another live process listens on it. A POSIX socket file left behind by a
 * crashed service is removed (under a lock, after a connection attempt showed
 * that nobody listens) and the endpoint is taken over. A POSIX socket is
 * restricted to the owner (0600) before the server is returned.
 */
export async function listenExclusive(
  endpoint: ServiceEndpoint,
  onConnection: (socket: net.Socket) => void,
): Promise<net.Server | "in_use"> {
  let server = await listenOnce(endpoint, onConnection);
  if (server === "in_use") {
    if (endpoint.kind === "named-pipe") return "in_use";
    if (await isListening(endpoint.path)) return "in_use";
    const lock = endpoint.path + ".lock";
    if (!(await acquireDirectoryLock(lock, 10_000))) return "in_use";
    try {
      if (await isListening(endpoint.path)) return "in_use";
      await removeStaleSocket(endpoint.path);
      server = await listenOnce(endpoint, onConnection);
      if (server === "in_use") return "in_use";
    } finally {
      await releaseDirectoryLock(lock);
    }
  }
  if (endpoint.kind === "unix-socket") {
    try {
      await chmod(endpoint.path, 0o600);
    } catch (error) {
      server.close();
      throw new CrotError(
        "OPERATION_FAILED",
        `Cannot restrict the CROT ${endpoint.channel} socket ${endpoint.path}: ${(error as Error).message}`,
      );
    }
  }
  return server;
}

export async function removeStaleSocket(socketPath: string): Promise<void> {
  const info = await lstat(socketPath).catch(() => undefined);
  if (!info) return;
  if (!info.isSocket()) {
    throw new CrotError("CONFIG_ERROR", `${socketPath} exists and is not a socket; CROT does not remove it.`);
  }
  await unlink(socketPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}

/** Warn when the POSIX state directory is accessible by other users (the socket and handshake still protect it). */
export async function stateDirectoryWarning(dir: string): Promise<string | undefined> {
  if (process.platform === "win32") return undefined;
  const info = await stat(dir).catch(() => undefined);
  if (!info || (info.mode & 0o077) === 0) return undefined;
  const mode = (info.mode & 0o777).toString(8).padStart(4, "0");
  return `state directory ${dir} has mode ${mode}; the service sockets are restricted to the owner (0600) and every connection must prove the credential`;
}
