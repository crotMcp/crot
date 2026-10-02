import { readFile, stat, writeFile } from "node:fs/promises";
import { request, type IncomingHttpHeaders } from "node:http";
import path from "node:path";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalTokenVerifier, loadOrCreateLocalToken, type AccessTokenVerifier } from "../../src/adapters/http/auth.js";
import { CrotHttpServer, isLoopbackHost } from "../../src/adapters/http/server.js";
import { TOOLS } from "../../src/adapters/mcp/tools.js";
import { MemoryAuditSink } from "../../src/core/audit/audit.js";
import { parseConfig } from "../../src/core/config/load.js";
import { HttpConfigSchema, type HttpConfigInput } from "../../src/core/config/schema.js";
import type { CrotCore } from "../../src/core/crot-core.js";
import { CrotError } from "../../src/core/errors.js";
import { createTestCore, isWindows, makeTempDirs, type TempDirs } from "../helpers.js";

let dirs: TempDirs;
let core: CrotCore | undefined;
let server: CrotHttpServer | undefined;
let audit: MemoryAuditSink;
let token: string;
let verifier: AccessTokenVerifier & { fingerprint?: string };
const clients: Client[] = [];

/** Verifier with two fixed users: demonstrates the replaceable authentication seam. */
class TwoUserVerifier implements AccessTokenVerifier {
  readonly method = "test-verifier";
  static readonly tokens: Record<string, string> = {
    "token-for-user-a-0123456789abcdef": "user-a",
    "token-for-user-b-0123456789abcdef": "user-b",
  };
  async verifyAccessToken(candidate: string): Promise<AuthInfo | undefined> {
    const subject = TwoUserVerifier.tokens[candidate];
    return subject ? { token: candidate, clientId: subject, scopes: [], extra: { subject, authMethod: this.method } } : undefined;
  }
}
const TOKEN_A = "token-for-user-a-0123456789abcdef";
const TOKEN_B = "token-for-user-b-0123456789abcdef";

async function start(http: HttpConfigInput = {}, coreConfig: Record<string, unknown> = {}, custom?: AccessTokenVerifier): Promise<void> {
  audit = new MemoryAuditSink();
  core = await createTestCore({ workspace: { root: dirs.workspace }, ...coreConfig }, audit);
  const tokenFile = path.join(dirs.outside, "state", "http-token");
  token = (await loadOrCreateLocalToken(tokenFile, core.platform.privateFiles)).token;
  verifier = custom ?? new LocalTokenVerifier(token);
  server = await CrotHttpServer.start(core, { config: HttpConfigSchema.parse({ enabled: true, port: 0, ...http }), verifier });
}

async function connect(bearer: string = token, name = "http-test-client"): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
  const client = new Client({ name, version: "0.0.1" });
  const transport = new StreamableHTTPClientTransport(new URL(server!.url), { requestInit: { headers: { Authorization: `Bearer ${bearer}` } } });
  await client.connect(transport);
  clients.push(client);
  return { client, transport };
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
  const first = result.content[0];
  const body = first && first.type === "text" ? JSON.parse(first.text) : undefined;
  return { isError: result.isError === true, body };
}

interface RawResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

/** Low-level request (allows setting Host/Origin, which fetch forbids). */
function raw(options: { method?: string; path?: string; headers?: Record<string, string>; body?: string } = {}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: server!.port,
        method: options.method ?? "POST",
        path: options.path ?? "/mcp",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(options.headers ?? {}) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(options.body);
  });
}

const INITIALIZE = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "raw", version: "1" } },
});
const LIST_TOOLS = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
const auth = (t: string = token) => ({ Authorization: `Bearer ${t}` });

beforeEach(async () => {
  dirs = await makeTempDirs();
});
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => undefined);
  await server?.close();
  await core?.shutdown();
  server = undefined;
  core = undefined;
  await dirs.cleanup();
});

describe("HTTP transport: safe defaults", () => {
  it("is disabled by default, binds loopback and requires local-token auth", () => {
    const http = parseConfig({ workspace: { root: dirs.workspace } }).http;
    expect(http).toMatchObject({ enabled: false, host: "127.0.0.1", auth: { mode: "local-token" }, allowedOrigins: [] });
    expect(http.maxRequestBytes).toBeGreaterThan(0);
    expect(http.maxSessions).toBeGreaterThan(0);
    expect(() => parseConfig({ workspace: { root: dirs.workspace }, http: { auth: { mode: "none" } } })).toThrow(CrotError);
  });

  it("recognizes loopback hosts only", () => {
    for (const h of ["127.0.0.1", "127.1.2.3", "localhost", "::1", "[::1]"]) expect(isLoopbackHost(h)).toBe(true);
    for (const h of ["0.0.0.0", "::", "192.168.1.10", "10.0.0.1", "example.com"]) expect(isLoopbackHost(h)).toBe(false);
  });

  it("refuses to bind a non-loopback address", async () => {
    core = await createTestCore({ workspace: { root: dirs.workspace } });
    await expect(
      CrotHttpServer.start(core, { config: HttpConfigSchema.parse({ host: "0.0.0.0", port: 0 }), verifier: new TwoUserVerifier() }),
    ).rejects.toThrow(CrotError);
  });

  it("creates a private token file once and reuses it", async () => {
    core = await createTestCore({ workspace: { root: dirs.workspace } });
    const file = path.join(dirs.outside, "new-state", "http-token");
    const first = await loadOrCreateLocalToken(file, core.platform.privateFiles);
    expect(first.created).toBe(true);
    expect(first.token.length).toBeGreaterThanOrEqual(32);
    const second = await loadOrCreateLocalToken(file, core.platform.privateFiles);
    expect(second).toEqual({ token: first.token, created: false });
    expect((await readFile(file, "utf8")).trim()).toBe(first.token);
    if (!isWindows) expect((await stat(file)).mode & 0o777).toBe(0o600);
    await writeFile(file, "");
    await expect(loadOrCreateLocalToken(file, core.platform.privateFiles)).rejects.toThrow(CrotError);
    expect(() => new LocalTokenVerifier("short")).toThrow(CrotError);
  });
});

describe("HTTP transport: lifecycle", () => {
  it("starts and stops", async () => {
    await start();
    expect(server!.listening).toBe(true);
    expect(server!.url).toBe(`http://127.0.0.1:${server!.port}/mcp`);
    const port = server!.port;
    await server!.close();
    await server!.close(); // idempotent
    expect(server!.listening).toBe(false);
    await expect(
      new Promise((resolve, reject) => {
        const req = request({ host: "127.0.0.1", port, path: "/mcp", method: "POST" }, resolve);
        req.on("error", reject);
        req.end();
      }),
    ).rejects.toThrow();
  });

  it("closes sessions and connections on shutdown, then Core shuts down", async () => {
    await start();
    const { client } = await connect();
    expect(server!.sessionCount).toBe(1);
    await server!.close();
    expect(server!.sessionCount).toBe(0);
    await core!.shutdown();
    await expect(client.listTools()).rejects.toThrow();
  });
});

describe("HTTP transport: MCP over HTTP", () => {
  beforeEach(() => start());

  it("completes the initialize handshake and exposes exactly the stdio tool set", async () => {
    const { client, transport } = await connect();
    expect(client.getServerVersion()?.name).toBe("crot");
    expect(transport.sessionId).toBeTruthy();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(TOOLS.map((t) => t.name).sort());
    expect(client.getInstructions()).toContain("Permission mode: sandbox");
  });

  it("delegates tool calls to the existing Core", async () => {
    const { client } = await connect();
    expect((await call(client, "fs_write_file", { path: "hello.txt", content: "hi" })).body).toEqual({
      path: "hello.txt",
      bytesWritten: 2,
      created: true,
    });
    expect(await readFile(path.join(dirs.workspace, "hello.txt"), "utf8")).toBe("hi");
    expect((await call(client, "fs_read_file", { path: "hello.txt" })).body.content).toBe("hi");
    expect((await call(client, "crot_status")).body.workspace.root).toBe(dirs.workspace);
  });

  it("passes the authenticated remote principal to Core and audits it without the token", async () => {
    const { client } = await connect();
    await call(client, "fs_write_file", { path: "secret-content.txt", content: "TOP-SECRET-CONTENT" });
    const event = audit.events.at(-1)!;
    expect(event.outcome).not.toBe("denied");
    expect(event.principal).toEqual({
      id: `local-token:${(verifier as LocalTokenVerifier).fingerprint}`,
      kind: "remote",
      transport: "http",
      authMethod: "local-token",
      client: { name: "http-test-client", version: "0.0.1" },
    });
    const serialized = JSON.stringify(audit.events);
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain("TOP-SECRET-CONTENT");
  });

  it("leaves authorization to the PermissionEngine (sandbox denial)", async () => {
    await writeFile(path.join(dirs.outside, "secret.txt"), "s");
    const { client } = await connect();
    const { isError, body } = await call(client, "fs_read_file", { path: path.join(dirs.outside, "secret.txt") });
    expect(isError).toBe(true);
    expect(body.error.code).toBe("PERMISSION_DENIED");
    expect(JSON.stringify(body)).not.toMatch(/\bat .+:\d+:\d+/); // no stack trace
    const event = audit.events.at(-1)!;
    expect(event.outcome).toBe("denied");
    expect(event.principal).toMatchObject({ kind: "remote", transport: "http" });
  });

  it("rejects unauthenticated requests before they reach Core", async () => {
    const before = audit.events.length;
    const missing = await raw({ body: INITIALIZE });
    expect(missing.status).toBe(401);
    expect(missing.headers["www-authenticate"]).toContain("Bearer");
    expect(JSON.parse(missing.body)).toEqual({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null });
    expect((await raw({ body: INITIALIZE, headers: auth("x".repeat(43)) })).status).toBe(401);
    expect((await raw({ body: INITIALIZE, headers: { Authorization: `Basic ${token}` } })).status).toBe(401);
    expect((await raw({ method: "GET" })).status).toBe(401);
    await expect(connect("wrong-token-wrong-token-wrong-token")).rejects.toThrow();
    expect(server!.sessionCount).toBe(0);
    expect(audit.events.length).toBe(before);
    expect(JSON.stringify(missing)).not.toContain(token);
  });

  it("rejects invalid requests with clean errors", async () => {
    const badJson = await raw({ body: "{ not json", headers: auth() });
    expect(badJson.status).toBe(400);
    expect(JSON.parse(badJson.body).error.code).toBe(-32700);
    expect((await raw({ path: "/", headers: auth() })).status).toBe(404);
    expect((await raw({ path: "/mcp/../etc/passwd", headers: auth() })).status).toBe(404);
    expect((await raw({ path: "/files", method: "GET", headers: auth() })).status).toBe(404);
    const put = await raw({ method: "PUT", body: "{}", headers: auth() });
    expect(put.status).toBe(405);
    expect(put.headers.allow).toBe("GET, POST, DELETE");
    expect((await raw({ body: LIST_TOOLS, headers: auth() })).status).toBe(400);
    expect((await raw({ body: LIST_TOOLS, headers: { ...auth(), "mcp-session-id": "no-such-session" } })).status).toBe(404);
    for (const r of [badJson, put]) expect(r.body).not.toMatch(/\bat .+:\d+:\d+/);
  });

  it("enforces Host and Origin checks", async () => {
    expect((await raw({ body: INITIALIZE, headers: { ...auth(), Host: `evil.example:${server!.port}` } })).status).toBe(403);
    expect((await raw({ body: INITIALIZE, headers: { ...auth(), Origin: "https://evil.example" } })).status).toBe(403);
    expect(server!.sessionCount).toBe(0);
  });
});

describe("HTTP transport: limits and identity", () => {
  it("rejects oversized bodies", async () => {
    await start({ maxRequestBytes: 1024 });
    const response = await raw({ body: JSON.stringify({ padding: "x".repeat(4096) }), headers: auth() });
    expect(response.status).toBe(413);
  });

  it("caps the number of sessions", async () => {
    await start({ maxSessions: 1 });
    await connect();
    await expect(connect()).rejects.toThrow();
    expect(server!.sessionCount).toBe(1);
  });

  it("accepts a replacement verifier and binds sessions to their principal", async () => {
    await start({}, {}, new TwoUserVerifier());
    const a = await connect(TOKEN_A, "client-a");
    const b = await connect(TOKEN_B, "client-b");
    await call(b.client, "fs_write_file", { path: "b.txt", content: "b" });
    expect(audit.events.at(-1)!.principal).toEqual({
      id: "user-b",
      kind: "remote",
      transport: "http",
      authMethod: "test-verifier",
      client: { name: "client-b", version: "0.0.1" },
    });
    // user-b cannot use user-a's session.
    const hijack = await raw({ body: LIST_TOOLS, headers: { ...auth(TOKEN_B), "mcp-session-id": a.transport.sessionId! } });
    expect(hijack.status).toBe(404);
    expect((await a.client.listTools()).tools.length).toBe(TOOLS.length);
  });

  it("applies the configured permission mode unchanged (full_control)", async () => {
    await start({}, { permissions: { mode: "full_control" } });
    const { client } = await connect();
    const { isError } = await call(client, "fs_write_file", { path: path.join(dirs.outside, "ok.txt"), content: "ok" });
    expect(isError).toBe(false);
  });
});
