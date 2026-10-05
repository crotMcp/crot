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
>;

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

  private constructor(
    private readonly core: CrotCore,
    private readonly config: CrotHttpServerConfig,
    private readonly verifier: AccessTokenVerifier,
    log: ((message: string) => void) | undefined,
    entryPoint: HttpEntryPoint,
  ) {
    this.log = log ?? (() => undefined);
    this.entryPoint = entryPoint;
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
    const server = new CrotHttpServer(core, config, options.verifier, options.log, options.entryPoint ?? "loopback");
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
    if (auth === "missing") return sendError(res, UNAUTHORIZED);
    if (auth === "invalid") return sendError(res, INVALID_TOKEN);
    // The principal comes only from the verified facts and the entry point (AD-15 point 6).
    const principal = principalFromAuthInfo(this.entryPoint, auth);
    if (!principal) {
      this.log("http: rejected a credential that does not establish a principal for this entry point");
      return sendError(res, INVALID_TOKEN);
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
    // A fresh object per request: the key under which the factory finds this request's principal.
    const authInfo: AuthInfo = { ...auth };
    this.modernPrincipals.set(authInfo, principal);
    const response = await this.modern.fetch(request, { authInfo, parsedBody: body });
    await sendWebResponse(res, response);
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
        this.sessions.set(id, { id, transport, server, owner, lastSeen: Date.now() });
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
