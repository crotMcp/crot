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

/** Appends JSON lines to a local file (created with owner-only permissions). Writes are serialized. */
export class JsonlFileAuditSink implements AuditSink {
  private queue: Promise<void> = Promise.resolve();
  private ready: Promise<void> | undefined;

  constructor(readonly file: string) {}

  record(event: AuditEvent): Promise<void> {
    this.ready ??= mkdir(path.dirname(this.file), { recursive: true }).then(() => undefined);
    const write = this.queue.then(() => this.ready).then(() => appendFile(this.file, `${JSON.stringify(event)}\n`, { mode: 0o600 }));
    this.queue = write.catch(() => undefined);
    return write;
  }

  async close(): Promise<void> {
    await this.queue;
  }
}
