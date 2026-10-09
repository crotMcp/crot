/**
 * Structured relay log records (ARCHITECTURE.md §27 AD-22 points 14–15,
 * AD-15 point 10).
 *
 * The relay must not log or store bodies or headers other than method,
 * `Mcp-Method`, status, sizes, durations and codes. Records are built only
 * from the typed fields below, every string field is reduced to a safe
 * vocabulary, and there is no free-text message field that could carry a
 * token, a header, a body or a path.
 */
export interface RelayLogRecord {
  readonly event: string;
  readonly deviceId?: string;
  readonly tunnelId?: string;
  readonly stream?: number;
  readonly method?: string;
  readonly mcpMethod?: string;
  readonly status?: number;
  readonly outcome?: string;
  readonly code?: string;
  readonly closeCode?: number;
  readonly requestBytes?: number;
  readonly responseBytes?: number;
  readonly durationMs?: number;
  readonly software?: string;
  readonly count?: number;
}

export type RelayLogger = (record: RelayLogRecord) => void;

const SAFE = /^[A-Za-z0-9_./:-]{1,64}$/;

/** A field value reduced to the safe vocabulary (anything else is reported as "invalid"). */
export function safeToken(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return SAFE.test(value) ? value : "invalid";
}

/** Normalize a record: only known fields, safe strings, finite numbers. */
export function sanitizeRecord(record: RelayLogRecord): RelayLogRecord {
  const out: Record<string, string | number> = { event: safeToken(record.event) ?? "invalid" };
  const strings = ["deviceId", "tunnelId", "method", "mcpMethod", "outcome", "code", "software"] as const;
  const numbers = ["stream", "status", "closeCode", "requestBytes", "responseBytes", "durationMs", "count"] as const;
  for (const k of strings) {
    const v = record[k];
    if (typeof v === "string") out[k] = safeToken(v)!;
  }
  for (const k of numbers) {
    const v = record[k];
    if (typeof v === "number" && Number.isFinite(v)) out[k] = Math.round(v);
  }
  return out as unknown as RelayLogRecord;
}

/** JSON lines on a stream (default: stderr). */
export function jsonLineLogger(write: (line: string) => void = (l) => process.stderr.write(l)): RelayLogger {
  return (record) => write(JSON.stringify({ time: new Date().toISOString(), ...sanitizeRecord(record) }) + "\n");
}
