/**
 * WP-31: untrusted sources cannot change the remote profile, the preset or the
 * full-control opt-in, and cannot approve their own operations.
 *
 * Agents (local or through the relay entry point, which serves the same MCP
 * tools) reach CROT only through the tools; the device state behind the tray
 * controls is changed only on the authenticated control channel (AD-19).
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { localContextResolver } from "../../src/adapters/mcp/context.js";
import { createCrotMcpServer } from "../../src/adapters/mcp/server.js";
import { TOOLS } from "../../src/adapters/mcp/tools.js";
import type { CrotCore, CrotCoreOptions } from "../../src/core/crot-core.js";
import { serviceProtectedPaths } from "../../src/service/endpoints.js";
import { CONTROL_METHODS, parseControlRequest } from "../../src/service/protocol.js";
import { createTestCore, makeTempDirs, type TempDirs } from "../helpers.js";

let dirs: TempDirs;
let core: CrotCore | undefined;
let client: Client | undefined;

async function connect(config: unknown, options: CrotCoreOptions = {}) {
  core = await createTestCore(config, undefined, options);
  const server = createCrotMcpServer(core, { resolveContext: localContextResolver("in-memory") });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test-client", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
}

async function call(name: string, args: Record<string, unknown> = {}) {
  const result = (await client!.callTool({ name, arguments: args })) as CallToolResult;
  const first = result.content[0];
  const body = first && first.type === "text" ? JSON.parse(first.text) : undefined;
  return { isError: result.isError === true, body };
}

beforeEach(async () => {
  dirs = await makeTempDirs();
});
afterEach(async () => {
  await client?.close();
  await core?.shutdown();
  client = undefined;
  core = undefined;
  await dirs.cleanup();
});

describe("no tool reaches the device controls", () => {
  it("no MCP tool is a control method or names presets, full control, approvals or pairing", async () => {
    await connect({ workspace: { root: dirs.workspace } });
    const { tools } = await client!.listTools();
    const names = tools.map((t) => t.name);
    expect(names.sort()).toEqual(TOOLS.map((t) => t.name).sort());
    const control = new Set(CONTROL_METHODS.map((m) => m.replace(/\./g, "_")));
    for (const name of names) {
      expect(control.has(name)).toBe(false);
      expect(name).not.toMatch(/preset|full_?control|approv|pairing|unpair|revoke|regrant|untrusted/i);
    }
  });

  it("tools cannot modify the device settings, the client list or the binding, even in full_control", async () => {
    const stateDir = path.join(dirs.outside, "state");
    await mkdir(stateDir);
    const files = serviceProtectedPaths(stateDir);
    for (const file of files) await writeFile(file, "original");
    await connect(
      { workspace: { root: dirs.workspace }, permissions: { mode: "full_control" } },
      { protectedPaths: files },
    );
    for (const file of files) {
      const { isError } = await call("fs_write_file", { path: file, content: '{"remoteFullControl":true}' });
      expect(isError).toBe(true);
      expect(await readFile(file, "utf8")).toBe("original");
    }
  });

  it("tool calls leave the remote profile of the running Core unchanged", async () => {
    await connect({ workspace: { root: dirs.workspace } });
    const before = JSON.stringify(core!.permissions.remoteProfile);
    await call("crot_status");
    await call("fs_write_file", { path: "a.txt", content: "x" });
    expect(JSON.stringify(core!.permissions.remoteProfile)).toBe(before);
    expect(core!.permissions.remoteProfile.fullControl.enabled).toBe(false);
  });
});

describe("the control channel accepts no wider request than the tray sends", () => {
  it("remote.setFullControl names no device, account or client: it applies only to the device paired here", () => {
    for (const params of [
      { enabled: true, deviceId: "other-device" },
      { enabled: true, accountId: "other-account" },
      { enabled: true, clientId: "client-a" },
      { enabled: "true" },
    ])
      expect(parseControlRequest({ t: "request", id: 1, method: "remote.setFullControl", params })).toBeUndefined();
    expect(
      parseControlRequest({ t: "request", id: 1, method: "remote.setFullControl", params: { enabled: true } }),
    ).toEqual({ t: "request", id: 1, method: "remote.setFullControl", params: { enabled: true } });
  });

  it("an approval names its subject: approving without the subject digest is malformed", () => {
    expect(
      parseControlRequest({
        t: "request",
        id: 2,
        method: "approvals.decide",
        params: { requestId: "r1", decision: "approve" },
      }),
    ).toBeUndefined();
    expect(
      parseControlRequest({ t: "request", id: 3, method: "preset.set", params: { value: "full-control" } }),
    ).toBeUndefined();
  });
});

describe("crot_status reports the remote profile (end to end through the MCP adapter)", () => {
  it("default: workspace only, untrusted-content protection on, full control off", async () => {
    await connect({ workspace: { root: dirs.workspace }, permissions: { mode: "full_control" } });
    const { isError, body } = await call("crot_status");
    expect(isError).toBe(false);
    expect(body.mode).toBe("full_control");
    expect(body.remote).toMatchObject({
      mode: "sandbox",
      untrustedContent: "require-approval",
      fullControl: { enabled: false },
    });
    expect(body.remote.capabilities).not.toContain("filesystem.full");
    expect(Array.isArray(body.remote.restrictions)).toBe(true);
  });

  it("with the opt-in: full control for the bound device only, local mode unchanged", async () => {
    await connect(
      { workspace: { root: dirs.workspace } },
      { remoteProfile: { fullControl: { deviceId: "dev-1", accountId: "acct-1" } } },
    );
    const { isError, body } = await call("crot_status");
    expect(isError).toBe(false);
    expect(body.mode).toBe("sandbox");
    expect(body.remote.mode).toBe("sandbox");
    expect(body.remote.fullControl).toMatchObject({ enabled: true, deviceId: "dev-1", accountId: "acct-1" });
    expect(body.remote.restrictions.join(" ")).toMatch(/dev-1/);
    expect(body.remote.restrictions.join(" ")).toMatch(/L1/);
  });
});
