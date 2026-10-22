import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, inject, it } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { TrayToolClient } from "../../src/tray/tool-client.js";
import { makeTempDirs, makeServiceHost, type TempDirs, type ServiceHost } from "../helpers.js";

let dirs: TempDirs, host: ServiceHost, client: TrayToolClient;
const bin = inject("crotMcpBin");
beforeEach(async () => {
  dirs = await makeTempDirs();
  host = await makeServiceHost(dirs.outside);
  client = new TrayToolClient({
    command: process.execPath,
    entry: bin,
    args: ["--workspace", dirs.workspace, "--no-audit"],
    env: host.env,
  });
});
afterEach(async () => {
  await client?.close();
  await host?.cleanup(bin);
  await dirs?.cleanup();
});
it("uses a real CrotService and ordinary guarded filesystem operations, not an owner bypass", async () => {
  await writeFile(path.join(dirs.workspace, "visible.txt"), "hello from real service");
  await writeFile(path.join(dirs.outside, "private.txt"), "must not be readable");
  const list = (await client.call("fs_list_directory", { path: "." })) as CallToolResult;
  expect(list.isError).not.toBe(true);
  const first = list.content[0];
  expect(first?.type).toBe("text");
  expect(first?.type === "text" ? JSON.parse(first.text) : null).toMatchObject({
    entries: expect.arrayContaining([expect.objectContaining({ path: "visible.txt", type: "file" })]),
  });
  const read = (await client.call("fs_read_file", { path: "visible.txt" })) as CallToolResult;
  expect(read.content).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ type: "text", text: expect.stringContaining("hello from real service") }),
    ]),
  );
  const denied = (await client.call("fs_read_file", {
    path: path.join(dirs.outside, "private.txt"),
  })) as CallToolResult;
  expect(denied.isError).toBe(true);
  expect(JSON.stringify(denied)).not.toContain("must not be readable");
  await expect(client.call("network_request", { url: "https://example.com" })).rejects.toThrow(
    "Unsupported UI operation",
  );
});
