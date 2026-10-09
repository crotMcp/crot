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
 * - Revocation and re-grant are user actions on the control channel only.
 *   A revoked client stays refused until the user re-grants it (WP-28).
 *   A re-grant records `grantedAt`: access tokens issued before it are not
 *   accepted for that client (the relay entry point answers 401, the client
 *   gets a fresh token), so a token obtained before the revocation never
 *   becomes usable again.
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
  /** Last re-grant by the user: tokens issued before it are not accepted for this client. */
  readonly grantedAt?: string;
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
    if (c.grantedAt !== undefined && (typeof c.grantedAt !== "string" || !Number.isFinite(Date.parse(c.grantedAt))))
      return undefined;
    const record: RemoteClientRecord = {
      accountId: c.accountId,
      deviceId: c.deviceId,
      clientId: c.clientId,
      firstSeen: c.firstSeen,
      lastSeen: c.lastSeen,
      ...(c.revokedAt !== undefined ? { revokedAt: c.revokedAt } : {}),
      ...(c.grantedAt !== undefined ? { grantedAt: c.grantedAt } : {}),
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

export type RegrantResult =
  | { readonly ok: true; readonly persisted: true; readonly grantedAt: string }
  | { readonly ok: false; readonly reason: "unknown_client" | "not_revoked" | "state_unavailable" | "write_failed" };

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
    return sortByLastSeen(this.clients);
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

  /**
   * Whether an access token issued at `issuedAt` (seconds) does not
   * postdate the client's last re-grant. `iat` has second precision, so a
   * token issued in the second of the re-grant is refused as well (it may
   * have been issued before it); the client gets a new token a second later.
   */
  predatesGrant(id: RemoteClientId, issuedAt: number | undefined): boolean {
    const grantedAt = this.clients.get(remoteClientKey(id))?.grantedAt;
    if (grantedAt === undefined) return false;
    if (issuedAt === undefined || !Number.isFinite(issuedAt)) return true;
    return issuedAt <= Math.floor(Date.parse(grantedAt) / 1000);
  }

  /**
   * Re-grant a revoked client (user action). It widens access, so it takes
   * effect only when it was written: on a write failure the client stays
   * revoked.
   */
  async regrant(id: RemoteClientId): Promise<RegrantResult> {
    if (this.failedClosed) return { ok: false, reason: "state_unavailable" };
    const key = remoteClientKey(id);
    const existing = this.clients.get(key);
    if (!existing) return { ok: false, reason: "unknown_client" };
    if (existing.revokedAt === undefined) return { ok: false, reason: "not_revoked" };
    const grantedAt = new Date(this.now()).toISOString();
    const { revokedAt: _revoked, ...rest } = existing;
    const regranted: RemoteClientRecord = { ...rest, grantedAt };
    // Written before it takes effect: no request is admitted on a re-grant that is not on disk.
    // It takes effect inside the same queued write, so a background write queued meanwhile
    // serializes the re-granted state rather than the revoked one.
    const next = new Map(this.clients).set(key, regranted);
    try {
      await this.write(next, () => {
        const { revokedAt: _r, ...current } = this.clients.get(key) ?? regranted;
        this.clients.set(key, { ...current, grantedAt });
      });
    } catch (error) {
      this.onError(error);
      return { ok: false, reason: "write_failed" };
    }
    return { ok: true, persisted: true, grantedAt };
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

  /**
   * Queue a write of `snapshot` (default: the current state). `written` runs once it is on
   * disk, before the next queued write starts.
   */
  private write(snapshot?: ReadonlyMap<string, RemoteClientRecord>, written?: () => void): Promise<void> {
    const run = async () => {
      if (this.file !== undefined && this.privateFiles !== undefined) {
        const text =
          JSON.stringify({ version: FORMAT_VERSION, clients: sortByLastSeen(snapshot ?? this.clients) }) + "\n";
        await writeStateFile(this.file, text, this.privateFiles);
      }
      written?.();
    };
    const next = this.writing.catch(() => undefined).then(run);
    this.writing = next.catch(() => undefined);
    return next;
  }
}

function sortByLastSeen(clients: ReadonlyMap<string, RemoteClientRecord>): RemoteClientRecord[] {
  return [...clients.values()].sort((a, b) => (a.lastSeen < b.lastSeen ? 1 : a.lastSeen > b.lastSeen ? -1 : 0));
}
