import { writeFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { localContextResolver } from "../../src/adapters/mcp/context.js";
import { createCrotMcpServer } from "../../src/adapters/mcp/server.js";
import { TOOLS } from "../../src/adapters/mcp/tools.js";
import { MemoryAuditSink } from "../../src/core/audit/audit.js";
import type { CrotCore } from "../../src/core/crot-core.js";
import { createTestCore, makeTempDirs, type TempDirs } from "../helpers.js";

let dirs: TempDirs;
let core: CrotCore;
let client: Client;
let audit: MemoryAuditSink;

async function connect(config: unknown) {
  audit = new MemoryAuditSink();
  core = await createTestCore(config, audit);
  const server = createCrotMcpServer(core, { resolveContext: localContextResolver("in-memory") });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test-client", version: "1.2.3" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
}

async function call(name: string, args: Record<string, unknown> = {}) {
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
  const first = result.content[0];
  const body = first && first.type === "text" ? JSON.parse(first.text) : undefined;
  return { isError: result.isError === true, body };
}

beforeEach(async () => {
  dirs = await makeTempDirs();
  await connect({ workspace: { root: dirs.workspace } });
});
afterEach(async () => {
  await client.close();
  await core.shutdown();
  await dirs.cleanup();
});

describe("CROT MCP adapter", () => {
  it("lists every tool with an explicit input schema", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(TOOLS.map((t) => t.name).sort());
    for (const t of tools) {
      expect(t.inputSchema.type).toBe("object");
      expect(t.description).toBeTruthy();
    }
    const read = tools.find((t) => t.name === "fs_read_file")!;
    expect(read.inputSchema.required).toEqual(["path"]);
    expect(read.annotations?.readOnlyHint).toBe(true);
  });

  it("publishes server instructions with mode and workspace", async () => {
    expect(client.getInstructions()).toContain("Permission mode: sandbox");
    expect(client.getInstructions()).toContain(dirs.workspace);
    expect(client.getInstructions()).toContain(`Operating system: ${core.platform.info.os}`);
    expect(client.getInstructions()).toContain(`default shell for shell_run: ${core.platform.info.defaultShell}`);
  });

  it("reports status", async () => {
    const { isError, body } = await call("crot_status");
    expect(isError).toBe(false);
    expect(body.mode).toBe("sandbox");
    expect(body.workspace.root).toBe(dirs.workspace);
    expect(body.platform.shells.length).toBeGreaterThan(0);
  });

  it("delegates filesystem tools to Core", async () => {
    expect((await call("fs_write_file", { path: "hello.txt", content: "hi" })).body).toEqual({
      path: "hello.txt",
      bytesWritten: 2,
      created: true,
    });
    expect((await call("fs_read_file", { path: "hello.txt" })).body.content).toBe("hi");
    expect((await call("fs_list_directory")).body.entries).toEqual([{ path: "hello.txt", type: "file", size: 2 }]);
  });

  it("delegates process tools to Core", async () => {
    const { body } = await call("process_exec", { command: process.execPath, args: ["-e", "console.log(6*7)"] });
    expect(body.exitCode).toBe(0);
    expect(body.stdout.trim()).toBe("42");
  });

  it("returns permission denials as tool errors and audits them with the client identity", async () => {
    await writeFile(path.join(dirs.outside, "secret.txt"), "s");
    const { isError, body } = await call("fs_read_file", { path: path.join(dirs.outside, "secret.txt") });
    expect(isError).toBe(true);
    expect(body.error.code).toBe("PERMISSION_DENIED");
    const event = audit.events.at(-1)!;
    expect(event.outcome).toBe("denied");
    expect(event.principal).toEqual({ id: "local-user", kind: "local", transport: "in-memory", client: { name: "test-client", version: "1.2.3" } });
  });

  it("rejects invalid input", async () => {
    const result = (await client.callTool({ name: "fs_read_file", arguments: { path: 42 } })) as CallToolResult;
    expect(result.isError).toBe(true);
    const unknown = (await client.callTool({ name: "fs_read_file", arguments: { path: "a", bogus: true } })) as CallToolResult;
    expect(unknown.isError).toBe(true);
  });

  it("reflects full_control mode", async () => {
    await client.close();
    await core.shutdown();
    await connect({ workspace: { root: dirs.workspace }, permissions: { mode: "full_control" } });
    const { isError } = await call("fs_write_file", { path: path.join(dirs.outside, "ok.txt"), content: "ok" });
    expect(isError).toBe(false);
  });
});
