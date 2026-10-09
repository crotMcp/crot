/**
 * CROT Cloud Relay v1 (ARCHITECTURE.md §22, §27 AD-15 point 10, AD-21
 * points 5–7, AD-22; WP-29).
 *
 * A router, not a second Core: it admits client requests for
 * `https://<relay-host>/d/<deviceId>/mcp` (token signature, `iss`, `aud` =
 * the device URI, time claims, `sub` = the paired account, entitlement,
 * device online), forwards method, end-to-end headers and body unchanged
 * over the device's tunnel and streams the response back unchanged. It
 * implements no MCP, keeps no session state, never mints or rewrites tokens,
 * never retries, and logs no bodies, tokens, headers or paths. The device
 * repeats every check and is authoritative (AD-15 point 2).
 *
 * Served by the relay itself, never forwarded: the Protected Resource
 * Metadata per registered device (AD-21 point 6), device registration at
 * pairing (AD-22 point 4), the tunnel endpoint (AD-22 points 2–3) and a
 * minimal health check.
 */
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { verifyTunnelProof } from "../identity/device-credential.js";
import { canonicalDeviceUri, isDeviceId, isRelayHost, protectedResourceMetadataUrl } from "../identity/device-id.js";
import type { SigningKeySource } from "../identity/jwks.js";
import { checkAccessToken } from "../identity/verifier.js";
import {
  CloseCode,
  DEFAULT_EXCHANGE_DEADLINE_MS,
  endToEndHeaders,
  INITIAL_CONNECTION_WINDOW,
  INITIAL_STREAM_WINDOW,
  isHopByHop,
  MAX_DATA_PAYLOAD,
  MAX_FRAME_BYTES,
  MAX_JSON_PAYLOAD,
  MAX_REQUEST_BODY_BYTES,
  MAX_RESPONSE_BODY_BYTES,
  offeredMajors,
  OUTCOME_HEADER,
  selectMajor,
  STALL_LIMIT_MS,
  TUNNEL_PATH,
  TUNNEL_SUBPROTOCOL_PREFIX,
  TUNNEL_V1,
  unsupportedVersionReason,
  type HeaderList,
  type RequestOutcome,
} from "../tunnel/protocol.js";
import { acceptWebSocket } from "../tunnel/websocket.js";
import { jsonLineLogger, safeToken, type RelayLogger, type RelayLogRecord } from "./log.js";
import { isDevicePublicKey, type DeviceRecord, type DeviceRegistry } from "./registry.js";
import {
  DEFAULT_TUNNEL_TIMING,
  RelayTunnel,
  REQUEST_QUEUE_LOW_MARK,
  type HandshakeDecision,
  type Hello,
  type StreamEnd,
  type TunnelStream,
  type TunnelTiming,
} from "./tunnel.js";

export const SUPPORTED_MAJORS: readonly string[] = [TUNNEL_V1];
const MCP_PATH = /^\/d\/([a-z2-7]{26})\/mcp$/;
const REGISTER_PATH = /^\/d\/([a-z2-7]{26})\/register$/;
const PRM_PATH = /^\/\.well-known\/oauth-protected-resource\/d\/([a-z2-7]{26})\/mcp$/;
const HEALTH_PATH = "/.crot/health";
const MAX_REGISTER_BODY = 4 * 1024;
const MAX_HEADER_BLOCK = 64 * 1024;
/** Concurrent WebSocket handshakes (before READY) the relay accepts. */
const MAX_PENDING_HANDSHAKES = 256;

export type Entitlement = "entitled" | "not_entitled" | "blocked";

export interface RateLimit {
  readonly max: number;
  readonly windowMs: number;
}

export interface CloudRelayOptions {
  /** The relay host of the canonical device URI (AD-21 point 5). */
  readonly relayHost: string;
  /** The authorization server's issuer (AD-21 point 1). */
  readonly issuer: string;
  /** Identity environment id recorded with registrations. */
  readonly environment: string;
  /** The issuer's signing keys, fetched directly from the issuer (AD-21 point 7). */
  readonly keys: SigningKeySource;
  readonly registry: DeviceRegistry;
  /** Entitlement hook (WP-36); default: every registered device is entitled. */
  readonly entitlement?: (record: DeviceRecord) => Entitlement | Promise<Entitlement>;
  readonly log?: RelayLogger;
  readonly now?: () => number;
  /** Exchange deadline (AD-22 point 12): at least 60 s in a relay configuration (`parseRelayConfig`). */
  readonly exchangeDeadlineMs?: number;
  /** Slow-client limit (AD-22 point 8). */
  readonly stallMs?: number;
  readonly timing?: Partial<TunnelTiming>;
  /** Tunnel handshakes per device (close 4429 beyond). Default 30 per minute. */
  readonly handshakeRate?: RateLimit;
  /** Supersessions per device (close 4409 beyond). Default 10 per hour (AD-22 point 9). */
  readonly supersessionRate?: RateLimit;
}

export interface RelayStatus {
  readonly tunnels: { readonly handshake: number; readonly ready: number; readonly draining: number };
  readonly openStreams: number;
  readonly devicesOnline: number;
}

/** Sliding-window counter per key. */
class WindowCounter {
  private readonly hits = new Map<string, number[]>();
  constructor(
    private readonly limit: RateLimit,
    private readonly now: () => number,
  ) {}
  /** Record a hit unless over the limit; returns the wait in ms when refused. */
  take(key: string): number | undefined {
    const now = this.now();
    if (this.hits.size > 10_000) this.prune(now);
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < this.limit.windowMs);
    if (list.length >= this.limit.max) {
      this.hits.set(key, list);
      return Math.max(1, this.limit.windowMs - (now - list[0]!));
    }
    list.push(now);
    this.hits.set(key, list);
    return undefined;
  }
  /** Forget keys without hits in the window (bounded memory under random device ids). */
  private prune(now: number): void {
    for (const [key, list] of this.hits) if (list.every((t) => now - t >= this.limit.windowMs)) this.hits.delete(key);
  }
  /** Whether a hit would be over the limit (without recording it). */
  full(key: string): boolean {
    const now = this.now();
    return (this.hits.get(key) ?? []).filter((t) => now - t < this.limit.windowMs).length >= this.limit.max;
  }
}

interface Refusal {
  readonly status: number;
  readonly code: string;
  readonly outcome: RequestOutcome;
  readonly message: string;
  readonly headers?: Record<string, string>;
}

const REFUSALS = {
  unknown_device: { status: 404, code: "unknown_device", outcome: "not_executed", message: "Unknown device" },
  not_found: { status: 404, code: "not_found", outcome: "not_executed", message: "Not found" },
  method_not_allowed: {
    status: 405,
    code: "method_not_allowed",
    outcome: "not_executed",
    message: "Method not allowed",
  },
  not_entitled: { status: 403, code: "not_entitled", outcome: "not_executed", message: "The device is not entitled" },
  device_offline: {
    status: 503,
    code: "device_offline",
    outcome: "not_executed",
    message: "The device is offline or remote mode is off",
  },
  busy: {
    status: 503,
    code: "busy",
    outcome: "not_executed",
    message: "The device is busy",
    headers: { "retry-after": "1" },
  },
  refused: {
    status: 503,
    code: "refused",
    outcome: "not_executed",
    message: "The device refused the request before processing it",
    headers: { "retry-after": "1" },
  },
  request_too_large: {
    status: 413,
    code: "request_too_large",
    outcome: "not_executed",
    message: "The request body exceeds the relay limit",
  },
  headers_too_large: {
    status: 431,
    code: "headers_too_large",
    outcome: "not_executed",
    message: "The request headers exceed the relay limit",
  },
  bad_request: { status: 400, code: "bad_request", outcome: "not_executed", message: "Bad request" },
  tunnel_lost: {
    status: 502,
    code: "tunnel_lost",
    outcome: "unknown",
    message: "The connection to the device was lost; the request may or may not have been executed",
  },
  device_reset: {
    status: 502,
    code: "device_reset",
    outcome: "unknown",
    message: "The device ended the request; it may or may not have been executed",
  },
  deadline_exceeded: {
    status: 504,
    code: "deadline_exceeded",
    outcome: "unknown",
    message: "The request exceeded the relay deadline; it may or may not have been executed",
  },
} as const satisfies Record<string, Refusal>;

function writeRefusal(res: ServerResponse, refusal: Refusal, extra: Record<string, string> = {}): void {
  if (res.headersSent || res.destroyed) {
    res.destroy();
    return;
  }
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: null,
    error: { code: -32000, message: refusal.message, data: { crot: refusal.code, outcome: refusal.outcome } },
  });
  res.writeHead(refusal.status, {
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(body)),
    "cache-control": "no-store",
    [OUTCOME_HEADER]: refusal.outcome,
    ...refusal.headers,
    ...extra,
  });
  res.end(body);
}

function bearerToken(req: IncomingMessage): string | undefined | null {
  const values: string[] = [];
  for (let i = 0; i + 1 < req.rawHeaders.length; i += 2)
    if (req.rawHeaders[i]!.toLowerCase() === "authorization") values.push(req.rawHeaders[i + 1]!);
  if (values.length === 0) return undefined;
  if (values.length > 1) return null;
  const m = /^Bearer ([A-Za-z0-9\-._~+/]+=*)$/.exec(values[0]!);
  return m ? m[1]! : null;
}

export class CloudRelay {
  private readonly log: RelayLogger;
  private readonly now: () => number;
  private readonly timing: TunnelTiming;
  private readonly deadlineMs: number;
  private readonly stallMs: number;
  private readonly handshakes: WindowCounter;
  private readonly supersessions: WindowCounter;
  /** The routable tunnel per device. */
  private readonly routes = new Map<string, RelayTunnel>();
  private readonly tunnels = new Set<RelayTunnel>();
  private server: Server | undefined;
  private closing = false;

  constructor(private readonly options: CloudRelayOptions) {
    if (!isRelayHost(options.relayHost)) throw new Error("relayHost must be a lowercase DNS name");
    this.log = options.log ?? jsonLineLogger();
    this.now = options.now ?? Date.now;
    this.timing = { ...DEFAULT_TUNNEL_TIMING, ...options.timing };
    this.deadlineMs = options.exchangeDeadlineMs ?? DEFAULT_EXCHANGE_DEADLINE_MS;
    this.stallMs = options.stallMs ?? STALL_LIMIT_MS;
    this.handshakes = new WindowCounter(options.handshakeRate ?? { max: 30, windowMs: 60_000 }, this.now);
    this.supersessions = new WindowCounter(options.supersessionRate ?? { max: 10, windowMs: 3_600_000 }, this.now);
  }

  /** Listen (HTTPS when `tls` is given; plain HTTP behind a TLS-terminating load balancer otherwise). */
  async listen(options: {
    readonly port: number;
    readonly host?: string;
    readonly tls?: { readonly cert: string | Buffer; readonly key: string | Buffer };
  }): Promise<void> {
    const handler = (req: IncomingMessage, res: ServerResponse) => this.handle(req, res);
    const serverOptions = { maxHeaderSize: MAX_HEADER_BLOCK };
    const server = options.tls
      ? createHttpsServer(
          { ...serverOptions, cert: options.tls.cert, key: options.tls.key, minVersion: "TLSv1.2" },
          handler,
        )
      : createHttpServer(serverOptions, handler);
    // An approval wait sends no bytes: no idle or request timeout below the exchange deadline (AD-22 point 12).
    server.requestTimeout = 0;
    server.headersTimeout = 60_000;
    server.timeout = 0;
    server.keepAliveTimeout = 5_000;
    server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => this.upgrade(req, socket, head));
    server.on("clientError", (_error, socket: Duplex) => {
      if (!socket.destroyed) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port, options.host ?? "0.0.0.0", () => {
        server.off("error", reject);
        resolve();
      });
    });
    this.server = server;
    this.log({ event: "relay.listening", count: (server.address() as AddressInfo).port });
  }

  get port(): number {
    return (this.server?.address() as AddressInfo | undefined)?.port ?? 0;
  }

  status(): RelayStatus {
    const tunnels = { handshake: 0, ready: 0, draining: 0 };
    let openStreams = 0;
    for (const t of this.tunnels) {
      const phase = t.phase;
      if (phase !== "closed") tunnels[phase]++;
      openStreams += t.openStreams;
    }
    return { tunnels, openStreams, devicesOnline: this.routes.size };
  }

  /** Whether a device has a routable tunnel. */
  isOnline(deviceId: string): boolean {
    return this.routes.get(deviceId)?.routable === true;
  }

  /** GOAWAY `shutting_down` to every tunnel, drain up to the drain limit, then stop. */
  async close(): Promise<void> {
    this.closing = true;
    const server = this.server;
    server?.close();
    for (const t of [...this.tunnels]) t.goAway("shutting_down");
    const deadline = this.now() + this.timing.drainMs + 1_000;
    while (this.tunnels.size > 0 && this.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    for (const t of [...this.tunnels]) t.terminate(CloseCode.GOING_AWAY, "shutting_down");
    server?.closeAllConnections();
    this.log({ event: "relay.closed" });
  }

  // ---- HTTP ------------------------------------------------------------------

  private handle(req: IncomingMessage, res: ServerResponse): void {
    this.route(req, res).catch(() => {
      this.log({ event: "relay.internal_error" });
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json", [OUTCOME_HEADER]: "unknown" });
        res.end('{"jsonrpc":"2.0","id":null,"error":{"code":-32603,"message":"Internal relay error"}}');
      } else res.destroy();
    });
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const target = req.url ?? "";
    const q = target.indexOf("?");
    const pathname = q === -1 ? target : target.slice(0, q);
    let m: RegExpExecArray | null;
    if ((m = MCP_PATH.exec(pathname))) return this.exchange(req, res, m[1]!);
    if ((m = PRM_PATH.exec(pathname))) return this.metadata(req, res, m[1]!);
    if ((m = REGISTER_PATH.exec(pathname))) return this.register(req, res, m[1]!);
    req.resume();
    if (pathname === HEALTH_PATH && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ status: this.closing ? "shutting_down" : "ok" }));
      return;
    }
    writeRefusal(res, REFUSALS.not_found);
  }

  private async record(deviceId: string): Promise<DeviceRecord | undefined> {
    return isDeviceId(deviceId) ? this.options.registry.get(deviceId) : undefined;
  }

  /** PRM (AD-21 point 6): only for registered devices. */
  private async metadata(req: IncomingMessage, res: ServerResponse, deviceId: string): Promise<void> {
    req.resume();
    if (req.method !== "GET") return writeRefusal(res, REFUSALS.method_not_allowed, { allow: "GET" });
    if (!(await this.record(deviceId))) return writeRefusal(res, REFUSALS.not_found);
    const body = JSON.stringify({
      resource: canonicalDeviceUri(this.options.relayHost, deviceId),
      authorization_servers: [this.options.issuer],
      bearer_methods_supported: ["header"],
      scopes_supported: ["offline_access"],
    });
    res.writeHead(200, { "content-type": "application/json", "cache-control": "max-age=300" });
    res.end(body);
  }

  private unauthorized(res: ServerResponse, deviceId: string, presented: boolean): void {
    const prm = protectedResourceMetadataUrl(this.options.relayHost, deviceId);
    const challenge = presented
      ? `Bearer resource_metadata="${prm}", error="invalid_token"`
      : `Bearer resource_metadata="${prm}"`;
    writeRefusal(
      res,
      { status: 401, code: "unauthorized", outcome: "not_executed", message: "Unauthorized" },
      { "www-authenticate": challenge },
    );
  }

  /** Verify a client token for a device URI (AD-21 point 7); the reason code only is logged. */
  private async checkToken(token: string, deviceId: string, account: string | undefined, event: string) {
    const checked = await checkAccessToken(token, {
      issuer: this.options.issuer,
      audience: canonicalDeviceUri(this.options.relayHost, deviceId),
      ...(account !== undefined ? { account } : {}),
      keys: this.options.keys,
      nowSeconds: this.now() / 1000,
    });
    if (!checked.ok) this.log({ event, deviceId, code: checked.reason });
    return checked;
  }

  private async entitled(record: DeviceRecord): Promise<Entitlement> {
    return this.options.entitlement ? this.options.entitlement(record) : "entitled";
  }

  /** Device registration at pairing (AD-22 point 4). */
  private async register(req: IncomingMessage, res: ServerResponse, deviceId: string): Promise<void> {
    if (req.method !== "POST") {
      req.resume();
      return writeRefusal(res, REFUSALS.method_not_allowed, { allow: "POST" });
    }
    const respond = (status: number, code: string, body: object = {}) => {
      this.log({ event: "device.register", deviceId, status, code });
      const text = JSON.stringify(body);
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(text);
    };
    const token = bearerToken(req);
    if (!token || !isDeviceId(deviceId)) {
      req.resume();
      this.log({
        event: "device.register",
        deviceId,
        status: 401,
        code: token === undefined ? "no_token" : "malformed",
      });
      return this.unauthorized(res, deviceId, token !== undefined);
    }
    const body = await readBody(req, MAX_REGISTER_BODY);
    if (body === "too_large") return respond(413, "too_large", { error: "request_too_large" });
    if (body === "aborted") return;
    const checked = await this.checkToken(token, deviceId, undefined, "device.register_token_refused");
    if (!checked.ok) return this.unauthorized(res, deviceId, true);
    let publicKey: unknown;
    try {
      publicKey = (JSON.parse(body.toString("utf8")) as { publicKey?: unknown }).publicKey;
    } catch {
      return respond(400, "invalid_body", { error: "invalid_request" });
    }
    if (!isDevicePublicKey(publicKey)) return respond(400, "invalid_key", { error: "invalid_public_key" });
    const record: DeviceRecord = {
      deviceId,
      accountId: checked.token.subject,
      publicKey: { kty: publicKey.kty, crv: publicKey.crv, x: publicKey.x },
      environment: this.options.environment,
      registeredAt: new Date(this.now()).toISOString(),
    };
    const result = await this.options.registry.register(record);
    if (result === "conflict") return respond(409, "conflict", { error: "already_registered" });
    const stored = (await this.options.registry.get(deviceId))!;
    return respond(result === "created" ? 201 : 200, result, { deviceId, registeredAt: stored.registeredAt });
  }

  // ---- forwarding ------------------------------------------------------------

  private async exchange(req: IncomingMessage, res: ServerResponse, deviceId: string): Promise<void> {
    const started = this.now();
    const method = req.method ?? "";
    const mcpMethod = typeof req.headers["mcp-method"] === "string" ? safeToken(req.headers["mcp-method"]) : undefined;
    const summary: Summary = {
      event: "exchange",
      deviceId,
      method: safeToken(method),
      ...(mcpMethod ? { mcpMethod } : {}),
    };
    const refuse = (refusal: Refusal, extra?: Record<string, string>) => {
      req.resume();
      writeRefusal(res, refusal, extra);
      this.log({
        ...summary,
        status: refusal.status,
        outcome: refusal.outcome,
        code: refusal.code,
        durationMs: this.now() - started,
      });
    };
    const record = await this.record(deviceId);
    if (!record) return refuse(REFUSALS.unknown_device);
    if (method !== "POST" && method !== "GET" && method !== "DELETE")
      return refuse(REFUSALS.method_not_allowed, { allow: "GET, POST, DELETE" });
    const token = bearerToken(req);
    if (!token) {
      req.resume();
      this.log({
        ...summary,
        status: 401,
        outcome: "not_executed",
        code: token === undefined ? "no_token" : "malformed",
      });
      return this.unauthorized(res, deviceId, token !== undefined);
    }
    const checked = await this.checkToken(token, deviceId, record.accountId, "admission.refused");
    if (!checked.ok) {
      req.resume();
      this.log({ ...summary, status: 401, outcome: "not_executed", code: "invalid_token" });
      return this.unauthorized(res, deviceId, true);
    }
    if ((await this.entitled(record)) !== "entitled") return refuse(REFUSALS.not_entitled);
    const admittedAt = this.now();
    const declared = req.headers["content-length"];
    const length = declared === undefined ? undefined : Number(declared);
    if (length !== undefined && (!Number.isSafeInteger(length) || length < 0)) return refuse(REFUSALS.bad_request);
    if (length !== undefined && length > MAX_REQUEST_BODY_BYTES) return refuse(REFUSALS.request_too_large);
    const headers = endToEndHeaders(req.rawHeaders);
    // A body without a length is read completely first, so the size limit is enforced before forwarding.
    let buffered: Buffer | undefined;
    if (length === undefined && req.headers["transfer-encoding"] !== undefined) {
      const body = await readBody(req, MAX_REQUEST_BODY_BYTES);
      if (body === "aborted") return;
      if (body === "too_large") return refuse(REFUSALS.request_too_large);
      buffered = body;
    }
    const noBody = buffered ? buffered.length === 0 : !length;
    const tunnel = this.routes.get(deviceId);
    if (!tunnel || !tunnel.routable) return refuse(REFUSALS.device_offline);
    const ex = new Exchange(res, summary, started, this.log, this.now, this.stallMs);
    const opened = tunnel.open(
      { method, path: req.url ?? "", headers, deadlineMs: this.deadlineMs - (this.now() - admittedAt) },
      noBody,
      ex,
    );
    if (!opened.ok)
      return refuse(
        opened.reason === "busy"
          ? REFUSALS.busy
          : opened.reason === "headers_too_large"
            ? REFUSALS.headers_too_large
            : REFUSALS.device_offline,
      );
    ex.attach(opened.stream, tunnel.tunnelId, this.deadlineMs - (this.now() - admittedAt));
    if (buffered) {
      for (let i = 0; i < buffered.length; i += MAX_DATA_PAYLOAD)
        opened.stream.write(buffered.subarray(i, i + MAX_DATA_PAYLOAD));
      if (!noBody) opened.stream.end();
      ex.requestBytes = buffered.length;
    } else if (!noBody) ex.pipeRequest(req);
    else req.resume();
  }

  // ---- tunnel ----------------------------------------------------------------

  private upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const target = req.url ?? "";
    if (target !== TUNNEL_PATH || this.closing) {
      socket.end(
        `HTTP/1.1 ${this.closing ? "503 Service Unavailable" : "404 Not Found"}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
      );
      return;
    }
    if (this.status().tunnels.handshake >= MAX_PENDING_HANDSHAKES) {
      socket.end(
        "HTTP/1.1 503 Service Unavailable\r\nRetry-After: 5\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
      );
      return;
    }
    const header = req.headers["sec-websocket-protocol"];
    const offered = offeredMajors(typeof header === "string" ? header : undefined);
    const major = selectMajor(offered, SUPPORTED_MAJORS);
    // Without a common major the relay still echoes the device's highest offered `crot-tunnel.v<N>`:
    // standard clients (WHATWG WebSocket, Node's built-in client) fail an upgrade that answers no
    // requested subprotocol before they could read the 4426 close. No frame is sent on it.
    const echoed = major ?? selectMajor(offered, offered);
    const ws = acceptWebSocket(req, socket, head, {
      ...(echoed ? { protocol: TUNNEL_SUBPROTOCOL_PREFIX + echoed } : {}),
      maxMessageBytes: MAX_FRAME_BYTES,
    });
    if (!ws) return;
    if (!major) {
      // A WebSocket client cannot read the body of a refused upgrade: accept, then close 4426 (AD-22 point 10).
      this.log({ event: "tunnel.refused", closeCode: CloseCode.UNSUPPORTED_VERSION, code: "unsupported_version" });
      ws.attach({ onMessage: () => undefined, onClose: () => undefined });
      ws.close(CloseCode.UNSUPPORTED_VERSION, unsupportedVersionReason(SUPPORTED_MAJORS));
      return;
    }
    const tunnel = new RelayTunnel(ws, {
      relayHost: this.options.relayHost,
      versions: SUPPORTED_MAJORS,
      limits: {
        frameBytes: MAX_DATA_PAYLOAD,
        jsonBytes: MAX_JSON_PAYLOAD,
        requestBodyBytes: MAX_REQUEST_BODY_BYTES,
        responseBodyBytes: MAX_RESPONSE_BODY_BYTES,
        connectionWindow: INITIAL_CONNECTION_WINDOW,
        streamWindow: INITIAL_STREAM_WINDOW,
        exchangeDeadlineMs: this.deadlineMs,
      },
      timing: this.timing,
      log: this.log,
      now: this.now,
      authenticate: (hello, challenge, t) => this.authenticate(hello, challenge, t),
      onReady: (t) => this.onReady(t),
      onUnroutable: (t) => {
        if (t.deviceId && this.routes.get(t.deviceId) === t) this.routes.delete(t.deviceId);
      },
      onClosed: (t) => {
        this.tunnels.delete(t);
        if (t.deviceId && this.routes.get(t.deviceId) === t) this.routes.delete(t.deviceId);
      },
    });
    this.tunnels.add(tunnel);
  }

  private async authenticate(hello: Hello, challenge: Buffer, _tunnel: RelayTunnel): Promise<HandshakeDecision> {
    const refuse = (closeCode: number, reason: string): HandshakeDecision => ({ ok: false, closeCode, reason });
    if (!isDeviceId(hello.deviceId)) return refuse(CloseCode.UNAUTHORIZED, "unauthorized");
    const wait = this.handshakes.take(hello.deviceId);
    if (wait !== undefined) return refuse(CloseCode.RATE_LIMITED, `rate_limited;retryAfterMs=${wait}`);
    const record = await this.options.registry.get(hello.deviceId);
    if (!record || !verifyTunnelProof(record.publicKey, hello.deviceId, this.options.relayHost, challenge, hello.proof))
      return refuse(CloseCode.UNAUTHORIZED, "unauthorized");
    if ((await this.entitled(record)) !== "entitled") return refuse(CloseCode.FORBIDDEN, "forbidden");
    if (this.closing) return refuse(CloseCode.GOING_AWAY, "shutting_down");
    const current = this.routes.get(hello.deviceId);
    if (current && current.routable && this.supersessions.full(hello.deviceId)) {
      this.log({ event: "tunnel.supersession_limit", deviceId: hello.deviceId });
      return refuse(CloseCode.SUPERSEDED_TOO_OFTEN, "superseded_too_often");
    }
    return { ok: true, features: [] };
  }

  private onReady(tunnel: RelayTunnel): void {
    const deviceId = tunnel.deviceId!;
    const previous = this.routes.get(deviceId);
    this.routes.set(deviceId, tunnel);
    if (previous && previous !== tunnel) {
      this.supersessions.take(deviceId);
      this.log({ event: "tunnel.superseded", deviceId, tunnelId: previous.tunnelId });
      previous.goAway("superseded");
    }
  }
}

type Summary = { -readonly [K in keyof RelayLogRecord]: RelayLogRecord[K] };

/** Read a whole body up to `max` bytes. */
function readBody(req: IncomingMessage, max: number): Promise<Buffer | "too_large" | "aborted"> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on("data", (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > max) {
        done = true;
        req.resume();
        resolve("too_large");
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!done) {
        done = true;
        resolve(Buffer.concat(chunks));
      }
    });
    req.on("close", () => {
      if (!done) {
        done = true;
        resolve("aborted");
      }
    });
  });
}

/**
 * One client exchange over one tunnel stream: writes the device's response
 * as received, returns flow-control credit as bytes reach the client, and
 * reports the outcome when the exchange does not complete (AD-22 point 13).
 * It never retries.
 */
class Exchange {
  private stream: TunnelStream | undefined;
  private tunnelId: string | undefined;
  private headSent = false;
  private finished = false;
  private requestEnded = false;
  private responseBytes = 0;
  requestBytes = 0;
  private deadline: NodeJS.Timeout | undefined;
  private stall: NodeJS.Timeout | undefined;
  private pendingCredit: (() => void)[] = [];
  private paused: IncomingMessage | undefined;

  constructor(
    private readonly res: ServerResponse,
    private readonly summary: Summary,
    private readonly started: number,
    private readonly log: RelayLogger,
    private readonly now: () => number,
    private readonly stallMs: number,
  ) {
    res.on("close", () => {
      if (this.finished) return;
      // The client went away before the response completed: cancel on the device (AD-22 point 13).
      this.stream?.reset("cancel");
      this.done(undefined, "unknown", "client_closed");
    });
    res.on("drain", () => {
      clearTimeout(this.stall);
      this.stall = undefined;
      for (const credit of this.pendingCredit.splice(0)) credit();
    });
  }

  attach(stream: TunnelStream, tunnelId: string, deadlineMs: number): void {
    this.stream = stream;
    this.tunnelId = tunnelId;
    this.deadline = setTimeout(() => this.onDeadline(), Math.max(1, deadlineMs));
    this.deadline.unref();
  }

  pipeRequest(req: IncomingMessage): void {
    req.on("data", (chunk: Buffer) => {
      if (this.finished || !this.stream) return;
      this.requestBytes += chunk.length;
      for (let i = 0; i < chunk.length; i += MAX_DATA_PAYLOAD)
        this.stream.write(chunk.subarray(i, i + MAX_DATA_PAYLOAD));
      if (this.stream.queuedBytes >= REQUEST_QUEUE_LOW_MARK) {
        req.pause();
        this.paused = req;
      }
    });
    req.on("end", () => {
      this.requestEnded = true;
      if (!this.finished) this.stream?.end();
    });
  }

  onWritable(): void {
    const req = this.paused;
    this.paused = undefined;
    req?.resume();
  }

  onResponse(status: number, headers: HeaderList): void {
    if (this.finished) return;
    const flat: string[] = [];
    for (const [name, value] of headers) if (!isHopByHop(name)) flat.push(name, value);
    try {
      this.res.writeHead(status, flat);
      this.res.flushHeaders();
    } catch {
      this.stream?.reset("protocol_error");
      this.fail(REFUSALS.device_reset, "invalid_response_head");
      return;
    }
    this.headSent = true;
    this.summary.status = status;
  }

  onData(chunk: Buffer, credit: () => void): void {
    if (this.finished) return credit();
    this.responseBytes += chunk.length;
    if (this.responseBytes > MAX_RESPONSE_BODY_BYTES) {
      this.stream?.reset("response_too_large");
      this.fail(REFUSALS.device_reset, "response_too_large");
      return;
    }
    let flushed: boolean;
    try {
      flushed = this.res.write(chunk);
    } catch {
      // e.g. more bytes than the device's own Content-Length: this stream only, never the tunnel.
      this.stream?.reset("protocol_error");
      this.fail(REFUSALS.device_reset, "invalid_response_body");
      return;
    }
    if (flushed) credit();
    else {
      this.pendingCredit.push(credit);
      if (!this.stall) {
        this.stall = setTimeout(() => {
          this.stream?.reset("client_stalled");
          this.fail(REFUSALS.device_reset, "client_stalled");
        }, this.stallMs);
        this.stall.unref();
      }
    }
  }

  onEnd(): void {
    if (this.finished) return;
    try {
      this.res.end();
    } catch {
      this.res.destroy();
    }
    // The response is complete; a request body still being sent is no longer needed.
    if (!this.requestEnded && this.paused) this.paused.resume();
    this.done(this.summary.status, undefined, "complete");
  }

  onAbort(reason: StreamEnd): void {
    if (this.finished) return;
    const refusal =
      reason === "refused" || reason === "not_processed"
        ? REFUSALS.refused
        : reason === "deadline_exceeded"
          ? REFUSALS.deadline_exceeded
          : reason === "tunnel_lost"
            ? REFUSALS.tunnel_lost
            : REFUSALS.device_reset;
    this.fail(refusal, reason);
  }

  private onDeadline(): void {
    if (this.finished) return;
    this.stream?.reset("deadline_exceeded");
    this.fail(REFUSALS.deadline_exceeded, "deadline_exceeded");
  }

  /** End the exchange without a complete response: an explicit outcome before the head, an aborted stream after. */
  private fail(refusal: Refusal, code: string): void {
    if (this.finished) return;
    if (!this.headSent) {
      writeRefusal(this.res, refusal);
      this.done(refusal.status, refusal.outcome, code);
    } else {
      this.done(this.summary.status, "unknown", code);
      this.res.destroy();
    }
    this.paused?.resume();
  }

  private done(status: number | undefined, outcome: RequestOutcome | undefined, code: string): void {
    if (this.finished) return;
    this.finished = true;
    clearTimeout(this.deadline);
    clearTimeout(this.stall);
    this.pendingCredit = [];
    this.log({
      ...this.summary,
      tunnelId: this.tunnelId,
      ...(status !== undefined ? { status } : {}),
      ...(outcome ? { outcome } : {}),
      code,
      requestBytes: this.requestBytes,
      responseBytes: this.responseBytes,
      durationMs: this.now() - this.started,
    });
  }
}
