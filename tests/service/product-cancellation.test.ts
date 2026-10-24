import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { createPrivateFileProtection } from "../../src/core/platform/private-files.js";
import { prepareSecretStore } from "../../src/service/secrets/store.js";
import { ProductRuntime, productPaths } from "../../src/service/product-runtime.js";
import { createTestCore, makeTempDirs, testContext } from "../helpers.js";

it("cancels a background process even when its ID arrives after task cancellation", async () => {
  const dirs = await makeTempDirs();
  const core = await createTestCore({ workspace: { root: dirs.workspace }, permissions: { mode: "full_control" } });
  let runtime: ProductRuntime | undefined;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let started!: () => void;
  const ready = new Promise<void>((resolve) => (started = resolve));
  let execution: Promise<unknown> | undefined;
  try {
    const privateFiles = createPrivateFileProtection(process.platform === "win32");
    const stateDir = path.join(dirs.outside, "state");
    const { store } = await prepareSecretStore({ stateDir, privateFiles, preference: "file" });
    runtime = await ProductRuntime.open({
      stateDir,
      privateFiles,
      secrets: store,
      core: () => core,
      selectWorkspace: async () => {},
    });
    execution = runtime.execute("processes", "start", [testContext], async (args) => {
      const result = await core.processes.start(args[0] as typeof testContext, {
        command: process.execPath,
        args: ["-e", "setInterval(()=>{},1000)"],
      });
      started();
      await gate;
      return result;
    });
    await Promise.race([
      ready,
      execution.then(() => {
        throw new Error("Expected pending startup");
      }),
    ]);
    const listing = await runtime.request("tasks.list", {});
    const task = (listing.tasks as { id: string; state: string }[])[0]!;
    expect(task.state).toBe("Running");
    await runtime.request("tasks.cancel", { id: task.id });
    release();
    const result = (await execution) as { id: string };
    const processes = await core.processes.list(testContext);
    expect(processes.find((p) => p.id === result.id)?.endedAt).toBeTruthy();
    const after = await runtime.request("tasks.list", {});
    expect((after.tasks as { state: string }[])[0]?.state).toBe("Cancelled");
  } finally {
    release();
    await execution?.catch(() => undefined);
    await runtime?.close();
    await core.shutdown();
    await dirs.cleanup();
  }
});

it("policy persistence fails closed on audit failure and recovers an interrupted pre-audit snapshot", async () => {
  const dirs = await makeTempDirs();
  const core = await createTestCore({ workspace: { root: dirs.workspace } });
  const privateFiles = createPrivateFileProtection(process.platform === "win32");
  const stateDir = path.join(dirs.outside, "security-state");
  const { store } = await prepareSecretStore({ stateDir, privateFiles, preference: "file" });
  let runtime: ProductRuntime | undefined,
    staged = "",
    refuse = false;
  const host = {
    stateDir,
    privateFiles,
    secrets: store,
    core: () => core,
    selectWorkspace: async () => {},
    recordControlEvent: async () => {
      staged = await readFile(productPaths(stateDir)[0]!, "utf8");
      if (refuse) throw new Error("audit unavailable");
    },
  };
  try {
    runtime = await ProductRuntime.open(host);
    const policy = { strict: true, rules: [] };
    refuse = true;
    await expect(runtime.request("security.setPolicy", policy)).rejects.toThrow("audit unavailable");
    expect(core.permissions.runtime.policy.strict).toBe(false);
    expect(JSON.parse(await readFile(productPaths(stateDir)[0]!, "utf8")).security.strict).toBe(false);
    refuse = false;
    await runtime.request("security.setPolicy", policy);
    expect(core.permissions.runtime.policy.strict).toBe(true);
    expect(JSON.parse(staged).securityPrevious.strict).toBe(false);
    await runtime.close();
    runtime = undefined;
    // Model a crash after staging but before the audit/commit boundary.
    await writeFile(productPaths(stateDir)[0]!, staged);
    runtime = await ProductRuntime.open(host);
    expect(core.permissions.runtime.policy.strict).toBe(false);
    const persisted = JSON.parse(await readFile(productPaths(stateDir)[0]!, "utf8"));
    expect(persisted.security.strict).toBe(false);
    expect(persisted.securityPrevious).toBeUndefined();
  } finally {
    await runtime?.close();
    await core.shutdown();
    await dirs.cleanup();
  }
});
