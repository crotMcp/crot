import { randomUUID } from "node:crypto";
import { appendFile, mkdir, open } from "node:fs/promises";
import path from "node:path";
import type { AuditApproval } from "../approvals/types.js";
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
  /** Network destinations (scheme, host, port, addresses used), for network.access operations. */
  readonly network?: readonly {
    readonly scheme: string;
    readonly host: string;
    readonly port: number;
    readonly addresses?: readonly string[];
  }[];
  readonly outcome: "success" | "error" | "denied";
  readonly durationMs: number;
  readonly error?: { readonly code: string; readonly message: string };
  /** Audit-safe operation summary (e.g. command line, flags). */
  readonly details?: Readonly<Record<string, unknown>>;
  /**
   * Present when an approval gate rule matched the operation (AD-5, AD-7):
   * request id, terminal status, rule, subject digest and timing. Never the
   * approval subject itself.
   */
  readonly approval?: AuditApproval;
}

/**
 * Mandatory approval audit record (ARCHITECTURE.md §27, AD-7): written after
 * an approval and the re-authorization, before the operation is executed. If
 * it cannot be written, the operation is refused.
 *
 * It records that the operation was approved and authorized; it does **not**
 * state that the operation ran or succeeded (it has no `outcome`). The
 * execution result is only in the operation's event written afterwards with
 * the same `approval.requestId`; a record without that event means the result
 * is unknown.
 */
export interface ApprovalAuditRecord extends Omit<AuditEvent, "outcome" | "error" | "approval"> {
  readonly kind: "approval";
  readonly outcome?: undefined;
  readonly error?: undefined;
  readonly approval: AuditApproval;
}

/** Everything an audit sink receives. */
export type AuditRecord = AuditEvent | ApprovalAuditRecord;

/** Destination for audit events. Implementations must not transmit data off the machine. */
export interface AuditSink {
  record(event: AuditRecord): Promise<void>;
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
  readonly events: AuditRecord[] = [];
  async record(event: AuditRecord): Promise<void> {
    this.events.push(event);
  }
}

/** Writes one JSON line per event to a writable stream (stderr for local stdio servers). */
export class StreamAuditSink implements AuditSink {
  constructor(
    private readonly stream: NodeJS.WritableStream,
    private readonly flushTimeoutMs = 2_000,
  ) {}
  async record(event: AuditRecord): Promise<void> {
    this.stream.write(`${JSON.stringify({ type: "crot.audit", ...event })}\n`);
  }

  /**
   * Wait until buffered events have been handed to the OS. Pipes are
   * asynchronous on macOS and Windows, so exiting right away could lose them.
   */
  close(): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, this.flushTimeoutMs);
      timer.unref();
      try {
        this.stream.write("", () => {
          clearTimeout(timer);
          resolve();
        });
      } catch {
        clearTimeout(timer);
        resolve();
      }
    });
  }
}

/** How the audit file and its directory are created (the platform's PrivateFileProtection). */
export interface AuditFileProtection {
  ensureDirectory(dir: string): Promise<void>;
  readonly fileMode: number | undefined;
  /** Restrict an existing file (Windows ACLs via the Native Host); called before the first event is written. */
  protectFile?(file: string): Promise<void>;
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
 * (owner-only on POSIX; inherited ACLs on Windows with Core; explicit
 * owner-only ACLs on Windows with the Native Host).
 */
export class JsonlFileAuditSink implements AuditSink {
  private queue: Promise<void> = Promise.resolve();
  private ready: Promise<void> | undefined;

  constructor(
    readonly file: string,
    private readonly protection: AuditFileProtection = POSIX_PRIVATE,
  ) {}

  record(event: AuditRecord): Promise<void> {
    this.ready ??= this.prepare();
    const options = this.protection.fileMode !== undefined ? { mode: this.protection.fileMode } : {};
    const write = this.queue
      .then(() => this.ready)
      .then(() => appendFile(this.file, `${JSON.stringify(event)}\n`, options));
    this.queue = write.catch(() => undefined);
    return write;
  }

  async close(): Promise<void> {
    await this.queue;
  }

  /** Create the directory; where protection is applied after creation, create and restrict the file before any event is written. */
  private async prepare(): Promise<void> {
    await this.protection.ensureDirectory(path.dirname(this.file));
    if (!this.protection.protectFile) return;
    const handle = await open(this.file, "a", this.protection.fileMode);
    await handle.close();
    await this.protection.protectFile(this.file);
  }
}
