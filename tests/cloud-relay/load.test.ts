/** WP-29 release gate: real HTTP/WebSocket load, admission before buffering, credit isolation. */
import { request } from "node:http";
import { connect, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { parseRelayConfig } from "../../src/cloud-relay/config.js";
import { WindowCounter } from "../../src/cloud-relay/limits.js";
import { INITIAL_CONNECTION_WINDOW, INITIAL_STREAM_WINDOW, OUTCOME_HEADER } from "../../src/tunnel/protocol.js";
import { RelayHarness, sleep, waitFor, type PairedDevice } from "./harness.js";
let h: RelayHarness;
const sockets: Socket[] = [];
afterEach(async () => {
  for (const s of sockets.splice(0)) s.destroy();
  await h?.stop();
});
function token(p: PairedDevice, client: string) {
  return h.as.token({ resource: p.uri, sub: p.accountId, clientId: client });
}
function post(p: PairedDevice, client: string) {
  return h.post(p, "{}", { authorization: "Bearer " + token(p, client) });
}
async function refused(r: Response, status: number) {
  expect(r.status).toBe(status);
  expect(r.headers.get(OUTCOME_HEADER)).toBe("not_executed");
  expect(r.headers.get("retry-after")).toBe("1");
  await r.text();
}
function socket(port: number): Promise<Socket> {
  return new Promise((resolve) => {
    const s = connect(port, "127.0.0.1", () => resolve(s));
    sockets.push(s);
    s.on("error", () => undefined);
  });
}
describe("WP-29 limits/load", () => {
  it("validates configurable limits and bounds rate-counter cardinality", () => {
    let now = 0;
    const c = new WindowCounter({ max: 2, windowMs: 1000 }, () => now, 2);
    expect(c.take("a")).toBeUndefined();
    expect(c.take("a")).toBeUndefined();
    expect(c.take("a")).toBe(1000);
    c.take("b");
    expect(c.take("c")).toBe(1000);
    now = 1001;
    expect(c.take("c")).toBeUndefined();
    const base = {
      relayHost: "relay.example",
      issuer: "https://auth.example",
      pairingClientId: "pair",
      registryFile: "x",
    };
    expect(parseRelayConfig(base).limits.clientConcurrency).toBe(4);
    for (const limits of [
      { clientConcurrency: 0 },
      { sourceHandshakes: 65 },
      { counterKeys: NaN },
      { clientRequests: { max: 1, windowMs: 0 } },
      { typo: 1 },
    ])
      expect(() => parseRelayConfig({ ...base, limits })).toThrow();
  });
  it("client and device request rate windows reject before tunnel OPEN, then recover", async () => {
    let now = Date.now();
    h = await new RelayHarness().start({
      now: () => now,
      limits: { clientRequests: { max: 2, windowMs: 1000 }, deviceRequests: { max: 3, windowMs: 1000 } },
    });
    const { paired, device } = await h.ready({ onOpen: (s) => s.respond(204, [], true) });
    for (let i = 0; i < 2; i++) {
      const r = await post(paired, "client-a");
      expect(r.status).toBe(204);
    }
    await refused(await post(paired, "client-a"), 429);
    expect((await post(paired, "client-b")).status).toBe(204);
    await refused(await post(paired, "client-c"), 429);
    expect(device.opened).toHaveLength(3);
    now += 1001;
    expect((await post(paired, "client-a")).status).toBe(204);
    await waitFor(() => h.relay.status().admission.requests === 0);
    expect(h.relay.status().openStreams).toBe(0);
  });
  it("reserves per-client/device slots BEFORE reading unfinished chunked bodies; abort releases memory and slots", async () => {
    h = await new RelayHarness().start({ limits: { clientConcurrency: 1, deviceConcurrency: 2 } });
    const { paired, device } = await h.ready({ maxStreams: 8, onOpen: (s) => s.respond(204, [], true) });
    const pending = (client: string) => {
      const req = request(h.url(paired), {
        method: "POST",
        headers: { authorization: "Bearer " + token(paired, client), "transfer-encoding": "chunked" },
      });
      req.on("error", () => undefined);
      req.write(Buffer.alloc(16384));
      return req;
    };
    const a = pending("client-a");
    await waitFor(() => h.relay.status().admission.bufferedRequestBytes === 16384);
    await refused(await post(paired, "client-a"), 503);
    const b = pending("client-b");
    await waitFor(() => h.relay.status().admission.requests === 2);
    await refused(await post(paired, "client-c"), 503);
    expect(device.opened).toHaveLength(0);
    a.destroy();
    b.destroy();
    await waitFor(
      () => h.relay.status().admission.requests === 0 && h.relay.status().admission.bufferedRequestBytes === 0,
    );
    expect(h.relay.status().admission.clients).toBe(0);
    expect((await post(paired, "client-c")).status).toBe(204);
  });
  it("global body admission is bounded across devices and recovers on abort", async () => {
    h = await new RelayHarness().start({
      limits: { clientConcurrency: 1, deviceConcurrency: 1, globalConcurrency: 1 },
    });
    const a = await h.ready({ onOpen: (s) => s.respond(204, [], true) });
    const b = await h.ready({ onOpen: (s) => s.respond(204, [], true) }, "another-account");
    const req = request(h.url(a.paired), {
      method: "POST",
      headers: {
        authorization: "Bearer " + token(a.paired, "a"),
        "transfer-encoding": "chunked",
      },
    });
    req.on("error", () => undefined);
    req.write("held");
    try {
      await waitFor(() => h.relay.status().admission.requests === 1);
      await refused(await post(b.paired, "b"), 503);
      expect(b.device.opened).toHaveLength(0);
    } finally {
      req.destroy();
    }
    await waitFor(() => h.relay.status().admission.requests === 0);
    expect((await post(b.paired, "b")).status).toBe(204);
  });
  it("per-account registration rate follows token verification and recovers without affecting other accounts", async () => {
    let now = Date.now();
    h = await new RelayHarness().start({
      now: () => now,
      limits: { accountRegistrations: { max: 1, windowMs: 1000 } },
    });
    const a = h.newDevice(),
      b = h.newDevice();
    await h.register(a);
    const noPair = await h.registerRaw(b.deviceId, h.clientToken(b), { publicKey: b.publicKey });
    expect(noPair.status).toBe(403);
    const r = await h.registerRaw(b.deviceId, h.pairingToken(b), { publicKey: b.publicKey });
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBe("1");
    expect(await h.registry.get(b.deviceId)).toBeUndefined();
    await h.register(h.newDevice("other"));
    now += 1001;
    await h.register(b);
  });
  it("per-source pending handshakes cannot consume the global pool; close releases slots", async () => {
    h = await new RelayHarness().start({ limits: { sourceHandshakes: 2 } });
    const paired = h.newDevice();
    await h.register(paired);
    const a = await h.connect(paired, { noHello: true }),
      b = await h.connect(paired, { noHello: true });
    await waitFor(() => h.relay.status().tunnels.handshake === 2);
    await expect(h.connect(paired, { noHello: true })).rejects.toThrow();
    expect(h.relay.status().tunnels.handshake).toBe(2);
    a.ws.terminate();
    b.ws.terminate();
    await waitFor(() => h.relay.status().tunnels.handshake === 0);
    await h.online(paired);
  });
  it("per-source TCP cap includes pre-HTTP sockets and ignores spoofed forwarded headers", async () => {
    h = await new RelayHarness().start({ limits: { sourceConnections: 2, sourceHandshakes: 1 } });
    await socket(h.relay.port);
    await socket(h.relay.port);
    const rejected = await socket(h.relay.port);
    let text = "";
    rejected.on("data", (b) => (text += b.toString()));
    await new Promise<void>((r) => rejected.on("close", () => r()));
    expect(text).toContain("503");
    expect(text).toContain("Retry-After: 1");
    sockets[0]!.destroy();
    await sleep(30);
    const free = await socket(h.relay.port);
    free.write("GET /.crot/health HTTP/1.1\r\nHost: x\r\nX-Forwarded-For: 203.0.113.1\r\nConnection: close\r\n\r\n");
    let response = "";
    free.on("data", (b) => (response += b.toString()));
    await new Promise<void>((r) => free.on("close", () => r()));
    expect(response).toContain("200");
  });
  it("load: slow client credit stays bounded while 48 requests from other clients complete, with no lingering streams", async () => {
    h = await new RelayHarness().start({ stallMs: 30000, limits: { clientConcurrency: 4, deviceConcurrency: 16 } });
    const { paired, device } = await h.ready({ maxStreams: 32 });
    device.onOpen = (s) => {
      if (s.header("x-load") === "slow") {
        s.respond(200);
        void s.write(Buffer.alloc(12 * 1024 * 1024), true);
      } else {
        s.respond(200);
        void s.write(Buffer.alloc(64 * 1024, 7), true);
      }
    };
    const slow = [];
    for (let i = 0; i < 4; i++) {
      const r = await h.raw(paired, {
        body: "{}",
        headers: { "x-load": "slow", authorization: "Bearer " + token(paired, "slow-client") },
      });
      r.res.pause();
      slow.push(r);
    }
    await refused(await post(paired, "slow-client"), 503);
    await waitFor(() => h.relay.status().admission.uncreditedResponseBytes > 0);
    const held = device.opened[0]!;
    for (let batch = 0; batch < 6; batch++) {
      const results = await Promise.all(Array.from({ length: 8 }, (_, i) => post(paired, "client-" + i)));
      for (const r of results) {
        expect(r.status).toBe(200);
        expect(Buffer.from(await r.arrayBuffer()).equals(Buffer.alloc(64 * 1024, 7))).toBe(true);
      }
      expect(h.relay.status().admission.uncreditedResponseBytes).toBeLessThanOrEqual(INITIAL_CONNECTION_WINDOW);
      expect(held.sendWindow).toBeGreaterThanOrEqual(0);
      expect(held.sendWindow).toBeLessThanOrEqual(INITIAL_STREAM_WINDOW);
    }
    expect(device.opened.length).toBe(52);
    expect(held.resetCode).toBeUndefined();
    for (const r of slow) r.destroy();
    await Promise.all(device.opened.slice(0, 4).map((s) => s.reset()));
    await waitFor(() => h.relay.status().openStreams === 0 && h.relay.status().admission.requests === 0);
    expect(h.relay.status().admission.clients).toBe(0);
    expect(h.relay.status().admission.bufferedRequestBytes).toBe(0);
    // After cancellation the same tunnel is still usable, without retries.
    const after = await post(paired, "after-load");
    expect(after.status).toBe(200);
    await after.arrayBuffer();
  }, 20000);
});
