/** WP-32: real HTTPS sockets, OAuth issuance, relay, WSS tunnel and CrotService. Only the IdP is emulated. */
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import https from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { ServeCommand } from "../../src/cli/options.js";
import { CloudRelay } from "../../src/cloud-relay/server.js";
import { MemoryDeviceRegistry } from "../../src/cloud-relay/registry.js";
import { createPrivateFileProtection } from "../../src/core/platform/private-files.js";
import { createIdentityHttp } from "../../src/identity/http.js";
import { IssuerKeySet } from "../../src/identity/jwks.js";
import { ControlClient } from "../../src/service/control-client.js";
import type { ControlEvent, ControlOverview } from "../../src/service/protocol.js";
import { CrotService } from "../../src/service/service.js";
import { TestAuthorizationServer, TEST_RELAY, PAIRING_CLIENT } from "../identity/test-authorization-server.js";

export async function eventually(check: () => boolean | Promise<boolean>, timeout = 10000): Promise<void> {
  const until = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() > until) throw new Error("WP-32 condition timed out");
    await new Promise((r) => setTimeout(r, 100));
  }
}
export class RemoteAcceptance {
  readonly as = new TestAuthorizationServer();
  readonly registry = new MemoryDeviceRegistry();
  readonly logs: unknown[] = [];
  readonly wireVersions = new Set<string>();
  readonly approvals: Extract<ControlEvent, { event: "approval.requested" }>[] = [];
  readonly approvalErrors: unknown[] = [];
  autoApprove = true;
  base = "";
  workspace = "";
  stateDir = "";
  uri = "";
  deviceId = "";
  ca!: Buffer;
  relay!: CloudRelay;
  service!: CrotService;
  control!: ControlClient;
  private server!: https.Server;
  private oldCA: typeof https.globalAgent.options.ca;
  private authPort = 0;
  async start(
    options: {
      workspace?: string;
      stateDir?: string;
      downloads?: string;
      browser?: boolean;
      exchangeDeadlineMs?: number;
      gateWrites?: boolean;
    } = {},
  ): Promise<this> {
    this.base = await mkdtemp(path.join(process.platform === "win32" ? tmpdir() : "/tmp", "crot-ra-"));
    this.workspace = options.workspace ?? path.join(this.base, "project");
    this.stateDir = options.stateDir ?? path.join(this.base, "s");
    await mkdir(this.workspace, { recursive: true });
    const keyFile = path.join(this.base, "key.pem"),
      certFile = path.join(this.base, "cert.pem");
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "1",
        "-subj",
        "/CN=WP32-test-only",
        "-addext",
        `subjectAltName=DNS:localhost,DNS:auth.crot-dev.example,DNS:${TEST_RELAY}`,
        "-keyout",
        keyFile,
        "-out",
        certFile,
      ],
      { stdio: "ignore" },
    );
    const key = await readFile(keyFile);
    this.ca = await readFile(certFile);
    this.server = https.createServer({ key, cert: this.ca }, (req, res) => {
      void (async () => {
        const url = new URL(req.url!, this.as.issuer);
        if (url.pathname === "/oauth2/authorize") {
          const result = this.as.authorize(url.href, { sub: "user_01" });
          res.writeHead(302, { location: result.redirect }).end();
          return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const response = await this.as.fetch(url, {
          method: req.method,
          ...(chunks.length ? { body: Buffer.concat(chunks).toString() } : {}),
        });
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(await response.text());
      })().catch(() => res.writeHead(400).end());
    });
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.authPort = (this.server.address() as { port: number }).port;
    this.relay = new CloudRelay({
      relayHost: TEST_RELAY,
      issuer: this.as.issuer,
      pairingClientId: PAIRING_CLIENT,
      environment: "test",
      // The acceptance matrix sends hundreds of commands; production default-limit behavior is covered by WP-29.
      limits: { clientRequests: { max: 10000, windowMs: 60000 }, deviceRequests: { max: 10000, windowMs: 60000 } },
      registry: this.registry,
      keys: new IssuerKeySet({ issuer: this.as.issuer, http: createIdentityHttp({ fetch: this.fetch }) }),
      log: (r) => this.logs.push(r),
      ...(options.exchangeDeadlineMs ? { exchangeDeadlineMs: options.exchangeDeadlineMs } : {}),
    });
    await this.relay.listen({ port: 0, host: "127.0.0.1", tls: { key, cert: this.ca } });
    // Test-only trust root for the real WSS connector; certificate and hostname verification remain enabled.
    this.oldCA = https.globalAgent.options.ca;
    https.globalAgent.options.ca = this.ca;
    const started = await CrotService.start({
      command: {
        kind: "serve",
        warnings: [],
        config: {
          workspace: { root: this.workspace },
          environment: { path: "inherited" },
          secrets: { store: "file" },
          http: { enabled: true, port: 0 },
          audit: { sink: "file", path: path.join(this.base, "audit.jsonl") },
          permissions: {
            mode: "sandbox",
            capabilities: [
              "filesystem.read",
              "filesystem.write",
              "shell.execute",
              "git.read",
              "git.write",
              "docker.use",
              "browser.read",
              "browser.control",
            ],
            ...(options.gateWrites
              ? { approvals: { rules: [{ id: "test-writes", match: { capabilities: ["filesystem.write"] } }] } }
              : {}),
          },
          ...(options.browser ? { browser: { enabled: true, downloadsDirectory: options.downloads } } : {}),
        } as ServeCommand["config"],
      },
      launch: "managed",
      stateDir: this.stateDir,
      privateFiles: createPrivateFileProtection(process.platform === "win32"),
      log: (r) => this.logs.push(r),
      requestStop: () => undefined,
      identity: { environment: this.as.environment(), http: createIdentityHttp({ fetch: this.fetch }) },
      tunnel: { url: () => `wss://localhost:${this.relay.port}/.crot/tunnel`, watchIntervalMs: 25 },
    });
    if (started === "already_running") throw new Error("fixture service already running");
    this.service = started;
    this.control = (await ControlClient.connect({
      stateDir: this.stateDir,
      privateFiles: createPrivateFileProtection(process.platform === "win32"),
    }))!;
    this.control.onevent = (e) => {
      if (e.event !== "approval.requested") return;
      this.approvals.push(e);
      if (!this.autoApprove) return;
      void this.ask("approvals.decide", {
        requestId: e.approval.requestId,
        decision: "approve",
        subjectDigest: e.approval.subjectDigest,
      }).catch((error: unknown) => this.approvalErrors.push(error));
    };
    await this.ask("approvals.subscribe");
    const pairing = (await this.ask("pairing.start")) as { authorizationUrl: string };
    const authorization = await this.fetch(pairing.authorizationUrl, { redirect: "manual" });
    const callback = await globalThis.fetch(authorization.headers.get("location")!);
    await callback.text();
    await eventually(async () => ((await this.ask("overview")) as ControlOverview).pairing.state === "paired");
    const overview = (await this.ask("overview")) as ControlOverview;
    this.deviceId = overview.pairing.device!.deviceId;
    this.uri = `https://${TEST_RELAY}/d/${this.deviceId}/mcp`;
    await this.ask("remote.setMode", { enabled: true });
    await eventually(() => this.relay.status().tunnels.ready === 1);
    return this;
  }
  ask(method: string, params?: Record<string, unknown>): Promise<unknown> {
    return this.control.request(method as never, params);
  }
  /** DNS override only: canonical HTTPS authorities, actual loopback sockets, explicit test CA. */
  readonly fetch: typeof globalThis.fetch = async (input, init) => {
    const original = input instanceof Request ? input : undefined;
    const url = new URL(input instanceof URL ? input.href : typeof input === "string" ? input : input.url);
    if (url.protocol !== "https:" || ![new URL(this.as.issuer).hostname, TEST_RELAY].includes(url.hostname))
      throw new Error("unmapped test authority");
    const headers = new Headers(init?.headers ?? original?.headers);
    headers.set("host", url.host);
    const revision = headers.get("mcp-protocol-version");
    if (url.hostname === TEST_RELAY && revision) this.wireVersions.add(revision);
    const body =
      init?.body ?? (original && original.method !== "GET" ? Buffer.from(await original.arrayBuffer()) : undefined);
    return new Promise<Response>((resolve, reject) => {
      const req = https.request(
        {
          hostname: "127.0.0.1",
          port: url.hostname === TEST_RELAY ? this.relay.port : this.authPort,
          servername: url.hostname,
          ca: this.ca,
          agent: false, // Never reuse a TLS socket across fixture trust-policy changes.
          path: url.pathname + url.search,
          method: init?.method ?? original?.method ?? "GET",
          headers: Object.fromEntries(headers),
          signal: init?.signal ?? original?.signal ?? undefined,
        },
        (res) => {
          const responseHeaders = new Headers();
          for (const [name, value] of Object.entries(res.headers))
            if (value !== undefined) responseHeaders.set(name, Array.isArray(value) ? value.join(", ") : value);
          resolve(
            new Response(
              [204, 304].includes(res.statusCode!) ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>),
              { status: res.statusCode, headers: responseHeaders },
            ),
          );
        },
      );
      req.once("error", reject);
      if (body !== undefined && body !== null)
        req.write(typeof body === "string" || Buffer.isBuffer(body) ? body : String(body));
      req.end();
    });
  };
  async stop(): Promise<void> {
    this.control?.close();
    await this.service?.shutdown("WP-32 teardown");
    await this.relay?.close();
    https.globalAgent.options.ca = this.oldCA;
    if (this.server) {
      this.server.closeAllConnections();
      await new Promise<void>((r) => this.server.close(() => r()));
    }
    if (this.base) await rm(this.base, { recursive: true, force: true });
  }
  async audit(): Promise<string> {
    return readFile(path.join(this.base, "audit.jsonl"), "utf8");
  }
  async seed(): Promise<void> {
    execFileSync("git", ["init", "--initial-branch=main", this.workspace], { stdio: "ignore" });
    execFileSync("git", ["-C", this.workspace, "config", "user.name", "WP32 Fixture"]);
    execFileSync("git", ["-C", this.workspace, "config", "user.email", "wp32@example.invalid"]);
    await writeFile(path.join(this.workspace, "fixture.txt"), "WP32_INPUT_CANARY");
    execFileSync("git", ["-C", this.workspace, "add", "."]);
    execFileSync("git", ["-C", this.workspace, "commit", "-m", "fixture"], { stdio: "ignore" });
  }
}
