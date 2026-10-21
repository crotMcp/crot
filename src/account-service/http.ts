import { PORTAL_HTML, PORTAL_SCRIPT, PORTAL_CSS } from "./portal.js";
import type { AuthorizationServerMetadata } from "../identity/authorization-server.js";
/** Embedded cloud account API. No MCP bodies enter this module. Owner and device credentials are separate. */
import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { verifyManagementProof, type ManagementAction } from "../identity/device-credential.js";
import type { SigningKeySource } from "../identity/jwks.js";
import { checkAccessToken } from "../identity/verifier.js";
import type { DeviceRecord } from "../cloud-relay/registry.js";
import { WindowCounter } from "../cloud-relay/limits.js";
import type { BillingProvider } from "./billing.js";
import type { CommercialService } from "./service.js";

export class AccountHttp {
  private readonly challenges = new Map<
    string,
    { record: DeviceRecord; action: ManagementAction; clientId: string; expires: number }
  >();
  private readonly rates: WindowCounter;
  constructor(
    private readonly options: {
      accounts: CommercialService;
      billing?: BillingProvider;
      host: string;
      issuer: string;
      keys: SigningKeySource;
      portalClientIds?: readonly string[];
      portalMetadata?: () => Promise<AuthorizationServerMetadata>;
      now: () => number;
      record: (id: string) => Promise<DeviceRecord | undefined>;
      online: (id: string) => boolean;
      revoke: (record: DeviceRecord) => Promise<void>;
      discard: (req: IncomingMessage) => void;
      log: (status: number, code: string) => void;
    },
  ) {
    this.rates = new WindowCounter({ max: 60, windowMs: 60_000 }, options.now, 10_000);
  }
  matches(pathname: string): boolean {
    return (
      [
        "/portal",
        "/portal/callback",
        "/portal.js",
        "/portal.css",
        "/portal/config",
        "/billing/stripe",
        "/.well-known/oauth-protected-resource/account",
      ].includes(pathname) ||
      pathname === "/account" ||
      pathname.startsWith("/account/") ||
      /^\/d\/[a-z2-7]{26}\/(account|clients\/[^/]+\/revoke)$/.test(pathname)
    );
  }
  async handle(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
    if (["/portal", "/portal/callback", "/portal.js", "/portal.css", "/portal/config"].includes(pathname)) {
      this.options.discard(req);
      if (req.method !== "GET") {
        res.writeHead(405).end();
        return true;
      }
      const headers = {
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
        "content-security-policy": `default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self' https:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
      };
      if (pathname === "/portal/config") {
        try {
          const metadata = await this.options.portalMetadata?.();
          const clientId = this.options.portalClientIds?.[0];
          if (!metadata || !metadata.s256 || !clientId) throw new Error("portal unavailable");
          res.writeHead(200, { ...headers, "content-type": "application/json" }).end(
            JSON.stringify({
              issuer: this.options.issuer,
              resource: `https://${this.options.host}/account`,
              clientId,
              authorizationEndpoint: metadata.authorizationEndpoint,
              tokenEndpoint: metadata.tokenEndpoint,
            }),
          );
        } catch {
          res.writeHead(503, headers).end();
        }
        return true;
      }
      res.writeHead(200, {
        ...headers,
        "content-type":
          pathname === "/portal.js"
            ? "text/javascript"
            : pathname === "/portal.css"
              ? "text/css"
              : "text/html; charset=utf-8",
      });
      res.end(pathname === "/portal.js" ? PORTAL_SCRIPT : pathname === "/portal.css" ? PORTAL_CSS : PORTAL_HTML);
      return true;
    }
    const managed = /^\/d\/([a-z2-7]{26})\/(account|clients\/([^/]+)\/revoke)$/.exec(pathname);
    const owner = pathname === "/account" || pathname.startsWith("/account/");
    const webhook = pathname === "/billing/stripe";
    const metadata = pathname === "/.well-known/oauth-protected-resource/account";
    if (!managed && !owner && !webhook && !metadata) return false;
    const reply = (status: number, code: string, body: object = { error: code }) => {
      this.options.discard(req);
      this.options.log(status, code);
      res.writeHead(status, {
        "content-type": "application/json",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        ...(status >= 400 ? { "CROT-Request-Outcome": "not_executed" } : {}),
        ...(status === 429 ? { "Retry-After": "1" } : {}),
      });
      res.end(JSON.stringify(body));
      return true;
    };
    if (this.rates.take(req.socket.remoteAddress ?? "unknown") !== undefined) return reply(429, "rate_limited");
    if (metadata)
      return req.method === "GET"
        ? reply(200, "metadata", {
            resource: `https://${this.options.host}/account`,
            authorization_servers: [this.options.issuer],
            bearer_methods_supported: ["header"],
          })
        : reply(405, "method_not_allowed");
    if (webhook) {
      if (req.method !== "POST") return reply(405, "method_not_allowed");
      if (!this.options.billing) return reply(503, "billing_unavailable");
      const signature = req.headers["stripe-signature"];
      if (typeof signature !== "string") return reply(400, "invalid_webhook");
      const raw = await boundedBody(req, 64 * 1024);
      if (!raw) return reply(400, "invalid_webhook");
      try {
        await this.options.accounts.billing(this.options.billing, raw, signature);
        return reply(200, "accepted", { received: true });
      } catch {
        return reply(400, "webhook_not_applied");
      }
    }
    if (managed) {
      const record = await this.options.record(managed[1]!);
      if (!record || this.options.accounts.isRevoked(record.deviceId)) return reply(404, "unknown_device");
      const action: ManagementAction = managed[2] === "account" ? "account_status" : "revoke_client";
      let clientId = "";
      try {
        clientId = managed[3] ? decodeURIComponent(managed[3]) : "";
      } catch {
        return reply(400, "invalid_client");
      }
      if (action === "revoke_client" && (!clientId || clientId.length > 512 || clientId.includes("\0")))
        return reply(400, "invalid_client");
      for (const [key, c] of this.challenges) if (c.expires <= this.options.now()) this.challenges.delete(key);
      if (req.method === "GET") {
        if (this.challenges.size >= 1024) return reply(503, "busy");
        const challenge = randomBytes(32).toString("base64url");
        this.challenges.set(challenge, { record, action, clientId, expires: this.options.now() + 30_000 });
        return reply(200, "challenge", { challenge });
      }
      if (req.method !== "POST") return reply(405, "method_not_allowed");
      const body = await jsonBody(req);
      if (!body || typeof body.challenge !== "string" || typeof body.proof !== "string")
        return reply(400, "invalid_proof");
      const pending = this.challenges.get(body.challenge);
      this.challenges.delete(body.challenge); // Each challenge admits at most one attempted response.
      if (
        !pending ||
        pending.record !== record ||
        pending.action !== action ||
        pending.clientId !== clientId ||
        pending.expires <= this.options.now() ||
        !verifyManagementProof(
          record.publicKey,
          record.deviceId,
          this.options.host,
          action,
          clientId,
          Buffer.from(body.challenge, "base64url"),
          Buffer.from(body.proof, "base64url"),
        )
      )
        return reply(403, "invalid_proof");
      if ((await this.options.record(record.deviceId)) !== record || this.options.accounts.isRevoked(record.deviceId))
        return reply(404, "unknown_device");
      if (action === "account_status")
        return reply(200, "account_status", {
          ...this.options.accounts.snapshot(record.accountId),
          entitled: this.options.accounts.deviceState(record.accountId, record.deviceId) === "entitled",
        });
      return reply(200, "provider_revocation", {
        provider: await this.options.accounts.revokeProvider(record.accountId, record.deviceId, clientId),
      });
    }
    const authorization = req.headers.authorization;
    const token =
      typeof authorization === "string" && /^Bearer [^ ]+$/.test(authorization) ? authorization.slice(7) : "";
    const checked = await checkAccessToken(token, {
      issuer: this.options.issuer,
      audience: `https://${this.options.host}/account`,
      keys: this.options.keys,
      nowSeconds: this.options.now() / 1000,
    });
    if (!checked.ok) return reply(401, "invalid_owner_token");
    if (!this.options.portalClientIds?.includes(checked.token.clientId)) return reply(403, "portal_client_required");
    const account = checked.token.subject;
    if (pathname === "/account" && req.method === "GET")
      return reply(200, "account", {
        ...this.options.accounts.snapshot(account),
        devices: this.options.accounts.devices(account).map((d) => ({
          deviceId: d.deviceId,
          registeredAt: d.registeredAt,
          revoked: d.revoked,
          clients: d.clients.map((c) => ({ clientId: c.clientId, lastSeen: c.lastSeen })),
          online: !d.revoked && this.options.online(d.deviceId),
        })),
      });
    if (req.method !== "POST") return reply(405, "method_not_allowed");
    if (pathname === "/account/trial") {
      const body = await jsonBody(req);
      if (!body || Object.keys(body).length) return reply(400, "invalid_request");
      return (await this.options.accounts.startTrial(account))
        ? reply(200, "trial_started", this.options.accounts.snapshot(account))
        : reply(409, "trial_unavailable");
    }
    if (pathname === "/account/checkout") {
      const body = await jsonBody(req);
      if (!body || Object.keys(body).join(",") !== "plan" || (body.plan !== "pro" && body.plan !== "team"))
        return reply(400, "invalid_plan");
      if (!this.options.billing) return reply(503, "billing_unavailable");
      try {
        return reply(200, "checkout", { url: await this.options.billing.checkout(account, body.plan) });
      } catch {
        return reply(503, "billing_unavailable");
      }
    }
    const revoke = /^\/account\/devices\/([a-z2-7]{26})\/revoke$/.exec(pathname);
    if (revoke) {
      const body = await jsonBody(req);
      if (!body || Object.keys(body).length) return reply(400, "invalid_request");
      if (!(await this.options.accounts.revoke(account, revoke[1]!))) return reply(404, "unknown_device");
      const record = await this.options.record(revoke[1]!);
      if (record && record.accountId === account) await this.options.revoke(record);
      void this.options.accounts.revokeProvider(account, revoke[1]!);
      return reply(200, "device_revoked", { revoked: true });
    }
    return reply(404, "not_found");
  }
}
async function boundedBody(req: IncomingMessage, max: number): Promise<Buffer | undefined> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0,
      done = false;
    const finish = (value?: Buffer) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      finish();
      req.destroy();
    }, 5000);
    timer.unref();
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > max) {
        chunks.length = 0;
        finish();
        req.destroy();
      } else if (!done) chunks.push(chunk);
    });
    req.once("end", () => finish(Buffer.concat(chunks)));
    req.once("error", () => finish());
    req.once("aborted", () => finish());
  });
}
async function jsonBody(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const raw = await boundedBody(req, 4096);
  if (!raw) return;
  try {
    const body: unknown = JSON.parse(raw.toString("utf8"));
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : undefined;
  } catch {
    return;
  }
}
