import { afterEach, describe, expect, it } from "vitest";
import { CloseCode, encodeFrame, FrameType, OUTCOME_HEADER } from "../../src/tunnel/protocol.js";
import { RelayHarness, sleep, waitFor } from "./harness.js";
import type { DeviceStream } from "./test-device.js";

/**
 * WP-29 / AD-22 points 8, 9 and 14 over real sockets: supersession, slow
 * clients, keep-alive loss, oversized frames, connection errors with
 * requests in flight, interoperability with a standard WebSocket client.
 */

let h: RelayHarness;
afterEach(async () => {
  await h.stop();
});

const answer = (body: string) => (s: DeviceStream) => {
  void s.bodyDone().then(() => {
    s.respond(200, [["content-type", "application/json"]]);
    void s.write(Buffer.from(body), true);
  });
};

describe("one tunnel per device (AD-22 point 9)", () => {
  it("a new tunnel supersedes the old one: GOAWAY superseded, in-flight finishes, new streams go to the new tunnel", async () => {
    h = await new RelayHarness().start();
    const { paired, device: old } = await h.ready();
    const inflight = h.post(paired);
    await waitFor(() => old.opened.length === 1);
    const fresh = await h.online(paired, { onOpen: answer('{"tunnel":"new"}') });
    const goaway = await old.frame(FrameType.GOAWAY);
    expect(JSON.parse(goaway.payload.toString())).toEqual({ lastStream: 1, code: "superseded" });
    expect(await (await h.post(paired)).json()).toEqual({ tunnel: "new" });
    answer('{"tunnel":"old"}')(old.opened[0]!);
    expect(await (await inflight).json()).toEqual({ tunnel: "old" });
    expect((await old.whenClosed()).code).toBe(1000);
    expect(fresh.closed).toBeUndefined();
    expect(h.logs).toContainEqual(expect.objectContaining({ event: "tunnel.superseded", deviceId: paired.deviceId }));
  });

  it("too frequent supersession is refused with 4409 and logged; the current tunnel stays", async () => {
    h = await new RelayHarness().start({ supersessionRate: { max: 2, windowMs: 3_600_000 } });
    const paired = h.newDevice();
    await h.register(paired);
    await h.online(paired);
    await h.online(paired);
    const current = await h.online(paired, { onOpen: answer('{"current":true}') });
    const refused = await h.connect(paired);
    expect((await refused.whenClosed()).code).toBe(CloseCode.SUPERSEDED_TOO_OFTEN);
    expect(h.logs).toContainEqual(expect.objectContaining({ event: "tunnel.supersession_limit" }));
    expect(await (await h.post(paired)).json()).toEqual({ current: true });
    expect(current.closed).toBeUndefined();
  });
});

describe("slow clients (AD-22 point 8)", () => {
  it("a client that does not read stalls only its own stream and is reset after the stall limit", async () => {
    h = await new RelayHarness().start({ stallMs: 300 });
    const { paired, device } = await h.ready();
    device.onOpen = (s) => {
      if (device.opened.length === 1) {
        s.respond(200, [["content-type", "application/octet-stream"]]);
        void s.write(Buffer.alloc(30 * 1024 * 1024), true);
      } else answer('{"other":true}')(s);
    };
    const slow = await h.raw(paired, { body: "{}" });
    slow.res.pause();
    await sleep(100);
    expect(await (await h.post(paired)).json()).toEqual({ other: true });
    expect(await device.opened[0]!.reset()).toBe("client_stalled");
    expect(h.logs).toContainEqual(
      expect.objectContaining({ event: "exchange", code: "client_stalled", outcome: "unknown" }),
    );
    slow.destroy();
  }, 30_000);

  it("an approval-style wait (no data pending) is not a stall", async () => {
    h = await new RelayHarness().start({ stallMs: 100 });
    const { paired, device } = await h.ready();
    device.onOpen = (s) => setTimeout(() => answer('{"late":true}')(s), 400);
    expect(await (await h.post(paired)).json()).toEqual({ late: true });
  });
});

describe("liveness (AD-22 point 9)", () => {
  it("the relay pings an idle device and drops a silent one; its requests become 503 offline", async () => {
    h = await new RelayHarness().start({ timing: { pingAfterIdleMs: 50, deadAfterMs: 250 } });
    const { paired, device } = await h.ready({ autoPong: false });
    await device.frame(FrameType.PING);
    await device.whenClosed();
    await waitFor(() => !h.relay.isOnline(paired.deviceId));
    const res = await h.post(paired);
    expect(res.status).toBe(503);
    expect(res.headers.get(OUTCOME_HEADER)).toBe("not_executed");
    expect(h.logs).toContainEqual(expect.objectContaining({ event: "tunnel.dead" }));
  });

  it("a device answering PINGs stays online", async () => {
    h = await new RelayHarness().start({ timing: { pingAfterIdleMs: 30, deadAfterMs: 150 } });
    const { paired, device } = await h.ready();
    await sleep(500);
    expect(device.closed).toBeUndefined();
    expect(h.relay.isOnline(paired.deviceId)).toBe(true);
  });
});

describe("connection errors over the wire (AD-22 point 14)", () => {
  it("a frame above the size limit closes 4400", async () => {
    h = await new RelayHarness().start();
    const { device } = await h.ready();
    device.send(encodeFrame(FrameType.PONG, 0, Buffer.alloc(70 * 1024)));
    expect((await device.whenClosed()).code).toBe(CloseCode.PROTOCOL_ERROR);
  });

  it("a protocol error with requests in flight: GOAWAY protocol_error, close 4400, clients get 502 unknown", async () => {
    h = await new RelayHarness().start();
    const { paired, device } = await h.ready();
    const pending = h.post(paired);
    await waitFor(() => device.opened.length === 1);
    device.send(encodeFrame(0x31, 0));
    const goaway = await device.frame(FrameType.GOAWAY);
    expect(JSON.parse(goaway.payload.toString()).code).toBe("protocol_error");
    expect((await device.whenClosed()).code).toBe(CloseCode.PROTOCOL_ERROR);
    const res = await pending;
    expect(res.status).toBe(502);
    expect(res.headers.get(OUTCOME_HEADER)).toBe("unknown");
    expect(device.opened).toHaveLength(1);
  });

  it("unmasked client frames are refused at the WebSocket layer", async () => {
    h = await new RelayHarness().start();
    const { device } = await h.ready();
    const raw = (device.ws as unknown as { socket: { write(b: Buffer): void } }).socket;
    raw.write(Buffer.from([0x82, 0x06, 0x20, 0, 0, 0, 0, 0]));
    const closed = await device.whenClosed();
    expect([1002, 1006]).toContain(closed.code);
  });
});

describe("interoperability", () => {
  it.skipIf(typeof (globalThis as { WebSocket?: unknown }).WebSocket !== "function")(
    "a standard WebSocket client negotiates crot-tunnel.v1 and receives CHALLENGE",
    async () => {
      h = await new RelayHarness().start();
      const WS = (globalThis as unknown as { WebSocket: new (url: string, protocols: string[]) => WebSocketLike })
        .WebSocket;
      const ws = new WS(`ws://127.0.0.1:${h.relay.port}/.crot/tunnel`, ["crot-tunnel.v1"]);
      ws.binaryType = "arraybuffer";
      const first = await new Promise<ArrayBuffer>((resolve, reject) => {
        ws.onmessage = (e) => resolve(e.data as ArrayBuffer);
        ws.onerror = () => reject(new Error("error"));
      });
      expect(ws.protocol).toBe("crot-tunnel.v1");
      expect(new Uint8Array(first)[0]).toBe(FrameType.CHALLENGE);
      ws.send(new Uint8Array([0x30, 0, 0, 0, 0, 0]));
      const code = await new Promise<number>((r) => (ws.onclose = (e) => r(e.code)));
      expect(code).toBe(CloseCode.PROTOCOL_ERROR);
    },
  );

  it.skipIf(typeof (globalThis as { WebSocket?: unknown }).WebSocket !== "function")(
    "a standard client can read the 4426 reason",
    async () => {
      h = await new RelayHarness().start();
      const WS = (globalThis as unknown as { WebSocket: new (url: string, protocols: string[]) => WebSocketLike })
        .WebSocket;
      const ws = new WS(`ws://127.0.0.1:${h.relay.port}/.crot/tunnel`, ["crot-tunnel.v9"]);
      const closed = await new Promise<{ code: number; reason: string }>((r) => (ws.onclose = (e) => r(e)));
      expect(closed).toMatchObject({ code: 4426, reason: "update required;supported=v1" });
    },
  );
});

interface WebSocketLike {
  binaryType: string;
  protocol: string;
  onmessage: ((e: { data: unknown }) => void) | null;
  onerror: (() => void) | null;
  onclose: ((e: { code: number; reason: string }) => void) | null;
  send(data: Uint8Array): void;
}
