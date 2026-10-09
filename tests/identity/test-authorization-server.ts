/**
 * An in-process stand-in for the identity environment (WP-28 tests): a
 * WorkOS AuthKit-like authorization server configured as AD-21 point 1
 * prescribes — one resource indicator pattern `https://<relay>/d/*`, no
 * default resource, PKCE S256, RS256 access tokens (≤ 5 min) whose `aud` is
 * the requested resource. No network: `fetch` is a shim the device's
 * IdentityHttp uses, so the device code runs unchanged against it.
 *
 * Tokens can also be minted directly with arbitrary claims, keys and headers
 * for the verifier's negative tests.
 */
import { createHash, createSign, generateKeyPairSync, randomBytes, type KeyObject } from "node:crypto";
import { createIdentityHttp, type IdentityHttp } from "../../src/identity/http.js";
import type { IdentityEnvironment } from "../../src/identity/environment.js";

export const TEST_ISSUER = "https://auth.crot-dev.example";
export const TEST_RELAY = "relay.crot-dev.example";
export const PAIRING_CLIENT = "client_pairing_native";
export const MCP_CLIENT = "https://mcp-client.example/oauth/client.json";

export interface SigningKey {
  readonly kid: string;
  readonly privateKey: KeyObject;
  readonly publicJwk: Record<string, unknown>;
}

export function rsaKey(kid: string, bits = 2048): SigningKey {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: bits });
  return { kid, privateKey, publicJwk: { ...publicKey.export({ format: "jwk" }), kid, use: "sig", alg: "RS256" } };
}

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");

/** Sign a JWS with RS256 (or emit an unsigned/other-alg token for negative tests). */
export function signJwt(
  claims: Record<string, unknown>,
  key: SigningKey | undefined,
  header: Record<string, unknown> = {},
): string {
  const h = { alg: "RS256", typ: "at+jwt", ...(key ? { kid: key.kid } : {}), ...header };
  const input = `${b64(h)}.${b64(claims)}`;
  // Other algorithms get a placeholder signature: the device must refuse them by `alg`, not by shape.
  if (!key || h.alg !== "RS256") return `${input}.${Buffer.from("not-a-signature").toString("base64url")}`;
  const signature = createSign("RSA-SHA256").update(input).sign(key.privateKey).toString("base64url");
  return `${input}.${signature}`;
}

interface PendingCode {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly challenge: string;
  readonly resource: string;
  readonly subject: string;
}

export interface AuthorizeResult {
  /** Where the browser would be redirected (the device's loopback callback). */
  readonly redirect: string;
}

export class TestAuthorizationServer {
  readonly issuer: string;
  readonly relayHost: string;
  keys: SigningKey[];
  /** Key that signs new tokens. */
  active: SigningKey;
  /** Metadata overrides (e.g. another issuer, no S256, RFC 9207). */
  metadataOverride: Record<string, unknown> = {};
  /** Make the endpoints fail (network down). */
  down = false;
  tokenLifetimeSeconds = 300;
  readonly requests = { metadata: 0, jwks: 0, token: 0 };
  clock: () => number = Date.now;
  private readonly codes = new Map<string, PendingCode>();
  private readonly registeredClients = new Set([PAIRING_CLIENT, MCP_CLIENT]);

  constructor(options: { issuer?: string; relayHost?: string } = {}) {
    this.issuer = options.issuer ?? TEST_ISSUER;
    this.relayHost = options.relayHost ?? TEST_RELAY;
    this.active = rsaKey("key-1");
    this.keys = [this.active];
  }

  /** The development environment pointing at this server. */
  environment(overrides: Partial<IdentityEnvironment> = {}): IdentityEnvironment {
    return {
      id: "test",
      kind: "development",
      issuer: this.issuer,
      relayHost: this.relayHost,
      pairing: { clientId: PAIRING_CLIENT, redirectPort: 0, scope: "openid" },
      ...overrides,
    };
  }

  /** Add a new key and sign with it; the old one stays published until retired. */
  rotate(kid: string): SigningKey {
    const key = rsaKey(kid);
    this.keys = [...this.keys, key];
    this.active = key;
    return key;
  }

  retire(kid: string): void {
    this.keys = this.keys.filter((k) => k.kid !== kid);
  }

  get resourcePattern(): string {
    return `https://${this.relayHost}/d/`;
  }

  /** A token as the provider would issue it for `resource`, with claim overrides. */
  token(options: {
    resource: string;
    sub: string;
    clientId?: string;
    claims?: Record<string, unknown>;
    key?: SigningKey;
    header?: Record<string, unknown>;
  }): string {
    const iat = Math.floor(this.clock() / 1000);
    return signJwt(
      {
        iss: this.issuer,
        sub: options.sub,
        aud: options.resource,
        client_id: options.clientId ?? MCP_CLIENT,
        iat,
        exp: iat + this.tokenLifetimeSeconds,
        jti: randomBytes(8).toString("hex"),
        sid: "session_01",
        org_id: "org_01",
        scope: "openid profile admin",
        permissions: ["crot:full_control"],
        role: "admin",
        ...options.claims,
      },
      options.key ?? this.active,
      options.header,
    );
  }

  /**
   * The user's sign-in at the authorization endpoint: validates the request
   * as the configured environment does and returns the redirect to the
   * client's callback (code or error).
   */
  authorize(authorizationUrl: string, user: { sub: string; deny?: boolean; iss?: string }): AuthorizeResult {
    const url = new URL(authorizationUrl);
    if (`${url.origin}${url.pathname}` !== `${this.issuer}/oauth2/authorize`) throw new Error("not this server");
    const p = url.searchParams;
    const redirectUri = p.get("redirect_uri") ?? "";
    if (!/^http:\/\/127\.0\.0\.1:\d+\/callback$/.test(redirectUri)) throw new Error("redirect_uri not allowed");
    const clientId = p.get("client_id") ?? "";
    if (!this.registeredClients.has(clientId)) throw new Error("unknown client");
    const back = new URL(redirectUri);
    const state = p.get("state");
    if (state) back.searchParams.set("state", state);
    if (user.iss !== undefined) back.searchParams.set("iss", user.iss);
    const fail = (error: string) => {
      back.searchParams.set("error", error);
      return { redirect: back.toString() };
    };
    if (user.deny) return fail("access_denied");
    if (p.get("response_type") !== "code") return fail("unsupported_response_type");
    if (p.get("code_challenge_method") !== "S256" || !p.get("code_challenge")) return fail("invalid_request");
    const resource = p.get("resource") ?? "";
    if (!this.allowedResource(resource)) return fail("invalid_target");
    const code = randomBytes(16).toString("base64url");
    this.codes.set(code, { clientId, redirectUri, challenge: p.get("code_challenge")!, resource, subject: user.sub });
    back.searchParams.set("code", code);
    return { redirect: back.toString() };
  }

  private allowedResource(resource: string): boolean {
    const prefix = this.resourcePattern;
    // The single resource indicator pattern `https://<relay>/d/*` (AD-21 point 1).
    return resource.startsWith(prefix) && /^[a-z2-7]{26}\/mcp$/.test(resource.slice(prefix.length));
  }

  private tokenEndpoint(form: URLSearchParams): { status: number; body: unknown } {
    this.requests.token++;
    const code = this.codes.get(form.get("code") ?? "");
    if (form.get("grant_type") !== "authorization_code" || !code)
      return { status: 400, body: { error: "invalid_grant" } };
    this.codes.delete(form.get("code")!);
    const verifier = form.get("code_verifier") ?? "";
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    if (
      challenge !== code.challenge ||
      form.get("client_id") !== code.clientId ||
      form.get("redirect_uri") !== code.redirectUri ||
      (form.get("resource") ?? code.resource) !== code.resource
    )
      return { status: 400, body: { error: "invalid_grant" } };
    return {
      status: 200,
      body: {
        token_type: "Bearer",
        access_token: this.token({ resource: code.resource, sub: code.subject, clientId: code.clientId }),
        expires_in: this.tokenLifetimeSeconds,
        refresh_token: "rt_" + randomBytes(8).toString("hex"),
      },
    };
  }

  /** The `fetch` the device's IdentityHttp uses (no network). */
  readonly fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (this.down) throw new TypeError("fetch failed");
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    if (url.origin !== this.issuer) return json(404, { error: "not_found" });
    if (url.pathname === "/.well-known/oauth-authorization-server" && (init?.method ?? "GET") === "GET") {
      this.requests.metadata++;
      return json(200, {
        issuer: this.issuer,
        authorization_endpoint: `${this.issuer}/oauth2/authorize`,
        token_endpoint: `${this.issuer}/oauth2/token`,
        jwks_uri: `${this.issuer}/oauth2/jwks`,
        registration_endpoint: `${this.issuer}/oauth2/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
        client_id_metadata_document_supported: true,
        ...this.metadataOverride,
      });
    }
    if (url.pathname === "/oauth2/jwks") {
      this.requests.jwks++;
      return json(200, { keys: this.keys.map((k) => k.publicJwk) });
    }
    if (url.pathname === "/oauth2/token" && init?.method === "POST") {
      const r = this.tokenEndpoint(new URLSearchParams(String(init.body)));
      return json(r.status, r.body);
    }
    return json(404, { error: "not_found" });
  };

  /** The device's HTTP client routed to this server. */
  http(): IdentityHttp {
    return createIdentityHttp({ fetch: this.fetch });
  }
}
