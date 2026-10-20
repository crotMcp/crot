import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { devicePublicKey } from "../../src/identity/device-credential.js";
import { protectedResourceMetadataUrl } from "../../src/identity/device-id.js";
import { CloseCode, encodeFrame, encodeJsonFrame, FrameType } from "../../src/tunnel/protocol.js";
import { TEST_ISSUER, TEST_RELAY, rsaKey } from "../identity/test-authorization-server.js";
import { RelayHarness, sleep } from "./harness.js";
import { TestDevice } from "./test-device.js";

/**
 * WP-29 / AD-22 points 3–4 and AD-21 points 6–7: device registration at
 * pairing, Protected Resource Metadata, tunnel handshake and its refusals.
 */

let h: RelayHarness;
beforeEach(async () => {
  h = await new RelayHarness().start({ timing: { handshakeMs: 300 } });
});
afterEach(async () => {
  await h.stop();
});

describe("device registration (AD-22 point 4)", () => {
  it("registers once; the same key and account again is unchanged, anything else conflicts", async () => {
    const d = h.newDevice();
    const first = await h.registerRaw(d.deviceId, h.pairingToken(d), { publicKey: d.publicKey });
    expect(first.status).toBe(201);
    expect(first.body).toEqual({ deviceId: d.deviceId, registeredAt: expect.any(String) });
    expect(await h.registry.get(d.deviceId)).toMatchObject({
      accountId: "user_01",
      publicKey: d.publicKey,
      environment: "test",
    });
    const again = await h.registerRaw(d.deviceId, h.pairingToken(d), { publicKey: d.publicKey });
    expect(again.status).toBe(200);
    const otherKey = devicePublicKey(generateKeyPairSync("ed25519").privateKey);
    expect((await h.registerRaw(d.deviceId, h.pairingToken(d), { publicKey: otherKey })).status).toBe(409);
    const otherAccount = { ...d, accountId: "user_02" };
    expect((await h.registerRaw(d.deviceId, h.pairingToken(otherAccount), { publicKey: d.publicKey })).status).toBe(
      409,
    );
    expect((await h.registry.get(d.deviceId))!.publicKey).toEqual(d.publicKey);
  });

  it("refuses missing, foreign, expired and wrongly issued tokens", async () => {
    const d = h.newDevice();
    const other = h.newDevice();
    const none = await h.registerRaw(d.deviceId, undefined, { publicKey: d.publicKey });
    expect(none.status).toBe(401);
    expect(none.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${protectedResourceMetadataUrl(TEST_RELAY, d.deviceId)}"`,
    );
    const foreign = await h.registerRaw(d.deviceId, h.pairingToken(other), { publicKey: d.publicKey });
    expect(foreign.status).toBe(401);
    expect(foreign.headers.get("www-authenticate")).toContain('error="invalid_token"');
    const now = Math.floor(Date.now() / 1000);
    const expired = h.pairingToken(d, { iat: now - 400, exp: now - 100 });
    expect((await h.registerRaw(d.deviceId, expired, { publicKey: d.publicKey })).status).toBe(401);
    const wrongIssuer = h.pairingToken(d, { iss: "https://auth.other.example" });
    expect((await h.registerRaw(d.deviceId, wrongIssuer, { publicKey: d.publicKey })).status).toBe(401);
    const forged = h.as.token({ resource: d.uri, sub: d.accountId, key: rsaKey("key-1") });
    expect((await h.registerRaw(d.deviceId, forged, { publicKey: d.publicKey })).status).toBe(401);
    expect(await h.registry.count()).toBe(0);
  });

  it("accepts only the pairing client's token: other clients of the owner or of another account are refused", async () => {
    const d = h.newDevice("user_victim");
    const attacker = { ...d, accountId: "user_attacker" };
    // An ordinary MCP client token for this device URI — of another account (the provider issues
    // tokens for any device URI, AD-21) and of the owner — is not a pairing.
    for (const token of [h.clientToken(attacker), h.clientToken(d)]) {
      const r = await h.registerRaw(d.deviceId, token, { publicKey: h.newDevice().publicKey });
      expect(r.status).toBe(403);
      expect(r.body).toEqual({ error: "pairing_client_required" });
    }
    expect(await h.registry.count()).toBe(0);
    expect(h.logs).toContainEqual(
      expect.objectContaining({ event: "device.register", status: 403, code: "not_pairing_client" }),
    );
    // The device's own pairing token still registers it.
    expect((await h.registerRaw(d.deviceId, h.pairingToken(d), { publicKey: d.publicKey })).status).toBe(201);
    // After that, nobody else can take the id over, with any token.
    const pairingOfAttacker = h.pairingToken(attacker);
    expect((await h.registerRaw(d.deviceId, pairingOfAttacker, { publicKey: h.newDevice().publicKey })).status).toBe(
      409,
    );
    expect((await h.registry.get(d.deviceId))!.accountId).toBe("user_victim");
    expect(h.logText()).not.toContain(pairingOfAttacker);
  });

  it("validates the public key and the body", async () => {
    const d = h.newDevice();
    const t = () => h.pairingToken(d);
    expect((await h.registerRaw(d.deviceId, t(), "not json")).status).toBe(400);
    expect((await h.registerRaw(d.deviceId, t(), { publicKey: { kty: "RSA", n: "x", e: "AQAB" } })).status).toBe(400);
    expect((await h.registerRaw(d.deviceId, t(), { publicKey: { ...d.publicKey, d: "secret" } })).status).toBe(400);
    expect((await h.registerRaw(d.deviceId, t(), { publicKey: { ...d.publicKey, x: "AAAA" } })).status).toBe(400);
    expect((await h.registerRaw(d.deviceId, t(), { publicKey: d.publicKey, pad: "x".repeat(5000) })).status).toBe(413);
    const get = await fetch(`${h.origin}/d/${d.deviceId}/register`);
    expect(get.status).toBe(405);
    expect(await h.registry.count()).toBe(0);
  });

  it("logs registrations without tokens or keys", async () => {
    const d = h.newDevice();
    const token = h.pairingToken(d);
    await h.registerRaw(d.deviceId, token, { publicKey: d.publicKey });
    expect(h.logText()).not.toContain(token);
    expect(h.logText()).not.toContain(d.publicKey.x);
    expect(h.logs).toContainEqual(expect.objectContaining({ event: "device.register", status: 201, code: "created" }));
  });
});

describe("Protected Resource Metadata (AD-21 point 6)", () => {
  it("is served for registered devices only, with the canonical resource", async () => {
    const d = h.newDevice();
    const prm = `${h.origin}/.well-known/oauth-protected-resource/d/${d.deviceId}/mcp`;
    expect((await fetch(prm)).status).toBe(404);
    await h.register(d);
    const res = await fetch(prm);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      resource: d.uri,
      authorization_servers: [TEST_ISSUER],
      bearer_methods_supported: ["header"],
      scopes_supported: ["offline_access"],
    });
    expect((await fetch(`${h.origin}/.well-known/oauth-protected-resource`)).status).toBe(404);
  });

  it("answers health checks without device information", async () => {
    const res = await fetch(`${h.origin}/.crot/health`);
    expect(await res.json()).toEqual({ status: "ok" });
  });
});

describe("tunnel handshake (AD-22 points 3, 10, 14)", () => {
  it("CHALLENGE → HELLO → READY with the pinned host, a fresh challenge and the limits", async () => {
    const { paired, device } = await h.ready();
    expect(device.ws.protocol).toBe("crot-tunnel.v1");
    expect(device.challenge).toMatchObject({ versions: ["v1"], relayHost: TEST_RELAY });
    expect(Buffer.from(String(device.challenge!.challenge), "base64url")).toHaveLength(32);
    expect(device.ready).toEqual({
      tunnelId: expect.any(String),
      features: [],
      limits: {
        frameBytes: 65536,
        jsonBytes: 65536,
        requestBodyBytes: 4 * 1024 * 1024,
        responseBodyBytes: 32 * 1024 * 1024,
        connectionWindow: 8 * 1024 * 1024,
        streamWindow: 1024 * 1024,
        exchangeDeadlineMs: 15 * 60_000,
      },
    });
    expect(h.relay.isOnline(paired.deviceId)).toBe(true);
    const second = await h.online(paired);
    expect(second.challenge!.challenge).not.toBe(device.challenge!.challenge);
  });

  it("refuses a bad proof, an unknown device and a proof for another relay host (4401)", async () => {
    const d = h.newDevice();
    await h.register(d);
    const wrongKey = generateKeyPairSync("ed25519").privateKey;
    expect((await (await h.connect(d, { key: wrongKey })).whenClosed()).code).toBe(CloseCode.UNAUTHORIZED);
    const unknown = h.newDevice();
    expect((await (await h.connect(unknown)).whenClosed()).code).toBe(CloseCode.UNAUTHORIZED);
    const otherHost = await h.connect(d, { signHost: "relay.other.example" });
    const closed = await otherHost.whenClosed();
    expect(closed).toEqual({ code: CloseCode.UNAUTHORIZED, reason: "unauthorized" });
    expect(h.relay.isOnline(d.deviceId)).toBe(false);
  });

  it("refuses a device that is not entitled (4403)", async () => {
    await h.stop();
    h = await new RelayHarness().start({ entitlement: () => "blocked" });
    const d = h.newDevice();
    await h.register(d);
    expect((await (await h.connect(d)).whenClosed()).code).toBe(CloseCode.FORBIDDEN);
  });

  it("accepts, then closes 4426 when no common major version is offered", async () => {
    const d = h.newDevice();
    await h.register(d);
    for (const protocols of [["crot-tunnel.v2"], ["chat"], []]) {
      const device = await h.connect(d, { protocols });
      // the device's own offer is echoed so standard clients can read the close (no frame is sent)
      expect(device.ws.protocol).toBe(protocols[0] === "crot-tunnel.v2" ? "crot-tunnel.v2" : undefined);
      expect(await device.whenClosed()).toEqual({
        code: CloseCode.UNSUPPORTED_VERSION,
        reason: "update required;supported=v1",
      });
      expect(device.frames).toHaveLength(0);
    }
    const both = await h.online(d, { protocols: ["crot-tunnel.v2", "crot-tunnel.v1"] });
    expect(both.ws.protocol).toBe("crot-tunnel.v1");
  });

  it("closes 4408 when the handshake does not finish in time", async () => {
    const d = h.newDevice();
    await h.register(d);
    const device = await h.connect(d, { noHello: true });
    expect((await device.whenClosed()).code).toBe(CloseCode.HANDSHAKE_TIMEOUT);
  });

  it("treats frames before HELLO, invalid HELLO and text messages as protocol errors (4400)", async () => {
    const d = h.newDevice();
    await h.register(d);
    const cases: ((device: TestDevice) => void)[] = [
      (x) => x.send(encodeFrame(FrameType.PING, 0, Buffer.alloc(8))),
      (x) => x.send(encodeFrame(FrameType.HELLO, 0, Buffer.from("{not json"))),
      (x) =>
        x.send(encodeJsonFrame(FrameType.HELLO, 0, { deviceId: d.deviceId, proof: "x", software: "s", maxStreams: 1 })),
      (x) =>
        x.send(
          encodeJsonFrame(FrameType.HELLO, 0, {
            deviceId: d.deviceId,
            proof: Buffer.alloc(64).toString("base64url"),
            software: "s",
            maxStreams: 5000,
          }),
        ),
      (x) => x.ws.sendText("hello"),
      (x) => x.send(Buffer.from([0x02, 0x00])),
    ];
    for (const act of cases) {
      const device = await h.connect(d, { noHello: true });
      await device.frame(FrameType.CHALLENGE);
      act(device);
      expect((await device.whenClosed()).code).toBe(CloseCode.PROTOCOL_ERROR);
    }
  });

  it("rate-limits handshakes per device (4429 with retryAfterMs)", async () => {
    await h.stop();
    h = await new RelayHarness().start({ handshakeRate: { max: 2, windowMs: 60_000 } });
    const d = h.newDevice();
    await h.register(d);
    await h.online(d);
    await h.online(d);
    const closed = await (await h.connect(d)).whenClosed();
    expect(closed.code).toBe(CloseCode.RATE_LIMITED);
    expect(closed.reason).toMatch(/^rate_limited;retryAfterMs=\d+$/);
  });

  it("failed proofs never use up the device's handshake allowance (no lockout by a third party)", async () => {
    await h.stop();
    h = await new RelayHarness().start({ handshakeRate: { max: 2, windowMs: 60_000 } });
    const victim = h.newDevice();
    await h.register(victim);
    const attackerKey = generateKeyPairSync("ed25519").privateKey;
    // Far more failed attempts than the allowance, with the victim's (public) device id.
    for (let i = 0; i < 10; i++) {
      const closed = await (await h.connect(victim, { key: attackerKey })).whenClosed();
      expect(closed.code).toBe(CloseCode.UNAUTHORIZED);
    }
    const otherHost = await (await h.connect(victim, { signHost: "relay.other.example" })).whenClosed();
    expect(otherHost.code).toBe(CloseCode.UNAUTHORIZED);
    // The legitimate device still connects, and its own allowance still applies.
    await h.online(victim);
    await h.online(victim);
    const limited = await (await h.connect(victim)).whenClosed();
    expect(limited.code).toBe(CloseCode.RATE_LIMITED);
    // Failures after that are still reported as failures, not as rate limiting.
    expect((await (await h.connect(victim, { key: attackerKey })).whenClosed()).code).toBe(CloseCode.UNAUTHORIZED);
  });

  it("unknown device ids are refused 4401 however often they are tried", async () => {
    await h.stop();
    h = await new RelayHarness().start({ handshakeRate: { max: 1, windowMs: 60_000 } });
    const unknown = h.newDevice();
    for (let i = 0; i < 3; i++)
      expect((await (await h.connect(unknown)).whenClosed()).code).toBe(CloseCode.UNAUTHORIZED);
  });

  it("only serves the tunnel path", async () => {
    const d = h.newDevice();
    await h.register(d);
    await expect(TestDevice.connect({ ...h.deviceOptions(d), url: `${h.origin}/elsewhere` })).rejects.toThrow(
      /upgrade refused: 404/,
    );
  });

  it("never logs the proof or the challenge", async () => {
    const { device } = await h.ready();
    await sleep(10);
    expect(h.logText()).not.toContain(String(device.challenge!.challenge));
    expect(h.logs).toContainEqual(expect.objectContaining({ event: "tunnel.ready", software: "crot-test/0.1.0" }));
  });
});
