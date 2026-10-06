/**
 * Remote clients of this device and their revocation (ARCHITECTURE.md §27,
 * AD-19 point 8; AD-15 points 4 and 8).
 *
 * A remote client is the triple (accountId, deviceId, clientId), the remote
 * exposure scope of AD-15 point 8. The registry keeps only these
 * identifiers, when the client was first and last seen at the relay entry
 * point, and when the user revoked it — no names, tokens, addresses or other
 * personal data. It is stored in the service's protected private state.
 *
 * - Revocation is a user action on the control channel only; there is no
 *   re-grant in WP-22 (WP-28). A revoked client stays refused.
 * - Fail closed: if the stored state cannot be read or is malformed, every
 *   remote request is refused, and the file is left untouched.
 */
import type { PrivateFileProtection } from "../core/platform/types.js";
import { isRecord, readStateFile, writeStateFile } from "./private-state.js";

export const REMOTE_CLIENTS_FILE_NAME = "remote-clients.json";
const FORMAT_VERSION = 1;
/** Longest identifier kept (longer ones are never admitted as a client of this device). */
export const MAX_REMOTE_ID_LENGTH = 512;
/** Most clients kept; the oldest clients that are not revoked are forgotten first. */
export const MAX_REMOTE_CLIENTS = 1_000;
/** lastSeen is written to disk at most this often per client. */
const SEEN_PERSIST_INTERVAL_MS = 60_000;

export interface RemoteClientId {
  readonly accountId: string;
  readonly deviceId: string;
  readonly clientId: string;
}

export interface RemoteClientRecord extends RemoteClientId {
  readonly firstSeen: string;
  readonly lastSeen: string;
  readonly revokedAt?: string;
}

export function isValidRemoteId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_REMOTE_ID_LENGTH && !/[\0]/.test(value);
}

export function remoteClientKey(id: RemoteClientId): string {
  return JSON.stringify([id.accountId, id.deviceId, id.clientId]);
}

function parse(text: string): Map<string, RemoteClientRecord> | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || value.version !== FORMAT_VERSION || !Array.isArray(value.clients)) return undefined;
  const clients = new Map<string, RemoteClientRecord>();
  for (const c of value.clients) {
    if (!isRecord(c)) return undefined;
    if (!isValidRemoteId(c.accountId) || !isValidRemoteId(c.deviceId) || !isValidRemoteId(c.clientId)) return undefined;
    if (typeof c.firstSeen !== "string" || typeof c.lastSeen !== "string") return undefined;
    if (c.revokedAt !== undefined && typeof c.revokedAt !== "string") return undefined;
    const record: RemoteClientRecord = {
      accountId: c.accountId,
      deviceId: c.deviceId,
      clientId: c.clientId,
      firstSeen: c.firstSeen,
      lastSeen: c.lastSeen,
      ...(c.revokedAt !== undefined ? { revokedAt: c.revokedAt } : {}),
    };
    clients.set(remoteClientKey(record), record);
  }
  return clients;
}

export interface RemoteClientRegistryOptions {
  /** Persistence problems (never identifiers or credentials). */
  readonly onError?: (error: unknown) => void;
  readonly now?: () => number;
}

export type RevokeResult =
  | { readonly ok: true; readonly persisted: boolean }
  | { readonly ok: false; readonly reason: "unknown_client" | "already_revoked" | "state_unavailable" };

export class RemoteClientRegistry {
  private readonly lastPersisted = new Map<string, number>();
  private writing: Promise<void> = Promise.resolve();

  private constructor(
    readonly file: string | undefined,
    private readonly privateFiles: PrivateFileProtection | undefined,
    private readonly clients: Map<string, RemoteClientRecord>,
    /** Why the stored state could not be read; undefined when it could. */
    readonly error: string | undefined,
    private readonly onError: (error: unknown) => void,
    private readonly now: () => number,
  ) {}

  /** A registry without persistence (tests, embedding). */
  static inMemory(options: RemoteClientRegistryOptions = {}): RemoteClientRegistry {
    return new RemoteClientRegistry(
      undefined,
      undefined,
      new Map(),
      undefined,
      options.onError ?? (() => undefined),
      options.now ?? Date.now,
    );
  }

  static async open(
    file: string,
    privateFiles: PrivateFileProtection,
    options: RemoteClientRegistryOptions = {},
  ): Promise<RemoteClientRegistry> {
    const onError = options.onError ?? (() => undefined);
    const now = options.now ?? Date.now;
    const failed = (error: string) => new RemoteClientRegistry(file, privateFiles, new Map(), error, onError, now);
    let read;
    try {
      read = await readStateFile(file);
    } catch (error) {
      return failed(`cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (read.kind === "missing")
      return new RemoteClientRegistry(file, privateFiles, new Map(), undefined, onError, now);
    const clients = parse(read.text);
    if (!clients) return failed(`${file} is malformed`);
    return new RemoteClientRegistry(file, privateFiles, clients, undefined, onError, now);
  }

  /** Whether the stored state could not be read: every remote request is refused. */
  get failedClosed(): boolean {
    return this.error !== undefined;
  }

  list(): RemoteClientRecord[] {
    return [...this.clients.values()].sort((a, b) => (a.lastSeen < b.lastSeen ? 1 : a.lastSeen > b.lastSeen ? -1 : 0));
  }

  get(id: RemoteClientId): RemoteClientRecord | undefined {
    return this.clients.get(remoteClientKey(id));
  }

  /** Revoked, or unknown because the state failed closed. */
  isRevoked(id: RemoteClientId): boolean {
    return this.failedClosed || this.clients.get(remoteClientKey(id))?.revokedAt !== undefined;
  }

  /**
   * Record that an admitted client made a request. A new client is written
   * at once; lastSeen at most once a minute. Write failures are reported only.
   * Returns true when the client was new.
   */
  seen(id: RemoteClientId): boolean {
    if (this.failedClosed) return false;
    const key = remoteClientKey(id);
    const at = new Date(this.now()).toISOString();
    const existing = this.clients.get(key);
    if (existing) {
      this.clients.set(key, { ...existing, lastSeen: at });
      if (this.now() - (this.lastPersisted.get(key) ?? 0) >= SEEN_PERSIST_INTERVAL_MS) this.persist(key);
      return false;
    }
    this.clients.set(key, {
      accountId: id.accountId,
      deviceId: id.deviceId,
      clientId: id.clientId,
      firstSeen: at,
      lastSeen: at,
    });
    this.trim();
    this.persist(key);
    return true;
  }

  /**
   * Revoke a known client. The revocation holds in memory at once, even if it
   * cannot be written (`persisted: false`, reported to the user).
   */
  async revoke(id: RemoteClientId): Promise<RevokeResult> {
    if (this.failedClosed) return { ok: false, reason: "state_unavailable" };
    const key = remoteClientKey(id);
    const existing = this.clients.get(key);
    if (!existing) return { ok: false, reason: "unknown_client" };
    if (existing.revokedAt !== undefined) return { ok: false, reason: "already_revoked" };
    this.clients.set(key, { ...existing, revokedAt: new Date(this.now()).toISOString() });
    try {
      await this.write();
      return { ok: true, persisted: true };
    } catch (error) {
      this.onError(error);
      return { ok: true, persisted: this.file === undefined };
    }
  }

  /** Wait for background writes (tests, shutdown). */
  async flush(): Promise<void> {
    await this.writing.catch(() => undefined);
  }

  private trim(): void {
    if (this.clients.size <= MAX_REMOTE_CLIENTS) return;
    const forgettable = this.list()
      .filter((c) => c.revokedAt === undefined)
      .reverse();
    for (const c of forgettable) {
      if (this.clients.size <= MAX_REMOTE_CLIENTS) break;
      this.clients.delete(remoteClientKey(c));
    }
  }

  private persist(key: string): void {
    this.lastPersisted.set(key, this.now());
    this.write().catch((error: unknown) => this.onError(error));
  }

  private write(): Promise<void> {
    const run = async () => {
      if (this.file === undefined || this.privateFiles === undefined) return;
      const text = JSON.stringify({ version: FORMAT_VERSION, clients: this.list() }) + "\n";
      await writeStateFile(this.file, text, this.privateFiles);
    };
    const next = this.writing.catch(() => undefined).then(run);
    this.writing = next.catch(() => undefined);
    return next;
  }
}
