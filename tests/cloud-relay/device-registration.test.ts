/**
 * WP-30: the device's registration at the Cloud Relay during pairing
 * (AD-22 point 4), against the real relay of WP-29. The device registers its
 * public key with the verified pairing token; the relay's own checks decide.
 */
import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { devicePublicKey } from "../../src/identity/device-credential.js";
import { canonicalDeviceUri, generateDeviceId } from "../../src/identity/device-id.js";
import { createIdentityHttp, type IdentityHttp } from "../../src/identity/http.js";
import { IssuerKeySet } from "../../src/identity/jwks.js";
import { startPairing, type PairingRegistration } from "../../src/identity/pairing.js";
import { registerDeviceAtRelay, relayRegistrationUrl } from "../../src/identity/relay-registration.js";
import { TEST_RELAY } from "../identity/test-authorization-server.js";
import { RelayHarness, type PairedDevice } from "./harness.js";

let h: RelayHarness;

afterEach(async () => {
  await h?.stop();
});

const RELAY_PREFIX = `{{https://${TEST_RELAY}}}/`;

/** Route the relay's https URL to the test relay; everything else to the test authorization server. */
function routedFetch(harness: RelayHarness): typeof globalThis.fetch {
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith(RELAY_PREFIX)) return fetch(`${harness.origin}/${url.slice(RELAY_PREFIX.length)}`, init);
    return harness.as.fetch(input, init);
  };
}

function httpFor(harness: RelayHarness): IdentityHttp {
  return createIdentityHttp({ fetch: routedFetch(harness) });
}

function register(device: PairedDevice, token: string, publicKey = device.publicKey) {
  return registerDeviceAtRelay({
    http: httpFor(h),
    url: relayRegistrationUrl(TEST_RELAY, device.deviceId),
    accessToken: token,
    publicKey,
  });
}

describe("relay registration URL", () => {
  it("is https://<relay-host>/d/<device-id>/register", () => {
    const id = generateDeviceId();
    expect(relayRegistrationUrl(TEST_RELAY, id)).toBe(`{{https://relay.crot-dev.example/d/${id}}}/register`);
    expect(relayRegistrationUrl(TEST_RELAY, id)).toBe(
      canonicalDeviceUri(TEST_RELAY, id).replace(/\/mcp$/, "/register"),
    );
  });

  it("refuses an invalid relay host or device id", () => {
    expect(() => relayRegistrationUrl("127.0.0.1:8080", generateDeviceId())).toThrow();
    expect(() => relayRegistrationUrl(TEST_RELAY, "not-a-device")).toThrow();
  });
});

describe("registerDeviceAtRelay against the Cloud Relay", () => {
  it("registers (201), is idempotent (200), and the registered key opens the tunnel", async () => {
    h = await new RelayHarness().start();
    const device = h.newDevice();
    expect(await register(device, h.pairingToken(device))).toEqual({ ok: true, created: true, status: 201 });
    expect(await register(device, h.pairingToken(device))).toEqual({ ok: true, created: false, status: 200 });
    await h.online(device);
  });

  it("reports a conflict when another key is registered for the device id", async () => {
    h = await new RelayHarness().start();
    const device = h.newDevice();
    await h.register(device);
    const other = devicePublicKey(generateKeyPairSync("ed25519").privateKey);
    expect(await register(device, h.pairingToken(device), other)).toEqual({
      ok: false,
      reason: "conflict",
      status: 409,
    });
  });

  it("refuses a token of another client (not the pairing client)", async () => {
    h = await new RelayHarness().start();
    const device = h.newDevice();
    expect(await register(device, h.clientToken(device))).toEqual({ ok: false, reason: "forbidden", status: 403 });
  });

  it("refuses an expired token", async () => {
    h = await new RelayHarness().start();
    const device = h.newDevice();
    const now = Math.floor(Date.now() / 1000);
    const token = h.pairingToken(device, { iat: now - 1200, exp: now - 600 });
    expect(await register(device, token)).toEqual({ ok: false, reason: "unauthorized", status: 401 });
  });

  it("never registers a device with a token for another device or account", async () => {
    h = await new RelayHarness().start();
    const device = h.newDevice();
    const foreign = h.newDevice("user_02");
    const result = await register(device, h.pairingToken(foreign));
    expect(result.ok).toBe(false);
    expect(["unauthorized", "forbidden"]).toContain(!result.ok && result.reason);
    // Not registered: the device can still be registered by its own pairing.
    expect(await register(device, h.pairingToken(device))).toMatchObject({ ok: true, created: true });
  });

  it("sends only the public key, no ambient credentials, no redirects", async () => {
    const seen: Array<{ url: string; init: RequestInit | undefined }> = [];
    const http = createIdentityHttp({
      fetch: async (input, init) => {
        seen.push({ url: String(input), init });
        return new Response("{}", { status: 201 });
      },
    });
    const id = generateDeviceId();
    const publicKey = devicePublicKey(generateKeyPairSync("ed25519").privateKey);
    const result = await registerDeviceAtRelay({
      http,
      url: relayRegistrationUrl(TEST_RELAY, id),
      accessToken: "tok-secret",
      publicKey,
    });
    expect(result).toEqual({ ok: true, created: true, status: 201 });
    expect(seen).toHaveLength(1);
    const { url, init } = seen[0]!;
    expect(url).toBe(`{{https://relay.crot-dev.example/d/${id}}}/register`);
    expect(init?.method).toBe("POST");
    expect(init?.redirect).toBe("error");
    expect(init?.credentials).toBe("omit");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer tok-secret");
    expect(JSON.parse(String(init?.body))).toEqual({ publicKey: { kty: "OKP", crv: "Ed25519", x: publicKey.x } });
  });

  it("does not fetch a non-https URL and fails closed without a JSON-capable client", async () => {
    let calls = 0;
    const http = createIdentityHttp({
      fetch: async () => {
        calls++;
        return new Response("{}", { status: 201 });
      },
    });
    const publicKey = devicePublicKey(generateKeyPairSync("ed25519").privateKey);
    const plain = "http" + "://" + TEST_RELAY + "/d/" + generateDeviceId() + "/register";
    expect(await registerDeviceAtRelay({ http, url: plain, accessToken: "t", publicKey })).toEqual({
      ok: false,
      reason: "invalid_url",
    });
    expect(calls).toBe(0);
    const legacy: IdentityHttp = { getJson: http.getJson, postForm: http.postForm };
    const url = relayRegistrationUrl(TEST_RELAY, generateDeviceId());
    expect(await registerDeviceAtRelay({ http: legacy, url, accessToken: "t", publicKey })).toEqual({
      ok: false,
      reason: "unavailable",
    });
    expect(calls).toBe(0);
  });

  it("reports an unreachable relay without the error text or the token", async () => {
    const http = createIdentityHttp({
      fetch: async () => {
        throw new TypeError("connect ECONNREFUSED tok-secret-leak");
      },
    });
    const publicKey = devicePublicKey(generateKeyPairSync("ed25519").privateKey);
    const result = await registerDeviceAtRelay({
      http,
      url: relayRegistrationUrl(TEST_RELAY, generateDeviceId()),
      accessToken: "tok-secret-leak",
      publicKey,
    });
    expect(result).toEqual({ ok: false, reason: "unreachable" });
    expect(JSON.stringify(result)).not.toContain("tok-secret");
  });
});

describe("pairing registers the device at the relay (AD-22 point 4)", () => {
  async function pair(
    harness: RelayHarness,
    registerStep: (deviceId: string, key: PairedDevice) => PairingRegistration,
    sub = "user_01",
  ) {
    const http = httpFor(harness);
    const keys = new IssuerKeySet({ issuer: harness.as.issuer, http: harness.as.http() });
    const deviceId = generateDeviceId();
    const { privateKey } = generateKeyPairSync("ed25519");
    const device: PairedDevice = {
      deviceId,
      accountId: sub,
      key: privateKey,
      publicKey: devicePublicKey(privateKey),
      uri: canonicalDeviceUri(TEST_RELAY, deviceId),
    };
    const flow = await startPairing({
      environment: harness.as.environment(),
      metadata: await keys.metadata(),
      http,
      keys,
      deviceId,
      timeoutMs: 10_000,
      register: registerStep(deviceId, device),
    });
    const { redirect } = harness.as.authorize(flow.authorizationUrl, { sub });
    await (await fetch(redirect)).text();
    return { device, outcome: await flow.outcome };
  }

  const relayStep =
    (harness: RelayHarness, calls: string[] = []) =>
    (deviceId: string, device: PairedDevice): PairingRegistration =>
    async (accessToken) => {
      calls.push(deviceId);
      const result = await registerDeviceAtRelay({
        http: httpFor(harness),
        url: relayRegistrationUrl(TEST_RELAY, deviceId),
        accessToken,
        publicKey: device.publicKey,
      });
      return result.ok
        ? { ok: true }
        : { ok: false, detail: `${result.reason}${result.status !== undefined ? ` (status ${result.status})` : ""}` };
    };

  it("pairs, registers the key and the tunnel then opens with it", async () => {
    h = await new RelayHarness().start();
    const { device, outcome } = await pair(h, relayStep(h));
    expect(outcome).toEqual({ ok: true, accountId: "user_01" });
    await h.online(device);
    // The relay never logs the pairing token.
    expect(h.logText()).not.toMatch(/eyJ[\w-]+\.[\w-]+\.[\w-]+/);
  });

  it("fails the pairing when the relay refuses the registration", async () => {
    h = await new RelayHarness().start({ pairingClientId: "other_client" });
    const { outcome } = await pair(h, relayStep(h));
    expect(outcome).toEqual({ ok: false, reason: "relay_registration_failed", detail: "forbidden (status 403)" });
  });

  it("does not register when the pairing token is rejected by the device", async () => {
    h = await new RelayHarness().start();
    h.as.tokenLifetimeSeconds = -600;
    const calls: string[] = [];
    const { outcome } = await pair(h, relayStep(h, calls));
    expect(outcome).toMatchObject({ ok: false, reason: "token_rejected" });
    expect(calls).toEqual([]);
  });

  it("fails closed when the registration step throws, without its message", async () => {
    h = await new RelayHarness().start();
    const { outcome } = await pair(h, () => async () => {
      throw new Error("boom tok-secret");
    });
    expect(outcome).toEqual({ ok: false, reason: "relay_registration_failed", detail: "registration failed" });
  });
});
