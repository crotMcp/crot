import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PrivateFileProtection } from "../platform/types.js";

/**
 * Persistent exposure state of remote scopes (ARCHITECTURE.md §27, AD-15
 * point 8; constraint C5).
 *
 * - A remote scope (accountId, deviceId, clientId) is `clean` until a source
 *   operation succeeds for it, then `exposed`. The state survives CROT
 *   restarts: it is stored in CROT's private state (a protected path that no
 *   CROT tool can modify).
 * - It fails closed: if the stored state cannot be read or is malformed,
 *   every remote scope is treated as exposed, and the file is left untouched.
 * - There is deliberately no reset here. A reset exists only as an explicit
 *   user action in an approval provider or as revocation of the client's
 *   access (WP-22); no tool, request, token claim or configuration value can
 *   clear a scope.
 *
 * Only SHA-256 digests of the scope keys are stored, never account, device or
 * client identifiers in clear text.
 */
export const REMOTE_EXPOSURE_FILE_NAME = "remote-exposure.json";

const FORMAT_VERSION = 1;

interface StoredState {
  readonly version: typeof FORMAT_VERSION;
  readonly exposed: readonly string[];
}

function digest(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

function parseState(text: string): Set<string> | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const state = value as Partial<StoredState>;
  if (state.version !== FORMAT_VERSION || !Array.isArray(state.exposed)) return undefined;
  if (!state.exposed.every((d) => typeof d === "string" && /^[0-9a-f]{64}$/.test(d))) return undefined;
  return new Set(state.exposed);
}

export interface RemoteExposureStoreOptions {
  /** Receives persistence failures (never identifiers or credentials). */
  readonly onError?: (error: unknown) => void;
}

export class RemoteExposureStore {
  private constructor(
    /** The state file; undefined for an in-memory store (tests, embedding). */
    readonly file: string | undefined,
    private readonly exposed: Set<string>,
    /** The stored state could not be read: every remote scope is exposed. */
    readonly failedClosed: boolean,
    private readonly onError: (error: unknown) => void,
  ) {}

  /** A store without persistence (tests, embedding). Starts clean. */
  static inMemory(): RemoteExposureStore {
    return new RemoteExposureStore(undefined, new Set(), false, () => undefined);
  }

  /**
   * Open the state file, creating it (owner-only where the platform supports
   * it) when it does not exist. Any other problem reading it fails closed.
   */
  static async open(
    file: string,
    privateFiles: PrivateFileProtection,
    options: RemoteExposureStoreOptions = {},
  ): Promise<RemoteExposureStore> {
    const onError = options.onError ?? (() => undefined);
    let text: string | undefined;
    try {
      text = await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        onError(error);
        return new RemoteExposureStore(file, new Set(), true, onError);
      }
    }
    if (text !== undefined) {
      const exposed = parseState(text);
      if (!exposed) {
        onError(
          new Error(`The remote exposure state ${file} is malformed; every remote client is treated as exposed.`),
        );
        return new RemoteExposureStore(file, new Set(), true, onError);
      }
      try {
        if (privateFiles.protectFile) await privateFiles.protectFile(file);
      } catch (error) {
        onError(error);
        return new RemoteExposureStore(file, exposed, true, onError);
      }
      return new RemoteExposureStore(file, exposed, false, onError);
    }
    // First start: create an empty, private state file.
    try {
      await privateFiles.ensureDirectory(path.dirname(file));
      const mode = privateFiles.fileMode !== undefined ? { mode: privateFiles.fileMode } : {};
      await writeFile(file, "", { flag: "wx", ...mode });
      if (privateFiles.protectFile) {
        try {
          await privateFiles.protectFile(file);
        } catch (error) {
          await rm(file, { force: true });
          throw error;
        }
      }
      await writeFile(file, serialize(new Set()), { encoding: "utf8", flag: "r+" });
    } catch (error) {
      onError(error);
      return new RemoteExposureStore(file, new Set(), true, onError);
    }
    return new RemoteExposureStore(file, new Set(), false, onError);
  }

  isExposed(remoteKey: string): boolean {
    return this.failedClosed || this.exposed.has(digest(remoteKey));
  }

  /**
   * Record that a remote scope is exposed. The in-memory state changes first
   * and never goes back; the file is rewritten synchronously so that the state
   * is on disk before the source operation's result is returned.
   */
  markExposed(remoteKey: string): void {
    const d = digest(remoteKey);
    if (this.exposed.has(d)) return;
    this.exposed.add(d);
    if (this.file === undefined || this.failedClosed) return;
    try {
      // Rewrites the existing private file in place, which keeps its mode and ACL.
      writeFileSync(this.file, serialize(this.exposed), { encoding: "utf8", flag: "w" });
    } catch (error) {
      this.onError(error);
    }
  }
}

function serialize(exposed: ReadonlySet<string>): string {
  const state: StoredState = { version: FORMAT_VERSION, exposed: [...exposed].sort() };
  return JSON.stringify(state) + "\n";
}
