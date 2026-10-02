import { randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { Principal } from "../auth/principal.js";
import type { Capability } from "../permissions/capabilities.js";

/**
 * One audited Core operation. Events describe *what* was done and by whom;
 * they never contain file contents, command output, stdin or environment values.
 */
export interface AuditEvent {
  readonly id: string;
  readonly timestamp: string;
  readonly operation: string;
  readonly capabilities: readonly Capability[];
  readonly principal: Principal;
  readonly requestId?: string;
  /** Absolute paths touched by the operation. */
  readonly paths: readonly string[];
  readonly outcome: "success" | "error" | "denied";
  readonly durationMs: number;
  readonly error?: { readonly code: string; readonly message: string };
  /** Audit-safe operation summary (e.g. command line, flags). */
  readonly details?: Readonly<Record<string, unknown>>;
}

/** Destination for audit events. Implementations must not transmit data off the machine. */
export interface AuditSink {
  record(event: AuditEvent): Promise<void>;
  close?(): Promise<void>;
}

export function newAuditEventId(): string {
  return randomUUID();
}

export class NullAuditSink implements AuditSink {
  async record(): Promise<void> {}
}

/** In-memory sink, useful for tests and embedding. */
export class MemoryAuditSink implements AuditSink {
  readonly events: AuditEvent[] = [];
  async record(event: AuditEvent): Promise<void> {
    this.events.push(event);
  }
}

/** Writes one JSON line per event to a writable stream (stderr for local stdio servers). */
export class StreamAuditSink implements AuditSink {
  constructor(private readonly stream: NodeJS.WritableStream) {}
  async record(event: AuditEvent): Promise<void> {
    this.stream.write(`${JSON.stringify({ type: "crot.audit", ...event })}\n`);
  }
}

/** How the audit file and its directory are created (the platform's PrivateFileProtection). */
export interface AuditFileProtection {
  ensureDirectory(dir: string): Promise<void>;
  readonly fileMode: number | undefined;
}

/** POSIX owner-only defaults, used when no platform protection is supplied. */
const POSIX_PRIVATE: AuditFileProtection = {
  ensureDirectory: async (dir) => {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  },
  fileMode: 0o600,
};

/**
 * Appends JSON lines to a local file. Writes are serialized. The file and
 * directory are created through the platform's private-file protection
 * (owner-only on POSIX; inherited ACLs on Windows).
 */
export class JsonlFileAuditSink implements AuditSink {
  private queue: Promise<void> = Promise.resolve();
  private ready: Promise<void> | undefined;

  constructor(
    readonly file: string,
    private readonly protection: AuditFileProtection = POSIX_PRIVATE,
  ) {}

  record(event: AuditEvent): Promise<void> {
    this.ready ??= this.protection.ensureDirectory(path.dirname(this.file));
    const options = this.protection.fileMode !== undefined ? { mode: this.protection.fileMode } : {};
    const write = this.queue.then(() => this.ready).then(() => appendFile(this.file, `${JSON.stringify(event)}\n`, options));
    this.queue = write.catch(() => undefined);
    return write;
  }

  async close(): Promise<void> {
    await this.queue;
  }
}
