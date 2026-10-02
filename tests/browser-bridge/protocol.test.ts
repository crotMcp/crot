import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  BRIDGE_PROTOCOL_VERSION,
  BrowserProtocolError,
  CHUNK_DATA_UNITS,
  ChunkReassembler,
  FrameReader,
  MAX_BROWSER_TO_HOST_FRAME_BYTES,
  MAX_CHUNKS,
  MAX_HOST_TO_BROWSER_FRAME_BYTES,
  MessageReader,
  createRequest,
  decodeMessage,
  encodeFrame,
  encodeHostMessage,
  encodeMessage,
  isRequestId,
  parseBrowserMessage,
  parseHostMessage,
  parseRelayAuth,
  type HostChunk,
  type HostRequest,
} from "../../src/browser-bridge/protocol.js";

const utf8 = new TextEncoder();
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

const request = (text: string, id = "req-1"): HostRequest => ({ type: "request", id, command: "page.type", params: { selector: "#q", text, clear: false } });

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

const chunksOf = (message: HostRequest): HostChunk[] =>
  encodeHostMessage(message).map((frame) => parseHostMessage(decodeMessage(frame.subarray(4))) as HostChunk);

describe("framing", () => {
  it("prefixes the UTF-8 JSON body with its length as a 32-bit little-endian integer", () => {
    const frame = encodeMessage({ a: "\u00e9" }, 1024);
    const body = utf8.encode(JSON.stringify({ a: "\u00e9" }));
    expect(Array.from(frame.subarray(0, 4))).toEqual([body.length, 0, 0, 0]);
    expect(Array.from(frame.subarray(4))).toEqual(Array.from(body));
    expect(Array.from(encodeFrame(new Uint8Array(0x010203)).subarray(0, 4))).toEqual([0x03, 0x02, 0x01, 0x00]);
  });

  it("decodes frames split at every byte and several frames in one chunk", () => {
    const messages = [{ n: 1 }, { n: 2, s: "\u00fc\ud83d\ude00" }, { n: 3 }];
    const stream = concat(...messages.map((m) => encodeMessage(m, 1024)));
    const reader = new MessageReader(1024);
    const out: unknown[] = [];
    for (const byte of stream) out.push(...reader.push(Uint8Array.of(byte)));
    expect(out).toEqual(messages);
    expect(new MessageReader(1024).push(stream)).toEqual(messages);
    const partial = new FrameReader(1024);
    expect(partial.push(stream.subarray(0, 6))).toEqual([]);
    expect(partial.bufferedBytes).toBe(6);
  });

  it("rejects an oversized frame from its header, before the body arrives, and stays failed", () => {
    const reader = new FrameReader(16);
    expect(() => reader.push(Uint8Array.of(17, 0, 0, 0))).toThrow(BrowserProtocolError);
    expect(() => reader.push(encodeMessage({}, 16))).toThrow(BrowserProtocolError);
    expect(() => new FrameReader(MAX_BROWSER_TO_HOST_FRAME_BYTES).push(Uint8Array.of(0xff, 0xff, 0xff, 0xff))).toThrow(BrowserProtocolError);
  });

  it("applies a raised limit to later frames", () => {
    const reader = new MessageReader(8);
    expect(reader.push(encodeMessage({ a: 1 }, 8))).toEqual([{ a: 1 }]);
    reader.maxFrameBytes = 1024;
    expect(reader.push(encodeMessage({ text: "longer than eight bytes" }, 1024))).toEqual([{ text: "longer than eight bytes" }]);
  });

  it("rejects empty frames, invalid UTF-8 and invalid JSON", () => {
    expect(() => new FrameReader(16).push(Uint8Array.of(0, 0, 0, 0))).toThrow(BrowserProtocolError);
    expect(() => decodeMessage(Uint8Array.of(0xc3, 0x28))).toThrow(BrowserProtocolError);
    expect(() => decodeMessage(Uint8Array.of(0xed, 0xa0, 0x80))).toThrow(BrowserProtocolError);
    expect(() => decodeMessage(utf8.encode("{not json"))).toThrow(BrowserProtocolError);
    expect(() => new MessageReader(16).push(encodeFrame(utf8.encode("nope")))).toThrow(BrowserProtocolError);
  });

  it("refuses to encode messages over the limit or that are not JSON", () => {
    expect(() => encodeMessage({ s: "x".repeat(100) }, 50)).toThrow(BrowserProtocolError);
    expect(() => encodeMessage(undefined, 50)).toThrow(BrowserProtocolError);
    expect(() => encodeMessage({ n: 1n }, 50)).toThrow(BrowserProtocolError);
  });

  it("uses the agreed limits", () => {
    expect(BRIDGE_PROTOCOL_VERSION).toBe(1);
    expect(MAX_HOST_TO_BROWSER_FRAME_BYTES).toBe(1024 * 1024);
    // The largest screenshot Core accepts (16 MiB, base64-encoded) fits one browser frame.
    expect(MAX_BROWSER_TO_HOST_FRAME_BYTES).toBeGreaterThan(Math.ceil((16 * 1024 * 1024) / 3) * 4 + 4096);
    expect(MAX_BROWSER_TO_HOST_FRAME_BYTES).toBeLessThan(64 * 1024 * 1024);
    // Worst case: 3 UTF-8 bytes per UTF-16 unit, plus the chunk envelope.
    expect(CHUNK_DATA_UNITS * 3 + 256).toBeLessThan(MAX_HOST_TO_BROWSER_FRAME_BYTES);
  });
});

describe("chunking (host -> browser)", () => {
  it("sends a request within the browser limit as one frame", () => {
    const frames = encodeHostMessage(request("hello"));
    expect(frames).toHaveLength(1);
    expect(parseHostMessage(decodeMessage(frames[0]!.subarray(4)))).toEqual(request("hello"));
    expect(encodeHostMessage({ type: "welcome", protocol: 1 })).toHaveLength(1);
  });

  it.each([
    ["ascii", "a".repeat(3_000_000)],
    ["escaped", String.fromCharCode(34, 92).repeat(700_000)],
    ["multi-byte", "\u00e9\u20ac".repeat(600_000)],
    ["surrogate pairs", "\ud83d\ude00".repeat(400_000)],
  ])("splits a large request into frames under 1 MiB and reassembles it (%s)", (_name, text) => {
    const message = request(text);
    const frames = encodeHostMessage(message);
    expect(frames.length).toBeGreaterThan(1);
    const reader = new MessageReader(MAX_HOST_TO_BROWSER_FRAME_BYTES);
    const reassembler = new ChunkReassembler();
    let result: unknown;
    frames.forEach((frame, i) => {
      expect(frame.length - 4).toBeLessThanOrEqual(MAX_HOST_TO_BROWSER_FRAME_BYTES);
      const decoded = reader.push(frame);
      expect(decoded).toHaveLength(1);
      const chunk = parseHostMessage(decoded[0]);
      expect(chunk).toMatchObject({ type: "chunk", id: "req-1", index: i, count: frames.length });
      expect(LONE_SURROGATE.test((chunk as HostChunk).data)).toBe(false);
      const out = reassembler.accept(chunk);
      if (i < frames.length - 1) {
        expect(out).toBeUndefined();
        expect(reassembler.pending).toBe(true);
      } else {
        result = out;
      }
    });
    expect(result).toEqual(message);
    expect(reassembler.pending).toBe(false);
  });

  it("refuses a request that would need more than MAX_CHUNKS frames", () => {
    expect(() => encodeHostMessage(request("a".repeat(CHUNK_DATA_UNITS * MAX_CHUNKS + 1)))).toThrow(BrowserProtocolError);
  });

  it("rejects out-of-order, interleaved, duplicated and foreign chunks", () => {
    const chunks = chunksOf(request("a".repeat(2_000_000)));
    expect(chunks.length).toBeGreaterThan(2);
    expect(() => new ChunkReassembler().accept(chunks[1]!)).toThrow(BrowserProtocolError);

    const interleaved = new ChunkReassembler();
    interleaved.accept(chunks[0]!);
    expect(() => interleaved.accept(request("x", "req-2"))).toThrow(BrowserProtocolError);

    const duplicated = new ChunkReassembler();
    duplicated.accept(chunks[0]!);
    expect(() => duplicated.accept(chunks[0]!)).toThrow(BrowserProtocolError);

    const foreign = new ChunkReassembler();
    foreign.accept(chunks[0]!);
    expect(() => foreign.accept({ ...chunks[1]!, id: "other" })).toThrow(BrowserProtocolError);

    const skipped = new ChunkReassembler();
    skipped.accept(chunks[0]!);
    expect(() => skipped.accept(chunks[2]!)).toThrow(BrowserProtocolError);
  });

  it("rejects a reassembled message that is not the announced request", () => {
    const json = JSON.stringify(request("x", "req-1"));
    const half = Math.floor(json.length / 2);
    const reassembler = new ChunkReassembler();
    reassembler.accept({ type: "chunk", id: "other", index: 0, count: 2, data: json.slice(0, half) });
    expect(() => reassembler.accept({ type: "chunk", id: "other", index: 1, count: 2, data: json.slice(half) })).toThrow(BrowserProtocolError);

    const garbage = new ChunkReassembler();
    garbage.accept({ type: "chunk", id: "g", index: 0, count: 2, data: "{" });
    expect(() => garbage.accept({ type: "chunk", id: "g", index: 1, count: 2, data: "oops" })).toThrow(BrowserProtocolError);
  });
});

describe("message validation", () => {
  const browser = { name: "Chrome", version: "130.0.0.0", extensionVersion: "0.1.0" };

  it("accepts hello and responses, dropping unknown keys", () => {
    expect(parseBrowserMessage({ type: "hello", protocol: 1, browser: { ...browser, extra: 1 }, extra: true })).toEqual({ type: "hello", protocol: 1, browser });
    expect(parseBrowserMessage({ type: "response", id: "req-1", ok: true, result: { tabs: [] }, extra: 1 })).toEqual({
      type: "response",
      id: "req-1",
      ok: true,
      result: { tabs: [] },
    });
    expect(parseBrowserMessage({ type: "response", id: "req-1", ok: true, result: null })).toMatchObject({ ok: true, result: null });
    expect(
      parseBrowserMessage({ type: "response", id: "req-1", ok: false, error: { code: "BROWSER_PAGE_RESTRICTED", message: "no", stack: "s" } }),
    ).toEqual({ type: "response", id: "req-1", ok: false, error: { code: "BROWSER_PAGE_RESTRICTED", message: "no" } });
  });

  it.each([
    null,
    [],
    "hello",
    { type: "request", id: "a", command: "tabs.list", params: {} },
    { type: "auth", protocol: 1, token: "a".repeat(43) },
    { type: "hello", protocol: "1", browser },
    { type: "hello", protocol: 0, browser },
    { type: "hello", protocol: 1 },
    { type: "hello", protocol: 1, browser: { ...browser, name: "" } },
    { type: "hello", protocol: 1, browser: { ...browser, version: "x".repeat(201) } },
    { type: "response", id: "bad id!", ok: true, result: 1 },
    { type: "response", id: "x".repeat(65), ok: true, result: 1 },
    { type: "response", id: "a", ok: true },
    { type: "response", id: "a", ok: "yes", result: 1 },
    { type: "response", id: "a", ok: true, result: 1, error: { code: "X", message: "" } },
    { type: "response", id: "a", ok: false },
    { type: "response", id: "a", ok: false, error: { code: "lower_case", message: "" } },
    { type: "response", id: "a", ok: false, error: { code: "X", message: "m".repeat(2001) } },
    { type: "response", id: "a", ok: false, result: 1, error: { code: "X", message: "" } },
  ])("rejects browser message %j", (value) => {
    expect(() => parseBrowserMessage(value)).toThrow(BrowserProtocolError);
  });

  it("accepts host messages", () => {
    expect(parseHostMessage({ type: "welcome", protocol: 1 })).toEqual({ type: "welcome", protocol: 1 });
    expect(parseHostMessage({ type: "request", id: "r1", command: "tabs.list", params: {} })).toEqual({ type: "request", id: "r1", command: "tabs.list", params: {} });
    expect(createRequest("r2", "tabs.close", { tabId: 4 })).toEqual({ type: "request", id: "r2", command: "tabs.close", params: { tabId: 4 } });
    expect(() => createRequest("bad id", "tabs.list", {})).toThrow(BrowserProtocolError);
  });

  it.each([
    { type: "response", id: "a", ok: true, result: 1 },
    { type: "request", id: "a", command: "page.evaluate", params: {} },
    { type: "request", id: "a", command: "tabs.list", params: [] },
    { type: "request", id: "a", command: "tabs.list" },
    { type: "welcome" },
    { type: "chunk", id: "a", index: 0, count: 1, data: "x" },
    { type: "chunk", id: "a", index: 2, count: 2, data: "x" },
    { type: "chunk", id: "a", index: 0, count: MAX_CHUNKS + 1, data: "x" },
    { type: "chunk", id: "a", index: 0, count: 2, data: "" },
    { type: "chunk", id: "a", index: 0.5, count: 2, data: "x" },
  ])("rejects host message %j", (value) => {
    expect(() => parseHostMessage(value)).toThrow(BrowserProtocolError);
  });

  it("validates relay authentication", () => {
    const token = "A-b_" + "c".repeat(39);
    expect(parseRelayAuth({ type: "auth", protocol: 1, token, extra: 1 })).toEqual({ type: "auth", protocol: 1, token });
    for (const bad of [
      { type: "auth", protocol: 1, token: "short" },
      { type: "auth", protocol: 1, token: "a/" + "b".repeat(40) },
      { type: "auth", token },
      { type: "hello", protocol: 1, token },
      null,
    ]) {
      expect(() => parseRelayAuth(bad)).toThrow(BrowserProtocolError);
    }
  });

  it("accepts UUID request ids", () => {
    expect(isRequestId(randomUUID())).toBe(true);
    expect(isRequestId("")).toBe(false);
    expect(isRequestId(42)).toBe(false);
  });
});
