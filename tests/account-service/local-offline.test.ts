import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Client as ModernClient, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { describe, expect, inject, it } from "vitest";
import { CrotHttpServer } from "../../src/adapters/http/server.js";
import { LocalTokenVerifier } from "../../src/adapters/http/auth.js";
import { HttpConfigSchema } from "../../src/core/config/schema.js";
import { AccountService } from "../../src/account-service/service.js";
import { createTestCore, makeServiceHost, makeTempDirs } from "../helpers.js";
const bin = inject("crotMcpBin");
describe("Local / Free is independent of cloud commercial admission", () => {
  it("stdio and loopback still execute filesystem tools while cloud is unentitled and network is unavailable", async () => {
    const dirs = await makeTempDirs();
    const accounts = await AccountService.open(path.join(dirs.outside, "free-accounts.json"));
    expect(accounts.snapshot("no_account").entitled).toBe(false);
    const host = await makeServiceHost(dirs.outside);
    const client = new Client({ name: "wp36-local-stdio", version: "1" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [bin, "--workspace", dirs.workspace, "--no-audit"],
      env: { ...host.env, HTTPS_PROXY: "http://127.0.0.1:1", HTTP_PROXY: "http://127.0.0.1:1" },
      stderr: "pipe",
    });
    const core = await createTestCore({ workspace: { root: dirs.workspace } });
    const token = "local_fixture_token_".repeat(3);
    const server = await CrotHttpServer.start(core, {
      config: HttpConfigSchema.parse({ enabled: true, port: 0 }),
      verifier: new LocalTokenVerifier(token),
    });
    const http = new ModernClient({ name: "wp36-loopback", version: "1" }, {
      versionNegotiation: { mode: { pin: "2026-07-28" } },
    } as never);
    try {
      await client.connect(transport);
      const written = await client.callTool({
        name: "fs_write_file",
        arguments: { path: "local-free.txt", content: "offline-without-account" },
      });
      expect(written.isError).not.toBe(true);
      await http.connect(
        new StreamableHTTPClientTransport(new URL(server.url), {
          requestInit: { headers: { authorization: `Bearer ${token}` } },
        }),
      );
      const read = await http.callTool({ name: "fs_read_file", arguments: { path: "local-free.txt" } });
      expect(read.isError).not.toBe(true);
      expect(JSON.stringify(read)).toContain("offline-without-account");
      expect(accounts.snapshot("no_account")).toMatchObject({ plan: "free", deviceCount: 0 });
    } finally {
      await http.close();
      await client.close();
      await server.close();
      await core.shutdown();
      await host.cleanup(bin);
      await dirs.cleanup();
    }
  });
});
