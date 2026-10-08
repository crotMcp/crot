/**
 * Minimal HTTP/1.1 request framing for the Docker endpoint: request heads,
 * Content-Length and chunked bodies. Bodies that are not inspected are
 * forwarded as they arrive; only the framing is tracked so the next request
 * on a keep-alive connection is found.
 */

export interface RequestHead {
  readonly method: string;
  readonly target: string;
  readonly version: string;
  /** Header lines as received (name and value), in order. */
  readonly headers: readonly (readonly [string, string])[];
  /** Raw bytes of the head including the final CRLFCRLF. */
  readonly raw: Buffer;
}

export const MAX_HEAD_BYTES = 64 * 1024;

export function header(head: RequestHead, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of head.headers) if (k.toLowerCase() === lower) return v;
  return undefined;
}

/** Parse a request head at the start of `buffer`; null when incomplete. Throws on malformed input. */
export function parseHead(buffer: Buffer): { head: RequestHead; rest: Buffer } | null {
  const end = buffer.indexOf("\r\n\r\n");
  if (end < 0) {
    if (buffer.length > MAX_HEAD_BYTES) throw new Error("request head too large");
    return null;
  }
  const raw = buffer.subarray(0, end + 4);
  const lines = raw.toString("latin1").slice(0, -4).split("\r\n");
  const requestLine = lines.shift() ?? "";
  const m = /^([A-Z]+) (\S+) (HTTP\/1\.[01])$/.exec(requestLine);
  if (!m) throw new Error("malformed request line");
  const headers: [string, string][] = [];
  for (const line of lines) {
    const i = line.indexOf(":");
    if (i <= 0) throw new Error("malformed header");
    headers.push([line.slice(0, i).trim(), line.slice(i + 1).trim()]);
  }
  return {
    head: { method: m[1]!, target: m[2]!, version: m[3]!, headers, raw: Buffer.from(raw) },
    rest: buffer.subarray(end + 4),
  };
}

/** Serialize a head with replaced headers. */
export function serializeHead(head: RequestHead, replace: Readonly<Record<string, string | null>>): Buffer {
  const lowerReplace = new Map(Object.entries(replace).map(([k, v]) => [k.toLowerCase(), [k, v] as const]));
  const lines = [`${head.method} ${head.target} ${head.version}`];
  const done = new Set<string>();
  for (const [k, v] of head.headers) {
    const r = lowerReplace.get(k.toLowerCase());
    if (r) {
      if (!done.has(k.toLowerCase()) && r[1] !== null) lines.push(`${k}: ${r[1]}`);
      done.add(k.toLowerCase());
    } else {
      lines.push(`${k}: ${v}`);
    }
  }
  for (const [lower, [k, v]] of lowerReplace) if (!done.has(lower) && v !== null) lines.push(`${k}: ${v}`);
  return Buffer.from(`${lines.join("\r\n")}\r\n\r\n`, "latin1");
}

export type BodyFraming =
  { readonly kind: "none" } | { readonly kind: "length"; readonly length: number } | { readonly kind: "chunked" };

export function bodyFraming(head: RequestHead): BodyFraming {
  const te = header(head, "transfer-encoding");
  if (
    te &&
    te
      .toLowerCase()
      .split(",")
      .map((s) => s.trim())
      .includes("chunked")
  )
    return { kind: "chunked" };
  const cl = header(head, "content-length");
  if (cl !== undefined) {
    if (!/^\d+$/.test(cl)) throw new Error("malformed Content-Length");
    return { kind: "length", length: Number(cl) };
  }
  return { kind: "none" };
}

/**
 * Streaming body tracker: consumes bytes of a body, reports how many belong
 * to it, and (when collecting) the decoded body.
 */
export class BodyReader {
  private remaining: number;
  private state: "size" | "data" | "data-crlf" | "trailer" | "done";
  private line = "";
  private chunkLeft = 0;
  private readonly parts: Buffer[] = [];
  private collected = 0;

  constructor(
    private readonly framing: BodyFraming,
    private readonly collect: boolean,
    private readonly maxCollect = 32 * 1024 * 1024,
  ) {
    this.remaining = framing.kind === "length" ? framing.length : 0;
    this.state =
      framing.kind === "chunked" ? "size" : framing.kind === "length" && framing.length > 0 ? "data" : "done";
  }

  get done(): boolean {
    return this.state === "done";
  }

  /** The decoded body (collecting readers). */
  body(): Buffer {
    return Buffer.concat(this.parts);
  }

  private keep(data: Buffer): void {
    if (!this.collect) return;
    this.collected += data.length;
    if (this.collected > this.maxCollect) throw new Error("request body too large to inspect");
    this.parts.push(Buffer.from(data));
  }

  /** Consume from `data`; returns the number of bytes that belong to this body. */
  feed(data: Buffer): number {
    if (this.framing.kind === "length") {
      const n = Math.min(this.remaining, data.length);
      this.keep(data.subarray(0, n));
      this.remaining -= n;
      if (this.remaining === 0) this.state = "done";
      return n;
    }
    let i = 0;
    while (i < data.length && this.state !== "done") {
      if (this.state === "size" || this.state === "trailer") {
        const nl = data.indexOf(0x0a, i);
        const end = nl < 0 ? data.length : nl + 1;
        this.line += data.subarray(i, end).toString("latin1");
        if (this.line.length > 8192) throw new Error("malformed chunked body");
        i = end;
        if (nl < 0) break;
        const line = this.line.replace(/\r?\n$/, "");
        this.line = "";
        if (this.state === "size") {
          const size = parseInt(line.split(";")[0]!.trim(), 16);
          if (!Number.isFinite(size) || size < 0) throw new Error("malformed chunk size");
          if (size === 0) this.state = "trailer";
          else {
            this.chunkLeft = size;
            this.state = "data";
          }
        } else if (line === "") {
          this.state = "done";
        }
      } else if (this.state === "data") {
        const n = Math.min(this.chunkLeft, data.length - i);
        this.keep(data.subarray(i, i + n));
        this.chunkLeft -= n;
        i += n;
        if (this.chunkLeft === 0) this.state = "data-crlf";
      } else if (this.state === "data-crlf") {
        const nl = data.indexOf(0x0a, i);
        if (nl < 0) {
          i = data.length;
          break;
        }
        i = nl + 1;
        this.state = "size";
      }
    }
    return i;
  }
}
