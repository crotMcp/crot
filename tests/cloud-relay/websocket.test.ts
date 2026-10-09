import { Duplex } from "node:stream";
import { describe, expect, it } from "vitest";
import { MAX_FRAME_BYTES } from "../../src/tunnel/protocol.js";
import { WebSocketConnection, WS_PROTOCOL_ERROR, WS_TOO_BIG } from "../../src/tunnel/websocket.js";

/**
 * WP-29 / AD-22 point 2: the relay's RFC 6455 endpoint before and after the
 * tunnel handshake. Memory retained for one connection is bounded by the
 * message limit, whatever the peer sends (fragments, tiny TCP segments,
 * pings it never reads the answers to).
 */

const OP_CONT = 0x0;
const OP_BINARY = 0x2;
const OP_TEXT = 0x1;
const OP_PING = 0x9;
const OP_CLOSE = 0x8;

/** A masked client → server frame. */
function frame(opcode: number, payload: Buffer = Buffer.alloc(0), fin = true): Buffer {
  const len = payload.length;
  const lenBytes = len < 126 ? 0 : len < 65536 ? 2 : 8;
  const header = Buffer.alloc(2 + lenBytes + 4);
  header[0] = (fin ? 0x80 : 0) | opcode;
  header[1] = 0x80 | (lenBytes === 0 ? len : lenBytes === 2 ? 126 : 127);
  if (lenBytes === 2) header.writeUInt16BE(len, 2);
  else if (lenBytes === 8) header.writeBigUInt64BE(BigInt(len), 2);
  // Mask 0: payload bytes are unchanged.
  return Buffer.concat([header, payload]);
}

/** A socket whose written bytes are collected; `stuck` never completes writes (a peer that does not read). */
function fakeSocket(options: { stuck?: boolean } = {}) {
  const written: Buffer[] = [];
  const socket = new Duplex({
    read() {},
    write(chunk: Buffer, _enc, cb) {
      written.push(chunk);
      if (!options.stuck) cb();
    },
    highWaterMark: 1024,
  });
  return { socket, written };
}

function server(options: { stuck?: boolean; max?: number } = {}) {
  const { socket, written } = fakeSocket(options);
  const ws = new WebSocketConnection(socket, "server", options.max ?? MAX_FRAME_BYTES, "crot-tunnel.v1");
  const messages: { data: Buffer; binary: boolean }[] = [];
  const events = { tooLarge: 0, closed: undefined as number | undefined };
  ws.attach({
    onMessage: (data, binary) => messages.push({ data, binary }),
    onTooLarge: () => {
      events.tooLarge++;
    },
    onClose: (code) => (events.closed = code),
  });
  const feed = (buf: Buffer) => socket.emit("data", buf);
  return { ws, socket, written, messages, events, feed };
}

const closeCodeOf = (written: Buffer[]) => {
  const out = Buffer.concat(written);
  for (let i = 0; i + 1 < out.length;) {
    const op = out[i]! & 0x0f;
    const len = out[i + 1]! & 0x7f;
    if (op === OP_CLOSE) return out.readUInt16BE(i + 2);
    i += 2 + len;
  }
  return undefined;
};

describe("WebSocket message assembly (AD-22 point 2)", () => {
  it("assembles a fragmented binary message, with a ping between the fragments", () => {
    const s = server();
    s.feed(frame(OP_BINARY, Buffer.from("ab"), false));
    s.feed(frame(OP_PING, Buffer.from("p")));
    s.feed(frame(OP_CONT, Buffer.from("cd"), false));
    s.feed(frame(OP_CONT, Buffer.alloc(0), false));
    s.feed(frame(OP_CONT, Buffer.from("e"), true));
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0]).toEqual({ data: Buffer.from("abcde"), binary: true });
    expect(s.ws.retainedBytes).toBe(0);
    // A second fragmented message on the same connection.
    s.feed(frame(OP_TEXT, Buffer.from("x"), false));
    s.feed(frame(OP_CONT, Buffer.from("y"), true));
    expect(s.messages[1]).toEqual({ data: Buffer.from("xy"), binary: false });
  });

  it("delivers a maximum-size message that arrives one byte at a time", () => {
    const s = server();
    const payload = Buffer.alloc(MAX_FRAME_BYTES);
    for (let i = 0; i < payload.length; i++) payload[i] = i & 0xff;
    const wire = frame(OP_BINARY, payload);
    for (let i = 0; i < wire.length; i++) {
      s.feed(wire.subarray(i, i + 1));
      expect(s.ws.retainedBytes).toBeLessThanOrEqual(MAX_FRAME_BYTES + 14);
    }
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0]!.data.equals(payload)).toBe(true);
    expect(s.ws.retainedBytes).toBe(0);
  });

  it("refuses a fragmented message above the limit (1009 / onTooLarge)", () => {
    const s = server({ max: 1000 });
    s.feed(frame(OP_BINARY, Buffer.alloc(600), false));
    s.feed(frame(OP_CONT, Buffer.alloc(401), true));
    expect(s.messages).toHaveLength(0);
    expect(s.events.tooLarge).toBe(1);
  });

  it("an unbounded number of empty fragments retains no more than the message limit", () => {
    const s = server();
    s.feed(frame(OP_BINARY, Buffer.alloc(0), false));
    const empty = frame(OP_CONT, Buffer.alloc(0), false);
    const batch = Buffer.concat(Array.from({ length: 10_000 }, () => empty));
    for (let i = 0; i < 100; i++) {
      s.feed(batch);
      expect(s.ws.retainedBytes).toBeLessThanOrEqual(MAX_FRAME_BYTES);
    }
    // A million fragments later the message still completes correctly.
    s.feed(frame(OP_CONT, Buffer.from("end"), true));
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0]!.data.toString()).toBe("end");
    expect(s.ws.retainedBytes).toBe(0);
  });

  it("does not grow the heap with the number of fragments (1M empty fragments)", () => {
    const s = server();
    s.feed(frame(OP_BINARY, Buffer.alloc(0), false));
    const empty = frame(OP_CONT, Buffer.alloc(0), false);
    const batch = Buffer.concat(Array.from({ length: 10_000 }, () => empty));
    (globalThis as { gc?: () => void }).gc?.();
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < 100; i++) s.feed(batch);
    (globalThis as { gc?: () => void }).gc?.();
    const grown = process.memoryUsage().heapUsed - before;
    // The defective version retained one Buffer object per fragment (~220 MB here).
    expect(grown).toBeLessThan(64 * 1024 * 1024);
    s.feed(frame(OP_CONT, Buffer.alloc(0), true));
    expect(s.messages).toHaveLength(1);
  });

  it("control frames inside a fragmented message keep their rules; a new data frame is a protocol error", () => {
    const s = server();
    s.feed(frame(OP_BINARY, Buffer.from("a"), false));
    s.feed(frame(OP_BINARY, Buffer.from("b"), true));
    expect(s.messages).toHaveLength(0);
    expect(closeCodeOf(s.written)).toBe(WS_PROTOCOL_ERROR);
  });
});

describe("WebSocket output a peer can provoke", () => {
  it("pings from a peer that never reads the pongs do not grow the output without bound", () => {
    const s = server({ stuck: true });
    const ping = frame(OP_PING, Buffer.alloc(125, 7));
    for (let i = 0; i < 20_000; i++) s.feed(ping);
    // 20 000 pongs would be ~2.5 MB; only a bounded backlog is kept.
    expect(s.ws.bufferedAmount).toBeLessThanOrEqual(64 * 1024 + 256);
  });

  it("pings from a reading peer are all answered", () => {
    const s = server();
    for (let i = 0; i < 100; i++) s.feed(frame(OP_PING, Buffer.from([i])));
    const pongs = Buffer.concat(s.written);
    let count = 0;
    for (let i = 0; i + 1 < pongs.length; i += 2 + (pongs[i + 1]! & 0x7f)) if ((pongs[i]! & 0x0f) === 0xa) count++;
    expect(count).toBe(100);
  });
});

void WS_TOO_BIG;
