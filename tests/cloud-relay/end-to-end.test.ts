import { Client as ModernClient, StreamableHTTPClientTransport as ModernTransport } from "@modelcontextprotocol/client";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CrotHttpServer, LEGACY_PROTOCOL_VERSIONS, type RemoteAdmission } from "../../src/adapters/http/server.js";
import { MemoryAuditSink } from "../../src/core/audit/audit.js";
import { HttpConfigSchema } from "../../src/core/config/schema.js";
import type { CrotCore } from "../../src/core/crot-core.js";
import { IssuerKeySet } from "../../src/identity/jwks.js";
import { OAuthAccessTokenVerifier } from "../../src/identity/verifier.js";
import { OUTCOME_HEADER } from "../../src/tunnel/protocol.js";
import { TestProvider } from "../approval-provider.js";
import { createTestCore, makeTempDirs, type TempDirs } from "../helpers.js";
import { TEST_RELAY } from "../identity/test-authorization-server.js";
import { RelayHarness, waitFor, type PairedDevice } from "./harness.js";
import type { TestDevice } from "./test-device.js";

/**
 * WP-29 acceptance (roadmap): SDK clients reach a test device through the
 * relay with every supported protocol version, including streamed responses
 * and a gated request waiting for approval; payloads never appear in relay
 * logs; identity headers are ignored by the device. The device side is the
 * real HTTP pipeline (relay entry point, OAuth verifier, Core); the tunnel
 * client in front of it is a test stand-in for WP-30 that only rewrites the
 * two checks AD-22 point 7 replaces (Host, path).
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
let device: TestDevice;
const closers: (() => Promise<unknown>)[] = [];

beforeEach(async () => {
  h = await new RelayHarness().start();
  dirs = await makeTempDirs();
  audit = new MemoryAuditSink();
  ui = new TestProvider();
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
  device = await h.online(paired);
  const local = new URL(server.url);
  device.proxyTo(local.origin, { path: local.pathname, host: local.host });
});

afterEach(async () => {
  for (const close of closers.splice(0)) await close().catch(() => undefined);
  await h.stop();
  await server.close();
  await core.shutdown();
  await dirs.cleanup();
});

async function modern(token = h.clientToken(paired), extra: Record<string, string> = {}): Promise<ModernClient> {
  const client = new ModernClient({ name: "remote-modern", version: "1.0.0" }, {
    versionNegotiation: { mode: { pin: MODERN } },
  } as never);
  await client.connect(
    new ModernTransport(new URL(h.url(paired)), {
      requestInit: { headers: { Authorization: `Bearer ${token}`, ...extra } },
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

describe("SDK clients through the relay (WP-29 acceptance)", () => {
  it("2026-07-28 client: tools list and a call run on the device as a remote principal", async () => {
    const client = await modern();
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toContain("fs_read_file");
    await writeFile(path.join(dirs.workspace, "hello.txt"), "hello from the device");
    const read = await client.callTool({ name: "fs_read_file", arguments: { path: "hello.txt" } });
    expect(text(read)).toContain("hello from the device");
    const principal = audit.events.at(-1)!.principal;
    expect(principal).toMatchObject({
      kind: "remote",
      transport: "relay",
      authMethod: "oauth",
      accountId: "user_01",
      deviceId: paired.deviceId,
    });
  });

  it("legacy session client (latest legacy version) works, sessions included", async () => {
    const client = await legacy();
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);
    const transport = (client as unknown as { _transport: { sessionId?: string } })._transport;
    expect(transport.sessionId).toBeTruthy();
  });

  it("every legacy protocol version initializes through the relay", async () => {
    for (const version of LEGACY_PROTOCOL_VERSIONS) {
      const res = await fetch(h.url(paired), {
        method: "POST",
        headers: {
          authorization: `Bearer ${h.clientToken(paired)}`,
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
      expect(res.status).toBe(200);
      expect(await res.text()).toContain(`"protocolVersion":"${version}"`);
    }
  });

  it("a gated request waits for approval through the relay and completes", async () => {
    const client = await modern();
    const writing = client.callTool({ name: "fs_write_file", arguments: { path: "remote.txt", content: "hello" } });
    await ui.next();
    ui.approveLast();
    expect(((await writing) as CallToolResult).isError).not.toBe(true);
    expect(await readFile(path.join(dirs.workspace, "remote.txt"), "utf8")).toBe("hello");
  });

  it("closing the client request cancels a pending approval on the device (AD-22 point 13)", async () => {
    const controller = new AbortController();
    const pending = fetch(h.url(paired), {
      method: "POST",
      signal: controller.signal,
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
          arguments: { path: "never.txt", content: "x" },
          _meta: {
            "io.modelcontextprotocol/protocolVersion": MODERN,
            "io.modelcontextprotocol/clientInfo": { name: "raw", version: "1" },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    }).catch((e: unknown) => e);
    const shown = await ui.next();
    controller.abort();
    await pending;
    expect(await device.opened.at(-1)!.reset()).toBe("cancel");
    await waitFor(() => ui.ended.some((e) => e.requestId === shown.request.requestId));
    expect(ui.ended.find((e) => e.requestId === shown.request.requestId)!.status).toBe("cancelled");
    await expect(readFile(path.join(dirs.workspace, "never.txt"))).rejects.toThrow();
  });

  it("identity headers injected by the client are ignored by the device", async () => {
    const client = await modern(h.clientToken(paired), {
      "x-crot-principal": "local",
      "x-crot-account": "attacker",
      "x-forwarded-for": "10.0.0.1",
    });
    await writeFile(path.join(dirs.workspace, "a.txt"), "a");
    await client.callTool({ name: "fs_read_file", arguments: { path: "a.txt" } });
    expect(audit.events.at(-1)!.principal).toMatchObject({ kind: "remote", accountId: "user_01" });
  });

  it("the device refuses a token the relay would also refuse; the relay refuses first", async () => {
    const other = h.newDevice("user_01");
    const res = await fetch(h.url(paired), {
      method: "POST",
      headers: { authorization: `Bearer ${h.clientToken(other)}`, "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(401);
    expect(res.headers.get(OUTCOME_HEADER)).toBe("not_executed");
    expect(device.opened).toHaveLength(0);
  });

  it("payloads and tokens never appear in relay logs", async () => {
    const token = h.clientToken(paired);
    const client = await modern(token);
    const writing = client.callTool({
      name: "fs_write_file",
      arguments: { path: "secret.txt", content: "PAYLOAD-MARKER-123" },
    });
    await ui.next();
    ui.approveLast();
    await writing;
    const logs = h.logText();
    expect(logs).not.toContain("PAYLOAD-MARKER-123");
    expect(logs).not.toContain(token);
    expect(logs).not.toContain("secret.txt");
    expect(logs).toContain('"mcpMethod":"tools/call"');
  });
});
