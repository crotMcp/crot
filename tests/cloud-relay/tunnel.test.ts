import { afterEach, describe, expect, it } from "vitest";
import {
  RelayTunnel,
  type HandshakeDecision,
  type StreamEnd,
  type StreamSink,
  type TunnelTiming,
} from "../../src/cloud-relay/tunnel.js";
import type { RelayLogRecord } from "../../src/cloud-relay/log.js";
import {
  CloseCode,
  decodeFrame,
  encodeFrame,
  encodeJsonFrame,
  encodeWindow,
  FLAG_END_STREAM,
  FrameType,
  parseJsonPayload,
  type Frame,
} from "../../src/tunnel/protocol.js";
import type { WebSocketConnection, WebSocketHandlers } from "../../src/tunnel/websocket.js";
import { sleep, waitFor } from "./harness.js";

/**
 * WP-29 / AD-22 points 5, 6, 8, 9 and 14 at the relay's tunnel state machine,
 * with a fake WebSocket: flow control in both directions, stream rules,
 * keep-alive and connection errors.
 */

class FakeSocket {
  handlers!: WebSocketHandlers;
  readonly sent: Frame[] = [];
  closedWith: { code: number; reason: string } | undefined;
  terminated = false;
  attach(h: WebSocketHandlers) {
    this.handlers = h;
  }
  send(data: Buffer) {
    this.sent.push(decodeFrame(data));
    return true;
  }
  close(code: number, reason: string) {
    if (this.closedWith) return;
    this.closedWith = { code, reason };
    queueMicrotask(() => this.handlers.onClose(code, reason));
  }
  terminate() {
    this.terminated = true;
  }
  deliver(frame: Buffer) {
    this.handlers.onMessage(frame, true);
  }
  of(type: number) {
    return this.sent.filter((f) => f.type === type);
  }
}

class Sink implements StreamSink {
  status: number | undefined;
  readonly chunks: Buffer[] = [];
  readonly credits: (() => void)[] = [];
  ended = false;
  aborted: StreamEnd | undefined;
  constructor(private readonly autoCredit = false) {}
  onResponse(status: number) {
    this.status = status;
  }
  onData(chunk: Buffer, credit: () => void) {
    this.chunks.push(chunk);
    if (this.autoCredit) credit();
    else this.credits.push(credit);
  }
  onEnd() {
    this.ended = true;
  }
  onAbort(reason: StreamEnd) {
    this.aborted = reason;
  }
}

const tunnels: RelayTunnel[] = [];
afterEach(() => {
  for (const t of tunnels.splice(0)) t.terminate();
});

function setup(options: { timing?: Partial<TunnelTiming>; maxStreams?: number; decision?: HandshakeDecision } = {}) {
  const ws = new FakeSocket();
  const logs: RelayLogRecord[] = [];
  const events: string[] = [];
  const tunnel = new RelayTunnel(ws as unknown as WebSocketConnection, {
    relayHost: "relay.crot-dev.example",
    versions: ["v1"],
    limits: {},
    timing: { handshakeMs: 1_000, pingAfterIdleMs: 20_000, deadAfterMs: 60_000, drainMs: 60_000, ...options.timing },
    log: (r) => logs.push(r),
    now: Date.now,
    authenticate: async () => options.decision ?? { ok: true, features: [] },
    onReady: () => events.push("ready"),
    onUnroutable: () => events.push("unroutable"),
    onClosed: () => events.push("closed"),
  });
  tunnels.push(tunnel);
  const hello = () =>
    ws.deliver(
      encodeJsonFrame(FrameType.HELLO, 0, {
        deviceId: "aaaaaaaaaaaaaaaaaaaaaaaaaa",
        proof: Buffer.alloc(64).toString("base64url"),
        software: "crot/0.1.0",
        maxStreams: options.maxStreams ?? 16,
        features: ["future-feature"],
      }),
    );
  return { ws, tunnel, logs, events, hello };
}

async function ready(options: Parameters<typeof setup>[0] = {}) {
  const s = setup(options);
  s.hello();
  await waitFor(() => s.tunnel.isReady);
  return s;
}

const head = {
  method: "POST",
  path: "/d/x/mcp",
  headers: [["host", "relay.crot-dev.example"]] as const,
  deadlineMs: 900_000,
};

function open(tunnel: RelayTunnel, sink: StreamSink = new Sink(), end = false) {
  const r = tunnel.open({ ...head, headers: [...head.headers] }, end, sink);
  if (!r.ok) throw new Error(r.reason);
  return r.stream;
}

const data = (stream: number, n: number, end = false) =>
  encodeFrame(FrameType.DATA, stream, Buffer.alloc(n, 1), end ? FLAG_END_STREAM : 0);
const response = (stream: number, end = false) =>
  encodeJsonFrame(FrameType.RESPONSE, stream, { status: 200, headers: [] }, end ? FLAG_END_STREAM : 0);
const sentData = (ws: FakeSocket, stream?: number) =>
  ws
    .of(FrameType.DATA)
    .filter((f) => stream === undefined || f.stream === stream)
    .reduce((n, f) => n + f.payload.length, 0);

describe("handshake state", () => {
  it("sends CHALLENGE first, READY after a positive decision, never features the relay does not support", async () => {
    const { ws, events } = await ready();
    expect(ws.sent.map((f) => f.type)).toEqual([FrameType.CHALLENGE, FrameType.READY]);
    expect(parseJsonPayload(ws.sent[1]!.payload).features).toEqual([]);
    expect(events).toEqual(["ready"]);
  });

  it("frames during authentication are protocol errors", async () => {
    const { ws, hello } = setup();
    hello();
    ws.deliver(encodeFrame(FrameType.PING, 0, Buffer.alloc(8)));
    expect(ws.closedWith?.code).toBe(CloseCode.PROTOCOL_ERROR);
  });

  it("a negative decision closes with its code and nothing else", async () => {
    const { ws, hello } = setup({ decision: { ok: false, closeCode: CloseCode.UNAUTHORIZED, reason: "unauthorized" } });
    hello();
    await waitFor(() => ws.closedWith !== undefined);
    expect(ws.closedWith).toEqual({ code: 4401, reason: "unauthorized" });
    expect(ws.of(FrameType.READY)).toHaveLength(0);
  });
});

describe("streams (AD-22 point 6)", () => {
  it("ids increase from 1; maxStreams is enforced; closed ids are not reused", async () => {
    const { ws, tunnel } = await ready({ maxStreams: 2 });
    open(tunnel, new Sink(true), true);
    open(tunnel, new Sink(true), true);
    expect(tunnel.open({ ...head, headers: [] }, true, new Sink())).toEqual({ ok: false, reason: "busy" });
    ws.deliver(response(1, true));
    const third = open(tunnel, new Sink(true), true);
    expect(third.id).toBe(3);
    expect(ws.of(FrameType.OPEN).map((f) => f.stream)).toEqual([1, 2, 3]);
  });

  it("frames for a closed stream are ignored; for a never-opened stream they are a connection error", async () => {
    const { ws, tunnel } = await ready();
    const sink = new Sink();
    const s = open(tunnel, sink, true);
    s.reset("cancel");
    ws.deliver(response(1));
    ws.deliver(data(1, 1000));
    expect(sink.status).toBeUndefined();
    // the crossed DATA's connection credit is returned
    expect(ws.of(FrameType.WINDOW).some((f) => f.stream === 0 && f.payload.readUInt32BE(0) === 1000)).toBe(true);
    expect(ws.closedWith).toBeUndefined();
    ws.deliver(response(9));
    expect(ws.closedWith?.code).toBe(CloseCode.PROTOCOL_ERROR);
  });

  it("an invalid response head resets only that stream (protocol_error)", async () => {
    const { ws, tunnel } = await ready();
    const sink = new Sink();
    open(tunnel, sink, true);
    ws.deliver(encodeJsonFrame(FrameType.RESPONSE, 1, { status: 101, headers: [] }));
    expect(sink.aborted).toBe("protocol_error");
    expect(parseJsonPayload(ws.of(FrameType.RESET)[0]!.payload)).toEqual({ code: "protocol_error" });
    const other = new Sink();
    open(tunnel, other, true);
    ws.deliver(encodeJsonFrame(FrameType.RESPONSE, 2, { status: 200, headers: [["Bad Name", "x"]] }));
    expect(other.aborted).toBe("protocol_error");
    expect(ws.closedWith).toBeUndefined();
  });

  it("a device RESET ends the stream with its code; unknown codes count as internal_error", async () => {
    const { ws, tunnel } = await ready();
    const a = new Sink();
    const b = new Sink();
    open(tunnel, a, true);
    open(tunnel, b, true);
    ws.deliver(encodeJsonFrame(FrameType.RESET, 1, { code: "refused" }));
    ws.deliver(encodeJsonFrame(FrameType.RESET, 2, { code: "brand_new" }));
    expect([a.aborted, b.aborted]).toEqual(["refused", "internal_error"]);
    expect(tunnel.openStreams).toBe(0);
  });
});

describe("response complete before the request body (AD-22 point 6)", () => {
  const resets = (ws: FakeSocket, stream: number) =>
    ws
      .of(FrameType.RESET)
      .filter((f) => f.stream === stream)
      .map((f) => parseJsonPayload(f.payload).code);

  it("the rest of the request is discarded with RESET cancel and the stream slot is freed", async () => {
    const { ws, tunnel } = await ready({ maxStreams: 1 });
    const sink = new Sink(true);
    const s = open(tunnel, sink);
    s.write(Buffer.alloc(1000));
    ws.deliver(response(1, true));
    expect(sink.ended).toBe(true);
    expect(sink.aborted).toBeUndefined();
    expect(resets(ws, 1)).toEqual(["cancel"]);
    expect(tunnel.openStreams).toBe(0);
    // Later client bytes for the finished stream are dropped, not sent.
    const before = sentData(ws, 1);
    s.write(Buffer.alloc(1000));
    s.end();
    expect(sentData(ws, 1)).toBe(before);
    expect(open(tunnel, new Sink(), true).id).toBe(2);
  });

  it("also when the request end is queued behind the device's window", async () => {
    const { ws, tunnel } = await ready({ maxStreams: 1 });
    const s = open(tunnel, new Sink(true));
    s.write(Buffer.alloc(2 * 1024 * 1024));
    s.end();
    expect(sentData(ws, 1)).toBe(1024 * 1024);
    ws.deliver(response(1));
    ws.deliver(data(1, 10, true));
    expect(resets(ws, 1)).toEqual(["cancel"]);
    expect(tunnel.openStreams).toBe(0);
    ws.deliver(encodeWindow(1, 1024 * 1024));
    ws.deliver(encodeWindow(0, 1024 * 1024));
    expect(sentData(ws, 1)).toBe(1024 * 1024);
  });

  it("no RESET when the request ended before the response", async () => {
    const { ws, tunnel } = await ready();
    const s = open(tunnel, new Sink(true));
    s.write(Buffer.alloc(10));
    s.end();
    ws.deliver(response(1, true));
    open(tunnel, new Sink(true), true);
    ws.deliver(response(2));
    ws.deliver(data(2, 5, true));
    expect(ws.of(FrameType.RESET)).toHaveLength(0);
    expect(tunnel.openStreams).toBe(0);
  });
});

describe("flow control (AD-22 point 8)", () => {
  it("relay → device: never beyond the stream window, resumes on WINDOW", async () => {
    const { ws, tunnel } = await ready();
    const s = open(tunnel, new Sink());
    s.write(Buffer.alloc(3 * 1024 * 1024));
    s.end();
    expect(sentData(ws, 1)).toBe(1024 * 1024);
    expect(ws.of(FrameType.DATA).every((f) => f.payload.length <= 65536)).toBe(true);
    ws.deliver(encodeWindow(1, 512 * 1024));
    ws.deliver(encodeWindow(0, 512 * 1024));
    expect(sentData(ws, 1)).toBe(1536 * 1024);
    ws.deliver(encodeWindow(1, 2 * 1024 * 1024));
    ws.deliver(encodeWindow(0, 2 * 1024 * 1024));
    expect(sentData(ws, 1)).toBe(3 * 1024 * 1024);
    const last = ws.of(FrameType.DATA).at(-1)!;
    expect(last.flags & FLAG_END_STREAM).toBe(FLAG_END_STREAM);
  });

  it("relay → device: the connection window is shared by all streams", async () => {
    const { ws, tunnel } = await ready();
    for (let i = 0; i < 9; i++) open(tunnel, new Sink()).write(Buffer.alloc(1024 * 1024));
    expect(sentData(ws)).toBe(8 * 1024 * 1024);
    expect(sentData(ws, 9)).toBe(0);
    ws.deliver(encodeWindow(0, 1024 * 1024));
    expect(sentData(ws, 9)).toBe(1024 * 1024);
  });

  it("device → relay: DATA beyond the granted stream window is a connection error", async () => {
    const { ws, tunnel } = await ready();
    const sink = new Sink();
    open(tunnel, sink, true);
    ws.deliver(response(1));
    for (let i = 0; i < 16; i++) ws.deliver(data(1, 65536));
    expect(ws.closedWith).toBeUndefined();
    ws.deliver(data(1, 1));
    expect(ws.closedWith?.code).toBe(CloseCode.PROTOCOL_ERROR);
    expect(parseJsonPayload(ws.of(FrameType.GOAWAY)[0]!.payload)).toEqual({ lastStream: 1, code: "protocol_error" });
    await waitFor(() => sink.aborted !== undefined);
    expect(sink.aborted).toBe("tunnel_lost");
  });

  it("device → relay: credit is returned only as bytes are delivered, for stream and connection", async () => {
    const { ws, tunnel } = await ready();
    const sink = new Sink();
    open(tunnel, sink, true);
    ws.deliver(response(1));
    ws.deliver(data(1, 65536));
    expect(ws.of(FrameType.WINDOW)).toHaveLength(0);
    sink.credits[0]!();
    sink.credits[0]!();
    const windows = ws.of(FrameType.WINDOW).map((f) => [f.stream, f.payload.readUInt32BE(0)]);
    expect(windows).toEqual([
      [1, 65536],
      [0, 65536],
    ]);
  });

  it("device → relay: the connection window is enforced across streams", async () => {
    const { ws, tunnel } = await ready();
    for (let i = 1; i <= 9; i++) {
      open(tunnel, new Sink(), true);
      ws.deliver(response(i));
    }
    for (let i = 1; i <= 8; i++) for (let k = 0; k < 16; k++) ws.deliver(data(i, 65536));
    expect(ws.closedWith).toBeUndefined();
    ws.deliver(data(9, 1));
    expect(ws.closedWith?.code).toBe(CloseCode.PROTOCOL_ERROR);
  });

  it("invalid WINDOW frames: zero increment, overflow, wrong size", async () => {
    for (const frame of [
      encodeFrame(FrameType.WINDOW, 0, Buffer.from([0, 0, 0, 0])),
      encodeFrame(FrameType.WINDOW, 0, Buffer.from([0x7f, 0xff, 0xff, 0xff])),
      encodeFrame(FrameType.WINDOW, 0, Buffer.from([0, 1])),
    ]) {
      const { ws } = await ready();
      ws.deliver(frame);
      expect(ws.closedWith?.code).toBe(CloseCode.PROTOCOL_ERROR);
    }
  });

  it("returns outstanding connection credit when a stream closes", async () => {
    const { ws, tunnel } = await ready();
    const sink = new Sink();
    const s = open(tunnel, sink, true);
    ws.deliver(response(1));
    ws.deliver(data(1, 4096));
    s.reset("cancel");
    expect(ws.of(FrameType.WINDOW).map((f) => [f.stream, f.payload.readUInt32BE(0)])).toEqual([[0, 4096]]);
    sink.credits[0]!();
    expect(ws.of(FrameType.WINDOW)).toHaveLength(1);
  });
});

describe("connection errors (AD-22 point 14)", () => {
  const cases: [string, Buffer][] = [
    ["unknown type below 0x80", encodeFrame(0x30, 0)],
    ["wrong direction (OPEN from the device)", encodeJsonFrame(FrameType.OPEN, 1, {})],
    ["wrong direction (HELLO again)", encodeJsonFrame(FrameType.HELLO, 0, {})],
    ["reserved flag bits", encodeFrame(FrameType.PING, 0, Buffer.alloc(8), 0x02)],
    ["END_STREAM on a control frame", encodeFrame(FrameType.PING, 0, Buffer.alloc(8), FLAG_END_STREAM)],
    ["short PING", encodeFrame(FrameType.PING, 0, Buffer.alloc(4))],
    ["PING on a stream", encodeFrame(FrameType.PING, 1, Buffer.alloc(8))],
    ["invalid GOAWAY JSON", encodeFrame(FrameType.GOAWAY, 0, Buffer.from("{"))],
    ["DATA on stream 0", encodeFrame(FrameType.DATA, 0, Buffer.alloc(1))],
    ["short frame", Buffer.from([0x20, 0, 0])],
  ];
  for (const [name, frame] of cases)
    it(name, async () => {
      const { ws, logs } = await ready();
      ws.deliver(frame);
      expect(ws.closedWith).toEqual({ code: CloseCode.PROTOCOL_ERROR, reason: "protocol_error" });
      expect(logs.some((l) => l.event === "tunnel.protocol_error")).toBe(true);
    });

  it("text messages are protocol errors", async () => {
    const { ws } = await ready();
    ws.handlers.onMessage(Buffer.from("hi"), false);
    expect(ws.closedWith?.code).toBe(CloseCode.PROTOCOL_ERROR);
  });

  it("extension frame types are ignored when not negotiated", async () => {
    const { ws } = await ready();
    ws.deliver(encodeFrame(0x80, 0, Buffer.from("x")));
    ws.deliver(encodeFrame(0xff, 7, Buffer.from("y")));
    expect(ws.closedWith).toBeUndefined();
  });

  it("DATA before RESPONSE and a second RESPONSE are connection errors", async () => {
    let s = await ready();
    open(s.tunnel, new Sink(), true);
    s.ws.deliver(data(1, 10));
    expect(s.ws.closedWith?.code).toBe(CloseCode.PROTOCOL_ERROR);
    s = await ready();
    open(s.tunnel, new Sink(), true);
    s.ws.deliver(response(1));
    s.ws.deliver(response(1));
    expect(s.ws.closedWith?.code).toBe(CloseCode.PROTOCOL_ERROR);
  });
});

describe("keep-alive and GOAWAY (AD-22 point 9)", () => {
  it("answers PING with PONG; sends PING when idle; closes after silence", async () => {
    const { ws, tunnel } = await ready({ timing: { pingAfterIdleMs: 50, deadAfterMs: 200 } });
    const sink = new Sink();
    open(tunnel, sink, true);
    ws.deliver(encodeFrame(FrameType.PING, 0, Buffer.from("12345678")));
    expect(ws.of(FrameType.PONG)[0]!.payload.toString()).toBe("12345678");
    await waitFor(() => ws.of(FrameType.PING).length > 0);
    expect(ws.of(FrameType.PING)[0]!.payload).toHaveLength(8);
    await waitFor(() => ws.terminated);
    expect(sink.aborted).toBe("tunnel_lost");
  });

  it("frames from the device keep the tunnel alive", async () => {
    const { ws } = await ready({ timing: { pingAfterIdleMs: 30, deadAfterMs: 150 } });
    for (let i = 0; i < 10; i++) {
      ws.deliver(encodeFrame(FrameType.PONG, 0, Buffer.alloc(8)));
      await sleep(40);
    }
    expect(ws.terminated).toBe(false);
  });

  it("a local GOAWAY stops new streams, lets in-flight ones finish and then closes", async () => {
    const { ws, tunnel, events } = await ready();
    const sink = new Sink(true);
    open(tunnel, sink, true);
    tunnel.goAway("superseded");
    expect(parseJsonPayload(ws.of(FrameType.GOAWAY)[0]!.payload)).toEqual({ lastStream: 1, code: "superseded" });
    expect(events).toContain("unroutable");
    expect(tunnel.open({ ...head, headers: [] }, true, new Sink())).toEqual({ ok: false, reason: "unavailable" });
    ws.deliver(response(1, true));
    expect(sink.ended).toBe(true);
    expect(ws.closedWith).toEqual({ code: 1000, reason: "superseded" });
  });

  it("a device GOAWAY: streams above lastStream end as not_processed", async () => {
    const { ws, tunnel } = await ready();
    const a = new Sink(true);
    const b = new Sink(true);
    open(tunnel, a, true);
    open(tunnel, b, true);
    ws.deliver(encodeJsonFrame(FrameType.GOAWAY, 0, { lastStream: 1, code: "remote_disabled" }));
    expect(b.aborted).toBe("not_processed");
    expect(a.aborted).toBeUndefined();
    expect(tunnel.routable).toBe(false);
  });
});
