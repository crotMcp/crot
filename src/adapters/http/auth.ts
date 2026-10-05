import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { CrotError } from "../../core/errors.js";
import type { PrivateFileProtection } from "../../core/platform/types.js";

/**
 * Authentication seam of the HTTP transport.
 *
 * A verifier turns a presented bearer credential into the SDK's AuthInfo, or
 * rejects it. It establishes *who* is calling; it never decides *what* the
 * caller may do: authorization stays with the Core PermissionEngine.
 *
 * The shape matches the SDK's OAuth token verifier, so a future OAuth/OIDC
 * resource-server verifier (user/device identity, commercial accounts) can
 * replace the provisional local token without changes to the HTTP server,
 * the MCP tools, Core or the PermissionEngine.
 *
 * Conventions for AuthInfo.extra (read by principalFromAuthInfo, AD-15):
 * - subject: stable principal id (falls back to clientId)
 * - authMethod: how the principal was authenticated
 * - accountId, deviceId: remote identity, required on the relay entry point
 *   (together with AuthInfo.clientId); a "local-token" credential is never
 *   accepted there.
 */
export interface AccessTokenVerifier {
  /** Authentication method recorded on the principal, e.g. "local-token". */
  readonly method: string;
  /** Resolve with AuthInfo for a valid credential, undefined for an invalid one. */
  verifyAccessToken(token: string): Promise<AuthInfo | undefined>;
}

/** Default token file name inside the platform state directory. */
export const DEFAULT_HTTP_TOKEN_FILE_NAME = "http-token";

const MIN_TOKEN_LENGTH = 32;

const sha256 = (value: string): Buffer => createHash("sha256").update(value, "utf8").digest();

/**
 * Provisional local-token verifier: a single random bearer token shared with
 * local clients through a private file. Intended for loopback use only; it is
 * not a remote-security solution.
 *
 * Tokens are compared as SHA-256 digests in constant time. Only a short
 * fingerprint of the token is ever exposed (principal id, logs).
 */
export class LocalTokenVerifier implements AccessTokenVerifier {
  readonly method = "local-token";
  /** First 12 hex digits of the token's SHA-256 digest. */
  readonly fingerprint: string;
  private readonly digest: Buffer;

  constructor(token: string) {
    if (token.length < MIN_TOKEN_LENGTH) {
      throw new CrotError(
        "CONFIG_ERROR",
        `The HTTP access token must be at least ${MIN_TOKEN_LENGTH} characters long.`,
      );
    }
    this.digest = sha256(token);
    this.fingerprint = this.digest.toString("hex").slice(0, 12);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo | undefined> {
    if (!timingSafeEqual(sha256(token), this.digest)) return undefined;
    const subject = `local-token:${this.fingerprint}`;
    return { token, clientId: subject, scopes: [], extra: { subject, authMethod: this.method } };
  }
}

/** Generate a new random access token (256 bits, base64url). */
export function generateAccessToken(): string {
  return randomBytes(32).toString("base64url");
}

async function readToken(file: string): Promise<string | undefined> {
  try {
    return (await readFile(file, "utf8")).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new CrotError("CONFIG_ERROR", `Cannot read the HTTP token file ${file}: ${(error as Error).message}`);
  }
}

/**
 * Read the local token from `file`, creating it (owner-only where the
 * platform supports it) when it does not exist.
 *
 * Where the platform restricts files after creation (protectFile, Windows
 * ACLs through the Native Host), a new file is created empty, restricted, and
 * only then receives the token; an existing file is restricted before use.
 * Failure to restrict is an error, never a silent downgrade.
 */
export async function loadOrCreateLocalToken(
  file: string,
  privateFiles: PrivateFileProtection,
): Promise<{ token: string; created: boolean }> {
  const existing = await readToken(file);
  if (existing !== undefined) {
    if (existing.length === 0) throw new CrotError("CONFIG_ERROR", `The HTTP token file ${file} is empty.`);
    if (privateFiles.protectFile) {
      try {
        await privateFiles.protectFile(file);
      } catch (error) {
        throw new CrotError(
          "CONFIG_ERROR",
          `Cannot restrict access to the HTTP token file ${file}: ${(error as Error).message}`,
        );
      }
    }
    return { token: existing, created: false };
  }
  await privateFiles.ensureDirectory(path.dirname(file));
  const token = generateAccessToken();
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
      await writeFile(file, `${token}\n`, { encoding: "utf8", flag: "r+" });
    } else {
      await writeFile(file, `${token}\n`, { encoding: "utf8", flag: "wx", ...mode });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      const raced = await readToken(file);
      if (raced) return { token: raced, created: false };
    }
    throw new CrotError("CONFIG_ERROR", `Cannot create the HTTP token file ${file}: ${(error as Error).message}`);
  }
  return { token, created: true };
}
