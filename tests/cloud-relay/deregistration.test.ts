import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileDeviceRegistry } from "../../src/cloud-relay/registry.js";
import { signDeregistrationProof, signTunnelProof } from "../../src/identity/device-credential.js";
import { createIdentityHttp, type IdentityHttp } from "../../src/identity/http.js";
import { deregisterDeviceAtRelay } from "../../src/identity/relay-registration.js";
import { DeviceIdentity } from "../../src/service/identity.js";
import { DeviceBindingStore } from "../../src/service/device-binding.js";
import { type PairingOutcome } from "../../src/identity/pairing.js";
import { generateSecret } from "../../src/service/secrets/store.js";
import { protectedResourceMetadataUrl } from "../../src/identity/device-id.js";
import { makeTempDirs, type TempDirs } from "../helpers.js";
import { MemoryKeyStore, privateFiles } from "../identity/helpers.js";
import { TEST_RELAY } from "../identity/test-authorization-server.js";
import { RelayHarness, waitFor, type PairedDevice } from "./harness.js";
let h: RelayHarness, dirs: TempDirs;
beforeEach(async () => {
  dirs = await makeTempDirs();
});
afterEach(async () => {
  await h?.stop();
  await dirs.cleanup();
});
const endpoint = (p: PairedDevice) => h.url(p, "/deregister");
async function challenge(p: PairedDevice): Promise<string> {
  const r = await fetch(endpoint(p));
  expect(r.status).toBe(200);
  return ((await r.json()) as { challenge: string }).challenge;
}
function remove(p: PairedDevice, c: string, proof: Buffer) {
  return fetch(endpoint(p), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ challenge: c, proof: proof.toString("base64url") }),
  });
}
const prove = (p: PairedDevice, c: string) =>
  signDeregistrationProof(p.key, p.deviceId, TEST_RELAY, Buffer.from(c, "base64url"));
function routedHttp(extra?: (url: string, init?: RequestInit) => Promise<Response | undefined>): IdentityHttp {
  return createIdentityHttp({
    fetch: async (input, init) => {
      const u = String(input);
      const override = await extra?.(u, init);
      if (override) return override;
      const prefix = `https://${TEST_RELAY}/`;
      return u.startsWith(prefix) ? fetch(h.origin + "/" + u.slice(prefix.length), init) : h.as.fetch(input, init);
    },
  });
}
describe("WP-29 fresh authenticated deregistration", () => {
  it("deletes registration, PRM and active tunnel; cannot replay a proof against a re-registration", async () => {
    h = await new RelayHarness().start();
    const { paired, device } = await h.ready();
    const c = await challenge(paired),
      proof = prove(paired, c);
    expect((await remove(paired, c, proof)).status).toBe(204);
    await device.whenClosed();
    expect(h.relay.isOnline(paired.deviceId)).toBe(false);
    expect(await h.registry.get(paired.deviceId)).toBeUndefined();
    const prm = protectedResourceMetadataUrl(TEST_RELAY, paired.deviceId).replace(`https://${TEST_RELAY}`, h.origin);
    expect((await fetch(prm)).status).toBe(404);
    expect((await h.post(paired)).status).toBe(404);
    await h.register(paired);
    expect((await remove(paired, c, proof)).status).toBe(403);
    await h.online(paired);
    // Idempotent same-account/key registration remains valid; key rotation uses a fresh pairing/id.
    expect((await h.registerRaw(paired.deviceId, h.pairingToken(paired), { publicKey: paired.publicKey })).status).toBe(
      200,
    );
  });
  it("rejects foreign key/device/host, tunnel-domain signatures, expired and malformed proofs without deletion", async () => {
    let now = Date.now();
    h = await new RelayHarness().start({ now: () => now });
    const p = h.newDevice(),
      other = h.newDevice();
    await h.register(p);
    const c = await challenge(p),
      bytes = Buffer.from(c, "base64url");
    const proofs = [
      signDeregistrationProof(other.key, p.deviceId, TEST_RELAY, bytes),
      signDeregistrationProof(p.key, other.deviceId, TEST_RELAY, bytes),
      signDeregistrationProof(p.key, p.deviceId, "other.example", bytes),
      signTunnelProof(p.key, p.deviceId, TEST_RELAY, bytes),
      randomBytes(64),
    ];
    for (const proof of proofs) expect((await remove(p, c, proof)).status).toBe(403);
    const malformed = await fetch(endpoint(p), { method: "POST", body: "null" });
    expect(malformed.status).toBe(400);
    now += 30_001;
    expect((await remove(p, c, prove(p, c))).status).toBe(403);
    expect(await h.registry.get(p.deviceId)).toBeDefined();
    expect(h.logText()).not.toContain(c);
    expect(h.logText()).not.toContain(proofs[0]!.toString("base64url"));
  });
  it("a handshake paused in entitlement cannot become routable after deletion", async () => {
    let unblock: () => void = () => {};
    let checking = false;
    h = await new RelayHarness().start({
      entitlement: async () => {
        checking = true;
        await new Promise<void>((r) => (unblock = r));
        return "entitled" as const;
      },
    });
    const p = h.newDevice();
    await h.register(p);
    const device = await h.connect(p);
    await waitFor(() => checking);
    const c = await challenge(p);
    expect((await remove(p, c, prove(p, c))).status).toBe(204);
    unblock();
    await device.whenClosed();
    expect(h.relay.isOnline(p.deviceId)).toBe(false);
  });
  it("file registry removal is atomic, durable and compare-to-record; failed persistence restores the record", async () => {
    const file = path.join(dirs.outside, "registry.json"),
      registry = await FileDeviceRegistry.open(file);
    h = await new RelayHarness().start({ registry });
    const p = h.newDevice();
    await h.register(p);
    const expected = (await registry.get(p.deviceId))!;
    expect(await registry.remove({ ...expected })).toBe(false);
    await rm(file);
    await mkdir(file);
    await expect(registry.remove(expected)).rejects.toThrow();
    expect(await registry.get(p.deviceId)).toBe(expected);
    await rm(file, { recursive: true });
    expect(await registry.remove(expected)).toBe(true);
    expect(await (await FileDeviceRegistry.open(file)).get(p.deviceId)).toBeUndefined();
  });
});
describe("WP-29 local registration transaction / unpair", () => {
  async function identity(http: IdentityHttp = routedHttp()) {
    const keys = new MemoryKeyStore();
    const binding = await DeviceBindingStore.open(path.join(dirs.outside, "binding.json"), privateFiles, keys);
    const runtime = new DeviceIdentity({ environment: h.as.environment(), binding, http, log: () => {} });
    return { keys, binding, runtime, http };
  }
  async function signIn(runtime: DeviceIdentity) {
    let finish: (r: PairingOutcome) => void = () => {};
    const outcome = new Promise<PairingOutcome>((r) => (finish = r));
    const pending = await runtime.startPairing((r) => finish(r));
    await (await fetch(h.as.authorize(pending.authorizationUrl, { sub: "user_01" }).redirect)).text();
    return { outcome: await outcome, pending };
  }
  it("local preparation/readback fails BEFORE register; no orphan record is ever created", async () => {
    h = await new RelayHarness().start();
    const { keys, runtime, binding } = await identity();
    keys.failWrite = true;
    const { outcome } = await signIn(runtime);
    expect(outcome).toMatchObject({ ok: false, reason: "relay_registration_failed" });
    expect(await h.registry.count()).toBe(0);
    expect(binding.view()).toEqual({ state: "unpaired" });
  });
  it("binding write failure after register immediately compensates with removal-only proof and retains no token", async () => {
    h = await new RelayHarness().start();
    const { runtime, binding, keys } = await identity();
    const { pending, outcome } = await signIn(runtime);
    expect(outcome.ok).toBe(true);
    expect(await h.registry.get(pending.deviceId)).toBeDefined();
    expect(binding.view()).toEqual({ state: "unpaired" });
    const intent = await readFile(binding.file + ".registration", "utf8");
    expect(intent).not.toMatch(/seed|token|private/i);
    await mkdir(binding.file);
    await expect(
      binding.pair(
        {
          deviceId: pending.deviceId,
          accountId: "user_01",
          environment: "test",
          issuer: h.as.issuer,
          relayHost: TEST_RELAY,
        },
        h.as.environment(),
      ),
    ).rejects.toThrow();
    expect(await binding.pendingRegistration()).toBeDefined();
    expect(await runtime.rollbackPairing(pending.deviceId)).toBe(true);
    expect(await h.registry.count()).toBe(0);
    expect(await binding.pendingRegistration()).toBeUndefined();
    expect(keys.values.has("device-key")).toBe(false);
  });
  it("a lost registration response and unavailable compensation remain recoverable across restart", async () => {
    h = await new RelayHarness().start();
    let offline = false;
    const http = routedHttp(async (u, init) => {
      if (u.endsWith("/register") && init?.method === "POST") {
        const r = await fetch(u.replace(`https://${TEST_RELAY}`, h.origin), init);
        await r.text();
        offline = true;
        throw new Error("lost response");
      }
      if (offline && u.includes("/deregister")) throw new Error("offline");
      return undefined;
    });
    const { runtime, binding, keys } = await identity(http);
    const { outcome, pending } = await signIn(runtime);
    expect(outcome.ok).toBe(false);
    expect(await h.registry.get(pending.deviceId)).toBeDefined();
    expect(binding.tunnelCredential(h.as.environment())).toMatchObject({ ok: false });
    const reopened = await DeviceBindingStore.open(binding.file, privateFiles, keys);
    const restored = new DeviceIdentity({
      environment: h.as.environment(),
      binding: reopened,
      http: routedHttp(),
      log: () => {},
    });
    await waitFor(() => !h.relay.isOnline(pending.deviceId));
    await waitFor(() => h.logs.some((x) => x.event === "device.deregister"));
    expect(await h.registry.count()).toBe(0);
    expect(await restored.rollbackPairing()).toBe(true);
    expect(await reopened.pendingRegistration()).toBeUndefined();
  });
  it("local unpair is immediate while removal uses a captured signer without the deleted secret; offline unpair never waits", async () => {
    h = await new RelayHarness().start();
    const { runtime, binding, keys } = await identity();
    const { pending } = await signIn(runtime);
    await binding.pair(
      {
        deviceId: pending.deviceId,
        accountId: "user_01",
        environment: "test",
        issuer: h.as.issuer,
        relayHost: TEST_RELAY,
      },
      h.as.environment(),
    );
    const deregister = runtime.prepareDeregistration();
    await binding.unpair();
    expect(binding.view()).toEqual({ state: "unpaired" });
    expect(keys.values.has("device-key")).toBe(false);
    await deregister();
    expect(await h.registry.count()).toBe(0);
    // The removal client fails closed without HTTPS JSON support; local unpair never depends on it.
    expect(
      await deregisterDeviceAtRelay(
        {
          getJson: async () => {
            throw new Error("offline");
          },
          postForm: async () => ({ status: 500, body: null }),
        },
        { deviceId: pending.deviceId, relayHost: TEST_RELAY, prove: () => Buffer.alloc(64) },
      ),
    ).toBe(false);
  });
  it("cancel during a successful but delayed register compensates AFTER register settles", async () => {
    h = await new RelayHarness().start();
    let release: () => void = () => {};
    let received = false;
    const http = routedHttp(async (u, init) => {
      if (u.endsWith("/register") && init?.method === "POST") {
        const response = await fetch(u.replace(`https://${TEST_RELAY}`, h.origin), init);
        received = true;
        await new Promise<void>((r) => (release = r));
        return response;
      }
      return undefined;
    });
    const { runtime, binding } = await identity(http);
    let result: PairingOutcome | undefined;
    const pending = await runtime.startPairing((r) => (result = r));
    const callback = fetch(h.as.authorize(pending.authorizationUrl, { sub: "user_01" }).redirect).catch(
      () => undefined,
    );
    await waitFor(() => received);
    runtime.cancelPairing();
    release();
    await callback;
    await waitFor(() => result !== undefined);
    expect(result).toEqual({ ok: false, reason: "cancelled" });
    expect(await h.registry.count()).toBe(0);
    expect(await binding.pendingRegistration()).toBeUndefined();
  });
  it("a persisted inactive intent with no remote record cleans up idempotently", async () => {
    h = await new RelayHarness().start();
    const { runtime, binding } = await identity();
    const p = h.newDevice();
    await binding.prepareRegistration(p.deviceId, generateSecret(), TEST_RELAY);
    expect(await runtime.rollbackPairing()).toBe(true);
    expect(await binding.pendingRegistration()).toBeUndefined();
  });
});
