/**
 * CROT browser-bridge protocol, version 1 (ARCHITECTURE.md §16).
 *
 * Two hops carry the same frames:
 *
 *   CROT Browser Extension <-native messaging-> crot-browser-relay <-IPC-> CROT Host (bridge)
 *
 * Framing on both hops is Chrome's native-messaging framing: a 32-bit length in
 * native byte order (little-endian on every platform CROT supports) followed
 * by that many bytes of UTF-8 JSON. The relay only forwards frames and checks
 * their size; it never interprets them. The CROT Host validates every message
 * it receives with the parsers below.
 *
 * This module has no dependencies on Node.js or zod so that the extension can
 * reuse it.
 */
import {
  BROWSER_COMMANDS,
  type BrowserCommand,
  type BrowserCommandParams,
} from "../core/capabilities/browser/connection.js";

export const BRIDGE_PROTOCOL_VERSION = 1;

export const FRAME_HEADER_BYTES = 4;
/** Chrome refuses native-messaging messages from the host larger than 1 MiB. */
export const MAX_HOST_TO_BROWSER_FRAME_BYTES = 1024 * 1024;
/**
 * Largest frame accepted from the browser. Fits the largest screenshot Core
 * accepts (16 MiB decoded, about 22.4 MB as base64) and stays below Chrome's
 * own 64 MiB limit for messages to the host.
 */
export const MAX_BROWSER_TO_HOST_FRAME_BYTES = 32 * 1024 * 1024;
/** Frame limit before the handshake has completed (auth, hello). */
export const MAX_HANDSHAKE_FRAME_BYTES = 4096;
/** UTF-16 code units of serialized message per chunk. At most 3 UTF-8 bytes each, even escaped: always under 1 MiB per frame. */
export const CHUNK_DATA_UNITS = 256 * 1024;
export const MAX_CHUNKS = 64;
export const MAX_BROWSER_INFO_LENGTH = 200;
export const MAX_ERROR_CODE_LENGTH = 64;
export const MAX_ERROR_MESSAGE_LENGTH = 2000;

const REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;
const TOKEN = /^[A-Za-z0-9_-]{32,256}$/;
const ERROR_CODE = /^[A-Z][A-Z0-9_]*$/;
const COMMANDS: ReadonlySet<string> = new Set<string>(BROWSER_COMMANDS);

/** Any violation of the protocol. The connection it occurred on must be closed. */
export class BrowserProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserProtocolError";
  }
}

// ---------------------------------------------------------------- messages

export interface BrowserInfoMessage {
  readonly name: string;
  readonly version: string;
  readonly extensionVersion: string;
}

/** Extension -> host: first message after connecting. */
export interface BrowserHello {
  readonly type: "hello";
  readonly protocol: number;
  readonly browser: BrowserInfoMessage;
}

/** Extension -> host: answer to one request. `result` is untrusted and validated by Core. */
export type BrowserResponse =
  | { readonly type: "response"; readonly id: string; readonly ok: true; readonly result: unknown }
  | {
      readonly type: "response";
      readonly id: string;
      readonly ok: false;
      readonly error: { readonly code: string; readonly message: string };
    };

export type BrowserToHostMessage = BrowserHello | BrowserResponse;

/** Host -> extension: the hello was accepted. */
export interface HostWelcome {
  readonly type: "welcome";
  readonly protocol: number;
}

/** Host -> extension: one authorized command. */
export interface HostRequest {
  readonly type: "request";
  readonly id: string;
  readonly command: BrowserCommand;
  readonly params: Readonly<Record<string, unknown>>;
}

/** Host -> extension: one piece of a request too large for a single frame. */
export interface HostChunk {
  readonly type: "chunk";
  /** Id of the chunked request. */
  readonly id: string;
  readonly index: number;
  readonly count: number;
  /** Consecutive slice of the request's JSON text. */
  readonly data: string;
}

export type HostToBrowserMessage = HostWelcome | HostRequest | HostChunk;

/** Relay -> host: first frame on the IPC connection, proving the relay runs as the user. Never forwarded to the browser. */
export interface RelayAuth {
  readonly type: "auth";
  readonly protocol: number;
  readonly token: string;
}

export function isRequestId(value: unknown): value is string {
  return typeof value === "string" && REQUEST_ID.test(value);
}

export function createRequest<C extends BrowserCommand>(
  id: string,
  command: C,
  params: BrowserCommandParams[C],
): HostRequest {
  if (!isRequestId(id)) throw new BrowserProtocolError("Invalid request id.");
  return { type: "request", id, command, params: params as Readonly<Record<string, unknown>> };
}

// ---------------------------------------------------------------- framing

const utf8 = new TextEncoder();
const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Prefix a frame body with its length. */
export function encodeFrame(body: Uint8Array): Uint8Array {
  const n = body.length;
  const frame = new Uint8Array(FRAME_HEADER_BYTES + n);
  frame[0] = n & 0xff;
  frame[1] = (n >>> 8) & 0xff;
  frame[2] = (n >>> 16) & 0xff;
  frame[3] = (n >>> 24) & 0xff;
  frame.set(body, FRAME_HEADER_BYTES);
  return frame;
}

function stringify(message: unknown): string {
  let json: string | undefined;
  try {
    json = JSON.stringify(message);
  } catch {
    json = undefined;
  }
  if (json === undefined) throw new BrowserProtocolError("Message is not JSON-serializable.");
  return json;
}

/** Serialize one message into one frame no larger than `maxFrameBytes` (body). */
export function encodeMessage(message: unknown, maxFrameBytes: number): Uint8Array {
  const body = utf8.encode(stringify(message));
  if (body.length > maxFrameBytes) {
    throw new BrowserProtocolError(
      "Message of " + body.length + " bytes exceeds the " + maxFrameBytes + "-byte frame limit.",
    );
  }
  return encodeFrame(body);
}

/** Decode one frame body: strict UTF-8, then JSON. */
export function decodeMessage(body: Uint8Array): unknown {
  let text: string;
  try {
    text = strictUtf8.decode(body);
  } catch {
    throw new BrowserProtocolError("Frame is not valid UTF-8.");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new BrowserProtocolError("Frame is not valid JSON.");
  }
}

/**
 * Splits a byte stream into frame bodies. Each byte is copied once. A frame
 * whose header announces an empty or oversized body is rejected before its
 * body is buffered; after any error the reader stays failed.
 */
export class FrameReader {
  private chunks: Uint8Array[] = [];
  private size = 0;
  private failed = false;

  /** May be raised after the handshake (MAX_HANDSHAKE_FRAME_BYTES, then the direction's limit). */
  constructor(public maxFrameBytes: number) {}

  get bufferedBytes(): number {
    return this.size;
  }

  push(chunk: Uint8Array): Uint8Array[] {
    if (this.failed) throw new BrowserProtocolError("The frame stream is no longer valid.");
    if (chunk.length > 0) {
      this.chunks.push(chunk);
      this.size += chunk.length;
    }
    const bodies: Uint8Array[] = [];
    while (this.size >= FRAME_HEADER_BYTES) {
      const header = this.read(FRAME_HEADER_BYTES, false);
      const length = (header[0]! | (header[1]! << 8) | (header[2]! << 16) | (header[3]! << 24)) >>> 0;
      if (length === 0 || length > this.maxFrameBytes) {
        this.failed = true;
        throw new BrowserProtocolError(
          length === 0
            ? "Empty frame."
            : "Frame of " + length + " bytes exceeds the " + this.maxFrameBytes + "-byte limit.",
        );
      }
      if (this.size < FRAME_HEADER_BYTES + length) break;
      this.read(FRAME_HEADER_BYTES, true);
      bodies.push(this.read(length, true));
    }
    return bodies;
  }

  private read(n: number, consume: boolean): Uint8Array {
    const out = new Uint8Array(n);
    let offset = 0;
    let i = 0;
    while (offset < n) {
      const chunk = consume ? this.chunks[0]! : this.chunks[i++]!;
      const count = Math.min(chunk.length, n - offset);
      out.set(chunk.subarray(0, count), offset);
      offset += count;
      if (consume) {
        if (count === chunk.length) this.chunks.shift();
        else this.chunks[0] = chunk.subarray(count);
      }
    }
    if (consume) this.size -= n;
    return out;
  }
}

/** FrameReader followed by strict UTF-8 and JSON decoding. Messages are still unvalidated. */
export class MessageReader {
  private readonly frames: FrameReader;

  constructor(maxFrameBytes: number) {
    this.frames = new FrameReader(maxFrameBytes);
  }

  get maxFrameBytes(): number {
    return this.frames.maxFrameBytes;
  }

  set maxFrameBytes(value: number) {
    this.frames.maxFrameBytes = value;
  }

  push(chunk: Uint8Array): unknown[] {
    return this.frames.push(chunk).map(decodeMessage);
  }
}

// ---------------------------------------------------------------- chunking (host -> browser)

/** Split `text` into slices of at most `units` UTF-16 code units, never inside a surrogate pair. */
function splitUtf16(text: string, units: number): string[] {
  const parts: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + units, text.length);
    if (end < text.length) {
      const last = text.charCodeAt(end - 1);
      if (last >= 0xd800 && last <= 0xdbff) end--;
    }
    parts.push(text.slice(start, end));
    start = end;
  }
  return parts;
}

/**
 * Encode a host message for the browser: one frame when it fits Chrome's
 * 1 MiB limit, otherwise (requests only) a contiguous sequence of chunk
 * frames. All frames of one message must be written consecutively.
 */
export function encodeHostMessage(message: HostWelcome | HostRequest): Uint8Array[] {
  const json = stringify(message);
  const body = utf8.encode(json);
  if (body.length <= MAX_HOST_TO_BROWSER_FRAME_BYTES) return [encodeFrame(body)];
  if (message.type !== "request") throw new BrowserProtocolError("Only requests can be chunked.");
  const pieces = splitUtf16(json, CHUNK_DATA_UNITS);
  if (pieces.length > MAX_CHUNKS) throw new BrowserProtocolError("Request is too large to send to the browser.");
  return pieces.map((data, index) =>
    encodeMessage(
      { type: "chunk", id: message.id, index, count: pieces.length, data } satisfies HostChunk,
      MAX_HOST_TO_BROWSER_FRAME_BYTES,
    ),
  );
}

/** Browser side: rebuilds chunked requests. Accepts only contiguous, in-order chunks of one request at a time. */
export class ChunkReassembler {
  private stream: { id: string; count: number; parts: string[] } | undefined;

  get pending(): boolean {
    return this.stream !== undefined;
  }

  /** Returns the complete message, or undefined while a chunked request is incomplete. */
  accept(message: HostToBrowserMessage): HostWelcome | HostRequest | undefined {
    if (message.type !== "chunk") {
      if (this.stream) throw this.fail("Message interleaved with a chunked request.");
      return message;
    }
    if (message.index === 0) {
      if (this.stream) throw this.fail("New chunked request before the previous one completed.");
      this.stream = { id: message.id, count: message.count, parts: [message.data] };
    } else {
      const s = this.stream;
      if (!s || s.id !== message.id || s.count !== message.count || s.parts.length !== message.index)
        throw this.fail("Out-of-order chunk.");
      s.parts.push(message.data);
    }
    const s = this.stream!;
    if (s.parts.length < s.count) return undefined;
    this.stream = undefined;
    let value: unknown;
    try {
      value = JSON.parse(s.parts.join("")) as unknown;
    } catch {
      throw new BrowserProtocolError("Chunked request is not valid JSON.");
    }
    const assembled = parseHostMessage(value);
    if (assembled.type !== "request" || assembled.id !== s.id)
      throw new BrowserProtocolError("Chunked message is not the announced request.");
    return assembled;
  }

  private fail(message: string): BrowserProtocolError {
    this.stream = undefined;
    return new BrowserProtocolError(message);
  }
}

// ---------------------------------------------------------------- validation

type Obj = Record<string, unknown>;

const isObject = (value: unknown): value is Obj => typeof value === "object" && value !== null && !Array.isArray(value);

const isBoundedString = (value: unknown, min: number, max: number): value is string =>
  typeof value === "string" && value.length >= min && value.length <= max;

const isProtocolNumber = (value: unknown): value is number =>
  Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 1000;

function invalid(what: string): never {
  throw new BrowserProtocolError("Invalid " + what + ".");
}

/** Validate a message from the extension (host side). Unknown keys are dropped. */
export function parseBrowserMessage(value: unknown): BrowserToHostMessage {
  if (!isObject(value)) invalid("message");
  switch (value.type) {
    case "hello": {
      const browser = value.browser;
      if (!isProtocolNumber(value.protocol) || !isObject(browser)) invalid("hello");
      const { name, version, extensionVersion } = browser;
      if (
        !isBoundedString(name, 1, MAX_BROWSER_INFO_LENGTH) ||
        !isBoundedString(version, 1, MAX_BROWSER_INFO_LENGTH) ||
        !isBoundedString(extensionVersion, 1, MAX_BROWSER_INFO_LENGTH)
      ) {
        invalid("hello");
      }
      return { type: "hello", protocol: value.protocol, browser: { name, version, extensionVersion } };
    }
    case "response": {
      const id = value.id;
      if (!isRequestId(id)) invalid("response id");
      if (value.ok === true) {
        if (!("result" in value) || "error" in value) invalid("response");
        return { type: "response", id, ok: true, result: value.result };
      }
      if (value.ok === false) {
        const error = value.error;
        if ("result" in value || !isObject(error)) invalid("response");
        const { code, message } = error;
        if (
          !isBoundedString(code, 1, MAX_ERROR_CODE_LENGTH) ||
          !ERROR_CODE.test(code) ||
          !isBoundedString(message, 0, MAX_ERROR_MESSAGE_LENGTH)
        ) {
          invalid("response error");
        }
        return { type: "response", id, ok: false, error: { code, message } };
      }
      return invalid("response");
    }
    default:
      return invalid("message type");
  }
}

/** Validate a message from the host (extension side). Unknown keys are dropped. */
export function parseHostMessage(value: unknown): HostToBrowserMessage {
  if (!isObject(value)) invalid("message");
  switch (value.type) {
    case "welcome":
      if (!isProtocolNumber(value.protocol)) invalid("welcome");
      return { type: "welcome", protocol: value.protocol };
    case "request": {
      const { id, command, params } = value;
      if (!isRequestId(id) || typeof command !== "string" || !COMMANDS.has(command) || !isObject(params))
        invalid("request");
      return { type: "request", id, command: command as BrowserCommand, params };
    }
    case "chunk": {
      const { id, index, count, data } = value;
      if (
        !isRequestId(id) ||
        !Number.isInteger(count) ||
        (count as number) < 2 ||
        (count as number) > MAX_CHUNKS ||
        !Number.isInteger(index) ||
        (index as number) < 0 ||
        (index as number) >= (count as number) ||
        !isBoundedString(data, 1, CHUNK_DATA_UNITS)
      ) {
        invalid("chunk");
      }
      return { type: "chunk", id, index: index as number, count: count as number, data };
    }
    default:
      return invalid("message type");
  }
}

/** Validate the relay's first IPC frame (host side). */
export function parseRelayAuth(value: unknown): RelayAuth {
  if (
    !isObject(value) ||
    value.type !== "auth" ||
    !isProtocolNumber(value.protocol) ||
    typeof value.token !== "string" ||
    !TOKEN.test(value.token)
  ) {
    invalid("relay authentication");
  }
  return { type: "auth", protocol: value.protocol, token: value.token };
}
