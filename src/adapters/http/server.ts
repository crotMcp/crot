import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isIP, type AddressInfo } from "node:net";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { HttpConfig } from "../../core/config/schema.js";
import type { CrotCore } from "../../core/crot-core.js";
import { CrotError } from "../../core/errors.js";
import { createCrotMcpServer } from "../mcp/server.js";
import type { AccessTokenVerifier } from "./auth.js";
import { HTTP_TRANSPORT, httpContextResolver } from "./context.js";

/** The only path served. */
export const MCP_HTTP_PATH = "/mcp";

export type CrotHttpServerConfig = Pick<HttpConfig, "host" | "port" | "allowedOrigins" | "maxRequestBytes" | "maxSessions" | "sessionIdleTimeoutMs">;

export interface CrotHttpServerOptions {
  readonly config: CrotHttpServerConfig;
  /** Authenticates every request before it reaches the MCP server or Core. */
  readonly verifier: AccessTokenVerifier;
  /** Operator diagnostics (stderr in the CLI). Never receives credentials, bodies or results. */
  readonly log?: (message: string) => void;
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
  /** clientId of the principal that opened the session. */
  readonly owner: string;
  lastSeen: number;
}

type Rejection = { status: number; code: number; message: string; headers?: Record<string, string> };

function sendError(res: ServerResponse, rejection: Rejection): void {
  res.writeHead(rejection.status, { "Content-Type": "application/json", ...(rejection.headers ?? {}) });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: rejection.code, message: rejection.message }, id: null }));
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

const withAuth = (req: IncomingMessage, auth: AuthInfo): IncomingMessage & { auth: AuthInfo } => Object.assign(req, { auth });

const UNAUTHORIZED: Rejection = { status: 401, code: -32001, message: "Unauthorized", headers: { "WWW-Authenticate": 'Bearer realm="crot"' } };
const INVALID_TOKEN: Rejection = {
  status: 401,
  code: -32001,
  message: "Unauthorized",
  headers: { "WWW-Authenticate": 'Bearer realm="crot", error="invalid_token"' },
};

/**
 * CROT MCP over Streamable HTTP (loopback only).
 *
 * A transport adapter: every MCP session gets its own McpServer created by
 * createCrotMcpServer, all bound to the same CrotCore, so HTTP requests use
 * exactly the Core services, PermissionEngine and audit path of stdio.
 *
 * Every request passes, in order: Host check, path check, Origin check,
 * method check, bearer authentication, body limit, JSON parsing and session
 * lookup. Requests failing any step are answered here and never reach the
 * MCP server or Core.
 */
export class CrotHttpServer {
  private readonly http: Server;
  private readonly sessions = new Map<string, Session>();
  private readonly allowedHosts = new Set<string>();
  private readonly log: (message: string) => void;
  private sweeper: NodeJS.Timeout | undefined;
  private closing: Promise<void> | undefined;
  private pendingSessions = 0;
  private boundPort = 0;

  private constructor(
    private readonly core: CrotCore,
    private readonly config: CrotHttpServerConfig,
    private readonly verifier: AccessTokenVerifier,
    log: ((message: string) => void) | undefined,
  ) {
    this.log = log ?? (() => undefined);
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
    const server = new CrotHttpServer(core, config, options.verifier, options.log);
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
    return `http://${host}:${this.boundPort}${MCP_HTTP_PATH}`;
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
        reject(new CrotError("CONFIG_ERROR", `Cannot listen on ${this.config.host}:${this.config.port}: ${error.message}`));
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
    const names = ["127.0.0.1", "localhost", "[::1]", isIP(this.config.host) === 6 ? `[${this.config.host}]` : this.config.host];
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
    if (this.closing) return sendError(res, { status: 503, code: -32000, message: "Server is shutting down", headers: { Connection: "close" } });

    // DNS rebinding protection: only loopback Host names on our port.
    const host = req.headers.host?.toLowerCase();
    if (!host || !this.allowedHosts.has(host)) return sendError(res, { status: 403, code: -32000, message: "Forbidden: invalid Host header" });

    const pathname = (req.url ?? "").split("?")[0];
    if (pathname !== MCP_HTTP_PATH) return sendError(res, { status: 404, code: -32000, message: "Not found" });

    // Browsers always send Origin on cross-origin requests; native MCP clients do not.
    const origin = req.headers.origin;
    if (origin !== undefined && !this.config.allowedOrigins.includes(origin)) {
      return sendError(res, { status: 403, code: -32000, message: "Forbidden: origin not allowed" });
    }

    if (req.method !== "POST" && req.method !== "GET" && req.method !== "DELETE") {
      return sendError(res, { status: 405, code: -32000, message: "Method not allowed", headers: { Allow: "GET, POST, DELETE" } });
    }

    const auth = await this.authenticate(req);
    if (auth === "missing") return sendError(res, UNAUTHORIZED);
    if (auth === "invalid") return sendError(res, INVALID_TOKEN);

    let body: unknown;
    if (req.method === "POST") {
      const raw = await readBody(req, this.config.maxRequestBytes);
      if (raw === undefined) return sendError(res, { status: 413, code: -32600, message: "Request body too large", headers: { Connection: "close" } });
      try {
        body = JSON.parse(raw.toString("utf8"));
      } catch {
        return sendError(res, { status: 400, code: -32700, message: "Parse error" });
      }
    }

    const header = req.headers["mcp-session-id"];
    const sessionId = typeof header === "string" ? header : undefined;
    if (sessionId === undefined) {
      if (req.method === "POST" && isInitializeRequest(body)) return this.openSession(req, res, body, auth);
      return sendError(res, { status: 400, code: -32000, message: "Bad Request: no session; send an initialize request first" });
    }
    const session = this.sessions.get(sessionId);
    // A session is usable only by the principal that opened it.
    if (!session || session.owner !== auth.clientId) return sendError(res, { status: 404, code: -32001, message: "Session not found" });
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

  private async openSession(req: IncomingMessage, res: ServerResponse, body: unknown, auth: AuthInfo): Promise<void> {
    if (this.sessions.size + this.pendingSessions >= this.config.maxSessions) {
      return sendError(res, { status: 503, code: -32000, message: "Too many sessions" });
    }
    this.pendingSessions++;
    const server = createCrotMcpServer(this.core, { resolveContext: httpContextResolver(auth, HTTP_TRANSPORT) });
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        this.sessions.set(id, { id, transport, server, owner: auth.clientId, lastSeen: Date.now() });
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
      await Promise.all(sessions.map((s) => s.server.close().catch(() => undefined)));
      this.http.closeAllConnections();
      await stopped;
    })();
    return this.closing;
  }
}
