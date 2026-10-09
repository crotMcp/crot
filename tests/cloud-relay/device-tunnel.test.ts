import { Client as ModernClient, StreamableHTTPClientTransport as ModernTransport } from "@modelcontextprotocol/client";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CrotHttpServer, LEGACY_PROTOCOL_VERSIONS, type RemoteAdmission } from "../../src/adapters/http/server.js";
import { MemoryAuditSink } from "../../src/core/audit/audit.js";
import { HttpConfigSchema } from "../../src/core/config/schema.js";
import type { CrotCore } from "../../src/core/crot-core.js";
import { signTunnelProof } from "../../src/identity/device-credential.js";
import { IssuerKeySet } from "../../src/identity/jwks.js";
import { OAuthAccessTokenVerifier } from "../../src/identity/verifier.js";
import {
  DeviceTunnel,
  DeviceTunnelManager,
  type DeviceTunnelCredential,
  type TunnelEnd,
} from "../../src/tunnel/device-tunnel.js";
import { decodeFrame, encodeJsonFrame, FrameType, OUTCOME_HEADER, TUNNEL_PATH } from "../../src/tunnel/protocol.js";
import { acceptWebSocket } from "../../src/tunnel/websocket.js";
import { TestProvider } from "../approval-provider.js";
import { createTestCore, makeTempDirs, type TempDirs } from "../helpers.js";
import { TEST_RELAY } from "../identity/test-authorization-server.js";
import { RelayHarness, sleep, waitFor, type PairedDevice } from "./harness.js";

/**
 * WP-30 acceptance: the real Cloud Relay (WP-29 harness) → the real device
 * tunnel client → the real relay entry point of the HTTP pipeline (OAuth
 * verifier, Core, approvals, audit). Unlike end-to-end.test.ts, no test
 * stand-in (TestDevice) sits between relay and device: the tunnel under test
 * performs the handshake with the device credential and does the two AD-22
 * point 7 rewrites itself.
 */

const MODERN = "2026-07-28";
const ADMIT_ALL: RemoteAdmission = { admit: () => ({ admitted: true }) };

let h: RelayHarness;
let dirs: TempDirs;
let core: CrotCore;
let server: CrotHttpServer;
let audit: MemoryAuditSink;
let ui: TestProvider;
let paired: PairedDevice;
let tunnel: DeviceTunnel;
let tunnelLogs: string[];
const closers: (() => Promise<unknown>)[] = [];

const tunnelUrl = () => h.origin.replace(/^http/, "ws") + TUNNEL_PATH;

function credentialFor(device: PairedDevice, key = device.key): DeviceTunnelCredential {
  return {
    deviceId: device.deviceId,
    relayHost: TEST_RELAY,
    prove: (challenge) => signTunnelProof(key, device.deviceId, TEST_RELAY, Buffer.from(challenge)),
  };
}

function target(): { host: string; port: number; path: string } {
  const local = new URL(server.url);
  return { host: local.hostname, port: Number(local.port), path: local.pathname };
}

async function openTunnel(device = paired, credential = credentialFor(device)): Promise<DeviceTunnel> {
  const t = new DeviceTunnel({
    url: tunnelUrl(),
    credential,
    target: target(),
    maxStreams: 64,
    log: (m) => tunnelLogs.push(m),
  });
  closers.push(() => t.stop("shutting_down"));
  await t.open();
  return t;
}

beforeEach(async () => {
  h = await new RelayHarness().start();
  dirs = await makeTempDirs();
  audit = new MemoryAuditSink();
  ui = new TestProvider();
  tunnelLogs = [];
  core = await createTestCore(
    {
      workspace: { root: dirs.workspace },
      permissions: {
        mode: "full_control",
        approvals: {
          rules: [{ id: "remote-writes", match: { capabilities: ["filesystem.write"], principalKinds: ["remote"] } }],
        },
      },
    },
    audit,
    { approvalProviders: [ui] },
  );
  paired = h.newDevice("user_01");
  await h.register(paired);
  const binding = {
    state: "paired" as const,
    deviceId: paired.deviceId,
    accountId: paired.accountId,
    issuer: h.as.issuer,
    relayHost: TEST_RELAY,
  };
  server = await CrotHttpServer.start(core, {
    config: HttpConfigSchema.parse({ enabled: true, port: 0 }),
    verifier: new OAuthAccessTokenVerifier({
      environment: h.as.environment(),
      keys: new IssuerKeySet({ issuer: h.as.issuer, http: h.as.http() }),
      binding: () => binding,
    }),
    entryPoint: "relay",
    remoteAdmission: ADMIT_ALL,
  });
  tunnel = await openTunnel();
});

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close().catch(() => undefined);
  await h.stop();
  await server.close();
  await core.shutdown();
  await dirs.cleanup();
});

async function modern(token = h.clientToken(paired)): Promise<ModernClient> {
  const client = new ModernClient({ name: "remote-modern", version: "1.0.0" }, {
    versionNegotiation: { mode: { pin: MODERN } },
  } as never);
  await client.connect(
    new ModernTransport(new URL(h.url(paired)), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  closers.push(() => client.close());
  return client;
}

async function legacy(token = h.clientToken(paired)): Promise<Client> {
  const client = new Client({ name: "remote-legacy", version: "0.0.1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(h.url(paired)), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  closers.push(() => client.close());
  return client;
}

const text = (r: unknown) => {
  const first = (r as CallToolResult).content[0];
  return first && first.type === "text" ? first.text : "";
};

function initialize(token: string, version = MODERN, signal?: AbortSignal): Promise<Response> {
  return fetch(h.url(paired), {
    method: "POST",
    ...(signal ? { signal } : {}),
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: version, capabilities: {}, clientInfo: { name: "raw", version: "1" } },
    }),
  });
}

/** A stateless 2026-07-28 tools/call request (no session needed). */
function rawWrite(file: string, signal?: AbortSignal): Promise<Response> {
  return fetch(h.url(paired), {
    method: "POST",
    ...(signal ? { signal } : {}),
    headers: {
      authorization: `Bearer ${h.clientToken(paired)}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": MODERN,
      "mcp-method": "tools/call",
      "mcp-name": "fs_write_file",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: {
        name: "fs_write_file",
        arguments: { path: file, content: "x" },
        _meta: {
          "io.modelcontextprotocol/protocolVersion": MODERN,
          "io.modelcontextprotocol/clientInfo": { name: "raw", version: "1" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
}

const toolEvents = () => audit.events.filter((e) => (e as { tool?: unknown }).tool !== undefined);

describe("relay → device tunnel → local CROT (WP-30 acceptance)", () => {
  it("a 2026-07-28 client lists and calls tools on the device as a remote principal", async () => {
    expect(tunnel.isReady).toBe(true);
    const client = await modern();
    expect((await client.listTools()).tools.map((t) => t.name)).toContain("fs_read_file");
    await writeFile(path.join(dirs.workspace, "hello.txt"), "hello through the tunnel");
    const read = await client.callTool({ name: "fs_read_file", arguments: { path: "hello.txt" } });
    expect(text(read)).toContain("hello through the tunnel");
    expect(audit.events.at(-1)!.principal).toMatchObject({
      kind: "remote",
      transport: "relay",
      authMethod: "oauth",
      accountId: "user_01",
      deviceId: paired.deviceId,
    });
  });

  it("a legacy session client works through the tunnel", async () => {
    const client = await legacy();
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);
  });

  it("every legacy protocol version initializes through the tunnel", async () => {
    for (const version of LEGACY_PROTOCOL_VERSIONS) {
      const res = await initialize(h.clientToken(paired), version);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain(`"protocolVersion":"${version}"`);
    }
  });

  it("parallel requests are multiplexed and all complete; streams are released", async () => {
    const token = h.clientToken(paired);
    const results = await Promise.all(Array.from({ length: 10 }, () => initialize(token)));
    for (const res of results) {
      expect(res.status).toBe(200);
      await res.text();
    }
    await waitFor(() => tunnel.activeStreams === 0);
  });

  it("a large streamed response crosses several flow-control windows", async () => {
    const big = "y".repeat(2 * 1024 * 1024);
    await writeFile(path.join(dirs.workspace, "big.txt"), big);
    const client = await modern();
    const read = await client.callTool({ name: "fs_read_file", arguments: { path: "big.txt" } });
    expect(text(read).length).toBeGreaterThan(1024 * 1024);
    await waitFor(() => tunnel.activeStreams === 0);
  });

  it("a gated request waits for approval through the tunnel and completes", async () => {
    const client = await modern();
    const writing = client.callTool({ name: "fs_write_file", arguments: { path: "remote.txt", content: "hello" } });
    await ui.next();
    ui.approveLast();
    expect(((await writing) as CallToolResult).isError).not.toBe(true);
    expect(await readFile(path.join(dirs.workspace, "remote.txt"), "utf8")).toBe("hello");
  });

  it("closing the client request cancels a pending approval on the device (AD-22 point 13)", async () => {
    const controller = new AbortController();
    const pending = rawWrite("never.txt", controller.signal).catch((e: unknown) => e);
    const shown = await ui.next();
    controller.abort();
    await pending;
    await waitFor(() => ui.ended.some((e) => e.requestId === shown.request.requestId));
    expect(ui.ended.find((e) => e.requestId === shown.request.requestId)!.status).toBe("cancelled");
    await waitFor(() => tunnel.activeStreams === 0);
    await expect(readFile(path.join(dirs.workspace, "never.txt"))).rejects.toThrow();
  });

  it("tunnel loss during a pending approval: outcome unknown, approval cancelled, nothing re-executed", async () => {
    const pending = rawWrite("lost.txt");
    const shown = await ui.next();
    tunnel.terminate();
    const res = await pending;
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(res.headers.get(OUTCOME_HEADER)).toBe("unknown");
    await res.text();
    await waitFor(() => ui.ended.some((e) => e.requestId === shown.request.requestId));
    expect(ui.ended.find((e) => e.requestId === shown.request.requestId)!.status).toBe("cancelled");
    // A new tunnel starts with no streams: the operation is never replayed.
    tunnel = await openTunnel();
    const shownBefore = ui.ended.length;
    await sleep(300);
    expect(ui.ended.length).toBe(shownBefore);
    expect(tunnel.activeStreams).toBe(0);
    await expect(readFile(path.join(dirs.workspace, "lost.txt"))).rejects.toThrow();
  });

  it("stop(remote_disabled) sends GOAWAY and closes normally", async () => {
    const end: TunnelEnd = await tunnel.stop("remote_disabled");
    expect(end.closeCode).toBe(1000);
    expect(tunnel.isReady).toBe(false);
  });

  it("tunnel logs carry no token, path or payload", async () => {
    const token = h.clientToken(paired);
    const client = await modern(token);
    await writeFile(path.join(dirs.workspace, "secret-name.txt"), "PAYLOAD-MARKER-456");
    await client.callTool({ name: "fs_read_file", arguments: { path: "secret-name.txt" } });
    const logs = tunnelLogs.join("\n");
    expect(logs).not.toContain(token);
    expect(logs).not.toContain("secret-name.txt");
    expect(logs).not.toContain("PAYLOAD-MARKER-456");
  });
});

describe("tokens never execute for another device or account", () => {
  it("a token for another device of the same account is refused, nothing runs", async () => {
    const other = h.newDevice("user_01");
    const before = toolEvents().length;
    const res = await initialize(h.clientToken(other));
    expect([401, 403]).toContain(res.status);
    expect(toolEvents().length).toBe(before);
  });

  it("a token for another account is refused, nothing runs", async () => {
    const foreign = h.newDevice("user_02");
    const before = toolEvents().length;
    const res = await initialize(h.clientToken(foreign));
    expect([401, 403]).toContain(res.status);
    expect(toolEvents().length).toBe(before);
  });

  it("an expired token is refused", async () => {
    const res = await initialize(h.clientToken(paired, { exp: Math.floor(Date.now() / 1000) - 600 }));
    expect(res.status).toBe(401);
  });
});

describe("handshake refusals", () => {
  it("a wrong device key (bad signature) is refused with 4401", async () => {
    const impostor = h.newDevice("user_01");
    const err = await openTunnel(paired, credentialFor(paired, impostor.key)).catch((e: unknown) => e);
    expect((err as TunnelEnd).closeCode).toBe(4401);
  });

  it("an unknown (unregistered) device is refused with 4401", async () => {
    const unknown = h.newDevice("user_01");
    const err = await openTunnel(unknown).catch((e: unknown) => e);
    expect((err as TunnelEnd).closeCode).toBe(4401);
  });

  it("the manager reconnects after a connection loss with backoff", async () => {
    await tunnel.stop("shutting_down");
    const manager = new DeviceTunnelManager({
      credential: () => credentialFor(paired),
      url: () => tunnelUrl(),
      target: target(),
      maxStreams: 64,
      backoff: { baseMs: 10, capMs: 50 },
    });
    closers.push(() => manager.stop("shutting_down"));
    manager.start();
    await waitFor(() => manager.status.state === "ready");
    const first = manager.tunnel!;
    first.terminate();
    await waitFor(() => manager.status.state === "ready" && manager.tunnel !== undefined && manager.tunnel !== first);
    const res = await initialize(h.clientToken(paired));
    expect(res.status).toBe(200);
  });
});

/** A minimal fake relay for refusals the real relay never produces on purpose. */
async function fakeRelay(
  behave: (conn: Awaited<ReturnType<typeof acceptWebSocket>>, frames: number[]) => void,
  protocol = "crot-tunnel.v1",
): Promise<{ url: string; frames: number[]; server: Server }> {
  const frames: number[] = [];
  const srv = createServer();
  srv.on("upgrade", (req, socket, head) => {
    void Promise.resolve(acceptWebSocket(req, socket, head, { protocol, maxMessageBytes: 64 * 1024 })).then((conn) => {
      conn.attach({
        onMessage: (data) => frames.push(decodeFrame(Buffer.from(data as Uint8Array)).type),
        onClose: () => undefined,
      });
      behave(conn, frames);
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  closers.push(() => new Promise((r) => srv.close(() => r(undefined))));
  const port = (srv.address() as AddressInfo).port;
  return { url: `ws://127.0.0.1:${port}${TUNNEL_PATH}`, frames, server: srv };
}

describe("handshake refusals (fake relay)", () => {
  it("an unsupported version (4426) blocks the manager with an hourly retry", async () => {
    const relay = await fakeRelay((conn) => conn.close(4426, "unsupported_version"));
    const manager = new DeviceTunnelManager({
      credential: () => credentialFor(paired),
      url: () => relay.url,
      target: target(),
      maxStreams: 8,
    });
    closers.push(() => manager.stop("shutting_down"));
    manager.start();
    await waitFor(() => manager.status.state === "blocked");
    expect(manager.status.reason).toBe("unsupported_version");
    expect(manager.status.nextAttemptAt! - Date.now()).toBeGreaterThan(30 * 60_000);
  });

  it("a challenge for another relay host is never signed (no HELLO)", async () => {
    const relay = await fakeRelay((conn) => {
      conn.send(
        encodeJsonFrame(
          FrameType.CHALLENGE,
          0,
          { versions: ["v1"], relayHost: "evil.example", challenge: randomBytes(32).toString("base64url") },
          0,
        ),
      );
    });
    const t = new DeviceTunnel({ url: relay.url, credential: credentialFor(paired), target: target(), maxStreams: 8 });
    const err = (await t.open().catch((e: unknown) => e)) as TunnelEnd;
    expect(err.ready).toBe(false);
    expect(err.local).toBe("relay_host_mismatch");
    expect(relay.frames).not.toContain(FrameType.HELLO);
  });
});
