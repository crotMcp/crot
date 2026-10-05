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
import { ControlClient } from "../../src/service/control-client.js";
import {
  credentialFile,
  fileCredentialStore,
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

const store = (): CredentialStore => fileCredentialStore(stateDir, privateFiles);

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
    });
  });
  return { channel, answer };
}

async function mcpClient(): Promise<Client> {
  const { channel, answer } = await shimConnect();
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
