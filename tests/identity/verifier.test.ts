import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalDeviceUri, generateDeviceId } from "../../src/identity/device-id.js";
import { IssuerKeySet } from "../../src/identity/jwks.js";
import { MAX_TOKEN_LENGTH } from "../../src/identity/jwt.js";
import {
  OAUTH_AUTH_METHOD,
  OAuthAccessTokenVerifier,
  UnavailableTokenVerifier,
  type BindingView,
  type TokenRejection,
} from "../../src/identity/verifier.js";
import { MCP_CLIENT, rsaKey, signJwt, TestAuthorizationServer } from "./test-authorization-server.js";

/**
 * WP-28 / AD-21 points 2–5: the relay entry point's access-token verifier
 * against an emulated AuthKit environment — every check of the verification
 * order, key rotation and the JWKS cache bounds, binding and environment.
 */

const ACCOUNT = "user_01HXYZ";

let as: TestAuthorizationServer;
let now: number;
let deviceId: string;
let binding: BindingView;
let rejections: TokenRejection[];
let keys: IssuerKeySet;
let verifier: OAuthAccessTokenVerifier;

const resource = () => canonicalDeviceUri(as.relayHost, deviceId);

function make(keyOptions: { minRefetchIntervalMs?: number; maxAgeMs?: number; maxStaleMs?: number } = {}) {
  keys = new IssuerKeySet({ issuer: as.issuer, http: as.http(), now: () => now, ...keyOptions });
  verifier = new OAuthAccessTokenVerifier({
    environment: as.environment(),
    keys,
    binding: () => binding,
    now: () => now,
    onReject: (r) => rejections.push(r),
  });
}

beforeEach(() => {
  as = new TestAuthorizationServer();
  now = Date.UTC(2026, 0, 15, 12, 0, 0);
  as.clock = () => now;
  deviceId = generateDeviceId();
  binding = { state: "paired", deviceId, accountId: ACCOUNT, issuer: as.issuer, relayHost: as.relayHost };
  rejections = [];
  make();
});
afterEach(() => undefined);

const good = (over: Parameters<TestAuthorizationServer["token"]>[0] extends infer T ? Partial<T> : never = {}) =>
  as.token({ resource: resource(), sub: ACCOUNT, ...over });

async function rejected(token: string, reason: TokenRejection): Promise<void> {
  expect(await verifier.verifyAccessToken(token)).toBeUndefined();
  expect(rejections.at(-1)).toBe(reason);
}

describe("OAuthAccessTokenVerifier", () => {
  it("accepts a token for this device and carries only verified facts", async () => {
    const token = good();
    const info = await verifier.verifyAccessToken(token);
    expect(info).toMatchObject({
      clientId: MCP_CLIENT,
      scopes: [],
      extra: { subject: ACCOUNT, accountId: ACCOUNT, deviceId, authMethod: OAUTH_AUTH_METHOD, issuedAt: now / 1000 },
    });
    expect(info!.resource?.href).toBe(resource());
    expect(info!.expiresAt).toBe(now / 1000 + 300);
    // scope, roles, permissions, org and session claims never reach the principal.
    expect(Object.keys(info!.extra!).sort()).toEqual(["accountId", "authMethod", "deviceId", "issuedAt", "subject"]);
    expect(JSON.stringify({ ...info, token: undefined })).not.toMatch(/admin|crot:full_control|org_01|session_01/);
    expect(verifier.method).toBe("oauth");
  });

  it("rejects a token for another device, another resource, or with several audiences", async () => {
    await rejected(
      as.token({ resource: canonicalDeviceUri(as.relayHost, generateDeviceId()), sub: ACCOUNT }),
      "audience",
    );
    await rejected(good({ claims: { aud: `https://${as.relayHost}/d/${deviceId}/` } }), "audience");
    await rejected(good({ claims: { aud: `https://other-relay.example/d/${deviceId}` } }), "audience");
    await rejected(good({ claims: { aud: [resource(), "https://api.example"] } }), "audience");
    await rejected(good({ claims: { aud: undefined } }), "audience");
    await rejected(good({ claims: { aud: [] } }), "audience");
    // A one-element array is the same single audience.
    expect(await verifier.verifyAccessToken(good({ claims: { aud: [resource()] } }))).toBeDefined();
  });

  it("rejects another issuer and a token of another account", async () => {
    await rejected(good({ claims: { iss: "https://evil.example" } }), "issuer");
    await rejected(good({ claims: { iss: `${as.issuer}/` } }), "issuer");
    await rejected(good({ sub: "user_other" }), "account");
    await rejected(good({ claims: { sub: undefined } }), "subject");
    await rejected(good({ claims: { client_id: undefined } }), "client_id");
    await rejected(good({ claims: { client_id: "" } }), "client_id");
  });

  it("rejects forged, tampered and non-RS256 tokens", async () => {
    const foreign = rsaKey("key-1"); // same kid, another key
    await rejected(good({ key: foreign }), "bad_signature");
    const [h, , s] = good().split(".");
    const tampered = `${h}.${Buffer.from(JSON.stringify({ iss: as.issuer, sub: "user_other", aud: resource(), iat: now / 1000, exp: now / 1000 + 60, client_id: "x" })).toString("base64url")}.${s}`;
    await rejected(tampered, "bad_signature");
    await rejected(good({ header: { alg: "none" } }), "unsupported_alg");
    await rejected(good({ header: { alg: "HS256" } }), "unsupported_alg");
    await rejected(good({ header: { alg: "RS512" } }), "unsupported_alg");
    await rejected(good({ header: { crit: ["exp"] } }), "unsupported_alg");
    await rejected(signJwt({ iss: as.issuer }, as.active, { kid: undefined }), "unknown_key");
    await rejected(`${good().split(".").slice(0, 2).join(".")}.`, "malformed");
    await rejected("not-a-jwt", "malformed");
    await rejected("a.b.c", "malformed");
    await rejected(`${"x".repeat(MAX_TOKEN_LENGTH + 1)}`, "malformed");
  });

  it("checks the time claims: exp without leeway, nbf and iat with 60 s skew, iat at most 15 minutes old", async () => {
    const t = now / 1000;
    await rejected(good({ claims: { exp: t } }), "expired");
    await rejected(good({ claims: { exp: t - 1 } }), "expired");
    await rejected(good({ claims: { exp: undefined } }), "missing_time");
    await rejected(good({ claims: { iat: undefined } }), "missing_time");
    await rejected(good({ claims: { exp: "soon" } }), "missing_time");
    await rejected(good({ claims: { nbf: t + 61 } }), "not_yet_valid");
    expect(await verifier.verifyAccessToken(good({ claims: { nbf: t + 60 } }))).toBeDefined();
    await rejected(good({ claims: { iat: t + 61 } }), "issued_in_future");
    expect(await verifier.verifyAccessToken(good({ claims: { iat: t + 30 } }))).toBeDefined();
    await rejected(good({ claims: { iat: t - 15 * 60 - 1, exp: t + 3600 } }), "too_old");
    expect(await verifier.verifyAccessToken(good({ claims: { iat: t - 15 * 60, exp: t + 3600 } }))).toBeDefined();
  });

  it("an unpaired device, an unavailable binding and another environment accept no token", async () => {
    const token = good();
    binding = { state: "unpaired" };
    await rejected(token, "not_paired");
    binding = { state: "unavailable", error: "malformed" };
    await rejected(token, "binding_unavailable");
    binding = {
      state: "paired",
      deviceId,
      accountId: ACCOUNT,
      issuer: "https://other-issuer.example",
      relayHost: as.relayHost,
    };
    await rejected(token, "environment_mismatch");
    binding = { state: "paired", deviceId, accountId: ACCOUNT, issuer: as.issuer, relayHost: "other-relay.example" };
    await rejected(token, "environment_mismatch");
    expect(await new UnavailableTokenVerifier().verifyAccessToken()).toBeUndefined();
  });

  it("an unpairing while the keys are fetched still rejects the request", async () => {
    const token = good();
    const original = as.fetch;
    let unpairDuring = true;
    const keysWithHook = new IssuerKeySet({
      issuer: as.issuer,
      http: {
        ...as.http(),
        getJson: async (url) => {
          const r = await as.http().getJson(url);
          if (unpairDuring && url.endsWith("/jwks")) binding = { state: "unpaired" };
          return r;
        },
      },
      now: () => now,
    });
    void original;
    const v = new OAuthAccessTokenVerifier({
      environment: as.environment(),
      keys: keysWithHook,
      binding: () => binding,
      now: () => now,
      onReject: (r) => rejections.push(r),
    });
    expect(await v.verifyAccessToken(token)).toBeUndefined();
    expect(rejections.at(-1)).toBe("not_paired");
    unpairDuring = false;
  });

  it("follows key rotation: unknown kid triggers a bounded refetch; withdrawn keys stop verifying", async () => {
    expect(await verifier.verifyAccessToken(good())).toBeDefined();
    expect(as.requests.jwks).toBe(1);
    as.rotate("key-2");
    now += 31_000;
    // New kid: one refetch, then accepted.
    expect(await verifier.verifyAccessToken(good())).toBeDefined();
    expect(as.requests.jwks).toBe(2);
    // Unknown kids within 30 s do not refetch again (no amplification).
    await rejected(good({ header: { kid: "nope-1" } }), "unknown_key");
    await rejected(good({ header: { kid: "nope-2" } }), "unknown_key");
    expect(as.requests.jwks).toBe(2);
    // A withdrawn key is gone after the next refresh (max age 10 min).
    const old = as.keys[0]!;
    as.retire("key-1");
    now += 10 * 60_000;
    await rejected(good({ key: old }), "unknown_key");
    expect(await verifier.verifyAccessToken(good())).toBeDefined();
    now += 31_000;
    await rejected(good({ header: { kid: "nope-3" } }), "unknown_key");
    expect(as.requests.jwks).toBe(4);
  });

  it("fails closed when the issuer cannot be reached beyond the stale bound", async () => {
    as.down = true;
    await rejected(good(), "keys_unavailable");
    as.down = false;
    // A failing issuer is asked again only after 30 s.
    await rejected(good(), "keys_unavailable");
    now += 31_000;
    expect(await verifier.verifyAccessToken(good())).toBeDefined();
    as.down = true;
    // The last good set is used while stale (≤ 1 h) …
    now += 30 * 60_000;
    expect(await verifier.verifyAccessToken(good())).toBeDefined();
    // … but not after.
    now += 31 * 60_000;
    await rejected(good(), "keys_unavailable");
    expect(keys.status().lastError).toMatch(/request failed/);
  });

  it("uses nothing from metadata that names another issuer, and only usable RSA keys", async () => {
    as.metadataOverride = { issuer: "https://evil.example" };
    await rejected(good(), "keys_unavailable");
    as.metadataOverride = { jwks_uri: "http://auth.crot-dev.example/oauth2/jwks" };
    make();
    await rejected(good(), "keys_unavailable");
    as.metadataOverride = {};
    // A 1024-bit key is not used.
    const weak = rsaKey("weak", 1024);
    as.keys = [...as.keys, weak];
    make();
    await rejected(good({ key: weak }), "unknown_key");
    // Duplicate kids are dropped entirely (ambiguous).
    const dup = { ...rsaKey("key-1"), kid: "key-1" };
    as.keys = [as.keys[0]!, dup];
    make();
    now += 31_000;
    await rejected(good(), "unknown_key");
  });

  it("reports RFC 9207 support as advertised by the issuer, without depending on it", async () => {
    await verifier.verifyAccessToken(good());
    expect(keys.status().issParameterSupported).toBe(false);
    as.metadataOverride = { authorization_response_iss_parameter_supported: true };
    make();
    await verifier.verifyAccessToken(good());
    expect(keys.status().issParameterSupported).toBe(true);
  });
});
