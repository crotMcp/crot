import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, inject, it } from "vitest";
import { TrayToolClient } from "../../src/tray/tool-client.js";
import { ControlClient } from "../../src/service/control-client.js";
import { createPrivateFileProtection } from "../../src/core/platform/private-files.js";
import { makeTempDirs, makeServiceHost, type ServiceHost, type TempDirs, waitFor, stopService } from "../helpers.js";
const bin = inject("crotMcpBin");
let dirs: TempDirs, host: ServiceHost, client: TrayToolClient, control: ControlClient | undefined;
afterEach(async () => {
  control?.close();
  await client?.close();
  await host?.cleanup(bin);
  await dirs?.cleanup();
});
it(
  "real owner grant/revoke drains an actor holding an open secret fd, preserves exact scope across restart and audits without secret content",
  { timeout: 90000 },
  async () => {
    dirs = await makeTempDirs();
    host = await makeServiceHost(dirs.outside);
    const config = path.join(dirs.outside, "config.json"),
      audit = path.join(dirs.outside, "audit.jsonl");
    await writeFile(
      config,
      JSON.stringify({
        workspace: { root: dirs.workspace },
        permissions: { mode: "full_control", approvals: { untrustedContent: "off" } },
        audit: { sink: "file", path: audit },
      }),
    );
    await writeFile(path.join(dirs.workspace, ".env"), "UNLOGGED_SECRET_VALUE");
    await writeFile(path.join(dirs.workspace, "other.pem"), "OTHER_PRIVATE");
    const connect = async () => {
      client = new TrayToolClient({ command: process.execPath, entry: bin, args: ["--config", config], env: host.env });
      await call("crot_status");
      control = await ControlClient.connect({
        stateDir: host.stateDir,
        privateFiles: createPrivateFileProtection(process.platform === "win32"),
      });
      expect(control).toBeDefined();
    };
    const call = async (name: string, args: unknown = {}) => {
      const r = (await client.call(name, args)) as { isError?: boolean; content: { text?: string }[] };
      if (r.isError) throw Error(JSON.stringify(r));
      return JSON.parse(r.content[0]!.text!) as Record<string, unknown>;
    };
    const rpc = async (method: string, params: Readonly<Record<string, unknown>> = {}) =>
      (await control!.request(
        method as import("../../src/service/protocol.js").ControlRequest["method"],
        params,
      )) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    await connect();
    await expect(call("fs_read_file", { path: ".env" })).rejects.toThrow("PERMISSION_DENIED");
    await expect(
      rpc("security.secretFiles.set", { workspace: dirs.outside, path: ".env", allow: true }),
    ).rejects.toThrow();
    expect(
      (await rpc("security.secretFiles.set", { workspace: dirs.workspace, path: ".env", allow: true })).drained,
    ).toBe(true);
    expect((await call("fs_read_file", { path: ".env" })).content).toBe("UNLOGGED_SECRET_VALUE");
    await expect(call("fs_read_file", { path: "other.pem" })).rejects.toThrow("PERMISSION_DENIED");
    const heartbeat = path.join(dirs.workspace, "heartbeat.txt");
    const started = await call("process_start", {
      command: process.execPath,
      args: [
        "-e",
        `const fs=require('fs');const fd=fs.openSync('.env','r');setInterval(()=>{const b=Buffer.alloc(32);fs.readSync(fd,b,0,32,0);fs.appendFileSync('heartbeat.txt','x');},20)`,
      ],
    });
    await waitFor(async () => (await readFile(heartbeat, "utf8").catch(() => "")).length > 2);
    const result = await rpc("security.secretFiles.set", { workspace: dirs.workspace, path: ".env", allow: false });
    expect(result.drained).toBe(true);
    const stopped = await readFile(heartbeat, "utf8");
    await new Promise((r) => setTimeout(r, 120));
    expect(await readFile(heartbeat, "utf8")).toBe(stopped);
    expect(typeof started.id).toBe("string");
    await expect(call("fs_read_file", { path: ".env" })).rejects.toThrow("PERMISSION_DENIED");
    // The same transport continues through the new Core; revocation is not a permanent emergency stop.
    expect(
      (await call("fs_write_file", { path: "public.txt", content: "still working" })).bytesWritten,
    ).toBeGreaterThan(0);
    const state = await rpc("security.secretFiles.status");
    expect(state.policy.allow).toEqual([]);
    expect(state.halted).toBe(false);
    const records = await readFile(audit, "utf8");
    expect(records).toContain('"action":"project_secret_access"');
    expect(records).not.toContain("UNLOGGED_SECRET_VALUE");
    control!.close();
    control = undefined;
    await client.close();
    await stopService(bin, host.env);
    await connect();
    expect((await rpc("security.secretFiles.status")).policy.allow).toEqual([]);
    await expect(call("fs_read_file", { path: ".env" })).rejects.toThrow("PERMISSION_DENIED");
  },
);
