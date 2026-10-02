/**
 * Browser-bridge endpoint and access token (ARCHITECTURE.md §16).
 *
 * The CROT Host that owns the bridge listens on a per-user local endpoint:
 * - POSIX: the Unix domain socket <state>/browser.sock. The state directory is
 *   created owner-only (0700) and the socket is restricted to the owner (0600).
 * - Windows: a named pipe whose name is derived from the bridge token
 *   (\\\\.\\pipe\\crot-browser-<digest>), so other users cannot predict it.
 *   Named pipes created by Node.js grant write access only to the creating
 *   user, LocalSystem and Administrators.
 *
 * crot-browser-relay, launched by the browser as the same user, proves that it
 * runs as the CROT user by presenting the token stored in <state>/browser-token,
 * a private file protected by the platform's PrivateFileProtection (0600, or an
 * owner-only ACL through the Native Host). The relay reads the token and
 * derives the endpoint with the functions below.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { CrotError } from "../core/errors.js";
import type { PrivateFileProtection } from "../core/platform/types.js";

export const BROWSER_TOKEN_FILE_NAME = "browser-token";
export const BROWSER_SOCKET_FILE_NAME = "browser.sock";
/** Longest Unix socket path accepted (macOS allows 104 bytes including the terminating NUL; Linux 108). */
export const MAX_SOCKET_PATH_BYTES = 103;

/** Same format as the relay auth token of the protocol: base64url, 32-256 characters. */
const TOKEN = /^[A-Za-z0-9_-]{32,256}$/;
const PIPE_PREFIX = "\\\\.\\pipe\\crot-browser-";

export interface BridgeEndpoint {
  readonly kind: "unix-socket" | "named-pipe";
  /** Socket path or pipe name, as passed to net.Server.listen / net.connect. */
  readonly path: string;
}

export function bridgeTokenFile(stateDir: string): string {
  return path.join(stateDir, BROWSER_TOKEN_FILE_NAME);
}

/** Endpoint of the bridge for a state directory and token. */
export function bridgeEndpoint(stateDir: string, token: string, windows: boolean = process.platform === "win32"): BridgeEndpoint {
  if (windows) {
    const digest = createHash("sha256").update("crot-browser-pipe\u0000" + token, "utf8").digest("hex").slice(0, 32);
    return { kind: "named-pipe", path: PIPE_PREFIX + digest };
  }
  const socket = path.join(stateDir, BROWSER_SOCKET_FILE_NAME);
  const bytes = Buffer.byteLength(socket, "utf8");
  if (bytes > MAX_SOCKET_PATH_BYTES) {
    throw new CrotError(
      "CONFIG_ERROR",
      "The browser bridge socket path is too long (" + bytes + " bytes, at most " + MAX_SOCKET_PATH_BYTES + "): " + socket,
    );
  }
  return { kind: "unix-socket", path: socket };
}

export function isBridgeToken(value: unknown): value is string {
  return typeof value === "string" && TOKEN.test(value);
}

/** New random bridge token (256 bits, base64url). */
export function generateBridgeToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Constant-time comparison of two tokens (as SHA-256 digests, so lengths do not leak). */
export function tokensEqual(a: string, b: string): boolean {
  const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();
  return timingSafeEqual(digest(a), digest(b));
}

/** Read the bridge token; undefined when the file does not exist. Throws CONFIG_ERROR for an unreadable or invalid file. */
export async function readBridgeToken(file: string): Promise<string | undefined> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new CrotError("CONFIG_ERROR", "Cannot read the browser bridge token file " + file + ": " + (error as Error).message);
  }
  const token = text.trim();
  if (!isBridgeToken(token)) throw new CrotError("CONFIG_ERROR", "The browser bridge token file " + file + " does not contain a valid token.");
  return token;
}

/**
 * Read the bridge token from `file`, creating it when it does not exist
 * (same procedure as the HTTP token): where the platform restricts files
 * after creation (protectFile), a new file is created empty, restricted and
 * only then receives the token, and an existing file is restricted before
 * use. Failure to restrict is an error, never a silent downgrade.
 */
export async function loadOrCreateBridgeToken(file: string, privateFiles: PrivateFileProtection): Promise<{ token: string; created: boolean }> {
  const existing = await readBridgeToken(file);
  if (existing !== undefined) {
    if (privateFiles.protectFile) {
      try {
        await privateFiles.protectFile(file);
      } catch (error) {
        throw new CrotError("CONFIG_ERROR", "Cannot restrict access to the browser bridge token file " + file + ": " + (error as Error).message);
      }
    }
    return { token: existing, created: false };
  }
  await privateFiles.ensureDirectory(path.dirname(file));
  const token = generateBridgeToken();
  const mode = privateFiles.fileMode !== undefined ? { mode: privateFiles.fileMode } : {};
  try {
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
      const raced = await readBridgeToken(file).catch(() => undefined);
      if (raced) return { token: raced, created: false };
    }
    throw new CrotError("CONFIG_ERROR", "Cannot create the browser bridge token file " + file + ": " + (error as Error).message);
  }
  return { token, created: true };
}
