import { describe, expect, it, vi } from "vitest";
import { discoverAuthorizationServer } from "../../src/identity/authorization-server.js";
import { canonicalDeviceUri, generateDeviceId } from "../../src/identity/device-id.js";
import { IssuerKeySet } from "../../src/identity/jwks.js";
import { startPairing, type PairingFlow, type PairingFlowOptions } from "../../src/identity/pairing.js";
import { PAIRING_CLIENT, TestAuthorizationServer } from "./test-authorization-server.js";

/**
 * WP-28 / AD-21 points 1, 2 and 5: pairing with the authorization code flow,
 * PKCE S256, a loopback redirect and the new device's canonical URI as the
 * RFC 8707 resource; the token is verified like a remote request's.
 */

async function begin(as: TestAuthorizationServer, overrides: Partial<PairingFlowOptions> = {}): Promise<PairingFlow> {
  const http = as.http();
  const metadata = await discoverAuthorizationServer(as.issuer, http);
  const keys = new IssuerKeySet({ issuer: as.issuer, http });
  return startPairing({
    environment: as.environment(),
    metadata,
    http,
    keys,
    deviceId: generateDeviceId(),
    ...overrides,
  });
}

async function get(url: string): Promise<number> {
  const r = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  await r.text();
  return r.status;
}

describe("pairing", () => {
  it("reports verified account sign-in even when Relay refuses registration, without pairing", async () => {
    const as = new TestAuthorizationServer(),
      onAuthenticated = vi.fn();
    const flow = await begin(as, {
      onAuthenticated,
      register: async () => ({ ok: false, detail: "entitlement_required" }),
    });
    await get(as.authorize(flow.authorizationUrl, { sub: "free_account" }).redirect);
    expect(await flow.outcome).toMatchObject({ ok: false, reason: "relay_registration_failed" });
    expect(onAuthenticated).toHaveBeenCalledTimes(1);
    expect(onAuthenticated.mock.calls[0]?.[0]).toBeGreaterThan(Date.now() / 1000);
  });
  it("does not report account sign-in for an unverified callback", async () => {
    const as = new TestAuthorizationServer(),
      onAuthenticated = vi.fn();
    const flow = await begin(as, { onAuthenticated });
    await get(as.authorize(flow.authorizationUrl, { sub: "u", iss: "https://evil.example" }).redirect);
    expect(await flow.outcome).toMatchObject({ ok: false, reason: "issuer_mismatch" });
    expect(onAuthenticated).not.toHaveBeenCalled();
  });

  it.each(["authkit", "GoogleOAuth", "GitHubOAuth"] as const)(
    "routes %s and login_hint without changing PKCE",
    async (provider) => {
      const flow = await begin(new TestAuthorizationServer(), { provider, login_hint: "person@example.test" });
      const url = new URL(flow.authorizationUrl);
      expect(url.searchParams.get("provider")).toBe(provider);
      expect(url.searchParams.get("login_hint")).toBe("person@example.test");
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
      flow.cancel();
      await flow.outcome;
    },
  );

  it("requests a token for the new device's canonical URI and establishes the account from sub", async () => {
    const as = new TestAuthorizationServer();
    const flow = await begin(as);
    const url = new URL(flow.authorizationUrl);
    expect(url.searchParams.get("resource")).toBe(canonicalDeviceUri(as.relayHost, flow.deviceId));
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("client_id")).toBe(PAIRING_CLIENT);
    expect(url.searchParams.get("redirect_uri")).toBe(flow.redirectUri);
    expect(flow.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    // A forged callback (wrong state) is ignored; the flow keeps waiting.
    expect(await get(`${flow.redirectUri}?state=forged&code=x`)).toBe(400);
    expect(await get(flow.redirectUri.replace("/callback", "/other"))).toBe(404);
    expect(await get(as.authorize(flow.authorizationUrl, { sub: "user_01" }).redirect)).toBe(200);
    expect(await flow.outcome).toEqual({ ok: true, accountId: "user_01" });
    expect(as.requests.token).toBe(1);
  });

  it("fails on a denied sign-in, an iss of another issuer, a rejected token or another client", async () => {
    let as = new TestAuthorizationServer();
    let flow = await begin(as);
    await get(as.authorize(flow.authorizationUrl, { sub: "u", deny: true }).redirect);
    expect(await flow.outcome).toMatchObject({ ok: false, reason: "access_denied" });

    flow = await begin(as);
    await get(as.authorize(flow.authorizationUrl, { sub: "u", iss: "https://evil.example" }).redirect);
    expect(await flow.outcome).toMatchObject({ ok: false, reason: "issuer_mismatch" });

    // RFC 9207 iss equal to the issuer is accepted (not required).
    flow = await begin(as);
    await get(as.authorize(flow.authorizationUrl, { sub: "u", iss: as.issuer }).redirect);
    expect(await flow.outcome).toMatchObject({ ok: true });

    // The provider issued the token with another key than it publishes.
    as = new TestAuthorizationServer();
    flow = await begin(as);
    const redirect = as.authorize(flow.authorizationUrl, { sub: "u" }).redirect;
    as.active = { ...as.active, privateKey: new TestAuthorizationServer().active.privateKey };
    await get(redirect);
    expect(await flow.outcome).toMatchObject({ ok: false, reason: "token_rejected", detail: "bad_signature" });

    // Another client's code: the token's client_id is not the pairing client.
    as = new TestAuthorizationServer();
    flow = await begin(as);
    const swapped = new URL(flow.authorizationUrl);
    swapped.searchParams.set("client_id", "https://mcp-client.example/oauth/client.json");
    const back = new URL(as.authorize(swapped.toString(), { sub: "u" }).redirect);
    await get(back.toString());
    expect(await flow.outcome).toMatchObject({ ok: false, reason: "token_exchange_failed" });
  });

  it("refuses a provider without PKCE S256; times out and can be cancelled", async () => {
    const as = new TestAuthorizationServer();
    as.metadataOverride = { code_challenge_methods_supported: ["plain"] };
    await expect(begin(as)).rejects.toThrow(/S256/);
    as.metadataOverride = {};
    const slow = await begin(as, { timeoutMs: 50 });
    expect(await slow.outcome).toEqual({ ok: false, reason: "timeout" });
    const flow = await begin(as);
    flow.cancel();
    expect(await flow.outcome).toEqual({ ok: false, reason: "cancelled" });
    await expect(fetch(flow.redirectUri, { signal: AbortSignal.timeout(2_000) })).rejects.toThrow();
  });
});
