import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BrowserConnection, BrowserConnectionState } from "../../src/core/capabilities/browser/connection.js";
import type { CrotCore } from "../../src/core/crot-core.js";
import { createTestCore, makeTempDirs, testContext as ctx, type TempDirs } from "../helpers.js";

class StubConnection implements BrowserConnection {
  requests = 0;
  constructor(public current: BrowserConnectionState) {}
  state(): BrowserConnectionState {
    return this.current;
  }
  async request(): Promise<unknown> {
    this.requests++;
    return { tabs: [] };
  }
}

const CONNECTED: BrowserConnectionState = {
  kind: "connected",
  browser: { name: "Chrome", version: "130.0.0.0", extensionVersion: "0.1.0" },
  connectionId: "c0ffee00c0ffee00c0ffee00c0ffee00",
};

let dirs: TempDirs;
let core: CrotCore | undefined;

beforeEach(async () => {
  dirs = await makeTempDirs();
});
afterEach(async () => {
  await core?.shutdown();
  core = undefined;
  await dirs.cleanup();
});

describe("Core browser capability", () => {
  it("is disabled without a browser connection and reports browser.* as enforced", async () => {
    core = await createTestCore({ workspace: { root: dirs.workspace } });
    const status = core.status();
    expect(status.browser).toEqual({ state: "disabled" });
    for (const capability of ["browser.read", "browser.control"]) {
      expect(status.capabilities.find((c) => c.capability === capability)).toEqual({
        capability,
        granted: false,
        enforced: true,
      });
    }
    await expect(core.browser.listTabs(ctx)).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  });

  it("keeps every other capability working when another instance owns the bridge", async () => {
    const connection = new StubConnection({ kind: "in_use" });
    core = await createTestCore(
      {
        workspace: { root: dirs.workspace },
        permissions: {
          mode: "sandbox",
          capabilities: ["filesystem.read", "filesystem.write", "shell.execute", "browser.read", "browser.control"],
        },
      },
      undefined,
      { browser: connection },
    );
    expect(core.status().browser).toEqual({ state: "in_use" });
    await expect(core.browser.listTabs(ctx)).rejects.toMatchObject({ code: "BROWSER_BRIDGE_IN_USE" });
    await expect(core.browser.openTab(ctx, { url: "https://example.com/" })).rejects.toMatchObject({
      code: "BROWSER_BRIDGE_IN_USE",
    });
    await expect(core.browser.status(ctx)).resolves.toMatchObject({ state: "in_use" });

    await core.filesystem.writeFile(ctx, { path: "note.txt", content: "still working" });
    await expect(core.filesystem.readFile(ctx, { path: "note.txt" })).resolves.toMatchObject({
      content: "still working",
    });
    const exec = await core.processes.exec(ctx, {
      command: process.execPath,
      args: ["-e", "process.stdout.write('ok')"],
    });
    expect(exec).toMatchObject({ exitCode: 0, stdout: "ok" });
    expect(connection.requests).toBe(0);
  });

  it("uses the browser once connected (FULL_CONTROL)", async () => {
    const connection = new StubConnection(CONNECTED);
    core = await createTestCore(
      { workspace: { root: dirs.workspace }, permissions: { mode: "full_control" } },
      undefined,
      { browser: connection },
    );
    expect(core.status().browser).toEqual({ state: "connected" });
    await expect(core.browser.listTabs(ctx)).resolves.toEqual({ tabs: [] });
    expect(connection.requests).toBe(1);
  });

  it("refuses browser operations after shutdown", async () => {
    const connection = new StubConnection(CONNECTED);
    core = await createTestCore(
      { workspace: { root: dirs.workspace }, permissions: { mode: "full_control" } },
      undefined,
      { browser: connection },
    );
    await core.shutdown();
    await expect(core.browser.listTabs(ctx)).rejects.toMatchObject({ code: "OPERATION_FAILED" });
    expect(connection.requests).toBe(0);
  });
});
