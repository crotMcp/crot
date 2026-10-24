import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { AccountService } from "../../src/account-service/service.js";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult, JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ServeCommand } from "../../src/cli/options.js";
import { createPrivateFileProtection } from "../../src/core/platform/private-files.js";
import type { ServiceStatus } from "../../src/core/service-status.js";
import {
  ChannelError,
  connectChannel,
  MAX_SERVER_FRAME_BYTES,
  type AuthenticatedChannel,
} from "../../src/service/channel.js";
import { configDigest } from "../../src/service/config-digest.js";
import { environmentFingerprint } from "../../src/service/environment.js";
import { ControlClient } from "../../src/service/control-client.js";
import {
  credentialFile,
  secretCredentialStore,
  serviceEndpoint,
  type CredentialStore,
} from "../../src/service/endpoints.js";
import { parseServiceMessage, SERVICE_PROTOCOL_VERSION, type ServiceToShim } from "../../src/service/protocol.js";
import { ResumeDetector } from "../../src/service/resume-detector.js";
import { CrotService } from "../../src/service/service.js";
import { isWindows, makeTempDirs, waitFor, type TempDirs } from "../helpers.js";

const privateFiles = createPrivateFileProtection(isWindows);

let dirs: TempDirs;
let stateDir: string;
let services: CrotService[];
beforeEach(async () => {
  dirs = await makeTempDirs();
  // Short state directory: Unix socket paths are limited to 103 bytes.
  stateDir = isWindows ? path.join(dirs.outside, "state") : await mkdtemp(path.join("/tmp", "crot-s-"));
  services = [];
});
afterEach(async () => {
  for (const s of services) await s.shutdown("test end");
  if (!isWindows) await rm(stateDir, { recursive: true, force: true });
  await dirs.cleanup();
});

function serveCommand(config: Record<string, unknown> = {}): ServeCommand {
  return {
    kind: "serve",
    config: {
      workspace: { root: dirs.workspace },
      audit: { sink: "none" },
      environment: { path: "inherited" },
      // Owner-only files: these tests read the credential files; the OS stores are tested in tests/service/secrets.
      secrets: { store: "file" },
      ...config,
    } as ServeCommand["config"],
    warnings: [],
  };
}

interface Started {
  readonly service: CrotService;
  readonly logs: string[];
  readonly stops: string[];
  clock: number;
}

async function startService(
  options: { launch?: ServiceStatus["launch"]; config?: Record<string, unknown>; idleExitMs?: number } = {},
): Promise<Started> {
  const started = { logs: [] as string[], stops: [] as string[], clock: 1_000_000 } as Started & {
    service?: CrotService;
  };
  const service = await CrotService.start({
    command: serveCommand(options.config),
    launch: options.launch ?? "managed",
    stateDir,
    privateFiles,
    log: (m) => started.logs.push(m),
    requestStop: (reason) => started.stops.push(reason),
    ...(options.idleExitMs !== undefined ? { idleExitMs: options.idleExitMs } : {}),
    resume: { intervalMs: 60_000, thresholdMs: 10_000, now: () => started.clock },
  });
  if (service === "already_running") throw new Error("already running");
  services.push(service);
  return Object.assign(started, { service });
}

const store = (): CredentialStore => secretCredentialStore(stateDir, privateFiles);

/** MCP over a raw shim connection (what the built shim does with stdin/stdout). */
class ShimTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  constructor(private readonly channel: AuthenticatedChannel) {
    channel.onmessage = (value) => {
      const m = parseServiceMessage(value);
      if (m?.t === "mcp") this.onmessage?.(JSON.parse(m.data) as JSONRPCMessage);
    };
    channel.onclose = () => this.onclose?.();
    channel.start();
  }
  async start(): Promise<void> {}
  async send(message: JSONRPCMessage): Promise<void> {
    this.channel.send({ t: "mcp", line: JSON.stringify(message) });
  }
  async close(): Promise<void> {
    await this.channel.close();
  }
}

/** Connect like the shim: authenticate, hello, wait for the answer. */
async function shimConnect(
  config: Record<string, unknown> = {},
  environment?: Record<string, string>,
): Promise<{ channel: AuthenticatedChannel; answer: ServiceToShim }> {
  const credential = (await store().read("service"))!;
  const channel = await connectChannel(serviceEndpoint(stateDir, "service", credential).path, {
    channel: "service",
    credential,
    maxFrameBytes: MAX_SERVER_FRAME_BYTES,
  });
  const command = serveCommand(config);
  const answer = await new Promise<ServiceToShim>((resolve, reject) => {
    channel.onmessage = (v) => {
      channel.pause();
      const m = parseServiceMessage(v);
      if (m) resolve(m);
      else reject(new Error("bad answer"));
    };
    channel.onclose = () => reject(new Error("closed"));
    channel.start();
    channel.send({
      t: "hello",
      version: SERVICE_PROTOCOL_VERSION,
      configDigest: configDigest(command.configFile ?? "", command.config),
      pid: process.pid,
      ...(environment ? { environment } : {}),
    });
  });
  return { channel, answer };
}

async function mcpClient(config: Record<string, unknown> = {}): Promise<Client> {
  const { channel, answer } = await shimConnect(config);
  expect(answer.t).toBe("welcome");
  const client = new Client({ name: "shim-test", version: "0" });
  await client.connect(new ShimTransport(channel));
  return client;
}

async function crotStatus(client: Client): Promise<{ service: ServiceStatus; workspace: { root: string } }> {
  const result = (await client.callTool({ name: "crot_status", arguments: {} })) as CallToolResult;
  const first = result.content[0];
  return JSON.parse(first?.type === "text" ? first.text : "{}");
}

describe("CROT service (WP-20)", () => {
  it("WP-36: Free/offline/accountless local shim and loopback HTTP remain fully usable", async () => {
    // A free commercial service denies remote. It is deliberately not a dependency of the local service.
    expect(new AccountService().snapshot("unregistered").entitled).toBe(false);
    const config = { permissions: { mode: "full_control" }, http: { enabled: true, port: 0 } };
    const started = await startService({ config });
    const shim = await mcpClient(config);
    const http = new Client({ name: "free-local-http", version: "1" });
    const token = (await readFile(path.join(stateDir, "http-token"), "utf8")).trim();
    try {
      await http.connect(
        new StreamableHTTPClientTransport(new URL(started.service.httpUrl!), {
          requestInit: { headers: { authorization: `Bearer ${token}` } },
        }),
      );
      for (const [index, client] of [shim, http].entries()) {
        const write = await client.callTool({
          name: "fs_write_file",
          arguments: { path: `free-${index}.txt`, content: "accountless-local" },
        });
        expect(write.isError).not.toBe(true);
        const read = await client.callTool({ name: "fs_read_file", arguments: { path: `free-${index}.txt` } });
        expect(read.isError).not.toBe(true);
        expect(JSON.stringify(read)).toContain("accountless-local");
      }
      const overview = started.service.status();
      expect(overview.state).toBe("running");
      expect(started.logs.join("\n")).not.toContain("stripe");
      expect(started.logs.join("\n")).not.toContain("entitlement_required");
    } finally {
      await shim.close();
      await http.close();
    }
  });

  it("is a singleton per user: a second service gets already_running and starts nothing", async () => {
    const first = await startService();
    const second = await CrotService.start({
      command: serveCommand(),
      launch: "on-demand",
      stateDir,
      privateFiles,
      log: () => undefined,
      requestStop: () => undefined,
    });
    expect(second).toBe("already_running");
    expect(first.service.status()).toMatchObject({ state: "running", launch: "managed", pid: process.pid });
  });

  it("serves several MCP connections, each with its own MCP server; crot_status reports the service", async () => {
    await startService();
    const clients = await Promise.all([mcpClient(), mcpClient(), mcpClient()]);
    const statuses = await Promise.all(clients.map(crotStatus));
    for (const s of statuses) {
      expect(s.service).toMatchObject({ state: "running", pid: process.pid, launch: "managed" });
      expect(s.service.endpoints.kind).toBe(isWindows ? "named-pipe" : "unix-socket");
    }
    expect((await crotStatus(clients[0]!)).service.clients.stdio).toBe(3);
    // Parallel tool calls on all connections.
    await Promise.all(
      clients.map((c, i) =>
        c.callTool({ name: "fs_write_file", arguments: { path: `f${i}.txt`, content: String(i) } }),
      ),
    );
    for (let i = 0; i < 3; i++) expect(await readFile(path.join(dirs.workspace, `f${i}.txt`), "utf8")).toBe(String(i));
    await clients[0]!.close();
    await waitFor(async () => (await crotStatus(clients[1]!)).service.clients.stdio === 2);
    for (const c of clients.slice(1)) await c.close();
  });

  it("tells a client whose PATH, shell or home differs that commands use the service's environment", async () => {
    await startService();
    const same = await shimConnect({}, environmentFingerprint());
    expect(same.answer.t).toBe("welcome");
    expect((same.answer as Extract<ServiceToShim, { t: "welcome" }>).logs.join("\n")).not.toMatch(/note: this client/);
    const differentPath = environmentFingerprint({ ...process.env, PATH: "/elsewhere/bin", Path: "C:\\elsewhere" });
    const other = await shimConnect({}, differentPath);
    expect(other.answer.t).toBe("welcome");
    const logs = (other.answer as Extract<ServiceToShim, { t: "welcome" }>).logs.join("\n");
    expect(logs).toMatch(/note: this client's PATH differs from the running CROT service/);
    // Only digests travel: the value itself is never in the answer.
    expect(logs).not.toContain("elsewhere");
    await same.channel.close();
    await other.channel.close();
  });

  it("rejects a hello with a malformed environment fingerprint", async () => {
    await startService();
    await expect(shimConnect({}, { PATH: "not a digest" })).rejects.toThrow(/closed/);
  });

  it("refuses a client with another configuration while it is in use", async () => {
    await startService();
    const client = await mcpClient();
    const other = await shimConnect({ permissions: { mode: "full_control" } });
    expect(other.answer).toMatchObject({ t: "refused", reason: "config_mismatch" });
    expect((other.answer as { message: string }).message).toMatch(/different configuration/);
    await client.close();
  });

  it("an idle on-demand service makes room for a client with another configuration", async () => {
    const s = await startService({ launch: "on-demand", idleExitMs: 60_000 });
    const other = await shimConnect({ permissions: { mode: "full_control" } });
    expect(other.answer).toMatchObject({ t: "refused", reason: "restarting" });
    expect(s.stops).toEqual(["configuration changed"]);
  });

  it("an on-demand service asks to stop after its last client has gone", async () => {
    const s = await startService({ launch: "on-demand", idleExitMs: 50 });
    const a = await mcpClient();
    const b = await mcpClient();
    await a.close();
    await new Promise((r) => setTimeout(r, 200));
    expect(s.stops).toEqual([]);
    await b.close();
    await waitFor(() => s.stops.length === 1);
    expect(s.stops).toEqual(["last client disconnected"]);
  });

  it("a managed service keeps running without clients", async () => {
    const s = await startService({ launch: "managed", idleExitMs: 20 });
    const a = await mcpClient();
    await a.close();
    await new Promise((r) => setTimeout(r, 200));
    expect(s.stops).toEqual([]);
  });

  it("shutdown says bye to connected shims, closes the endpoints and stops Core", async () => {
    const s = await startService();
    const { channel, answer } = await shimConnect();
    expect(answer.t).toBe("welcome");
    const messages: unknown[] = [];
    let closed = false;
    channel.onmessage = (m) => messages.push(m);
    channel.onclose = () => (closed = true);
    channel.start();
    await s.service.shutdown("test");
    await waitFor(() => closed);
    expect(messages).toContainEqual({ t: "bye", reason: "test" });
    expect(s.service.status().state).toBe("stopping");
    const credential = (await store().read("service"))!;
    await expect(
      connectChannel(serviceEndpoint(stateDir, "service", credential).path, {
        channel: "service",
        credential,
        maxFrameBytes: 1 << 20,
      }),
    ).rejects.toMatchObject({ reason: "unreachable" });
  });
});

describe("Stage A emergency owner control", () => {
  it("connects an agent, executes a real task, approves through owner IPC and observes the audit; restores policy on restart", async () => {
    const config = { audit: { sink: "file", path: path.join(dirs.outside, "stage-a-workflow.jsonl") } };
    const started = await startService({ config });
    const client = await mcpClient(config);
    const control = (await ControlClient.connect({ stateDir, privateFiles }))!;
    let approval: import("../../src/core/approvals/types.js").PresentedApproval | undefined;
    try {
      control.onevent = (event) => {
        if (event.event === "approval.requested") approval = event.approval;
      };
      await control.request("approvals.subscribe");
      expect(await control.request("security.setPolicy", { strict: true, rules: [] })).toMatchObject({ ok: true });
      const task = client.callTool({
        name: "fs_write_file",
        arguments: { path: "approved-stage-a.txt", content: "owner-approved" },
      });
      await waitFor(() => approval !== undefined);
      expect(
        await control.request("approvals.decide", {
          requestId: approval!.requestId,
          decision: "approve",
          subjectDigest: approval!.subjectDigest,
        }),
      ).toEqual({ ok: true });
      expect((await task).isError).not.toBe(true);
      expect(await readFile(path.join(dirs.workspace, "approved-stage-a.txt"), "utf8")).toBe("owner-approved");
      expect(await control.request("monitoring.queryAudit", { type: "filesystem.write_file" })).toMatchObject({
        ok: true,
        events: expect.arrayContaining([
          expect.objectContaining({ type: "filesystem.write_file", outcome: "success" }),
        ]),
      });
    } finally {
      control.close();
      await client.close();
    }
    await started.service.shutdown("restart policy test");
    await startService({ config });
    const restarted = (await ControlClient.connect({ stateDir, privateFiles }))!;
    try {
      expect(await restarted.request("security.status")).toMatchObject({
        ok: true,
        policy: { strict: true, rules: [] },
      });
    } finally {
      restarted.close();
    }
  });

  it("preserves owner diagnostics, closes MCP admission and records kill in the real journal", async () => {
    const auditPath = path.join(dirs.outside, "emergency-audit.jsonl");
    const config = { permissions: { mode: "full_control" }, audit: { sink: "file", path: auditPath } };
    await startService({ config });
    const client = await mcpClient(config);
    const control = (await ControlClient.connect({ stateDir, privateFiles }))!;
    try {
      const result = await control.request("security.kill");
      expect(result).toMatchObject({ ok: true, halted: true, audited: true, cleanupComplete: true });
      expect(await control.request("security.status")).toMatchObject({ ok: true, halted: true });
      expect(await control.request("security.kill")).toEqual(result);
      expect((await shimConnect(config)).answer).toMatchObject({ t: "refused", reason: "shutting_down" });
      const journal = (await readFile(auditPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(journal.filter((e) => e.action === "emergency_stop")).toHaveLength(1);
      expect(await control.request("monitoring.queryAudit", { type: "emergency_stop" })).toMatchObject({
        ok: true,
        events: [{ type: "emergency_stop", outcome: "applied" }],
      });
    } finally {
      control.close();
      await client.close();
    }
  });
});

describe("control channel (WP-20)", () => {
  it("answers ping and status and stops the service on shutdown; it carries no MCP", async () => {
    const s = await startService();
    const control = (await ControlClient.connect({ stateDir, privateFiles }))!;
    expect(await control.request("ping")).toEqual({ pid: process.pid, state: "running" });
    const status = (await control.request("status")) as { service: ServiceStatus; workspace: string };
    expect(status.service).toMatchObject({ state: "running", clients: { control: 1 } });
    expect(status.workspace).toBe(dirs.workspace);
    expect(await control.request("shutdown")).toEqual({ stopping: true, pid: process.pid });
    await waitFor(() => s.stops.length === 1);
    expect(s.stops).toEqual(["control: shutdown requested"]);
    control.close();
  });

  it("closes the connection on anything that is not a control request (MCP, unknown methods)", async () => {
    await startService();
    const credential = (await store().read("control"))!;
    for (const message of [
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { t: "request", id: 1, method: "tools/call" },
      { t: "mcp", line: "{}" },
    ]) {
      const channel = await connectChannel(serviceEndpoint(stateDir, "control", credential).path, {
        channel: "control",
        credential,
        maxFrameBytes: 1 << 20,
      });
      let closed = false;
      const got: unknown[] = [];
      channel.onmessage = (m) => got.push(m);
      channel.onclose = () => (closed = true);
      channel.start();
      channel.send(message);
      await waitFor(() => closed);
      expect(got).toEqual([]);
    }
  });

  it("rejects a peer with a wrong or missing credential and one holding only the shim credential", async () => {
    await startService();
    const control = (await store().read("control"))!;
    const shim = (await store().read("service"))!;
    expect(control).not.toBe(shim);
    const endpoint = serviceEndpoint(stateDir, "control", control).path;
    for (const credential of [randomBytes(32).toString("base64url"), shim]) {
      await expect(
        connectChannel(endpoint, { channel: "control", credential, maxFrameBytes: 1 << 20 }),
      ).rejects.toBeInstanceOf(ChannelError);
    }
    // No credential at all: the client tool reports "not running" rather than guessing.
    await unlink(credentialFile(stateDir, "control"));
    expect(await ControlClient.connect({ stateDir, privateFiles })).toBeUndefined();
  });

  it.runIf(!isWindows)("credentials are owner-only files that are never logged", async () => {
    const s = await startService();
    for (const channel of ["service", "control"] as const) {
      const file = credentialFile(stateDir, channel);
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      const secret = (await readFile(file, "utf8")).trim();
      expect(s.logs.join("\n")).not.toContain(secret);
    }
    expect((await stat(stateDir)).mode & 0o777).toBe(0o700);
  });
});

describe("sleep/wake (WP-20)", () => {
  it("ResumeDetector reports a wall-clock gap much larger than its interval", () => {
    let now = 0;
    const gaps: number[] = [];
    let ticks = 0;
    const d = new ResumeDetector({
      intervalMs: 1_000,
      thresholdMs: 5_000,
      now: () => now,
      onResume: (g) => gaps.push(g),
      onTick: () => ticks++,
    });
    d.start();
    now += 1_000;
    d.check();
    now += 3_000; // late, but below the threshold
    d.check();
    now += 61_000; // the machine slept for a minute
    d.check();
    d.stop();
    expect(gaps).toEqual([60_000]);
    expect(ticks).toBe(2);
  });

  it.runIf(!isWindows)("after a resume the service re-creates a missing socket file and keeps serving", async () => {
    const s = await startService();
    const credential = (await store().read("service"))!;
    const socket = serviceEndpoint(stateDir, "service", credential).path;
    await unlink(socket);
    s.clock += 3_600_000;
    // The detector's timer runs every 60 s in this test; trigger its check directly.
    (s.service as unknown as { detector: ResumeDetector }).detector.check();
    await waitFor(async () => (await stat(socket).catch(() => undefined)) !== undefined);
    expect(s.service.status().power.resumes).toBe(1);
    expect(s.logs.some((l) => l.includes("resumed after"))).toBe(true);
    const client = await mcpClient();
    expect((await crotStatus(client)).service.power.resumes).toBe(1);
    await client.close();
  });
});

describe("CROT service secrets (WP-21)", () => {
  const toolText = (r: CallToolResult) => (r.content[0]?.type === "text" ? r.content[0].text : "");
  const allSecrets = async () => {
    const values: string[] = [];
    for (const name of ["service-token", "control-token", "browser-token", "http-token"]) {
      const v = await readFile(path.join(stateDir, name), "utf8").catch(() => "");
      if (v.trim()) values.push(v.trim());
    }
    return values;
  };

  it("reports the store, protects every secret path from CROT tools and never shows a value", async () => {
    const audit = path.join(dirs.outside, "audit.jsonl");
    const config = {
      permissions: { mode: "full_control" },
      audit: { sink: "file", path: audit },
      http: { enabled: true, port: 0 },
    };
    const started = await startService({ config });
    const client = await mcpClient(config);
    try {
      const status = await crotStatus(client);
      expect(status.service.secrets).toMatchObject({ store: "file", httpToken: "secret-store" });
      const secrets = await allSecrets();
      expect(secrets.length).toBeGreaterThanOrEqual(3);
      for (const name of ["service-token", "control-token", "http-token"]) {
        const file = path.join(stateDir, name);
        const read = (await client.callTool({ name: "fs_read_file", arguments: { path: file } })) as CallToolResult;
        expect(read.isError).toBe(true);
        expect(toolText(read)).toMatch(/CROT secrets/);
        const stat = (await client.callTool({ name: "fs_stat", arguments: { path: file } })) as CallToolResult;
        expect(stat.isError).toBe(true);
      }
      const marker = (await client.callTool({
        name: "fs_write_file",
        arguments: { path: path.join(stateDir, "secrets.json"), content: '{"version":1,"backend":"file"}' },
      })) as CallToolResult;
      expect(marker.isError).toBe(true);
      const everything = JSON.stringify(await crotStatus(client)) + started.logs.join("\n");
      for (const value of secrets) expect(everything).not.toContain(value);
      await client.close();
      await started.service.shutdown("test");
      const auditText = await readFile(audit, "utf8");
      expect(auditText).toContain("filesystem.read_file");
      for (const value of secrets) expect(auditText).not.toContain(value);
    } finally {
      await client.close().catch(() => undefined);
    }
  });

  it("migrates a configured http.auth.tokenFile into the store and serves HTTP with that token", async () => {
    const tokenFile = path.join(dirs.outside, "legacy-http-token");
    const legacy = randomBytes(32).toString("base64url");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(tokenFile, `${legacy}\n`);
    const started = await startService({ config: { http: { enabled: true, port: 0, auth: { tokenFile } } } });
    await expect(stat(tokenFile)).rejects.toThrow();
    expect((await readFile(path.join(stateDir, "http-token"), "utf8")).trim()).toBe(legacy);
    expect(started.logs.join("\n")).toMatch(/http-token migrated from/);
    expect(started.logs.join("\n")).not.toContain(legacy);
    const url = started.service.httpUrl!;
    const post = (token: string) =>
      fetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
        }),
      });
    expect((await post("wrong-token-0123456789-0123456789-0123")).status).toBe(401);
    const ok = await post(legacy);
    expect(ok.status).not.toBe(401);
    await ok.body?.cancel();
  });

  it('keeps the plaintext token file in the "token-file" compatibility mode, with a warning', async () => {
    const tokenFile = path.join(dirs.outside, "compat-token");
    const started = await startService({
      config: { http: { enabled: true, port: 0, auth: { storage: "token-file", tokenFile } } },
    });
    expect((await readFile(tokenFile, "utf8")).trim()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(started.logs.join("\n")).toMatch(/warning: http: the access token is kept in the plaintext file/);
    expect(started.service.status().secrets.httpToken).toBe("token-file");
  });

  it("refuses to start when a plaintext file and the store disagree (no insecure fallback)", async () => {
    const { writeFile, mkdir } = await import("node:fs/promises");
    const tokenFile = path.join(dirs.outside, "conflicting-token");
    await mkdir(stateDir, { recursive: true });
    await writeFile(path.join(stateDir, "http-token"), `${randomBytes(32).toString("base64url")}\n`);
    await writeFile(tokenFile, `${randomBytes(32).toString("base64url")}\n`);
    await expect(
      startService({ config: { http: { enabled: true, port: 0, auth: { tokenFile } } } }),
    ).rejects.toMatchObject({ code: "CONFIG_ERROR", message: expect.stringMatching(/holds a different http-token/) });
    expect(await stat(tokenFile)).toBeTruthy();
  });

  it("rotation is refused while the service runs and replaces the secrets once it is stopped", async () => {
    const { rotateSecrets } = await import("../../src/cli/secrets.js");
    const started = await startService();
    const before = (await store().read("service"))!;
    await expect(rotateSecrets({ stateDir, privateFiles }, ["service-token"])).rejects.toMatchObject({
      code: "OPERATION_FAILED",
      message: expect.stringMatching(/running/),
    });
    await started.service.shutdown("test");
    services.length = 0;
    const out = await rotateSecrets({ stateDir, privateFiles }, ["service-token", "http-token"]);
    expect(out).toMatch(/rotated service-token/);
    expect(out).toMatch(/crot-mcp secrets show http-token/);
    const after = (await store().read("service"))!;
    expect(after).not.toBe(before);
    expect(after).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // The next service uses the new credential.
    await startService();
    const client = await mcpClient();
    expect((await crotStatus(client)).service.state).toBe("running");
    await client.close();
  });
});
