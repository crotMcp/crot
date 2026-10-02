import { decodingFor } from "../../platform/encoding.js";
import type { ResolvedEncoding, TextDecoding } from "../../platform/types.js";

/** Encoding used to decode a stream, and whether decoding was lossy. */
export interface OutputEncodingInfo {
  readonly name: string;
  /** True when bytes could not be decoded or the text contains U+FFFD replacement characters. */
  readonly lossy: boolean;
}

export interface DecodedOutput {
  readonly data: string;
  /** Absolute offset to pass to the next read (incomplete trailing characters are held back). */
  readonly nextOffset: number;
  /** Bytes that were discarded before the requested offset could be served. */
  readonly droppedBytes: number;
  readonly encoding: OutputEncodingInfo;
}

const UTF8 = decodingFor("utf-8")!;
const UTF16LE = decodingFor("utf-16le")!;
export const AUTO_UTF8: ResolvedEncoding = { mode: "auto", fallback: null };

/**
 * Bounded output capture that keeps the most recent `capacity` bytes while
 * tracking absolute byte offsets, so callers can poll incrementally.
 *
 * Bytes are stored raw and decoded on read, so the size limit applies to bytes
 * and decoding never splits a character: a character cut off by truncation is
 * skipped, and an incomplete trailing character is held back until the rest
 * arrives (or the stream ends).
 */
export class OutputBuffer {
  private chunks: Buffer[] = [];
  private retained = 0;
  /** Absolute offset of the first retained byte. */
  private start = 0;
  private closed = false;
  /** Encoding chosen by "auto" once output turned out not to be UTF-8. */
  private detected: TextDecoding | undefined;

  constructor(
    private readonly capacity: number,
    private readonly encoding: ResolvedEncoding = AUTO_UTF8,
  ) {}

  get totalBytes(): number {
    return this.start + this.retained;
  }

  get truncated(): boolean {
    return this.start > 0;
  }

  /** Mark the stream as finished: trailing bytes are decoded as they are. */
  end(): void {
    this.closed = true;
  }

  append(chunk: Buffer): void {
    if (chunk.length === 0) return;
    this.chunks.push(chunk);
    this.retained += chunk.length;
    while (this.retained > this.capacity) {
      const first = this.chunks[0]!;
      const excess = this.retained - this.capacity;
      if (first.length <= excess) {
        this.chunks.shift();
        this.retained -= first.length;
        this.start += first.length;
      } else {
        this.chunks[0] = first.subarray(excess);
        this.retained -= excess;
        this.start += excess;
      }
    }
  }

  /** Decode retained output from absolute `offset` onward. */
  readFrom(offset: number): DecodedOutput {
    const all = Buffer.concat(this.chunks);
    const from = Math.max(offset, this.start);
    const bytes = all.subarray(Math.min(from - this.start, all.length));
    // Bytes before `start` were dropped: the first retained byte may be mid-character.
    const cut = offset < this.start;
    const { text, skipped, consumed, decoding, lossy } = this.decode(bytes, from, cut);
    return {
      data: text,
      nextOffset: from + consumed,
      droppedBytes: Math.max(0, this.start - offset) + skipped,
      encoding: { name: decoding.name, lossy },
    };
  }

  /** Decode everything retained (use after end()). */
  readAll(): DecodedOutput {
    return this.readFrom(0);
  }

  private decode(bytes: Buffer, from: number, cut: boolean) {
    const final = this.closed;
    let decoding: TextDecoding;
    if (this.encoding.mode === "fixed") decoding = this.encoding.decoding;
    else {
      if (!this.detected && from === 0 && bytes[0] === 0xff && bytes[1] === 0xfe) this.detected = UTF16LE;
      decoding = this.detected ?? UTF8;
    }
    let attempt = decodeWith(decoding, bytes, from, cut, final);
    if (attempt.text === null && decoding === UTF8 && final) {
      // Valid UTF-8 whose last character was cut off (e.g. the process was killed mid-write):
      // still UTF-8, with the partial character reported as lossy.
      const tail = incompleteUtf8Tail(bytes, attempt.start, attempt.end);
      const head = tail > 0 ? UTF8.decode(bytes.subarray(attempt.start, attempt.end - tail), true) : null;
      if (head !== null) attempt = { ...attempt, text: `${head}\ufffd` };
    }
    if (attempt.text === null && this.encoding.mode === "auto" && !this.detected && this.encoding.fallback) {
      // Not UTF-8: decode with the console code page from now on.
      this.detected = this.encoding.fallback;
      decoding = this.detected;
      attempt = decodeWith(decoding, bytes, from, cut, final);
    }
    let text = attempt.text;
    let lossy = false;
    if (text === null) {
      lossy = true;
      text = decoding.decode(bytes.subarray(attempt.start, attempt.end), false) ?? "";
    }
    if (from + attempt.start === 0 && text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    if (text.includes("\ufffd")) lossy = true;
    return { text, skipped: attempt.start, consumed: attempt.end, decoding, lossy };
  }
}

/** Fatal decode of `bytes` after trimming partial characters at the edges. */
function decodeWith(decoding: TextDecoding, bytes: Buffer, from: number, cut: boolean, final: boolean) {
  let start = 0;
  let end = bytes.length;
  if (decoding.name === "utf-8") {
    if (cut) while (start < Math.min(3, end) && (bytes[start]! & 0xc0) === 0x80) start++;
    if (!final) end -= incompleteUtf8Tail(bytes, start, end);
  } else if (decoding.name === "utf-16le" || decoding.name === "utf-16be") {
    if ((from + start) % 2 === 1) start++;
    if (!final) {
      if ((end - start) % 2 === 1) end--;
      if (end - start >= 2) {
        const unit = decoding.name === "utf-16le" ? bytes[end - 1]! : bytes[end - 2]!;
        if (unit >= 0xd8 && unit <= 0xdb) end -= 2;
      }
    }
  } else if (!final) {
    // Multi-byte legacy encodings (Shift_JIS, GBK, ...): hold back an incomplete tail.
    for (let k = 0; k <= 3 && end - k > start; k++) {
      if (decoding.decode(bytes.subarray(start, end - k), true) !== null) {
        end -= k;
        break;
      }
    }
  }
  return { text: decoding.decode(bytes.subarray(start, end), true), start, end };
}

/** Length of an incomplete UTF-8 sequence at the end of bytes[start, end). */
function incompleteUtf8Tail(bytes: Buffer, start: number, end: number): number {
  for (let i = end - 1; i >= Math.max(start, end - 4); i--) {
    const b = bytes[i]!;
    if ((b & 0xc0) === 0x80) continue;
    const length = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
    return end - i < length ? end - i : 0;
  }
  return 0;
}
