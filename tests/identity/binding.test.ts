import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verifyTunnelProof, tunnelProofMessage } from "../../src/identity/device-credential.js";
import {
  canonicalDeviceUri,
  generateDeviceId,
  isDeviceId,
  isRelayHost,
  protectedResourceMetadataUrl,
} from "../../src/identity/device-id.js";
import { DEV_ENVIRONMENT_VARIABLE, resolveIdentityEnvironment } from "../../src/identity/environment.js";
import { DEVICE_BINDING_FILE_NAME, DeviceBindingStore } from "../../src/service/device-binding.js";
import { RemoteClientRegistry, REMOTE_CLIENTS_FILE_NAME } from "../../src/service/remote-clients.js";
import { ROTATABLE_SECRET_NAMES, SECRET_NAMES, isValidSecret } from "../../src/service/secrets/types.js";
import { makeTempDirs, type TempDirs } from "../helpers.js";
import { MemoryKeyStore, openBinding, privateFiles, testEnvironment } from "./helpers.js";

/** WP-28 / AD-21 point 5: device ids, identity environment, device binding and credential, re-grant. */

let dirs: TempDirs;
beforeEach(async () => {
  dirs = await makeTempDirs();
});
afterEach(async () => {
  await dirs.cleanup();
});

describe("device id and canonical URI", () => {
  it("device ids are random, 128-bit, lowercase base32 in one spelling", () => {
    const ids = new Set(Array.from({ length: 200 }, generateDeviceId));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(isDeviceId(id)).toBe(true);
    expect(isDeviceId("abcdefghijklmnopqrstuvwxya")).toBe(true);
    // Non-zero padding bits, uppercase, wrong length, other alphabet: not a device id.
    expect(isDeviceId("abcdefghijklmnopqrstuvwxyz")).toBe(false);
    expect(isDeviceId("ABCDEFGHIJKLMNOPQRSTUVWXYA")).toBe(false);
    expect(isDeviceId("abcdefghijklmnopqrstuvwxa")).toBe(false);
    expect(isDeviceId("abcdefghijklmnopqrstuvwx1a")).toBe(false);
  });

  it("builds the canonical URI and PRM URL only from a valid relay host and device id", () => {
    const id = "abcdefghijklmnopqrstuvwxya";
    expect(canonicalDeviceUri("relay.crot.example", id)).toBe(`https://relay.crot.example/d/${id}/mcp`);
    expect(protectedResourceMetadataUrl("relay.crot.example", id)).toBe(
      `https://relay.crot.example/.well-known/oauth-protected-resource/d/${id}/mcp`,
    );
    for (const host of ["Relay.example", "relay.example:443", "127.0.0.1", "relay..example", "-a.example", "a/b"])
      expect(isRelayHost(host)).toBe(false);
    expect(() => canonicalDeviceUri("relay.example:8443", id)).toThrow();
    expect(() => canonicalDeviceUri("relay.example", "../x")).toThrow();
  });
});

describe("identity environment", () => {
  const file = (content: unknown) => {
    const f = path.join(dirs.outside, "env.json");
    return writeFile(f, JSON.stringify(content)).then(() => f);
  };
  const valid = { issuer: "https://auth.dev.example", relayHost: "relay.dev.example", pairingClientId: "client_123" };

  it("none in this build without the development variable", async () => {
    const r = await resolveIdentityEnvironment({ env: {} });
    expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/WP-38.*WP-39/) });
  });

  it("a development environment from the variable; a pinned release environment wins", async () => {
    const f = await file(valid);
    const dev = await resolveIdentityEnvironment({ env: { [DEV_ENVIRONMENT_VARIABLE]: f } });
    expect(dev).toMatchObject({
      ok: true,
      environment: {
        id: "development",
        kind: "development",
        issuer: valid.issuer,
        relayHost: valid.relayHost,
        pairing: { clientId: "client_123", redirectPort: 0, scope: "openid" },
      },
    });
    const release = { ...testEnvironment(), id: "staging", kind: "release" as const };
    const pinned = await resolveIdentityEnvironment({ env: { [DEV_ENVIRONMENT_VARIABLE]: f }, release });
    expect(pinned).toMatchObject({
      ok: true,
      environment: { id: "staging" },
      notes: [expect.stringMatching(/ignored/)],
    });
  });

  it("rejects malformed environments (fail closed)", async () => {
    for (const bad of [
      { ...valid, issuer: "http://auth.dev.example" },
      { ...valid, issuer: "https://auth.dev.example/tenant" },
      { ...valid, issuer: "https://auth.dev.example:8443" },
      { ...valid, relayHost: "relay.dev.example:443" },
      { ...valid, pairingClientId: "" },
      { ...valid, pairingRedirectPort: 70000 },
      { ...valid, pairingScope: 'openid "x"' },
      { ...valid, extra: true },
      [valid],
    ]) {
      const r = await resolveIdentityEnvironment({ env: { [DEV_ENVIRONMENT_VARIABLE]: await file(bad) } });
      expect(r.ok, JSON.stringify(bad)).toBe(false);
    }
    const missing = await resolveIdentityEnvironment({
      env: { [DEV_ENVIRONMENT_VARIABLE]: path.join(dirs.outside, "none.json") },
    });
    expect(missing).toMatchObject({ ok: false, reason: expect.stringMatching(/cannot read/) });
  });
});

describe("device binding", () => {
  it("pairing writes a new device key, then the binding; it survives a reopen", async () => {
    const { binding, keys, deviceId } = await openBinding(dirs.outside, { accountId: "user_01" });
    expect(binding.paired).toMatchObject({ deviceId, accountId: "user_01", environment: "test" });
    expect(isValidSecret("device-key", keys.values.get("device-key")!)).toBe(true);
    const stored = JSON.parse(await readFile(path.join(dirs.outside, DEVICE_BINDING_FILE_NAME), "utf8"));
    expect(stored).toMatchObject({ version: 1, state: "paired", deviceId, accountId: "user_01" });
    expect(JSON.stringify(stored)).not.toContain(keys.values.get("device-key"));
    const reopened = await DeviceBindingStore.open(
      path.join(dirs.outside, DEVICE_BINDING_FILE_NAME),
      privateFiles,
      keys,
    );
    expect(reopened.paired).toEqual(binding.paired);
    expect(reopened.publicKey).toEqual(binding.publicKey);
    await expect(binding.pair({ ...binding.paired! }, testEnvironment())).rejects.toThrow(/unpaired/);
  });

  it("cleans a post-commit crash intent before a subsequent unpair and pairing", async () => {
    const { binding, keys, deviceId } = await openBinding(dirs.outside);
    const file = path.join(dirs.outside, DEVICE_BINDING_FILE_NAME);
    const intent = JSON.stringify({ version: 1, deviceId, relayHost: testEnvironment().relayHost });
    await writeFile(file + ".registration", intent);
    const reopened = await DeviceBindingStore.open(file, privateFiles, keys);
    expect(reopened.paired).toEqual(binding.paired);
    await expect(readFile(file + ".registration")).rejects.toMatchObject({ code: "ENOENT" });
    await reopened.unpair();
    expect(await reopened.pendingRegistration()).toBeUndefined();
  });

  it("the tunnel proof is bound to the device, the relay and the challenge", async () => {
    const { binding, deviceId } = await openBinding(dirs.outside);
    const env = testEnvironment();
    const result = binding.tunnelCredential(env);
    if (!result.ok) throw new Error(result.reason);
    const challenge = Buffer.alloc(32, 1);
    const proof = result.credential.prove(challenge);
    const pub = result.credential.publicKey;
    expect(verifyTunnelProof(pub, deviceId, env.relayHost, challenge, proof)).toBe(true);
    expect(verifyTunnelProof(pub, generateDeviceId(), env.relayHost, challenge, proof)).toBe(false);
    expect(verifyTunnelProof(pub, deviceId, "other.example", challenge, proof)).toBe(false);
    expect(verifyTunnelProof(pub, deviceId, env.relayHost, Buffer.alloc(32, 2), proof)).toBe(false);
    expect(tunnelProofMessage(deviceId, env.relayHost, challenge).subarray(0, 22).toString()).toBe(
      "crot-device-tunnel-v1\0",
    );
    expect(() => result.credential.prove(Buffer.alloc(8))).toThrow(/size/);
    expect(binding.tunnelCredential(testEnvironment({ issuer: "https://other.example" }))).toEqual({
      ok: false,
      reason: "environment_mismatch",
    });
    expect(binding.tunnelCredential(undefined)).toEqual({ ok: false, reason: "no_environment" });
    // Unpairing removes the key; a credential handed out earlier stops working.
    expect(await binding.unpair()).toMatchObject({ persisted: true, keyRemoved: true, errors: [] });
    expect(() => result.credential.prove(challenge)).toThrow(/no longer paired/);
    expect(binding.tunnelCredential(env)).toEqual({ ok: false, reason: "not_paired" });
  });

  it("a new pairing after unpairing has a new device id and a new key", async () => {
    const { binding, keys, deviceId } = await openBinding(dirs.outside);
    const firstKey = binding.publicKey!.x;
    await binding.unpair();
    const env = testEnvironment();
    const next = generateDeviceId();
    await binding.pair(
      { deviceId: next, accountId: "user_02", environment: env.id, issuer: env.issuer, relayHost: env.relayHost },
      env,
    );
    expect(next).not.toBe(deviceId);
    expect(binding.publicKey!.x).not.toBe(firstKey);
    expect(keys.values.has("device-key")).toBe(true);
  });

  it("fails closed: malformed state, missing or invalid key; unpairing resets it", async () => {
    const file = path.join(dirs.outside, DEVICE_BINDING_FILE_NAME);
    const { keys } = await openBinding(dirs.outside);
    keys.values.delete("device-key");
    let b = await DeviceBindingStore.open(file, privateFiles, keys);
    expect(b.error).toMatch(/device key is missing/);
    expect(b.view()).toMatchObject({ state: "unavailable" });
    expect(b.tunnelCredential(testEnvironment())).toEqual({ ok: false, reason: "state_unavailable" });
    keys.values.set("device-key", "not-a-key");
    b = await DeviceBindingStore.open(file, privateFiles, keys);
    expect(b.error).toMatch(/cannot be read/);
    await writeFile(file, "{not json");
    b = await DeviceBindingStore.open(file, privateFiles, keys);
    expect(b.error).toMatch(/malformed/);
    await expect(
      b.pair(
        {
          deviceId: generateDeviceId(),
          accountId: "u",
          environment: "test",
          issuer: testEnvironment().issuer,
          relayHost: testEnvironment().relayHost,
        },
        testEnvironment(),
      ),
    ).rejects.toThrow();
    await b.unpair();
    expect(b.error).toBeUndefined();
    expect((await DeviceBindingStore.open(file, privateFiles, keys)).view()).toEqual({ state: "unpaired" });
  });

  it("a failed key write leaves the device unpaired; a failed key removal is reported, the binding still ends", async () => {
    const keys = new MemoryKeyStore();
    keys.failWrite = true;
    await expect(openBinding(dirs.outside, { keys })).rejects.toThrow(/keychain locked/);
    const file = path.join(dirs.outside, DEVICE_BINDING_FILE_NAME);
    expect((await DeviceBindingStore.open(file, privateFiles, keys)).view()).toEqual({ state: "unpaired" });
    keys.failWrite = false;
    const { binding } = await openBinding(dirs.outside, { keys });
    keys.failDelete = true;
    const r = await binding.unpair();
    expect(r).toMatchObject({ persisted: true, keyRemoved: false });
    expect(binding.view()).toEqual({ state: "unpaired" });
  });

  it("device-key is a secret the CLI does not rotate", () => {
    expect(SECRET_NAMES).toContain("device-key");
    expect(ROTATABLE_SECRET_NAMES).not.toContain("device-key");
    expect(isValidSecret("device-key", Buffer.alloc(32, 9).toString("base64url"))).toBe(true);
    expect(isValidSecret("device-key", Buffer.alloc(31, 9).toString("base64url"))).toBe(false);
  });
});

describe("remote client re-grant", () => {
  it("re-grant needs a revoked client, is persisted first and sets the token boundary", async () => {
    let now = Date.UTC(2026, 0, 1, 0, 0, 0, 500);
    const file = path.join(dirs.outside, REMOTE_CLIENTS_FILE_NAME);
    const reg = await RemoteClientRegistry.open(file, privateFiles, { now: () => now });
    const id = { accountId: "user_01", deviceId: generateDeviceId(), clientId: "client-a" };
    expect(await reg.regrant(id)).toEqual({ ok: false, reason: "unknown_client" });
    reg.seen(id);
    expect(await reg.regrant(id)).toEqual({ ok: false, reason: "not_revoked" });
    expect(reg.predatesGrant(id, 0)).toBe(false);
    await reg.revoke(id);
    now += 5_000;
    const r = await reg.regrant(id);
    expect(r).toMatchObject({ ok: true, persisted: true });
    expect(reg.isRevoked(id)).toBe(false);
    const second = Math.floor(now / 1000);
    expect(reg.predatesGrant(id, second - 1)).toBe(true);
    expect(reg.predatesGrant(id, second)).toBe(true);
    expect(reg.predatesGrant(id, second + 1)).toBe(false);
    expect(reg.predatesGrant(id, undefined)).toBe(true);
    const reopened = await RemoteClientRegistry.open(file, privateFiles);
    expect(reopened.predatesGrant(id, second)).toBe(true);
    expect(reopened.list()[0]).toMatchObject({ grantedAt: new Date(now).toISOString() });
    expect(reopened.list()[0]).not.toHaveProperty("revokedAt");
  });

  it("a background write queued during a re-grant does not revert it on disk", async () => {
    const file = path.join(dirs.outside, REMOTE_CLIENTS_FILE_NAME);
    const reg = await RemoteClientRegistry.open(file, privateFiles);
    const deviceId = generateDeviceId();
    const id = { accountId: "user_01", deviceId, clientId: "client-a" };
    reg.seen(id);
    await reg.revoke(id);
    const pending = reg.regrant(id);
    // A new client is seen while the re-grant is being written: its background write is queued after it.
    reg.seen({ accountId: "user_01", deviceId, clientId: "client-b" });
    expect(await pending).toMatchObject({ ok: true, persisted: true });
    await reg.flush();
    expect(reg.isRevoked(id)).toBe(false);
    const reopened = await RemoteClientRegistry.open(file, privateFiles);
    expect(reopened.isRevoked(id)).toBe(false);
    expect(reopened.list()).toHaveLength(2);
  });
});
