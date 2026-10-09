import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isIP, type AddressInfo } from "node:net";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import {
  createMcpHandler,
  isLegacyRequest,
  PROTOCOL_VERSION_META_KEY,
  type McpHttpHandler,
} from "@modelcontextprotocol/server";
import type { Principal } from "../../core/auth/principal.js";
import type { HttpConfig } from "../../core/config/schema.js";
import type { CrotCore } from "../../core/crot-core.js";
import { CrotError } from "../../core/errors.js";
import { createCrotModernMcpServer, MODERN_PROTOCOL_VERSIONS } from "../mcp/modern.js";
import { createCrotMcpServer } from "../mcp/server.js";
import type { AccessTokenVerifier } from "./auth.js";
import {
  exposureScopeFor,
  httpContextResolver,
  LocalPrincipalScopes,
  principalFromAuthInfo,
  sessionOwnerKey,
  type HttpEntryPoint,
} from "./context.js";

/** The only path served. */
export const MCP_HTTP_PATH = "/mcp";

/** Session-based protocol versions served for compatibility (AD-15 point 3). */
export const LEGACY_PROTOCOL_VERSIONS: readonly string[] = Object.freeze(["2025-11-25", "2025-06-18"]);

/**
 * Every protocol version served on the endpoint (AD-15 point 3). Requests that
 * name another version, and session requests that name none (versions before
 * 2025-06-18), are rejected with UnsupportedProtocolVersion.
 */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = Object.freeze([
  ...MODERN_PROTOCOL_VERSIONS,
  ...LEGACY_PROTOCOL_VERSIONS,
]);

/** JSON-RPC error code of an unsupported protocol version (MCP 2026-07-28). */
export const UNSUPPORTED_PROTOCOL_VERSION_CODE = -32022;

export type CrotHttpServerConfig = Pick<
  HttpConfig,
  "host" | "port" | "allowedOrigins" | "maxRequestBytes" | "maxSessions" | "sessionIdleTimeoutMs"
> &
  Partial<Pick<HttpConfig, "maxConcurrentRequests">>;

/** Default of http.maxConcurrentRequests when a caller passes no value. */
export const DEFAULT_MAX_CONCURRENT_REQUESTS = 32;

/** Load of the sessionless (2026-07-28) path, reported in crot_status (WP-20). */
export interface SessionlessLoad {
  readonly inFlight: number;
  readonly limit: number;
  /** Requests rejected because the limit was reached, since start. */
  readonly rejected: number;
}

export interface CrotHttpServerOptions {
  readonly config: CrotHttpServerConfig;
  /** Authenticates every request before it reaches the MCP server or Core. */
  readonly verifier: AccessTokenVerifier;
  /** Operator diagnostics (stderr in the CLI). Never receives credentials, bodies or results. */
  readonly log?: (message: string) => void;
  /**
   * Entry point served (AD-15 points 1 and 6); decides the principal kind.
   * Default `loopback` (the local token, `kind: "local"`). `relay` is the
   * pipeline of the relay tunnel (WP-30): it accepts only verifiers that
   * establish a remote principal (account, device, client) and never the
   * local token. Not configurable through the configuration file.
   */
  readonly entryPoint?: HttpEntryPoint;
  /**
   * Device-side admission of remote principals (AD-15 points 4 and 9, AD-19
   * points 6 and 8): remote mode and client revocation, checked for every
   * request of the relay entry point before any MCP or Core work. Required
   * for the relay entry point (fail closed); ignored on loopback.
   */
  readonly remoteAdmission?: RemoteAdmission;
  /**
   * Relay entry point: the Protected Resource Metadata URL of this device
   * (AD-21 point 6), built from the device's own canonical URI. Every 401 then
   * carries `WWW-Authenticate: Bearer resource_metadata="<url>"` (with
   * `error="invalid_token"` when a token was presented). Undefined while the
   * device is not paired. Ignored on loopback.
   */
  readonly resourceMetadataUrl?: () => string | undefined;
}

/** The remote client of a request: its exposure scope (AD-15 point 8). */
export interface RemoteClientKey {
  readonly accountId: string;
  readonly deviceId: string;
  readonly clientId: string;
}

export type RemoteAdmissionRefusal =
  "remote_mode_off" | "client_revoked" | "state_unavailable" | "invalid_client" | "not_paired" | "token_predates_grant";

/** Verified token facts the admission may use (set by the verifier, AuthInfo.extra). */
export interface RemoteTokenFacts {
  /** `iat` of the access token (seconds since the epoch). */
  readonly issuedAt?: number;
}

export type RemoteAdmissionDecision =
  { readonly admitted: true } | { readonly admitted: false; readonly reason: RemoteAdmissionRefusal };

/**
 * Admission of remote requests on this device (implemented by the service).
 * It authorizes nothing: an admitted request still passes the
 * PermissionEngine, the approval gates and the ExecutionGuard.
 */
export interface RemoteAdmission {
  admit(client: RemoteClientKey, token?: RemoteTokenFacts): RemoteAdmissionDecision;
}

const ADMISSION_MESSAGES: Readonly<Record<RemoteAdmissionRefusal, string>> = {
  remote_mode_off: "Forbidden: remote access is turned off on this device",
  client_revoked: "Forbidden: this client's access to the device was revoked",
  state_unavailable: "Forbidden: the device cannot read its remote access state",
  invalid_client: "Forbidden: the client identifiers are not accepted by this device",
  not_paired: "Forbidden: this device is not paired with the token's account",
  token_predates_grant: "Unauthorized",
};

/** Refusals answered as an invalid token (401): the client gets a new token and retries. */
const ADMISSION_INVALID_TOKEN: ReadonlySet<RemoteAdmissionRefusal> = new Set(["token_predates_grant"]);

function remoteKeyOf(client: RemoteClientKey): string {
  return JSON.stringify([client.accountId, client.deviceId, client.clientId]);
}

/** Whether `host` is a loopback address or name. */
export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[(.*)\]$/, "$1");
  if (h === "localhost") return true;
  const version = isIP(h);
  if (version === 4) return h.startsWith("127.");
  if (version === 6) return h === "::1" || h === "0:0:0:0:0:0:0:1";
  return false;
}

interface Session {
  readonly id: string;
  readonly transport: StreamableHTTPServerTransport;
  readonly server: McpServer;
  /** Identity key of the principal that opened the session (sessionOwnerKey). */
  readonly owner: string;
  /** Remote client of a relay session (remoteKeyOf); ended by endRemoteClient(). */
  readonly remote?: string;
  lastSeen: number;
}

type Rejection = {
  status: number;
  code: number;
  message: string;
  headers?: Record<string, string>;
  data?: Record<string, unknown>;
};

function sendError(res: ServerResponse, rejection: Rejection): void {
  res.writeHead(rejection.status, { "Content-Type": "application/json", ...(rejection.headers ?? {}) });
  const error = {
    code: rejection.code,
    message: rejection.message,
    ...(rejection.data ? { data: rejection.data } : {}),
  };
  res.end(JSON.stringify({ jsonrpc: "2.0", error, id: null }));
}

/** UnsupportedProtocolVersion (400, -32022) naming the supported versions and, when known, the requested one. */
function unsupportedVersion(requested: string | undefined): Rejection {
  return {
    status: 400,
    code: UNSUPPORTED_PROTOCOL_VERSION_CODE,
    message:
      requested === undefined
        ? "Unsupported protocol version: the request did not name a protocol version"
        : `Unsupported protocol version: ${requested}`,
    data: { supported: [...SUPPORTED_PROTOCOL_VERSIONS], ...(requested !== undefined ? { requested } : {}) },
  };
}

const METHOD_NOT_ALLOWED_SESSIONLESS: Rejection = {
  status: 405,
  code: -32000,
  message: "Method not allowed",
  headers: { Allow: "POST" },
};

/** The single value of a request header, undefined when absent or repeated. */
function headerValue(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return typeof value === "string" ? value : undefined;
}

/** The protocol version a request body claims in its `_meta` envelope (2026-07-28), if any. */
function envelopeVersion(body: unknown): unknown {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
  const params = (body as { params?: unknown }).params;
  if (typeof params !== "object" || params === null) return undefined;
  const meta = (params as { _meta?: unknown })._meta;
  if (typeof meta !== "object" || meta === null) return undefined;
  return (meta as Record<string, unknown>)[PROTOCOL_VERSION_META_KEY];
}

/** The protocolVersion a legacy initialize request asks for. */
function initializeVersion(body: unknown): unknown {
  return (body as { params?: { protocolVersion?: unknown } }).params?.protocolVersion;
}

/** A web-standard Request with the same method, URL and headers, for the MCP SDK v2 handler. */
function toWebRequest(req: IncomingMessage, raw: Buffer, signal: AbortSignal): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  const url = new URL(req.url ?? MCP_HTTP_PATH, `http://${req.headers.host ?? "localhost"}`);
  return new Request(url, { method: "POST", headers, body: new Uint8Array(raw), signal });
}

/** Stream a web-standard Response (a JSON body or an SSE stream scoped to the request) to the client. */
async function sendWebResponse(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    headers[name] = value;
  });
  res.writeHead(response.status, headers);
  if (!response.body) {
    res.end();
    return;
  }
  const reader = response.body.getReader();
  const cancel = () => void reader.cancel().catch(() => undefined);
  res.once("close", cancel);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(value)) {
        await new Promise<void>((resolve) => {
          res.once("drain", resolve);
          res.once("close", resolve);
        });
        if (res.destroyed) return;
      }
    }
    res.end();
  } catch {
    res.destroy();
  } finally {
    res.off("close", cancel);
  }
}

/** Read a request body up to `limit` bytes; undefined when it is larger. */
function readBody(req: IncomingMessage, limit: number): Promise<Buffer | undefined> {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > limit) return Promise.resolve(undefined);
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on("data", (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > limit) {
        done = true;
        req.pause();
        resolve(undefined);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks));
    });
    req.on("error", (error) => {
      if (done) return;
      done = true;
      reject(error);
    });
  });
}

const withAuth = (req: IncomingMessage, auth: AuthInfo): IncomingMessage & { auth: AuthInfo } =>
  Object.assign(req, { auth });

const UNAUTHORIZED: Rejection = {
  status: 401,
  code: -32001,
  message: "Unauthorized",
  headers: { "WWW-Authenticate": 'Bearer realm="crot"' },
};
const INVALID_TOKEN: Rejection = {
  status: 401,
  code: -32001,
  message: "Unauthorized",
  headers: { "WWW-Authenticate": 'Bearer realm="crot", error="invalid_token"' },
};

/**
 * CROT MCP over Streamable HTTP (loopback only).
 *
 * A transport adapter bound to one CrotCore, so HTTP requests use exactly the
 * Core services, PermissionEngine, ExecutionGuard and audit path of stdio.
 * One endpoint serves both protocol eras (ARCHITECTURE.md §27, AD-15 C3),
 * distinguished by the protocol version as the specification's
 * backward-compatibility rules describe:
 *
 * - 2026-07-28, sessionless: every request is processed from the request
 *   itself — no `initialize`, no `Mcp-Session-Id` (ignored), GET and DELETE
 *   answer 405, `server/discover` is served. One MCP server instance
 *   (MCP SDK v2) per request; header–body validation (`MCP-Protocol-Version`,
 *   `Mcp-Method`, `Mcp-Name`) happens before dispatch.
 * - 2025-11-25 and 2025-06-18, session-based: `initialize` opens a session
 *   (MCP SDK v1) bound to the principal that opened it, limited and expiring.
 *   A session is a transport mechanism only; every request is authenticated.
 *
 * Every request passes, in order (AD-15 point 2): Host, path, Origin and
 * method checks, the protocol-version header, bearer authentication and
 * principal derivation from the entry point, body limit, JSON parsing,
 * protocol classification and the version, session or header–body checks of
 * its era, then execution-context construction and dispatch. Requests failing
 * any step are answered here and never reach the MCP server or Core.
 *
 * Exposure scope (AD-15 point 8): legacy loopback sessions keep the session
 * (unchanged, AD-12); sessionless loopback requests use the local-token
 * principal for the lifetime of the process; remote principals always use
 * (accountId, deviceId, clientId), never a session.
 */
export class CrotHttpServer {
  private readonly http: Server;
  private readonly sessions = new Map<string, Session>();
  private readonly allowedHosts = new Set<string>();
  private readonly log: (message: string) => void;
  private readonly entryPoint: HttpEntryPoint;
  private readonly localScopes = new LocalPrincipalScopes();
  /** Principals of in-flight 2026-07-28 requests, keyed by the AuthInfo object handed to the SDK. */
  private readonly modernPrincipals = new WeakMap<AuthInfo, Principal>();
  private readonly modern: McpHttpHandler;
  private sweeper: NodeJS.Timeout | undefined;
  private closing: Promise<void> | undefined;
  private pendingSessions = 0;
  private boundPort = 0;
  private modernInFlight = 0;
  private modernRejected = 0;
  /** Responses of remote requests in flight, per remote client (endRemoteClient). */
  private readonly remoteResponses = new Map<string, Set<ServerResponse>>();
  private readonly remoteAdmission: RemoteAdmission | undefined;
  private readonly resourceMetadataUrl: (() => string | undefined) | undefined;

  private constructor(
    private readonly core: CrotCore,
    private readonly config: CrotHttpServerConfig,
    private readonly verifier: AccessTokenVerifier,
    log: ((message: string) => void) | undefined,
    entryPoint: HttpEntryPoint,
    remoteAdmission: RemoteAdmission | undefined,
    resourceMetadataUrl: (() => string | undefined) | undefined,
  ) {
    this.log = log ?? (() => undefined);
    this.entryPoint = entryPoint;
    this.remoteAdmission = remoteAdmission;
    this.resourceMetadataUrl = entryPoint === "relay" ? resourceMetadataUrl : undefined;
    this.modern = createMcpHandler((ctx) => this.modernServer(ctx.authInfo), {
      // Legacy traffic never reaches this handler: route() serves it with sessions.
      legacy: "reject",
      onerror: (error) => this.log(`http: ${error.message}`),
    });
    this.http = createServer((req, res) => this.handle(req, res));
    this.http.headersTimeout = 30_000;
    this.http.requestTimeout = 60_000;
  }

  /** Validate the configuration, bind and start serving. */
  static async start(core: CrotCore, options: CrotHttpServerOptions): Promise<CrotHttpServer> {
    const { config } = options;
    if (!isLoopbackHost(config.host)) {
      throw new CrotError(
        "CONFIG_ERROR",
        `HTTP host '${config.host}' is not a loopback address. This version of CROT serves HTTP only on loopback (127.0.0.1, ::1, localhost).`,
      );
    }
    const entryPoint = options.entryPoint ?? "loopback";
    if (entryPoint === "relay" && !options.remoteAdmission)
      throw new CrotError("CONFIG_ERROR", "The relay entry point requires the device's remote admission.");
    const server = new CrotHttpServer(
      core,
      config,
      options.verifier,
      options.log,
      entryPoint,
      options.remoteAdmission,
      options.resourceMetadataUrl,
    );
    await server.listen();
    return server;
  }

  /** Bound TCP port. */
  get port(): number {
    return this.boundPort;
  }

  /** Endpoint URL, e.g. http://127.0.0.1:7337/mcp. */
  get url(): string {
    const host = isIP(this.config.host) === 6 ? `[${this.config.host}]` : this.config.host;
    return "http://" + host + ":" + String(this.boundPort) + MCP_HTTP_PATH;
  }

  get listening(): boolean {
    return this.http.listening;
  }

  /** Sessionless requests in flight, their limit and the rejections so far. */
  get sessionlessLoad(): SessionlessLoad {
    return { inFlight: this.modernInFlight, limit: this.maxConcurrentRequests, rejected: this.modernRejected };
  }

  private get maxConcurrentRequests(): number {
    return this.config.maxConcurrentRequests ?? DEFAULT_MAX_CONCURRENT_REQUESTS;
  }

  /** Number of open MCP sessions. */
  get sessionCount(): number {
    return this.sessions.size;
  }

  private async listen(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        this.http.off("listening", onListening);
        reject(
          new CrotError("CONFIG_ERROR", `Cannot listen on ${this.config.host}:${this.config.port}: ${error.message}`),
        );
      };
      const onListening = () => {
        this.http.off("error", onError);
        resolve();
      };
      this.http.once("error", onError);
      this.http.once("listening", onListening);
      this.http.listen(this.config.port, this.config.host);
    });
    this.http.on("error", (error) => this.log(`http: server error: ${error.message}`));
    this.boundPort = (this.http.address() as AddressInfo).port;
    const names = [
      "127.0.0.1",
      "localhost",
      "[::1]",
      isIP(this.config.host) === 6 ? `[${this.config.host}]` : this.config.host,
    ];
    for (const name of names) this.allowedHosts.add(`${name.toLowerCase()}:${this.boundPort}`);
    const interval = Math.max(50, Math.min(this.config.sessionIdleTimeoutMs, 60_000));
    this.sweeper = setInterval(() => this.expireIdleSessions(), interval);
    this.sweeper.unref();
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    this.route(req, res).catch((error: unknown) => {
      this.log(`http: request failed: ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) sendError(res, { status: 500, code: -32603, message: "Internal error" });
      else res.destroy();
    });
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (this.closing)
      return sendError(res, {
        status: 503,
        code: -32000,
        message: "Server is shutting down",
        headers: { Connection: "close" },
      });

    // DNS rebinding protection: only loopback Host names on our port.
    const host = req.headers.host?.toLowerCase();
    if (!host || !this.allowedHosts.has(host))
      return sendError(res, { status: 403, code: -32000, message: "Forbidden: invalid Host header" });

    const pathname = (req.url ?? "").split("?")[0];
    if (pathname !== MCP_HTTP_PATH) return sendError(res, { status: 404, code: -32000, message: "Not found" });

    // Browsers always send Origin on cross-origin requests; native MCP clients do not.
    const origin = req.headers.origin;
    if (origin !== undefined && !this.config.allowedOrigins.includes(origin)) {
      return sendError(res, { status: 403, code: -32000, message: "Forbidden: origin not allowed" });
    }

    if (req.method !== "POST" && req.method !== "GET" && req.method !== "DELETE") {
      return sendError(res, {
        status: 405,
        code: -32000,
        message: "Method not allowed",
        headers: { Allow: "GET, POST, DELETE" },
      });
    }

    // A named protocol version must be one this endpoint serves (AD-15 point 3).
    const headerVersion = headerValue(req, "mcp-protocol-version");
    if (req.headers["mcp-protocol-version"] !== undefined && headerVersion === undefined)
      return sendError(res, unsupportedVersion(undefined));
    if (headerVersion !== undefined && !SUPPORTED_PROTOCOL_VERSIONS.includes(headerVersion))
      return sendError(res, unsupportedVersion(headerVersion));
    const modernHeader = headerVersion !== undefined && MODERN_PROTOCOL_VERSIONS.includes(headerVersion);

    const auth = await this.authenticate(req);
    if (auth === "missing") return sendError(res, this.challenge(false));
    if (auth === "invalid") return sendError(res, this.challenge(true));
    // The principal comes only from the verified facts and the entry point (AD-15 point 6).
    const principal = principalFromAuthInfo(this.entryPoint, auth);
    if (!principal) {
      this.log("http: rejected a credential that does not establish a principal for this entry point");
      return sendError(res, this.challenge(true));
    }
    let remote: string | undefined;
    if (principal.kind === "remote") {
      // principalFromAuthInfo guarantees the fields of a remote principal.
      const client = { accountId: principal.accountId!, deviceId: principal.deviceId!, clientId: principal.clientId! };
      const issuedAt = auth.extra?.issuedAt;
      const facts: RemoteTokenFacts = typeof issuedAt === "number" ? { issuedAt } : {};
      const decision: RemoteAdmissionDecision = this.remoteAdmission
        ? this.remoteAdmission.admit(client, facts)
        : { admitted: false, reason: "state_unavailable" };
      if (!decision.admitted) {
        if (ADMISSION_INVALID_TOKEN.has(decision.reason)) return sendError(res, this.challenge(true));
        return sendError(res, { status: 403, code: -32000, message: ADMISSION_MESSAGES[decision.reason] });
      }
      remote = remoteKeyOf(client);
      this.trackRemote(remote, res);
    }

    if (req.method !== "POST") {
      // 2026-07-28 has no GET stream and no session to delete; only legacy sessions use GET and DELETE.
      const sessionId = headerValue(req, "mcp-session-id");
      if (modernHeader || sessionId === undefined) return sendError(res, METHOD_NOT_ALLOWED_SESSIONLESS);
      return this.serveSession(req, res, undefined, auth, principal, sessionId, headerVersion);
    }

    const raw = await readBody(req, this.config.maxRequestBytes);
    if (raw === undefined)
      return sendError(res, {
        status: 413,
        code: -32600,
        message: "Request body too large",
        headers: { Connection: "close" },
      });
    let body: unknown;
    try {
      body = JSON.parse(raw.toString("utf8"));
    } catch {
      return sendError(res, { status: 400, code: -32700, message: "Parse error" });
    }

    const claimed = envelopeVersion(body);
    if (typeof claimed === "string" && !SUPPORTED_PROTOCOL_VERSIONS.includes(claimed))
      return sendError(res, unsupportedVersion(claimed));

    const controller = new AbortController();
    const abort = () => {
      if (!res.writableFinished) controller.abort();
    };
    res.once("close", abort);
    try {
      const request = toWebRequest(req, raw, controller.signal);
      if (!(await isLegacyRequest(request, body))) return await this.serveModern(res, request, body, auth, principal);
    } finally {
      res.off("close", abort);
    }

    // Legacy (session-based) traffic.
    const sessionId = headerValue(req, "mcp-session-id");
    if (sessionId !== undefined) return this.serveSession(req, res, body, auth, principal, sessionId, headerVersion);
    if (!isInitializeRequest(body))
      return sendError(res, {
        status: 400,
        code: -32000,
        message: "Bad Request: no session; send an initialize request first",
      });
    const requested = initializeVersion(body);
    if (typeof requested !== "string" || !LEGACY_PROTOCOL_VERSIONS.includes(requested))
      return sendError(res, unsupportedVersion(typeof requested === "string" ? requested : undefined));
    return this.openSession(req, res, body, auth, principal);
  }

  /**
   * Serve one 2026-07-28 request: the SDK validates the headers against the
   * body (HeaderMismatch -32020), serves server/discover and dispatches to a
   * per-request CROT MCP server built for exactly this principal. A received
   * Mcp-Session-Id is ignored.
   */
  private async serveModern(
    res: ServerResponse,
    request: Request,
    body: unknown,
    auth: AuthInfo,
    principal: Principal,
  ): Promise<void> {
    // Sessionless requests have no session count to bound them (WP-20): a
    // global in-flight limit protects the one service from a flood of
    // parallel requests. The rejection happens before any MCP server or Core
    // work, so it is neither a policy decision nor an audited event.
    if (this.modernInFlight >= this.maxConcurrentRequests) {
      this.modernRejected++;
      return sendError(res, {
        status: 503,
        code: -32000,
        message: "Too many concurrent requests",
        headers: { "Retry-After": "1" },
      });
    }
    this.modernInFlight++;
    try {
      // A fresh object per request: the key under which the factory finds this request's principal.
      const authInfo: AuthInfo = { ...auth };
      this.modernPrincipals.set(authInfo, principal);
      const response = await this.modern.fetch(request, { authInfo, parsedBody: body });
      await sendWebResponse(res, response);
    } finally {
      this.modernInFlight--;
    }
  }

  /** The per-request MCP server of a 2026-07-28 request (factory of the SDK v2 handler). */
  private modernServer(authInfo: AuthInfo | undefined) {
    const principal = authInfo ? this.modernPrincipals.get(authInfo) : undefined;
    // Only route() hands AuthInfo to the handler; anything else is a programming error and fails closed.
    if (!principal) throw new Error("2026-07-28 request without an authenticated principal");
    const scope = exposureScopeFor(principal, "sessionless", this.localScopes);
    return createCrotModernMcpServer(this.core, { resolveContext: httpContextResolver(principal, scope) });
  }

  /** A request of an existing legacy session (POST, GET stream or DELETE). */
  private async serveSession(
    req: IncomingMessage,
    res: ServerResponse,
    body: unknown,
    auth: AuthInfo,
    principal: Principal,
    sessionId: string,
    headerVersion: string | undefined,
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    // A session is usable only by the principal that opened it.
    if (!session || session.owner !== sessionOwnerKey(principal))
      return sendError(res, { status: 404, code: -32001, message: "Session not found" });
    // Session requests of 2025-06-18 and later always name their version.
    if (headerVersion === undefined || !LEGACY_PROTOCOL_VERSIONS.includes(headerVersion))
      return sendError(res, unsupportedVersion(headerVersion));
    session.lastSeen = Date.now();
    await session.transport.handleRequest(withAuth(req, auth), res, body);
  }

  /**
   * The 401 answer. Relay entry point of a paired device: the challenge names
   * the device's Protected Resource Metadata (AD-21 point 6); otherwise the
   * loopback challenge.
   */
  private challenge(tokenPresented: boolean): Rejection {
    const prm = this.resourceMetadataUrl?.();
    if (prm === undefined || /["\\\r\n]/.test(prm)) return tokenPresented ? INVALID_TOKEN : UNAUTHORIZED;
    const value = `Bearer resource_metadata="${prm}"${tokenPresented ? ', error="invalid_token"' : ""}`;
    return { status: 401, code: -32001, message: "Unauthorized", headers: { "WWW-Authenticate": value } };
  }

  private async authenticate(req: IncomingMessage): Promise<AuthInfo | "missing" | "invalid"> {
    const header = req.headers.authorization;
    if (typeof header !== "string") return "missing";
    const match = /^Bearer +(\S+) *$/i.exec(header);
    const token = match?.[1];
    if (!token) return "missing";
    let info: AuthInfo | undefined;
    try {
      info = await this.verifier.verifyAccessToken(token);
    } catch (error) {
      this.log(`http: credential verification failed: ${error instanceof Error ? error.message : String(error)}`);
      return "invalid";
    }
    if (!info) {
      this.log("http: rejected a request with an invalid credential");
      return "invalid";
    }
    if (info.expiresAt !== undefined && info.expiresAt * 1000 <= Date.now()) return "invalid";
    return info;
  }

  private async openSession(
    req: IncomingMessage,
    res: ServerResponse,
    body: unknown,
    auth: AuthInfo,
    principal: Principal,
  ): Promise<void> {
    if (this.sessions.size + this.pendingSessions >= this.config.maxSessions) {
      return sendError(res, { status: 503, code: -32000, message: "Too many sessions" });
    }
    this.pendingSessions++;
    // Loopback: the session is the exposure scope (AD-12). Remote: (account, device, client), never the session.
    const scope = exposureScopeFor(principal, "session", this.localScopes);
    const server = createCrotMcpServer(this.core, { resolveContext: httpContextResolver(principal, scope) });
    const owner = sessionOwnerKey(principal);
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        this.sessions.set(id, {
          id,
          transport,
          server,
          owner,
          lastSeen: Date.now(),
          ...(principal.kind === "remote"
            ? {
                remote: remoteKeyOf({
                  accountId: principal.accountId!,
                  deviceId: principal.deviceId!,
                  clientId: principal.clientId!,
                }),
              }
            : {}),
        });
      },
      onsessionclosed: (id) => {
        this.sessions.delete(id);
      },
    });
    transport.onclose = () => {
      if (transport.sessionId !== undefined) this.sessions.delete(transport.sessionId);
    };
    try {
      await server.connect(transport);
      await transport.handleRequest(withAuth(req, auth), res, body);
    } finally {
      this.pendingSessions--;
    }
    if (transport.sessionId === undefined || !this.sessions.has(transport.sessionId)) {
      // Initialization was rejected by the transport (e.g. bad Accept header).
      await server.close().catch(() => undefined);
    }
  }

  private expireIdleSessions(): void {
    const cutoff = Date.now() - this.config.sessionIdleTimeoutMs;
    for (const [id, session] of this.sessions) {
      if (session.lastSeen > cutoff) continue;
      this.sessions.delete(id);
      this.log("http: closed an idle session");
      void session.server.close().catch(() => undefined);
    }
  }

  private trackRemote(remote: string, res: ServerResponse): void {
    let set = this.remoteResponses.get(remote);
    if (!set) this.remoteResponses.set(remote, (set = new Set()));
    set.add(res);
    res.once("close", () => {
      set.delete(res);
      if (set.size === 0 && this.remoteResponses.get(remote) === set) this.remoteResponses.delete(remote);
    });
  }

  /**
   * End everything of one remote client on this device (revocation, AD-19
   * point 8): its legacy sessions are closed and its requests in flight are
   * aborted (their connections are closed, so their operations and approval
   * requests are cancelled). Later requests are refused by the admission.
   * Returns the number of sessions and requests ended.
   */
  async endRemoteClient(client: RemoteClientKey): Promise<{ sessions: number; requests: number }> {
    const remote = remoteKeyOf(client);
    const responses = [...(this.remoteResponses.get(remote) ?? [])];
    this.remoteResponses.delete(remote);
    for (const res of responses) {
      if (!res.headersSent) sendError(res, { status: 403, code: -32000, message: ADMISSION_MESSAGES.client_revoked });
      res.destroy();
    }
    const sessions = [...this.sessions.values()].filter((s) => s.remote === remote);
    for (const session of sessions) this.sessions.delete(session.id);
    await Promise.all(sessions.map((s) => s.server.close().catch(() => undefined)));
    if (sessions.length + responses.length > 0)
      this.log(
        `http: ended ${sessions.length} session(s) and ${responses.length} request(s) of a revoked remote client`,
      );
    return { sessions: sessions.length, requests: responses.length };
  }

  /**
   * Stop accepting connections, close every MCP session and open connection.
   * Does not shut down Core: the host calls core.shutdown() afterwards, in its
   * single shutdown path. Idempotent.
   */
  close(): Promise<void> {
    this.closing ??= (async () => {
      if (this.sweeper) clearInterval(this.sweeper);
      const stopped = new Promise<void>((resolve) => this.http.close(() => resolve()));
      const sessions = [...this.sessions.values()];
      this.sessions.clear();
      await Promise.all([
        ...sessions.map((s) => s.server.close().catch(() => undefined)),
        this.modern.close().catch(() => undefined),
      ]);
      this.http.closeAllConnections();
      await stopped;
    })();
    return this.closing;
  }
}
