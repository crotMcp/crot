/**
 * Relay–device tunnel protocol v1: frames, limits and codes
 * (ARCHITECTURE.md §27 AD-22 points 5–14).
 *
 * Shared by the Cloud Relay (WP-29) and the device tunnel adapter (WP-30).
 * This module only encodes, decodes and validates; it has no I/O and no
 * state. Nothing in a frame names a tool, capability, permission, approval
 * or configuration (AD-22 point 15): a stream carries one unmodified HTTP
 * exchange whose bodies are opaque bytes.
 */

/** Major versions as WebSocket subprotocols `crot-tunnel.v<N>` (AD-22 point 10). */
export const TUNNEL_SUBPROTOCOL_PREFIX = "crot-tunnel.";
export const TUNNEL_PATH = "/.crot/tunnel";
export const TUNNEL_V1 = "v1";

export const FrameType = {
  CHALLENGE: 0x01,
  HELLO: 0x02,
  READY: 0x03,
  OPEN: 0x10,
  RESPONSE: 0x11,
  DATA: 0x12,
  RESET: 0x13,
  WINDOW: 0x14,
  PING: 0x20,
  PONG: 0x21,
  GOAWAY: 0x22,
} as const;
export type FrameTypeValue = (typeof FrameType)[keyof typeof FrameType];

/** First extension frame type; 0x80–0xFF are ignored unless negotiated. */
export const EXTENSION_TYPE_MIN = 0x80;
export const FLAG_END_STREAM = 0x01;
export const FRAME_HEADER_BYTES = 6;

/** AD-22 point 5 and point 11. */
export const MAX_DATA_PAYLOAD = 64 * 1024;
export const MAX_JSON_PAYLOAD = 64 * 1024;
export const MAX_FRAME_BYTES = FRAME_HEADER_BYTES + Math.max(MAX_DATA_PAYLOAD, MAX_JSON_PAYLOAD);
export const MAX_REQUEST_BODY_BYTES = 4 * 1024 * 1024;
export const MAX_RESPONSE_BODY_BYTES = 32 * 1024 * 1024;
export const MAX_HEADER_COUNT = 100;
export const MAX_STREAMS_CAP = 1024;
export const MAX_STREAM_ID = 0xffff_ffff;

/** AD-22 point 8. */
export const INITIAL_CONNECTION_WINDOW = 8 * 1024 * 1024;
export const INITIAL_STREAM_WINDOW = 1024 * 1024;
export const MAX_WINDOW = 2 ** 31 - 1;

/** AD-22 points 3, 8, 9 and 12. */
export const HANDSHAKE_TIMEOUT_MS = 10_000;
export const PING_AFTER_IDLE_MS = 20_000;
export const DEAD_AFTER_SILENCE_MS = 60_000;
export const DRAIN_LIMIT_MS = 60_000;
export const STALL_LIMIT_MS = 60_000;
export const DEFAULT_EXCHANGE_DEADLINE_MS = 15 * 60_000;
export const MIN_EXCHANGE_DEADLINE_MS = 60_000;
export const CHALLENGE_BYTES = 32;

/** WebSocket close codes of AD-22 point 14. */
export const CloseCode = {
  NORMAL: 1000,
  GOING_AWAY: 1001,
  PROTOCOL_ERROR: 4400,
  UNAUTHORIZED: 4401,
  FORBIDDEN: 4403,
  HANDSHAKE_TIMEOUT: 4408,
  SUPERSEDED_TOO_OFTEN: 4409,
  UNSUPPORTED_VERSION: 4426,
  RATE_LIMITED: 4429,
} as const;

/** `RESET` codes (AD-22 point 13). */
export const RESET_CODES = [
  "cancel",
  "refused",
  "deadline_exceeded",
  "response_too_large",
  "client_stalled",
  "shutting_down",
  "device_terminated",
  "protocol_error",
  "internal_error",
] as const;
export type ResetCode = (typeof RESET_CODES)[number];

/** `GOAWAY` codes (AD-22 point 9). */
export const GOAWAY_CODES = ["shutting_down", "superseded", "remote_disabled", "unpaired", "protocol_error"] as const;
export type GoAwayCode = (typeof GOAWAY_CODES)[number];

/** Outcome of an exchange that did not end with a complete device response (AD-22 point 13). */
export type RequestOutcome = "not_executed" | "unknown";
export const OUTCOME_HEADER = "crot-request-outcome";

/** Hop-by-hop headers an intermediary removes (AD-22 point 7). */
const HOP_BY_HOP = new Set(["connection", "keep-alive", "transfer-encoding", "te", "upgrade", "trailer", "expect"]);

export interface Frame {
  readonly type: number;
  readonly flags: number;
  readonly stream: number;
  readonly payload: Buffer;
}

export class TunnelProtocolError extends Error {
  constructor(readonly code: string) {
    super(`tunnel protocol error: ${code}`);
  }
}

export function encodeFrame(type: number, stream: number, payload: Uint8Array = Buffer.alloc(0), flags = 0): Buffer {
  if (!Number.isInteger(stream) || stream < 0 || stream > MAX_STREAM_ID) throw new RangeError("invalid stream id");
  const header = Buffer.alloc(FRAME_HEADER_BYTES);
  header.writeUInt8(type, 0);
  header.writeUInt8(flags, 1);
  header.writeUInt32BE(stream, 2);
  return Buffer.concat([header, payload]);
}

export function encodeJsonFrame(type: number, stream: number, value: object, flags = 0): Buffer {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  if (payload.length > MAX_JSON_PAYLOAD) throw new TunnelProtocolError("json_too_large");
  return encodeFrame(type, stream, payload, flags);
}

export function encodeWindow(stream: number, increment: number): Buffer {
  if (!Number.isInteger(increment) || increment < 1 || increment > MAX_WINDOW)
    throw new RangeError("invalid window increment");
  const payload = Buffer.alloc(4);
  payload.writeUInt32BE(increment, 0);
  return encodeFrame(FrameType.WINDOW, stream, payload);
}

/**
 * Decode one frame (one WebSocket message). Checks only what is independent
 * of direction and state: header length, size limits, reserved flag bits.
 */
export function decodeFrame(message: Buffer): Frame {
  if (message.length < FRAME_HEADER_BYTES) throw new TunnelProtocolError("short_frame");
  const type = message.readUInt8(0);
  const flags = message.readUInt8(1);
  const stream = message.readUInt32BE(2);
  const payload = message.subarray(FRAME_HEADER_BYTES);
  if ((flags & ~FLAG_END_STREAM) !== 0) throw new TunnelProtocolError("reserved_flags");
  if (payload.length > Math.max(MAX_DATA_PAYLOAD, MAX_JSON_PAYLOAD)) throw new TunnelProtocolError("frame_too_large");
  return { type, flags, stream, payload };
}

/** A JSON payload: UTF-8, at most 64 KiB, an object (AD-22 point 5). */
export function parseJsonPayload(payload: Buffer): Record<string, unknown> {
  if (payload.length > MAX_JSON_PAYLOAD) throw new TunnelProtocolError("json_too_large");
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload));
  } catch {
    throw new TunnelProtocolError("invalid_json");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new TunnelProtocolError("invalid_json");
  return value as Record<string, unknown>;
}

export function parseWindowIncrement(payload: Buffer): number {
  if (payload.length !== 4) throw new TunnelProtocolError("invalid_window");
  const increment = payload.readUInt32BE(0);
  if (increment < 1 || increment > MAX_WINDOW) throw new TunnelProtocolError("invalid_window");
  return increment;
}

export type HeaderList = readonly (readonly [string, string])[];

const TOKEN = /^[!#$%&'*+.^_`|~0-9a-z-]+$/;
const FIELD_VALUE = /^[\t\x20-\x7e\x80-\xff]*$/;

/** A well-formed header list: `[name, value]` pairs, lower-case token names, valid values. */
export function parseHeaderList(value: unknown, max = MAX_HEADER_COUNT): HeaderList | undefined {
  if (!Array.isArray(value) || value.length > max) return undefined;
  const out: [string, string][] = [];
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length !== 2) return undefined;
    const [name, v] = entry as unknown[];
    if (typeof name !== "string" || typeof v !== "string") return undefined;
    if (!TOKEN.test(name) || !FIELD_VALUE.test(v)) return undefined;
    out.push([name, v]);
  }
  return out;
}

/**
 * End-to-end headers of a raw Node header array (`rawHeaders`), order and
 * duplicates kept, names lower-cased; hop-by-hop headers and those named by
 * `Connection` removed (AD-22 point 7). Nothing is added.
 */
export function endToEndHeaders(raw: readonly string[]): [string, string][] {
  const pairs: [string, string][] = [];
  for (let i = 0; i + 1 < raw.length; i += 2) pairs.push([raw[i]!.toLowerCase(), raw[i + 1]!]);
  const named = new Set<string>();
  for (const [name, value] of pairs)
    if (name === "connection") for (const token of value.split(",")) named.add(token.trim().toLowerCase());
  return pairs.filter(([name]) => !HOP_BY_HOP.has(name) && !name.startsWith("proxy-") && !named.has(name));
}

/** Whether a header (in a device response) is hop-by-hop and must not be written to the client. */
export function isHopByHop(name: string): boolean {
  return HOP_BY_HOP.has(name) || name.startsWith("proxy-");
}

export function isResetCode(value: unknown): value is ResetCode {
  return typeof value === "string" && (RESET_CODES as readonly string[]).includes(value);
}

export function isGoAwayCode(value: unknown): value is GoAwayCode {
  return typeof value === "string" && (GOAWAY_CODES as readonly string[]).includes(value);
}

/** The majors offered in `Sec-WebSocket-Protocol` (`crot-tunnel.v<N>`), others ignored. */
export function offeredMajors(header: string | undefined): string[] {
  if (!header) return [];
  return header
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^crot-tunnel\.v[1-9][0-9]{0,3}$/.test(s))
    .map((s) => s.slice(TUNNEL_SUBPROTOCOL_PREFIX.length));
}

/** The highest common major, or undefined. */
export function selectMajor(offered: readonly string[], supported: readonly string[]): string | undefined {
  const n = (v: string) => Number(v.slice(1));
  return offered
    .filter((v) => supported.includes(v))
    .sort((a, b) => n(b) - n(a))
    .at(0);
}

/** Reason of close 4426 (AD-22 point 10). */
export function unsupportedVersionReason(supported: readonly string[]): string {
  return `update required;supported=${supported.join(",")}`;
}
