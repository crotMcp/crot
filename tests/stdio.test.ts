import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempDirs, type TempDirs } from "./helpers.js";

const bin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "bin", "crot-mcp.js");

let dirs: TempDirs;
beforeEach(async () => {
  dirs = await makeTempDirs();
});
afterEach(() => dirs.cleanup());

// End-to-end check of the built stdio server; run `npm run build` first (CI does).
describe.skipIf(!existsSync(bin))("crot-mcp stdio server (built)", () => {
  it("serves tools over stdio", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [bin, "--workspace", dirs.workspace, "--no-audit"],
      stderr: "pipe",
    });
    const client = new Client({ name: "stdio-test", version: "0.0.0" });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      expect(tools.some((t) => t.name === "fs_write_file")).toBe(true);
      await client.callTool({ name: "fs_write_file", arguments: { path: "e2e.txt", content: "ok" } });
      const result = (await client.callTool({ name: "fs_read_file", arguments: { path: "e2e.txt" } })) as CallToolResult;
      const first = result.content[0];
      expect(first?.type === "text" && JSON.parse(first.text).content).toBe("ok");
    } finally {
      await client.close();
    }
  });
});
