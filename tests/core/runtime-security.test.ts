import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { MemoryAuditSink } from "../../src/core/audit/audit.js";
import { RuntimePermissionState, RuntimePolicySchema } from "../../src/core/permissions/runtime.js";
import { CAPABILITIES } from "../../src/core/permissions/capabilities.js";
import { PermissionEngine } from "../../src/core/permissions/engine.js";
import { createPermissionPolicy } from "../../src/core/permissions/policy.js";
import { TestProvider } from "../approval-provider.js";
import { createTestCore, makeTempDirs, testContext as ctx, waitFor } from "../helpers.js";

describe("Stage A runtime security", () => {
  it("validates exclusive selectors, duplicate rules and immutable snapshots", () => {
    for (const rules of [
      [{ state: "allow" }],
      [{ operation: "filesystem.read_file", capability: "filesystem.read", state: "allow" }],
      [
        { operation: "x", state: "ask" },
        { operation: "x", state: "deny" },
      ],
    ])
      expect(RuntimePolicySchema.safeParse({ strict: false, rules }).success).toBe(false);
    const state = new RuntimePermissionState();
    state.replace({ strict: true, rules: [] });
    state.policy.strict = false;
    expect(state.policy.strict).toBe(true);
    state.stop();
    state.replace({ strict: false, rules: [] });
    expect(state.halted).toBe(true);
  });

  it("allow cannot grant a capability or bypass workspace and service secret ceilings", () => {
    const runtime = new RuntimePermissionState();
    runtime.replace({
      strict: false,
      rules: [
        { capability: "filesystem.read", state: "allow" },
        { capability: "shell.execute", state: "allow" },
      ],
    });
    const engine = new PermissionEngine(
      createPermissionPolicy({ mode: "sandbox", capabilities: ["filesystem.read"] }),
      { runtime, secretPaths: ["/ws/private"] },
    );
    expect(engine.authorize({ context: ctx, capability: "shell.execute" }).allowed).toBe(false);
    for (const [absolute, insideWorkspace] of [
      ["/outside", false],
      ["/ws/private", true],
    ] as const)
      expect(
        engine.authorize({
          context: ctx,
          capability: "filesystem.read",
          paths: [{ absolute, insideWorkspace, relative: null }],
        }).allowed,
      ).toBe(false);
  });

  it("project grants suppress only runtime ask, not another workspace, outside paths, mandatory gates or deny", () => {
    const runtime = new RuntimePermissionState();
    runtime.replace({
      strict: false,
      rules: [{ operation: "filesystem.write_file", state: "ask" }],
      projectGrants: [{ workspace: "/ws", operation: "filesystem.write_file" }],
    });
    const policy = createPermissionPolicy({ mode: "full_control" });
    const engine = new PermissionEngine(policy, {
      runtime,
      workspaceRoot: "/ws",
      approvals: { rules: [], untrustedContent: "off" },
    });
    const request = {
      operation: "filesystem.write_file",
      capabilities: ["filesystem.write" as const],
      paths: [{ absolute: "/ws/a", insideWorkspace: true, relative: "a" }],
    };
    expect(engine.approvalRequirement(ctx, request)).toEqual({ required: false });
    expect(
      new PermissionEngine(policy, { runtime, workspaceRoot: "/other" }).approvalRequirement(ctx, request),
    ).toMatchObject({ required: true });
    expect(
      engine.approvalRequirement(ctx, {
        ...request,
        paths: [{ absolute: "/outside", insideWorkspace: false, relative: null }],
      }),
    ).toMatchObject({ required: true });
    const mandatory = new PermissionEngine(policy, {
      runtime,
      workspaceRoot: "/ws",
      approvals: {
        rules: [{ id: "always-write", match: { operations: ["filesystem.write_file"] } }],
        untrustedContent: "off",
      },
    });
    expect(mandatory.approvalRequirement(ctx, request)).toMatchObject({ required: true, rule: "always-write" });
    runtime.replace({ ...runtime.policy, strict: true });
    expect(engine.approvalRequirement(ctx, request)).toMatchObject({ required: true, rule: "runtime.strict" });
    runtime.replace({ ...runtime.policy, rules: [{ operation: "filesystem.write_file", state: "deny" }] });
    expect(
      engine.authorize({ context: ctx, operation: "filesystem.write_file", capability: "filesystem.write" }),
    ).toMatchObject({ allowed: false });
  });

  it("Strict Mode asks for real file reads and records approval plus execution", async () => {
    const dirs = await makeTempDirs(),
      audit = new MemoryAuditSink(),
      ui = new TestProvider();
    const runtime = new RuntimePermissionState();
    runtime.replace({ strict: true, rules: [] });
    const core = await createTestCore({ workspace: { root: dirs.workspace } }, audit, {
      runtimePermissions: runtime,
      approvalProviders: [ui],
    });
    try {
      await writeFile(path.join(dirs.workspace, "a.txt"), "real-file");
      const work = core.filesystem.readFile(ctx, { path: "a.txt" });
      await ui.next();
      ui.approveLast();
      expect(await work).toMatchObject({ content: "real-file" });
      expect(audit.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            operation: "filesystem.read_file",
            outcome: "success",
            approval: expect.objectContaining({ status: "approved" }),
          }),
        ]),
      );
    } finally {
      await core.shutdown();
      await dirs.cleanup();
    }
  });

  it("deny wins over strict and revokes a pending approved operation before it can execute", async () => {
    const dirs = await makeTempDirs(),
      ui = new TestProvider(),
      runtime = new RuntimePermissionState();
    runtime.replace({ strict: true, rules: [] });
    const core = await createTestCore({ workspace: { root: dirs.workspace } }, undefined, {
      runtimePermissions: runtime,
      approvalProviders: [ui],
    });
    try {
      const work = core.filesystem.writeFile(ctx, { path: "blocked.txt", content: "must-not-exist" });
      const rejected = expect(work).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
      await ui.next();
      runtime.replace({ strict: true, rules: [{ operation: "filesystem.write_file", state: "deny" }] });
      ui.approveLast();
      await rejected;
      await expect(readFile(path.join(dirs.workspace, "blocked.txt"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(core.filesystem.writeFile(ctx, { path: "blocked.txt", content: "x" })).rejects.toMatchObject({
        code: "PERMISSION_DENIED",
      });
      expect(ui.shown).toHaveLength(1);
    } finally {
      await core.shutdown();
      await dirs.cleanup();
    }
  });

  it("operation ask adds a gate while allow cannot remove configured mandatory gates", () => {
    const runtime = new RuntimePermissionState();
    runtime.replace({
      strict: false,
      rules: [
        { operation: "filesystem.read_file", state: "ask" },
        { operation: "filesystem.write_file", state: "allow" },
      ],
    });
    const engine = new PermissionEngine(createPermissionPolicy({ mode: "sandbox" }), {
      runtime,
      approvals: { rules: [{ id: "mandatory", match: { operations: ["filesystem.write_file"] } }] },
    });
    expect(
      engine.approvalRequirement(ctx, { operation: "filesystem.read_file", capabilities: ["filesystem.read"] }),
    ).toMatchObject({ required: true, rule: "runtime.ask" });
    expect(
      engine.approvalRequirement(ctx, { operation: "filesystem.write_file", capabilities: ["filesystem.write"] }),
    ).toMatchObject({ required: true, rule: "mandatory" });
  });

  it("emergency stop terminates an actual process tree, cancels approval and permanently blocks new calls", async () => {
    const dirs = await makeTempDirs(),
      ui = new TestProvider(),
      runtime = new RuntimePermissionState();
    const core = await createTestCore(
      { workspace: { root: dirs.workspace }, permissions: { mode: "full_control" } },
      undefined,
      { runtimePermissions: runtime, approvalProviders: [ui] },
    );
    try {
      const processInfo = await core.processes.start(ctx, {
        command: process.execPath,
        args: ["-e", "setInterval(()=>{},1000)"],
      });
      const pid = processInfo.pid!;
      expect(pid).toBeGreaterThan(0);
      runtime.replace({ strict: true, rules: [] });
      const pending = core.filesystem.writeFile(ctx, { path: "after.txt", content: "no" });
      const rejected = expect(pending).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
      await ui.next();
      const stopping = core.emergencyStop();
      expect(runtime.halted).toBe(true);
      expect(ui.last().ticket.approve(ui.last().request.subjectDigest).ok).toBe(false);
      await rejected;
      await stopping;
      await waitFor(() => {
        try {
          process.kill(pid, 0);
          return false;
        } catch {
          return true;
        }
      });
      await expect(core.filesystem.writeFile(ctx, { path: "after.txt", content: "no" })).rejects.toMatchObject({
        code: "PERMISSION_DENIED",
      });
      await expect(core.processes.start(ctx, { command: process.execPath, args: ["-e", "0"] })).rejects.toMatchObject({
        code: "PERMISSION_DENIED",
      });
      await expect(readFile(path.join(dirs.workspace, "after.txt"))).rejects.toMatchObject({ code: "ENOENT" });
      await core.emergencyStop();
    } finally {
      await core.shutdown();
      await dirs.cleanup();
    }
  });
});

it("named token scopes narrow every Core capability and cannot acquire full_control", () => {
  const engine = new PermissionEngine(createPermissionPolicy({ mode: "full_control" }));
  const expectations = {
    files: ["filesystem.read", "filesystem.write"],
    terminal: ["shell.execute", "process.manage", "git.read", "git.write"],
    browser: ["browser.read", "browser.control"],
  };
  for (const scope of ["files", "terminal", "browser"] as const) {
    const context = { principal: { ...ctx.principal, tokenAccess: { id: "token", generation: "1", scopes: [scope] } } };
    expect(engine.modeFor(context)).toBe("sandbox");
    for (const capability of CAPABILITIES)
      expect(engine.authorize({ context, capability }).allowed, `${scope}: ${capability}`).toBe(
        expectations[scope].includes(capability),
      );
  }
});
