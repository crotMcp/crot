import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AccountService } from "../../src/account-service/service.js";
import { backupRelayState, OperationalMetrics, restoreRelayState } from "../../src/cloud-relay/operations.js";
import { MemoryDeviceRegistry } from "../../src/cloud-relay/registry.js";
import { CloudRelay } from "../../src/cloud-relay/server.js";
import { devicePublicKey } from "../../src/identity/device-credential.js";
import { canonicalDeviceUri, generateDeviceId } from "../../src/identity/device-id.js";
import { IssuerKeySet } from "../../src/identity/jwks.js";
import { OAuthAccessTokenVerifier } from "../../src/identity/verifier.js";
import { PAIRING_CLIENT, TEST_RELAY, TestAuthorizationServer } from "../identity/test-authorization-server.js";
import { TestDevice } from "./test-device.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function relay(as: TestAuthorizationServer, registry: MemoryDeviceRegistry, metricsToken?: string) {
  const instance = new CloudRelay({
    relayHost: TEST_RELAY,
    issuer: as.issuer,
    pairingClientId: PAIRING_CLIENT,
    environment: "staging",
    keys: new IssuerKeySet({ issuer: as.issuer, http: as.http() }),
    registry,
    entitlement: () => "entitled",
    metricsToken,
    log: () => undefined,
  });
  await instance.listen({ port: 0, host: "127.0.0.1" });
  return instance;
}

describe("WP-39 operational drills", () => {
  it("reconnects a registered device after a relay restart", async () => {
    const as = new TestAuthorizationServer();
    const registry = new MemoryDeviceRegistry();
    const deviceId = generateDeviceId();
    const { privateKey } = generateKeyPairSync("ed25519");
    const record = {
      deviceId,
      accountId: "user_drill",
      publicKey: devicePublicKey(privateKey),
      environment: "staging",
      registeredAt: new Date(0).toISOString(),
    };
    await registry.register(record);
    const first = await relay(as, registry);
    const one = await TestDevice.online({
      url: `http://127.0.0.1:${first.port}`,
      deviceId,
      key: privateKey,
      relayHost: TEST_RELAY,
    });
    expect(first.isOnline(deviceId)).toBe(true);
    one.ws.terminate();
    await first.close();

    const second = await relay(as, registry);
    const two = await TestDevice.online({
      url: `http://127.0.0.1:${second.port}`,
      deviceId,
      key: privateKey,
      relayHost: TEST_RELAY,
    });
    expect(second.isOnline(deviceId)).toBe(true);
    two.ws.terminate();
    await second.close();
  });

  it("survives IdP signing-key rotation and a bounded IdP outage, then fails closed", async () => {
    const as = new TestAuthorizationServer();
    let now = Date.UTC(2026, 0, 1);
    as.clock = () => now;
    const deviceId = generateDeviceId();
    const resource = canonicalDeviceUri(as.relayHost, deviceId);
    const binding = {
      state: "paired" as const,
      deviceId,
      accountId: "user_drill",
      issuer: as.issuer,
      relayHost: as.relayHost,
    };
    const verifier = new OAuthAccessTokenVerifier({
      environment: as.environment(),
      keys: new IssuerKeySet({ issuer: as.issuer, http: as.http(), now: () => now, maxAgeMs: 100, maxStaleMs: 1_000 }),
      binding: () => binding,
      now: () => now,
    });
    const token = () => as.token({ resource, sub: "user_drill", claims: { exp: now / 1000 + 3600 } });
    expect(await verifier.verifyAccessToken(token())).toBeDefined();
    as.rotate("rotated-key");
    now += 31_000;
    expect(await verifier.verifyAccessToken(token())).toBeDefined();
    as.down = true;
    now += 500;
    expect(await verifier.verifyAccessToken(token())).toBeDefined();
    now += 1_001;
    expect(await verifier.verifyAccessToken(token())).toBeUndefined();
  });

  it("backs up and restores registrations/accounts after mass revocation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "crot-dr-"));
    roots.push(root);
    const registryFile = path.join(root, "live", "registry.json");
    const accountFile = path.join(root, "live", "accounts.json");
    const backupDir = path.join(root, "backup");
    const registry = (await import("../../src/cloud-relay/registry.js")).FileDeviceRegistry;
    const r = await registry.open(registryFile);
    const accounts = await AccountService.open(accountFile, { now: () => 1_000 });
    await accounts.startTrial("user_drill");
    const ids = [generateDeviceId(), generateDeviceId()];
    for (const id of ids) {
      const { privateKey } = generateKeyPairSync("ed25519");
      const record = {
        deviceId: id,
        accountId: "user_drill",
        publicKey: devicePublicKey(privateKey),
        environment: "staging",
        registeredAt: new Date(0).toISOString(),
      };
      expect(await accounts.register("user_drill", id, () => r.register(record))).toBe("created");
    }
    await backupRelayState({ registryFile, accountFile, outputDir: backupDir, now: () => 2_000 });
    for (const id of ids) {
      await accounts.revoke("user_drill", id);
      const existing = await r.get(id);
      if (existing) await r.remove(existing);
    }
    expect(await r.count()).toBe(0);
    await restoreRelayState({ backupDir, registryFile, accountFile });
    const restoredRegistry = await registry.open(registryFile);
    const restoredAccounts = await AccountService.open(accountFile, { now: () => 3_000 });
    expect(await restoredRegistry.count()).toBe(2);
    expect(ids.map((id) => restoredAccounts.deviceState("user_drill", id))).toEqual(["entitled", "entitled"]);

    await writeFile(path.join(backupDir, "registry.json"), "tampered\n");
    await expect(restoreRelayState({ backupDir, registryFile, accountFile })).rejects.toThrow("integrity failure");
  });

  it("exports authenticated fixed-cardinality metadata metrics without payload data under load", async () => {
    const token = "m".repeat(48);
    const as = new TestAuthorizationServer();
    const instance = await relay(as, new MemoryDeviceRegistry(), token);
    const origin = `http://127.0.0.1:${instance.port}`;
    expect((await fetch(`${origin}/.crot/metrics`)).status).toBe(404);
    const canary = "PAYLOAD-CANARY-DO-NOT-LOG";
    for (let i = 0; i < 250; i++)
      await fetch(`${origin}/not-found`, {
        headers: { "mcp-method": `${canary}-${i}`, authorization: `Bearer ${canary}` },
      });
    const response = await fetch(`${origin}/.crot/metrics`, { headers: { authorization: `Bearer ${token}` } });
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).toContain("crot_relay_event_total");
    expect(text).not.toContain(canary);
    expect(text.split("\n").length).toBeLessThan(40);
    await instance.close();
  });

  it("keeps metric labels bounded even for unknown event input", () => {
    const metrics = new OperationalMetrics();
    for (let i = 0; i < 1_000; i++) metrics.observe({ event: `untrusted-${i}` });
    const text = metrics.render({
      tunnels: { handshake: 0, ready: 0, draining: 0 },
      openStreams: 0,
      devicesOnline: 0,
      admission: { clients: 0, requests: 0, bufferedRequestBytes: 0, uncreditedResponseBytes: 0 },
    });
    expect(text).toContain('event="other"} 1000');
    expect(text).not.toContain("untrusted-");
  });
});
