import { createHmac } from "node:crypto";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountHttp } from "../../src/account-service/http.js";
import { AccountService } from "../../src/account-service/service.js";
import { StripeBillingProvider } from "../../src/account-service/billing.js";
import { signDeregistrationProof, signManagementProof, signTunnelProof } from "../../src/identity/device-credential.js";
import { DeviceIdentity } from "../../src/service/identity.js";
import { createIdentityHttp } from "../../src/identity/http.js";
import { DeviceBindingStore } from "../../src/service/device-binding.js";
import { generateSecret } from "../../src/service/secrets/store.js";
import { makeTempDirs } from "../helpers.js";
import { MemoryKeyStore, privateFiles } from "../identity/helpers.js";
import { TEST_RELAY, PAIRING_CLIENT } from "../identity/test-authorization-server.js";
import { RelayHarness, waitFor } from "../cloud-relay/harness.js";
let h: RelayHarness | undefined;
afterEach(async () => {
  await h?.stop();
  h = undefined;
});
const portal = "client_account_portal";
const ownerToken = (sub = "user_01", clientId = portal) =>
  h!.as.token({ resource: `https://${TEST_RELAY}/account`, sub, clientId });
function owner(suffix: string, options: { sub?: string; clientId?: string; body?: unknown } = {}) {
  return fetch(h!.origin + "/account" + suffix, {
    method: options.body !== undefined ? "POST" : "GET",
    headers: {
      authorization: `Bearer ${ownerToken(options.sub, options.clientId)}`,
      "content-type": "application/json",
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
}
async function start(
  options: { accounts?: AccountService; minimumDeviceVersion?: string; minimumClientVersion?: string } = {},
) {
  const accounts = options.accounts ?? new AccountService();
  h = await new RelayHarness().start({ accounts, portalClientIds: [portal], ...options });
  return accounts;
}

describe("WP-36 actual cloud admission and owner API", () => {
  it("Free registration is denied before registry mutation, explicit owner trial enables pairing", async () => {
    await start();
    const p = h!.newDevice();
    const denied = await h!.registerRaw(p.deviceId, h!.pairingToken(p), { publicKey: p.publicKey });
    expect(denied).toMatchObject({ status: 403, body: { error: "entitlement_required" } });
    expect(denied.headers.get("CROT-Request-Outcome")).toBe("not_executed");
    expect(await h!.registry.count()).toBe(0);
    expect((await owner("/trial", { body: {} })).status).toBe(200);
    await h!.register(p);
    await h!.online(p);
    const view = await (await owner("")).json();
    expect(view).toMatchObject({
      plan: "trial",
      entitled: true,
      deviceCount: 1,
      maxDevices: 2,
      devices: [{ deviceId: p.deviceId, online: true }],
    });
    expect((await owner("/trial", { body: {} })).status).toBe(409);
  });
  it("simultaneous actual pairing requests cannot exceed account quota", async () => {
    const accounts = await start();
    await accounts.startTrial("user_01");
    const devices = Array.from({ length: 8 }, () => h!.newDevice());
    const replies = await Promise.all(
      devices.map((p) => h!.registerRaw(p.deviceId, h!.pairingToken(p), { publicKey: p.publicKey })),
    );
    expect(replies.filter((r) => r.status === 201)).toHaveLength(2);
    expect(replies.filter((r) => r.body.error === "device_limit_reached")).toHaveLength(6);
    expect(await h!.registry.count()).toBe(2);
  });
  it("portal audience/client allowlist and owner identity cannot be replaced by device or another account token", async () => {
    const accounts = await start();
    await accounts.startTrial("user_01");
    const p = h!.newDevice();
    await h!.register(p);
    expect(
      (await fetch(h!.origin + "/account", { headers: { authorization: `Bearer ${h!.pairingToken(p)}` } })).status,
    ).toBe(401);
    expect((await owner("", { clientId: PAIRING_CLIENT })).status).toBe(403);
    expect((await owner(`/devices/${p.deviceId}/revoke`, { sub: "foreign", body: {} })).status).toBe(404);
    expect(await h!.registry.get(p.deviceId)).toBeDefined();
    expect((await owner("/checkout", { body: { plan: "team", accountId: "foreign" } })).status).toBe(400);
  });
  it("lost-device revocation removes public key, closes 4403, suppresses PRM and blocks re-registration", async () => {
    const accounts = await start();
    await accounts.startTrial("user_01");
    const { paired: p, device } = await h!.ready();
    expect((await owner(`/devices/${p.deviceId}/revoke`, { body: {} })).status).toBe(200);
    expect(await device.whenClosed()).toMatchObject({ code: 4403, reason: "device_revoked" });
    expect(await h!.registry.get(p.deviceId)).toBeUndefined();
    const again = await h!.connect(p);
    expect(await again.whenClosed()).toMatchObject({ code: 4403, reason: "device_revoked" });
    expect((await fetch(h!.origin + `/.well-known/oauth-protected-resource/d/${p.deviceId}/mcp`)).status).toBe(404);
    expect((await h!.post(p)).status).toBe(404);
    expect((await h!.registerRaw(p.deviceId, h!.pairingToken(p), { publicKey: p.publicKey })).body.error).toBe(
      "device_revoked",
    );
  });
  it("expiry closes an existing real tunnel and rejects future HTTP and HELLO admission", async () => {
    let now = Date.now();
    const accounts = new AccountService({ now: () => now });
    await start({ accounts });
    await accounts.startTrial("user_01");
    const { paired: p, device } = await h!.ready();
    now += 14 * 86400000;
    expect(await device.whenClosed()).toMatchObject({ code: 4403, reason: "not_entitled" });
    const r = await h!.post(p);
    expect(r.status).toBe(403);
    expect(r.headers.get("CROT-Request-Outcome")).toBe("not_executed");
    const again = await h!.connect(p);
    expect(await again.whenClosed()).toMatchObject({ code: 4403, reason: "not_entitled" });
  });
  it.each(["past_due", "canceled", "unpaid"])(
    "signed Stripe %s webhook terminates remote admission immediately",
    async (status) => {
      const accounts = new AccountService();
      const now = Date.now(),
        raw = Buffer.from(
          JSON.stringify({
            id: "evt_cancel",
            type: "customer.subscription.updated",
            data: { object: { id: "sub_1" } },
          }),
        );
      const billing = new StripeBillingProvider({
        secretKey: "cloud-only",
        webhookSecret: "whsec_cloud",
        prices: { pro: "price_pro", team: "price_team" },
        returnUrl: "https://crot.example/account",
        now: () => now,
        fetch: async () =>
          Response.json({
            id: "sub_1",
            status,
            metadata: { crot_account_id: "user_01" },
            current_period_end: Math.floor(now / 1000) + 3600,
            items: { data: [{ price: { id: "price_pro" } }] },
          }),
      });
      h = await new RelayHarness().start({ accounts, billing });
      await accounts.startTrial("user_01");
      const { paired: p, device } = await h.ready();
      const t = Math.floor(now / 1000),
        sig = `t=${t},v1=${createHmac("sha256", "whsec_cloud").update(`${t}.`).update(raw).digest("hex")}`;
      const result = await fetch(h.origin + "/billing/stripe", {
        method: "POST",
        body: raw,
        headers: { "stripe-signature": sig },
      });
      expect(result.status).toBe(200);
      expect(await device.whenClosed()).toMatchObject({ code: 4403 });
      expect((await h.post(p)).status).toBe(403);
      expect(h.relay.status().openStreams).toBe(0);
      expect(h.logText()).not.toContain("cloud-only");
      expect(h.logText()).not.toContain(sig);
      expect(h.logText()).not.toContain("crot_account_id");
    },
  );
  it("unconfigured billing cannot accept unsigned activation", async () => {
    await start();
    expect((await fetch(h!.origin + "/billing/stripe", { method: "POST", body: "{}" })).status).toBe(503);
  });
  it("device management proof binds exact operation/client, has one use, and cannot authenticate a tunnel", async () => {
    const revokeSession = vi.fn(async () => undefined);
    const accounts = new AccountService({ revoker: { revokeSession } });
    await start({ accounts });
    await accounts.startTrial("user_01");
    const p = h!.newDevice();
    await h!.register(p);
    await accounts.noteClient("user_01", p.deviceId, "client_A", "session_A");
    await accounts.noteClient("user_01", p.deviceId, "client_B", "session_B");
    const endpoint = h!.url(p, "/clients/client_A/revoke");
    const challenge = ((await (await fetch(endpoint)).json()) as { challenge: string }).challenge;
    const proof = signManagementProof(
      p.key,
      p.deviceId,
      TEST_RELAY,
      "revoke_client",
      "client_A",
      Buffer.from(challenge, "base64url"),
    );
    const post = (url: string, c: string, pr: Buffer) =>
      fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ challenge: c, proof: pr.toString("base64url") }),
      });
    expect((await post(h!.url(p, "/clients/client_B/revoke"), challenge, proof)).status).toBe(403);
    expect(revokeSession).not.toHaveBeenCalled();
    const c2 = ((await (await fetch(endpoint)).json()) as { challenge: string }).challenge;
    const valid = signManagementProof(
      p.key,
      p.deviceId,
      TEST_RELAY,
      "revoke_client",
      "client_A",
      Buffer.from(c2, "base64url"),
    );
    expect((await post(endpoint, c2, valid)).status).toBe(200);
    expect(revokeSession).toHaveBeenCalledExactlyOnceWith("session_A");
    expect((await post(endpoint, c2, valid)).status).toBe(403);
    for (const prove of [signTunnelProof, signDeregistrationProof]) {
      const c = ((await (await fetch(endpoint)).json()) as { challenge: string }).challenge;
      expect((await post(endpoint, c, prove(p.key, p.deviceId, TEST_RELAY, Buffer.from(c, "base64url")))).status).toBe(
        403,
      );
    }
    expect(h!.logText()).not.toContain(valid.toString("base64url"));
    expect(h!.logText()).not.toContain("session_A");
  });
  it("actual service identity/tray hook reads plan and requests cloud-only provider revocation", async () => {
    const dirs = await makeTempDirs();
    try {
      const revokeSession = vi.fn(async () => undefined),
        accounts = new AccountService({ revoker: { revokeSession } });
      await start({ accounts });
      await accounts.startTrial("user_01");
      const keys = new MemoryKeyStore(),
        binding = await DeviceBindingStore.open(path.join(dirs.outside, "binding.json"), privateFiles, keys);
      const id = h!.newDevice().deviceId;
      binding.stageDeviceKey(id, generateSecret());
      await binding.pair(
        { deviceId: id, accountId: "user_01", environment: "test", issuer: h!.as.issuer, relayHost: TEST_RELAY },
        h!.as.environment(),
      );
      // Use the real binding's public key rather than another fixture's key.
      const seed = await keys.read("device-key");
      const { deviceKeyFromSeed, devicePublicKey } = await import("../../src/identity/device-credential.js");
      const p = {
        ...h!.newDevice(),
        deviceId: id,
        uri: `https://${TEST_RELAY}/d/${id}/mcp`,
        publicKey: devicePublicKey(deviceKeyFromSeed(seed!)),
      };
      await h!.register(p);
      await accounts.noteClient("user_01", id, "client_A", "session_A");
      let now = Date.now();
      const sent: string[] = [];
      const identity = new DeviceIdentity({
        now: () => now,
        binding,
        environment: h!.as.environment(),
        log: () => {},
        http: createIdentityHttp({
          fetch: (input, init) => {
            sent.push(JSON.stringify(init));
            return String(input).startsWith(`https://${TEST_RELAY}/`)
              ? fetch(String(input).replace(`https://${TEST_RELAY}`, h!.origin), init)
              : h!.as.fetch(input, init);
          },
        }),
      });
      await identity.refreshCommercialIfNeeded();
      expect(identity.commercialStatus()).toMatchObject({
        state: "current",
        plan: "trial",
        entitled: true,
        deviceCount: 1,
      });
      const requests = sent.length;
      await identity.refreshCommercialIfNeeded();
      expect(sent).toHaveLength(requests);
      expect(await identity.revokeProvider({ accountId: "other", deviceId: id, clientId: "client_A" })).toBe(
        "not_available",
      );
      expect(sent).toHaveLength(requests);
      expect(await identity.revokeProvider({ accountId: "user_01", deviceId: id, clientId: "client_A" })).toBe(
        "requested",
      );
      expect(revokeSession).toHaveBeenCalledExactlyOnceWith("session_A");
      expect(sent.join("\n")).not.toContain("Bearer");
      expect(sent.join("\n")).not.toContain(dirs.workspace);
      now += 120_001;
      expect(identity.commercialStatus()).toMatchObject({ state: "unknown" });
      await h!.stop();
      h = undefined;
      await identity.refreshCommercial();
      expect(identity.commercialStatus()).toMatchObject({ state: "unknown" });
    } finally {
      await dirs.cleanup();
    }
  });
  it("optional device/client software floors refuse update without changing local capabilities", async () => {
    const accounts = await start({ minimumDeviceVersion: "1.0.0", minimumClientVersion: "1.0.0" });
    await accounts.startTrial("user_01");
    const p = h!.newDevice();
    await h!.register(p);
    const d = await h!.connect(p, { software: "crot/0.1.0" });
    expect(await d.whenClosed()).toMatchObject({ code: 4426, reason: "update required" });
    await h!.online(p, { software: "crot/1.0.0" });
    const denied = await h!.post(p);
    expect(denied.status).toBe(426);
    expect(denied.headers.get("CROT-Request-Outcome")).toBe("not_executed");
    await waitFor(() => h!.relay.isOnline(p.deviceId));
  });
});

it("MCP bodies never enter the account HTTP handler or commercial storage; hostile log fields are redacted", async () => {
  const accounts = await start();
  await accounts.startTrial("user_01");
  const { paired: p } = await h!.ready({
    onOpen: (stream) => {
      void stream.bodyDone().then(() => {
        stream.respond(200, [["content-type", "application/json"]]);
        void stream.write(Buffer.from('{"jsonrpc":"2.0","id":1,"result":{}}'), true);
      });
    },
  });
  const handler = vi.spyOn(AccountHttp.prototype, "handle");
  try {
    const r = await h!.post(
      p,
      '{"jsonrpc":"2.0","id":1,"method":"ping","params":{"path":"/private/PROJECT_CANARY","body":"BODY_CANARY"}}',
      { "mcp-method": "/private/PROJECT_CANARY" },
    );
    expect(r.status).toBe(200);
    await r.text();
    expect(handler).not.toHaveBeenCalled();
    expect(JSON.stringify(accounts.devices("user_01"))).not.toContain("CANARY");
    expect(h!.logText()).not.toContain("CANARY");
  } finally {
    handler.mockRestore();
  }
});

it("team-to-pro webhook downgrade immediately closes only over-limit tunnels", async () => {
  const accounts = await start();
  const update = {
    eventId: "evt_team",
    accountId: "user_01",
    subscriptionId: "sub_1",
    plan: "team" as const,
    status: "active" as const,
    expiresAt: Date.now() + 86400000,
  };
  const provider = { checkout: async () => "https://checkout.stripe.com/test", verifyAndResolve: async () => update };
  await accounts.billing(provider, Buffer.from("{}"), "test");
  const devices = [];
  for (let i = 0; i < 7; i++) devices.push(await h!.ready());
  await accounts.billing(
    { ...provider, verifyAndResolve: async () => ({ ...update, eventId: "evt_pro", plan: "pro" as const }) },
    Buffer.from("{}"),
    "test",
  );
  for (const { device } of devices.slice(5))
    expect(await device.whenClosed()).toMatchObject({ code: 4403, reason: "not_entitled" });
  expect(devices.slice(0, 5).every(({ paired }) => h!.relay.isOnline(paired.deviceId))).toBe(true);
  expect((await h!.post(devices[6]!.paired)).status).toBe(403);
});
