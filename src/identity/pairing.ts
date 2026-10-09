/**
 * Device pairing (ARCHITECTURE.md §27, AD-21 points 1, 2 and 5; WP-28).
 *
 * The user signs in to the identity environment in their browser with the
 * OAuth 2.1 authorization code flow and PKCE (S256) of a public native
 * client, redirected to a loopback URI on this machine (RFC 8252). The
 * request carries the RFC 8707 `resource` of the *new* device's canonical
 * URI, so the provider issues an access token whose `aud` is exactly that
 * URI — the same path every MCP client later takes. The device verifies that
 * token with the same checks as a remote request (signature, `iss`, `aud`,
 * time claims, `client_id`); its `sub` becomes the paired account.
 *
 * - `state` is random and checked; an `iss` parameter in the authorization
 *   response, when the provider sends one, must equal the issuer (RFC 9207 is
 *   an open condition of AD-21; the flow neither requires nor claims it).
 * - The code, the tokens and the verifier never leave this module: nothing is
 *   logged, stored or shown; the access token is dropped after its check.
 * - The callback listener accepts only `GET /callback` with the loopback Host
 *   of its own port and answers with a static page (no reflected input).
 * - Registration at the relay (AD-22 point 4; WP-30): when a `register` step
 *   is given, the verified access token is handed to it only after every
 *   check above passed, and the pairing succeeds only if the relay accepted
 *   the device. The token is never retained by this module.
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { AuthorizationServerMetadata } from "./authorization-server.js";
import { canonicalDeviceUri } from "./device-id.js";
import type { IdentityEnvironment } from "./environment.js";
import type { IdentityHttp } from "./http.js";
import type { SigningKeySource } from "./jwks.js";
import { checkAccessToken } from "./verifier.js";

/** How long a pairing waits for the user's sign-in. */
export const DEFAULT_PAIRING_TIMEOUT_MS = 10 * 60_000;
const CALLBACK_PATH = "/callback";

export type PairingFailure =
  | "cancelled"
  | "timeout"
  | "access_denied"
  | "authorization_error"
  | "issuer_mismatch"
  | "token_exchange_failed"
  | "token_rejected"
  | "client_mismatch"
  | "relay_registration_failed";

export type PairingOutcome =
  | { readonly ok: true; readonly accountId: string }
  | { readonly ok: false; readonly reason: PairingFailure; readonly detail?: string };

/**
 * Register the new device at the relay with the verified pairing access token
 * (AD-22 point 4). `detail` must not contain the token.
 */
export type PairingRegistration = (
  accessToken: string,
) => Promise<{ readonly ok: true } | { readonly ok: false; readonly detail: string }>;

export interface PairingFlowOptions {
  readonly environment: IdentityEnvironment;
  readonly metadata: AuthorizationServerMetadata;
  readonly http: IdentityHttp;
  readonly keys: SigningKeySource;
  /** The device id this pairing is for (new for every pairing). */
  readonly deviceId: string;
  readonly timeoutMs?: number;
  readonly now?: () => number;
  /** Register the device at the relay after the token passed every check (AD-22 point 4). */
  readonly register?: PairingRegistration;
}

export interface PairingFlow {
  /** The URL the user opens in their browser. */
  readonly authorizationUrl: string;
  readonly redirectUri: string;
  readonly deviceId: string;
  readonly expiresAt: string;
  /** Settles once: signed in and verified, failed, timed out or cancelled. */
  readonly outcome: Promise<PairingOutcome>;
  cancel(): void;
}

const PAGE_OK = "CROT: this device is being paired. You can close this window.";
const PAGE_FAILED = "CROT: pairing did not complete. Return to CROT for details; you can close this window.";

function page(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  });
  res.end(text);
}

async function listen(port: number): Promise<Server> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  return server;
}

/** Start a pairing: listen for the redirect and build the authorization URL. */
export async function startPairing(options: PairingFlowOptions): Promise<PairingFlow> {
  const { environment: env, metadata } = options;
  if (!metadata.s256) throw new Error("the identity provider does not advertise PKCE S256");
  const resource = canonicalDeviceUri(env.relayHost, options.deviceId);
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url");
  const state = randomBytes(24).toString("base64url");
  const server = await listen(env.pairing.redirectPort);
  const port = (server.address() as AddressInfo).port;
  const redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`;
  const url = new URL(metadata.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", env.pairing.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", env.pairing.scope);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("resource", resource);
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? DEFAULT_PAIRING_TIMEOUT_MS;

  let settle!: (outcome: PairingOutcome) => void;
  let settled = false;
  const outcome = new Promise<PairingOutcome>((resolve) => (settle = resolve));
  const finish = (result: PairingOutcome) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    // Let the answer to the browser finish; idle and lingering connections are closed.
    server.close();
    server.closeIdleConnections();
    setTimeout(() => server.closeAllConnections(), 1_000).unref();
    settle(result);
  };
  const timer = setTimeout(() => finish({ ok: false, reason: "timeout" }), timeoutMs);
  timer.unref();
  let exchanging = false;

  const exchange = async (code: string): Promise<PairingOutcome> => {
    let response: { status: number; body: unknown };
    try {
      response = await options.http.postForm(metadata.tokenEndpoint, {
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: env.pairing.clientId,
        code_verifier: verifier,
        resource,
      });
    } catch (error) {
      return {
        ok: false,
        reason: "token_exchange_failed",
        detail: error instanceof Error ? error.message : String(error),
      };
    }
    const body = response.body as Record<string, unknown> | undefined;
    if (response.status !== 200 || !body || typeof body.access_token !== "string") {
      const error = typeof body?.error === "string" ? body.error.slice(0, 64).replace(/[^\x20-\x7e]/g, "") : undefined;
      return {
        ok: false,
        reason: "token_exchange_failed",
        detail: `status ${response.status}${error ? `, ${error}` : ""}`,
      };
    }
    if (typeof body.token_type === "string" && body.token_type.toLowerCase() !== "bearer")
      return { ok: false, reason: "token_exchange_failed", detail: "not a bearer token" };
    const checked = await checkAccessToken(body.access_token, {
      issuer: env.issuer,
      audience: resource,
      keys: options.keys,
      nowSeconds: now() / 1000,
    });
    if (!checked.ok) return { ok: false, reason: "token_rejected", detail: checked.reason };
    if (checked.token.clientId !== env.pairing.clientId) return { ok: false, reason: "client_mismatch" };
    if (options.register) {
      let registered: Awaited<ReturnType<PairingRegistration>>;
      try {
        registered = await options.register(body.access_token);
      } catch {
        registered = { ok: false, detail: "registration failed" };
      }
      if (!registered.ok) return { ok: false, reason: "relay_registration_failed", detail: registered.detail };
    }
    return { ok: true, accountId: checked.token.subject };
  };

  server.on("request", (req: IncomingMessage, res: ServerResponse) => {
    if (req.headers.host !== `127.0.0.1:${port}`) return page(res, 400, PAGE_FAILED);
    const requestUrl = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    if (req.method !== "GET" || requestUrl.pathname !== CALLBACK_PATH) return page(res, 404, "Not found");
    const params = requestUrl.searchParams;
    // A response for another authorization request (or a forged one) is ignored; this flow keeps waiting.
    if (params.get("state") !== state || settled || exchanging) return page(res, 400, PAGE_FAILED);
    const iss = params.get("iss");
    if (iss !== null && iss !== env.issuer) {
      page(res, 400, PAGE_FAILED);
      return finish({ ok: false, reason: "issuer_mismatch" });
    }
    const error = params.get("error");
    if (error !== null) {
      page(res, 400, PAGE_FAILED);
      return finish({
        ok: false,
        reason: error === "access_denied" ? "access_denied" : "authorization_error",
        detail: error.slice(0, 64).replace(/[^\x20-\x7e]/g, ""),
      });
    }
    const code = params.get("code");
    if (!code) return page(res, 400, PAGE_FAILED);
    exchanging = true;
    void exchange(code).then(
      (result) => {
        page(res, result.ok ? 200 : 400, result.ok ? PAGE_OK : PAGE_FAILED);
        finish(result);
      },
      (err: unknown) => {
        page(res, 400, PAGE_FAILED);
        finish({
          ok: false,
          reason: "token_exchange_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
      },
    );
  });

  return {
    authorizationUrl: url.toString(),
    redirectUri,
    deviceId: options.deviceId,
    expiresAt: new Date(now() + timeoutMs).toISOString(),
    outcome,
    cancel: () => finish({ ok: false, reason: "cancelled" }),
  };
}
