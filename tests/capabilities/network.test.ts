import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { MemoryAuditSink } from "../../src/core/audit/audit.js";
import { localPrincipal, type AuthContext } from "../../src/core/auth/principal.js";
import { NetworkService, systemResolver, type HostResolver } from "../../src/core/capabilities/network/service.js";
import type { NetworkRequestInput } from "../../src/core/capabilities/network/schemas.js";
import { LimitsSchema } from "../../src/core/config/schema.js";
import { CrotError } from "../../src/core/errors.js";
import { ExecutionGuard } from "../../src/core/execution/guard.js";
import type { Capability } from "../../src/core/permissions/capabilities.js";
import { PermissionEngine } from "../../src/core/permissions/engine.js";
import { parseIp } from "../../src/core/permissions/network/addresses.js";
import { NetworkPolicy } from "../../src/core/permissions/network/policy.js";
import { createPermissionPolicy, type PermissionMode } from "../../src/core/permissions/policy.js";

const context: AuthContext = { principal: localPrincipal("test") };

// A local HTTP server standing in for remote hosts; every request it receives is recorded.
interface Seen {
  readonly method: string;
  readonly url: string;
}
let seen: Seen[] = [];
let server: http.Server;
let port: number;
let proxyHits = 0;
let proxy: http.Server;
let proxyPort: number;
let closedPort: number;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    seen.push({ method: req.method ?? "", url: req.url ?? "" });
    const url = new URL(req.url ?? "/", "http://x");
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      switch (url.pathname) {
        case "/ok":
          res.writeHead(200, { "content-type": "text/plain" }).end("hello");
          return;
        case "/echo":
          res
            .writeHead(200, { "content-type": "application/json" })
            .end(JSON.stringify({ method: req.method, headers: req.headers, body: Buffer.concat(chunks).toString() }));
          return;
        case "/redirect":
          res.writeHead(Number(url.searchParams.get("status") ?? 302), {
            location: url.searchParams.get("to") ?? "/ok",
          });
          res.end();
          return;
        case "/loop":
          res.writeHead(302, { location: "/loop" }).end();
          return;
        case "/big":
          res.writeHead(200).end(Buffer.alloc(10_000, 0x61));
          return;
        case "/slow":
          return; // never answers
        default:
          res.writeHead(404).end();
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
  proxy = http.createServer((_req, res) => {
    proxyHits++;
    res.writeHead(599).end("proxied");
  });
  await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
  proxyPort = (proxy.address() as AddressInfo).port;
  const probe = http.createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  closedPort = (probe.address() as AddressInfo).port;
  await new Promise<void>((r) => probe.close(() => r()));
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  await new Promise<void>((r) => proxy.close(() => r()));
});

afterEach(() => {
  seen = [];
});

interface Setup {
  readonly allow?: string[];
  readonly deny?: string[];
  readonly capabilities?: Capability[];
  readonly mode?: PermissionMode;
  /** Fake DNS: name -> answers (or a function for changing answers). */
  readonly dns?: Record<string, string[] | (() => string[])>;
  readonly resolver?: HostResolver;
}

function setup(s: Setup = {}) {
  const mode = s.mode ?? "full_control";
  const engine = new PermissionEngine(
    createPermissionPolicy({ mode, capabilities: s.capabilities ?? ["network.access"] }),
    {
      network: NetworkPolicy.create({ allow: s.allow ?? [], deny: s.deny ?? [] }, mode),
      // Several requests run in one session; the untrusted-content rule (AD-12) is
      // tested in tests/core/session-exposure.test.ts.
      approvals: { rules: [], untrustedContent: "off" },
    },
  );
  const audit = new MemoryAuditSink();
  const lookups: string[] = [];
  const resolver: HostResolver =
    s.resolver ??
    (async (name) => {
      lookups.push(name);
      const answer = s.dns?.[name];
      if (answer === undefined) throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
      return typeof answer === "function" ? answer() : answer;
    });
  const network = new NetworkService({
    guard: new ExecutionGuard(engine, audit),
    limits: LimitsSchema.parse({}),
    resolver,
  });
  const request = (input: NetworkRequestInput) => network.request(context, input);
  return { engine, audit, lookups, network, request };
}

async function failure(promise: Promise<unknown>): Promise<CrotError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(CrotError);
    return error as CrotError;
  }
  throw new Error("expected the operation to fail");
}

describe("network.access: capability", () => {
  it("is denied without network.access, before any DNS query or connection, and audited", async () => {
    const t = setup({ capabilities: ["shell.execute", "process.manage", "docker.use"], allow: ["*"], dns: {} });
    const error = await failure(t.request({ url: `http://api.test:${port}/ok` }));
    expect(error.code).toBe("PERMISSION_DENIED");
    expect(error.details?.missing).toEqual(["network.access"]);
    expect(t.lookups).toEqual([]);
    expect(seen).toEqual([]);
    expect(t.audit.events.map((e) => [e.operation, e.outcome])).toEqual([["network.resolve", "denied"]]);
    // IP literals are denied the same way (no resolve step).
    expect((await failure(t.request({ url: `http://127.0.0.1:${port}/ok` }))).code).toBe("PERMISSION_DENIED");
    expect(seen).toEqual([]);
  });

  it("network destinations cannot be authorized by any other capability", () => {
    const t = setup({
      capabilities: ["network.access", "shell.execute", "process.manage", "docker.use", "filesystem.read"],
      allow: ["*"],
    });
    const target = {
      scheme: "https",
      host: "example.com",
      hostKind: "name",
      port: 443,
      addresses: [parseIp("93.184.216.34")!],
    } as const;
    for (const capability of ["shell.execute", "process.manage", "docker.use", "filesystem.read"] as const) {
      const decision = t.engine.authorize({ context, capability, network: [target] });
      expect(decision.allowed, capability).toBe(false);
      if (!decision.allowed) expect(decision.missing).toEqual(["network.access"]);
    }
    expect(t.engine.authorize({ context, capability: "network.access", network: [target] }).allowed).toBe(true);
  });

  it("is not a process, shell, Git or Docker permission", () => {
    const t = setup({ capabilities: ["network.access"], allow: ["*"] });
    for (const capability of ["shell.execute", "process.manage", "docker.use", "git.write"] as const) {
      expect(t.engine.authorize({ context, capability }).allowed, capability).toBe(false);
    }
  });
});

describe("network.access: host policy", () => {
  it("refuses a host that is not allowed without resolving it", async () => {
    const t = setup({ allow: ["api.test:*"], dns: { "other.test": ["127.0.0.1"] } });
    const error = await failure(t.request({ url: `http://other.test:${port}/ok` }));
    expect(error.code).toBe("PERMISSION_DENIED");
    expect(error.message).toMatch(/not allowed by the network policy/);
    expect(t.lookups).toEqual([]);
    expect(seen).toEqual([]);
  });

  it("refuses a host matched by a deny rule even when allowed", async () => {
    const t = setup({
      allow: ["*.test:*", "127.0.0.1:*"],
      deny: ["blocked.test"],
      dns: { "blocked.test": ["127.0.0.1"] },
    });
    const error = await failure(t.request({ url: `http://blocked.test:${port}/ok` }));
    expect(error.code).toBe("PERMISSION_DENIED");
    expect(error.message).toMatch(/denied by rule 'blocked.test'/);
    expect(seen).toEqual([]);
  });

  it("allows an allowed host, connects to the checked address and audits host and addresses", async () => {
    const t = setup({ allow: [`api.test:${port}`, `127.0.0.1:${port}`], dns: { "api.test": ["127.0.0.1"] } });
    const response = await t.request({ url: `http://api.test:${port}/echo?token=secret-value` });
    expect(response.status).toBe(200);
    expect(response.remoteAddress).toBe("127.0.0.1");
    const echoed = JSON.parse(response.body) as { method: string; headers: Record<string, string> };
    expect(echoed.method).toBe("GET");
    expect(echoed.headers.host).toBe(`api.test:${port}`);
    expect(t.lookups).toEqual(["api.test"]);
    expect(t.audit.events.map((e) => [e.operation, e.outcome])).toEqual([
      ["network.resolve", "success"],
      ["network.request", "success"],
    ]);
    expect(t.audit.events[1]?.network).toEqual([{ scheme: "http", host: "api.test", port, addresses: ["127.0.0.1"] }]);
    // Audit records the origin only: never the path, query, headers or body.
    expect(JSON.stringify(t.audit.events)).not.toContain("secret-value");
  });

  it("sends the request method, headers and body", async () => {
    const t = setup({ allow: [`127.0.0.1:${port}`] });
    const response = await t.request({
      url: `http://127.0.0.1:${port}/echo`,
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test": "1" },
      body: '{"a":1}',
    });
    const echoed = JSON.parse(response.body) as { method: string; headers: Record<string, string>; body: string };
    expect(echoed).toMatchObject({ method: "POST", body: '{"a":1}' });
    expect(echoed.headers["x-test"]).toBe("1");
    expect(echoed.headers["content-length"]).toBe("7");
  });
});

describe("network.access: localhost, loopback, private and link-local addresses", () => {
  it("refuses an allowed name that resolves to loopback without an explicit IP rule", async () => {
    const t = setup({ allow: [`api.test:${port}`, "*"], dns: { "api.test": ["127.0.0.1"] } });
    const error = await failure(t.request({ url: `http://api.test:${port}/ok` }));
    expect(error.code).toBe("PERMISSION_DENIED");
    expect(error.message).toMatch(/loopback address 127\.0\.0\.1/);
    expect(seen).toEqual([]);
    expect(t.audit.events.map((e) => [e.operation, e.outcome])).toEqual([
      ["network.resolve", "success"],
      ["network.request", "denied"],
    ]);
  });

  it("localhost is loopback: it is never sent to DNS and needs explicit address rules", async () => {
    expect(await systemResolver("localhost")).toEqual(["127.0.0.1", "::1"]);
    expect(await systemResolver("app.localhost")).toEqual(["127.0.0.1", "::1"]);
    const denied = setup({ allow: [`localhost:${port}`], resolver: systemResolver });
    expect((await failure(denied.request({ url: `http://localhost:${port}/ok` }))).code).toBe("PERMISSION_DENIED");
    expect(seen).toEqual([]);
    const allowed = setup({
      allow: [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`],
      resolver: systemResolver,
    });
    expect((await allowed.request({ url: `http://localhost:${port}/ok` })).body).toBe("hello");
  });

  it.each([
    "http://127.0.0.1:PORT/ok",
    "http://2130706433:PORT/ok",
    "http://0x7f000001:PORT/ok",
    "http://0x7f.1:PORT/ok",
    "http://0177.0.0.1:PORT/ok",
    "http://127.1:PORT/ok",
    "http://[::ffff:127.0.0.1]:PORT/ok",
    "http://[::1]:PORT/ok",
    "http://0.0.0.0:PORT/ok",
    "http://[::]:PORT/ok",
  ])("refuses the loopback literal %s even with '*:*'", async (template) => {
    const t = setup({ allow: ["*:*"] });
    const error = await failure(t.request({ url: template.replace("PORT", String(port)) }));
    expect(error.code).toBe("PERMISSION_DENIED");
    expect(seen).toEqual([]);
  });

  it.each([
    "http://10.0.0.1/",
    "http://172.16.0.1/",
    "http://192.168.1.1/",
    "http://100.64.0.1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://[fe80::1]/",
    "http://[fd00::1]/",
    "http://[::ffff:169.254.169.254]/",
    "http://[64:ff9b::a9fe:a9fe]/",
  ])("refuses the private/link-local literal %s even with '*'", async (url) => {
    const t = setup({ allow: ["*"] });
    const error = await failure(t.request({ url }));
    expect(error.code).toBe("PERMISSION_DENIED");
    expect(error.message).toMatch(/non-public addresses must be allowed explicitly/);
  });

  it("numeric spellings of an allowed address are that address; a name rule never allows an IP", async () => {
    const t = setup({ allow: [`127.0.0.1:${port}`] });
    expect((await t.request({ url: `http://2130706433:${port}/ok` })).body).toBe("hello");
    const names = setup({ allow: [`api.test:${port}`] });
    expect((await failure(names.request({ url: `http://2130706433:${port}/ok` }))).code).toBe("PERMISSION_DENIED");
  });

  it("refuses names resolving to a mix of public and private addresses", async () => {
    const t = setup({ allow: ["api.test"], dns: { "api.test": ["93.184.216.34", "10.0.0.1"] } });
    expect((await failure(t.request({ url: "https://api.test/" }))).message).toMatch(/private address 10\.0\.0\.1/);
  });

  it("IPv6: a loopback IPv6 address needs its own explicit rule", async () => {
    const t = setup({ allow: [`127.0.0.1:${port}`, `api.test:${port}`], dns: { "api.test": ["::1"] } });
    expect((await failure(t.request({ url: `http://api.test:${port}/ok` }))).message).toMatch(/loopback address ::1/);
    expect((await failure(t.request({ url: `http://[::1]:${port}/ok` }))).code).toBe("PERMISSION_DENIED");
  });
});

describe("network.access: DNS rebinding", () => {
  it("resolves once per hop and connects only to the checked address", async () => {
    let calls = 0;
    // The first answer is allowed; any later answer would point elsewhere.
    const t = setup({
      allow: [`api.test:${port}`, `127.0.0.1:${port}`],
      dns: { "api.test": () => (calls++ === 0 ? ["127.0.0.1"] : ["10.0.0.1"]) },
    });
    const response = await t.request({ url: `http://api.test:${port}/ok` });
    expect(response.body).toBe("hello");
    expect(response.remoteAddress).toBe("127.0.0.1");
    expect(calls).toBe(1);
  });

  it("a later request checks the new answer again", async () => {
    let calls = 0;
    const t = setup({
      allow: [`api.test:${port}`, `127.0.0.1:${port}`],
      dns: { "api.test": () => (calls++ === 0 ? ["127.0.0.1"] : ["127.0.0.2"]) },
    });
    await t.request({ url: `http://api.test:${port}/ok` });
    const error = await failure(t.request({ url: `http://api.test:${port}/ok` }));
    expect(error.message).toMatch(/loopback address 127\.0\.0\.2/);
    expect(seen).toHaveLength(1);
  });
});

describe("network.access: redirects", () => {
  const allow = () => [`api.test:${port}`, `127.0.0.1:${port}`];

  it("follows allowed redirects and reports them", async () => {
    const t = setup({ allow: allow(), dns: { "api.test": ["127.0.0.1"] } });
    const response = await t.request({ url: `http://api.test:${port}/redirect?to=/ok` });
    expect(response).toMatchObject({ status: 200, body: "hello", url: `http://api.test:${port}/ok` });
    expect(response.redirects).toEqual([{ url: `http://api.test:${port}/redirect?to=/ok`, status: 302 }]);
  });

  it("checks every hop: a redirect to a link-local address is refused", async () => {
    const t = setup({ allow: [...allow(), "*"], dns: { "api.test": ["127.0.0.1"] } });
    const to = encodeURIComponent("http://169.254.169.254/latest/meta-data/");
    const error = await failure(t.request({ url: `http://api.test:${port}/redirect?to=${to}` }));
    expect(error.code).toBe("PERMISSION_DENIED");
    expect(error.message).toMatch(/link-local address 169\.254\.169\.254/);
    expect(t.audit.events.at(-1)).toMatchObject({ operation: "network.request", outcome: "denied" });
  });

  it("a redirect to a host that is not allowed is refused before DNS", async () => {
    const t = setup({ allow: allow(), dns: { "api.test": ["127.0.0.1"], "evil.test": ["127.0.0.1"] } });
    const to = encodeURIComponent(`http://evil.test:${port}/ok`);
    expect((await failure(t.request({ url: `http://api.test:${port}/redirect?to=${to}` }))).code).toBe(
      "PERMISSION_DENIED",
    );
    expect(t.lookups).toEqual(["api.test"]);
    expect(seen.map((s) => s.url)).toEqual([`/redirect?to=${to}`]);
  });

  it("a redirect to another loopback port, spelling or scheme is refused", async () => {
    const t = setup({ allow: allow(), dns: { "api.test": ["127.0.0.1"] } });
    for (const location of [`http://2130706433:${closedPort}/`, "file:///etc/passwd", "gopher://api.test/"]) {
      const error = await failure(
        t.request({ url: `http://api.test:${port}/redirect?to=${encodeURIComponent(location)}` }),
      );
      expect(["PERMISSION_DENIED", "OPERATION_FAILED"], location).toContain(error.code);
      expect(error.details?.errno, location).toBeUndefined(); // never connected
    }
  });

  it("does not forward credentials to another origin; 303 becomes GET without body", async () => {
    const t = setup({ allow: allow(), dns: { "api.test": ["127.0.0.1"] } });
    const to = encodeURIComponent(`http://127.0.0.1:${port}/echo`);
    const response = await t.request({
      url: `http://api.test:${port}/redirect?status=303&to=${to}`,
      method: "POST",
      headers: { Authorization: "Bearer secret", Cookie: "a=b", "X-Keep": "1" },
      body: "payload",
    });
    const echoed = JSON.parse(response.body) as { method: string; headers: Record<string, string>; body: string };
    expect(echoed.method).toBe("GET");
    expect(echoed.body).toBe("");
    expect(echoed.headers.authorization).toBeUndefined();
    expect(echoed.headers.cookie).toBeUndefined();
    expect(echoed.headers["x-keep"]).toBe("1");
  });

  it("followRedirects=false returns the redirect; redirect loops are limited", async () => {
    const t = setup({ allow: allow(), dns: { "api.test": ["127.0.0.1"] } });
    const response = await t.request({ url: `http://api.test:${port}/redirect?to=/ok`, followRedirects: false });
    expect(response.status).toBe(302);
    expect(response.headers.location).toBe("/ok");
    const error = await failure(t.request({ url: `http://api.test:${port}/loop` }));
    expect(error.code).toBe("LIMIT_EXCEEDED");
    expect(seen.filter((s) => s.url === "/loop")).toHaveLength(6); // first request + 5 redirects
  });
});

describe("network.access: proxies, limits, timeouts and errors", () => {
  it("ignores proxy environment variables and connects directly", async () => {
    const names = ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"];
    const saved = Object.fromEntries(names.map((n) => [n, process.env[n]]));
    for (const n of names) process.env[n] = `http://127.0.0.1:${proxyPort}`;
    try {
      const t = setup({ allow: [`127.0.0.1:${port}`] });
      expect((await t.request({ url: `http://127.0.0.1:${port}/ok` })).body).toBe("hello");
      expect(proxyHits).toBe(0);
    } finally {
      for (const n of names) {
        if (saved[n] === undefined) delete process.env[n];
        else process.env[n] = saved[n];
      }
    }
  });

  it("times out a request that does not answer", async () => {
    const t = setup({ allow: [`127.0.0.1:${port}`] });
    const started = Date.now();
    const error = await failure(t.request({ url: `http://127.0.0.1:${port}/slow`, timeoutMs: 300 }));
    expect(error.code).toBe("TIMEOUT");
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(t.audit.events.at(-1)).toMatchObject({ operation: "network.request", outcome: "error" });
  });

  it("times out a DNS lookup that does not answer", async () => {
    const t = setup({ allow: ["api.test"], resolver: () => new Promise<never>(() => undefined) });
    expect((await failure(t.request({ url: "https://api.test/", timeoutMs: 200 }))).code).toBe("TIMEOUT");
  });

  it("refuses timeouts above the configured maximum", async () => {
    const t = setup({ allow: [`127.0.0.1:${port}`] });
    expect((await failure(t.request({ url: `http://127.0.0.1:${port}/ok`, timeoutMs: 10_000_000 }))).code).toBe(
      "LIMIT_EXCEEDED",
    );
  });

  it("reports connection failures and unknown hosts", async () => {
    const t = setup({ allow: [`127.0.0.1:${closedPort}`, "missing.test"], dns: {} });
    const refused = await failure(t.request({ url: `http://127.0.0.1:${closedPort}/` }));
    expect(refused.code).toBe("OPERATION_FAILED");
    expect(refused.details?.errno).toBe("ECONNREFUSED");
    expect((await failure(t.request({ url: "https://missing.test/" }))).code).toBe("NOT_FOUND");
  });

  it("truncates responses at maxResponseBytes", async () => {
    const t = setup({ allow: [`127.0.0.1:${port}`] });
    const response = await t.request({ url: `http://127.0.0.1:${port}/big`, maxResponseBytes: 100 });
    expect(response).toMatchObject({ truncated: true, bytes: 100 });
    expect(response.body).toBe("a".repeat(100));
    const full = await t.request({ url: `http://127.0.0.1:${port}/big`, responseEncoding: "base64" });
    expect(full.truncated).toBe(false);
    expect(Buffer.from(full.body, "base64").length).toBe(10_000);
  });

  it("validates input: schemes, credentials, connection headers, bodies on GET", async () => {
    const t = setup({ allow: ["*"] });
    for (const input of [
      { url: "file:///etc/passwd" },
      { url: "http://user:pw@example.com/" },
      { url: "https://example.com/", headers: { Host: "127.0.0.1" } },
      { url: "https://example.com/", headers: { "Proxy-Authorization": "x" } },
      { url: "https://example.com/", headers: { "Transfer-Encoding": "chunked" } },
      { url: "https://example.com/", headers: { "X-A": "a\r\nInjected: 1" } },
      { url: "https://example.com/", method: "GET", body: "x" },
      { url: "https://example.com/", method: "CONNECT" },
    ] as NetworkRequestInput[]) {
      expect((await failure(t.request(input))).code, JSON.stringify(input)).toBe("INVALID_INPUT");
    }
    expect(seen).toEqual([]);
  });

  it("shutdown aborts requests in flight and refuses new ones", async () => {
    const t = setup({ allow: [`127.0.0.1:${port}`] });
    const pending = failure(t.request({ url: `http://127.0.0.1:${port}/slow`, timeoutMs: 10_000 }));
    await new Promise((r) => setTimeout(r, 100));
    t.network.shutdown();
    expect((await pending).code).toBe("OPERATION_FAILED");
    expect((await failure(t.request({ url: `http://127.0.0.1:${port}/ok` }))).code).toBe("OPERATION_FAILED");
  });
});
