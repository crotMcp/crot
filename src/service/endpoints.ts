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
 * Each endpoint has its own credential, a 256-bit random secret in a private
 * file of the state directory (<state>/service-token, <state>/control-token),
 * created owner-only through the platform's PrivateFileProtection (0600, or an
 * owner-only ACL through the Native Host). The credential is never sent: peers
 * prove possession in a challenge-response handshake (channel.ts). Secure OS
 * storage of these credentials is WP-21; the files are the storage until then
 * and are reached only through `CredentialStore`.
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
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, rm, rmdir, stat, unlink, utimes, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { CrotError } from "../core/errors.js";
import type { PrivateFileProtection } from "../core/platform/types.js";

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
const LOCK_STALE_MS = 15_000;

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
 * Where the channel credentials live. The file store below is the WP-20
 * storage (private files); WP-21 replaces it with OS secure storage behind the
 * same interface. Credentials never reach Core, the audit log, logs, the
 * browser or child processes.
 */
export interface CredentialStore {
  /** The credential, or undefined when none exists yet (never creates one). */
  read(channel: ServiceChannel): Promise<string | undefined>;
  /** Read the credential, creating it when it does not exist (service side only). */
  readOrCreate(channel: ServiceChannel): Promise<string>;
}

export function fileCredentialStore(stateDir: string, privateFiles: PrivateFileProtection): CredentialStore {
  return {
    read: (channel) => readCredential(credentialFile(stateDir, channel), channel),
    readOrCreate: async (channel) => {
      await privateFiles.ensureDirectory(stateDir);
      return loadOrCreateCredential(credentialFile(stateDir, channel), channel, privateFiles);
    },
  };
}

async function readCredential(file: string, channel: ServiceChannel): Promise<string | undefined> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new CrotError(
      "CONFIG_ERROR",
      `Cannot read the CROT ${channel} credential ${file}: ${(error as Error).message}`,
    );
  }
  const token = text.trim();
  if (token === "") return undefined; // being created right now
  if (!isCredential(token))
    throw new CrotError(
      "CONFIG_ERROR",
      `The CROT ${channel} credential file ${file} does not contain a valid credential.`,
    );
  return token;
}

/**
 * Same procedure as the HTTP and bridge tokens: where the platform restricts
 * files after creation (protectFile), a new file is created empty, restricted
 * and only then receives the secret; an existing file is restricted before
 * use. Failure to restrict is an error, never a silent downgrade.
 */
async function loadOrCreateCredential(
  file: string,
  channel: ServiceChannel,
  privateFiles: PrivateFileProtection,
): Promise<string> {
  const existing = await readCredential(file, channel);
  if (existing !== undefined) {
    if (privateFiles.protectFile) {
      try {
        await privateFiles.protectFile(file);
      } catch (error) {
        throw new CrotError(
          "CONFIG_ERROR",
          `Cannot restrict access to the CROT ${channel} credential ${file}: ${(error as Error).message}`,
        );
      }
    }
    return existing;
  }
  const token = randomBytes(32).toString("base64url");
  const mode = privateFiles.fileMode !== undefined ? { mode: privateFiles.fileMode } : {};
  try {
    // An empty file left by an interrupted creation is replaced.
    await rm(file, { force: true });
    if (privateFiles.protectFile) {
      await writeFile(file, "", { flag: "wx", ...mode });
      try {
        await privateFiles.protectFile(file);
      } catch (error) {
        await rm(file, { force: true });
        throw error;
      }
      await writeFile(file, token + "\n", { encoding: "utf8", flag: "r+" });
    } else {
      await writeFile(file, token + "\n", { encoding: "utf8", flag: "wx", ...mode });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      const raced = await readCredential(file, channel).catch(() => undefined);
      if (raced) return raced;
    }
    throw new CrotError(
      "CONFIG_ERROR",
      `Cannot create the CROT ${channel} credential ${file}: ${(error as Error).message}`,
    );
  }
  return token;
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

/**
 * Exclusive directory lock (atomic mkdir). A lock older than `staleMs` (its
 * holder crashed) is broken. Breaking is safe against concurrent breakers: the
 * stale lock is first moved aside under a unique name (only one process can
 * move it), and the moved directory must still be the one judged stale (same
 * inode and modification time); a process that moved a lock someone else had
 * just taken puts it back and does not get the lock.
 */
export async function acquireDirectoryLock(lock: string, staleMs = LOCK_STALE_MS): Promise<boolean> {
  try {
    await mkdir(lock, { mode: 0o700 });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const info = await stat(lock).catch(() => undefined);
  if (info && Date.now() - info.mtimeMs <= staleMs) return false;
  if (info) {
    const aside = `${lock}.stale-${process.pid}-${randomBytes(6).toString("hex")}`;
    try {
      await rename(lock, aside);
    } catch {
      return false; // another process broke it first
    }
    const moved = await stat(aside).catch(() => undefined);
    if (!moved || moved.ino !== info.ino || moved.mtimeMs !== info.mtimeMs) {
      await rename(aside, lock).catch(() => rmdir(aside).catch(() => undefined));
      return false;
    }
    await rmdir(aside).catch(() => undefined);
  }
  try {
    await mkdir(lock, { mode: 0o700 });
    return true;
  } catch {
    return false;
  }
}

/** Keep a held lock fresh (its modification time), so it is never judged stale while held. */
export async function refreshDirectoryLock(lock: string): Promise<void> {
  const now = new Date();
  await utimes(lock, now, now).catch(() => undefined);
}

export function releaseDirectoryLock(lock: string): Promise<void> {
  return rmdir(lock).catch(() => undefined);
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
