import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApprovalBroker } from "../../src/core/approvals/broker.js";
import type { ApprovalRule } from "../../src/core/approvals/types.js";
import { isAuditRecord, MemoryAuditSink, type AuditRecord, type AuditSink } from "../../src/core/audit/audit.js";
import { RemoteExposureStore } from "../../src/core/approvals/remote-exposure.js";
import { localPrincipal, remotePrincipal, type AuthContext } from "../../src/core/auth/principal.js";
import type { CrotCore } from "../../src/core/crot-core.js";
import { CrotError } from "../../src/core/errors.js";
import { ApprovalBindingError, ExecutionGuard } from "../../src/core/execution/guard.js";
import { PermissionEngine } from "../../src/core/permissions/engine.js";
import { createPermissionPolicy } from "../../src/core/permissions/policy.js";
import { TestProvider } from "../approval-provider.js";
import {
  createTestCore,
  isWindows,
  linkDirectory,
  makeTempDirs,
  testContext as ctx,
  type TempDirs,
} from "../helpers.js";

const WRITE_RULE: ApprovalRule = { id: "writes", match: { operations: ["filesystem.write_file"] } };

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

function config(approvals: Record<string, unknown> = { rules: [WRITE_RULE] }, mode = "sandbox"): unknown {
  return { workspace: { root: dirs.workspace }, permissions: { mode, approvals } };
}

async function gatedCore(
  options: { approvals?: Record<string, unknown>; providers?: TestProvider[]; sink?: AuditSink } = {},
): Promise<{ core: CrotCore; ui: TestProvider; audit: MemoryAuditSink }> {
  const audit = new MemoryAuditSink();
  const ui = new TestProvider();
  core = await createTestCore(config(options.approvals), options.sink ?? audit, {
    approvalProviders: options.providers ?? [ui],
  });
  return { core, ui, audit };
}

const exists = (p: string) =>
  readFile(p, "utf8").then(
    () => true,
    () => false,
  );

describe("approval gates: configuration", () => {
  it("defaults to no user rules, 45 s timeout, 8 pending requests and the untrusted-content rule; a clean session is not gated", async () => {
    const audit = new MemoryAuditSink();
    core = await createTestCore({ workspace: { root: dirs.workspace } }, audit);
    expect(core.config.permissions.approvals).toEqual({
      rules: [],
      timeoutMs: 45_000,
      maxPending: 8,
      untrustedContent: "require-approval",
    });
    expect(core.status().approvals).toEqual({
      rules: [],
      timeoutMs: 45_000,
      maxPending: 8,
      providers: 0,
      untrustedContent: "require-approval",
    });
    await core.filesystem.writeFile(ctx, { path: "a.txt", content: "x" });
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]).toMatchObject({ operation: "filesystem.write_file", outcome: "success" });
    expect(audit.events[0]?.approval).toBeUndefined();
  });

  it("reports in crot_status that gated operations are denied without an approval UI", async () => {
    core = await createTestCore(config());
    expect(core.status().approvals).toMatchObject({ rules: ["writes"], providers: 0 });
    expect(core.status().approvals.note).toMatch(/denied/);
  });

  it.each([
    ["timeoutMs above 300 s", { timeoutMs: 300_001 }],
    ["timeoutMs zero", { timeoutMs: 0 }],
    ["maxPending zero", { maxPending: 0 }],
    ["unknown operation", { rules: [{ id: "x", match: { operations: ["filesystem.format_disk"] } }] }],
    ["unknown capability", { rules: [{ id: "x", match: { capabilities: ["root.access"] } }] }],
    ["unknown match key", { rules: [{ id: "x", match: { clients: ["claude"] } }] }],
    ["empty list", { rules: [{ id: "x", match: { operations: [] } }] }],
    ["empty id", { rules: [{ id: "", match: {} }] }],
    ["duplicate id", { rules: [WRITE_RULE, WRITE_RULE] }],
    ["mode that is not active", { rules: [{ id: "x", match: { modes: ["full_control"] } }] }],
    ["capability not granted", { rules: [{ id: "x", match: { capabilities: ["browser.control"] } }] }],
    ["outside workspace in sandbox", { rules: [{ id: "x", match: { outsideWorkspace: true } }] }],
  ])("rejects %s with CONFIG_ERROR", async (_name, approvals) => {
    await expect(createTestCore(config(approvals))).rejects.toMatchObject({ code: "CONFIG_ERROR" });
  });

  it("accepts the maximum timeout", async () => {
    core = await createTestCore(config({ rules: [WRITE_RULE], timeoutMs: 300_000 }));
    expect(core.status().approvals.timeoutMs).toBe(300_000);
  });
});

describe("approval gates: pipeline", () => {
  it("runs an approved operation after the mandatory approval record", async () => {
    const { core, ui, audit } = await gatedCore();
    const writing = core.filesystem.writeFile(ctx, { path: "a.txt", content: "approved" });
    const { request } = await ui.next();
    expect(request.subject).toMatchObject({
      operation: "filesystem.write_file",
      capabilities: ["filesystem.write"],
      rule: "writes",
      mode: "sandbox",
      principal: ctx.principal,
      paths: [{ absolute: path.join(dirs.workspace, "a.txt"), insideWorkspace: true }],
    });
    expect(await exists(path.join(dirs.workspace, "a.txt"))).toBe(false); // nothing runs while pending
    expect(audit.events).toHaveLength(0);
    ui.approveLast();
    await writing;
    expect(await readFile(path.join(dirs.workspace, "a.txt"), "utf8")).toBe("approved");

    expect(audit.events).toHaveLength(2);
    const [mandatory, done] = audit.events as [AuditRecord, AuditRecord];
    expect(mandatory).toMatchObject({ kind: "approval", operation: "filesystem.write_file" });
    expect(mandatory.outcome).toBeUndefined(); // it does not claim execution
    expect(done).toMatchObject({ outcome: "success", approval: mandatory.approval });
    expect(mandatory.approval).toMatchObject({
      requestId: request.requestId,
      status: "approved",
      rule: "writes",
      subjectDigest: request.subjectDigest,
      provider: { id: "test-ui", channel: "local-ui" },
    });
    expect(mandatory.approval?.waitMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(audit.events)).not.toContain('"subject"');
  });

  it("denies a rejected operation with PERMISSION_DENIED and approval details", async () => {
    const { core, ui, audit } = await gatedCore();
    const writing = core.filesystem.writeFile(ctx, { path: "a.txt", content: "x" });
    const { request, ticket } = await ui.next();
    ticket.reject();
    const error = await writing.then(
      () => undefined,
      (e: unknown) => e as CrotError,
    );
    expect(error).toBeInstanceOf(CrotError);
    expect(error?.code).toBe("PERMISSION_DENIED");
    expect(error?.details).toEqual({
      operation: "filesystem.write_file",
      missing: [],
      approval: { requestId: request.requestId, status: "rejected" },
    });
    expect(error?.message).toMatch(/not approved.*rejected/);
    expect(await exists(path.join(dirs.workspace, "a.txt"))).toBe(false);
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]).toMatchObject({
      outcome: "denied",
      error: { code: "PERMISSION_DENIED" },
      approval: { requestId: request.requestId, status: "rejected", provider: { id: "test-ui" } },
    });
  });

  it("denies without a provider (headless) and leaves other operations alone", async () => {
    const { core, audit } = await gatedCore({ providers: [] });
    await expect(core.filesystem.writeFile(ctx, { path: "a.txt", content: "x" })).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
      details: { approval: { status: "unavailable" } },
    });
    expect(audit.events[0]?.approval).toMatchObject({ status: "unavailable", cancelReason: "no_provider" });
    await core.filesystem.createDirectory(ctx, { path: "d" }); // not matched by the rule
    expect(audit.events[1]).toMatchObject({ operation: "filesystem.create_directory", outcome: "success" });
    expect(audit.events[1]?.approval).toBeUndefined();
  });

  it("expires after timeoutMs", async () => {
    const { core, ui } = await gatedCore({ approvals: { rules: [WRITE_RULE], timeoutMs: 50 } });
    await expect(core.filesystem.writeFile(ctx, { path: "a.txt", content: "x" })).rejects.toMatchObject({
      details: { approval: { status: "expired" } },
    });
    const { request, ticket } = ui.last();
    expect(ticket.approve(request.subjectDigest)).toEqual({ ok: false, reason: "not_pending" });
    expect(await exists(path.join(dirs.workspace, "a.txt"))).toBe(false);
  });

  it("cancels when the caller aborts", async () => {
    const { core, ui, audit } = await gatedCore();
    const controller = new AbortController();
    const context: AuthContext = { ...ctx, signal: controller.signal };
    const writing = core.filesystem.writeFile(context, { path: "a.txt", content: "x" });
    await ui.next();
    controller.abort();
    await expect(writing).rejects.toMatchObject({ details: { approval: { status: "cancelled" } } });
    expect(audit.events[0]?.approval).toMatchObject({ status: "cancelled", cancelReason: "caller_aborted" });
  });

  it("bounds the queue: a request beyond maxPending is unavailable at once", async () => {
    const { core, ui, audit } = await gatedCore({ approvals: { rules: [WRITE_RULE], maxPending: 1 } });
    const first = core.filesystem.writeFile(ctx, { path: "a.txt", content: "x" });
    await ui.next();
    await expect(core.filesystem.writeFile(ctx, { path: "b.txt", content: "x" })).rejects.toMatchObject({
      details: { approval: { status: "unavailable" } },
    });
    expect(audit.events[0]?.approval).toMatchObject({ cancelReason: "queue_full" });
    expect(ui.shown).toHaveLength(1);
    ui.approveLast();
    await first;
  });

  it("cancels pending requests on shutdown without using up the drain window", async () => {
    const { core: c, ui, audit } = await gatedCore();
    const writing = c.filesystem.writeFile(ctx, { path: "a.txt", content: "x" });
    const { request, ticket } = await ui.next();
    const started = Date.now();
    await c.shutdown();
    expect(Date.now() - started).toBeLessThan(1_500);
    await expect(writing).rejects.toMatchObject({ details: { approval: { status: "cancelled" } } });
    expect(ticket.approve(request.subjectDigest)).toEqual({ ok: false, reason: "not_pending" });
    expect(audit.events[0]?.approval).toMatchObject({ cancelReason: "shutdown" });
    expect(await exists(path.join(dirs.workspace, "a.txt"))).toBe(false);
    core = undefined;
  });

  it.skipIf(isWindows)("revalidates paths after the approval (symlink swap while pending)", async () => {
    await mkdir(path.join(dirs.workspace, "sub"));
    const { core, ui, audit } = await gatedCore();
    const writing = core.filesystem.writeFile(ctx, { path: "sub/a.txt", content: "x" });
    await ui.next();
    await rm(path.join(dirs.workspace, "sub"), { recursive: true });
    await mkdir(path.join(dirs.workspace, "elsewhere"));
    await linkDirectory(path.join(dirs.workspace, "elsewhere"), path.join(dirs.workspace, "sub"));
    ui.approveLast();
    await expect(writing).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
      details: { approval: { status: "approved" } },
    });
    expect(await exists(path.join(dirs.workspace, "elsewhere", "a.txt"))).toBe(false);
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]).toMatchObject({ outcome: "denied", approval: { status: "approved" } });
    expect(audit.events[0]?.approval?.reauthorization).toMatch(/revalidation/);
  });

  it("refuses the operation when the mandatory approval record cannot be written (AD-7)", async () => {
    const recorded: AuditRecord[] = [];
    const sink: AuditSink = {
      record: async (event) => {
        if ("kind" in event && event.kind === "approval") throw new Error("disk full");
        if (isAuditRecord(event)) recorded.push(event);
      },
    };
    const onAuditError = vi.fn();
    const ui = new TestProvider();
    core = await createTestCore(config(), sink, { approvalProviders: [ui], onAuditError });
    const writing = core.filesystem.writeFile(ctx, { path: "a.txt", content: "x" });
    await ui.next();
    ui.approveLast();
    await expect(writing).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
      details: { approval: { status: "approved" } },
    });
    expect(await exists(path.join(dirs.workspace, "a.txt"))).toBe(false);
    expect(onAuditError).toHaveBeenCalledTimes(1);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ outcome: "denied" });
    expect(recorded[0]?.approval?.reauthorization).toMatch(/audit record/);
  });

  it("keeps the global audit policy for operations without a gate", async () => {
    const onAuditError = vi.fn();
    const failing: AuditSink = { record: () => Promise.reject(new Error("disk full")) };
    core = await createTestCore(config(), failing, { onAuditError });
    await core.filesystem.createDirectory(ctx, { path: "d" });
    expect(onAuditError).toHaveBeenCalledTimes(1);
  });

  it("gate-evaluates operations of every service (no opt-out)", async () => {
    const { core, audit } = await gatedCore({ approvals: { rules: [{ id: "all", match: {} }] }, providers: [] });
    const denied = { code: "PERMISSION_DENIED", details: { approval: { status: "unavailable" } } };
    await expect(core.filesystem.readFile(ctx, { path: "x.txt" })).rejects.toMatchObject(denied);
    await expect(core.filesystem.listDirectory(ctx, { path: "." })).rejects.toMatchObject(denied);
    await expect(core.processes.exec(ctx, { command: process.execPath, args: ["-v"] })).rejects.toMatchObject(denied);
    await expect(core.processes.list(ctx)).rejects.toMatchObject(denied);
    expect(audit.events).toHaveLength(4);
    expect(audit.events.every((e) => e.outcome === "denied" && e.approval?.rule === "all")).toBe(true);
  });

  it("matches rules on capabilities, principal kind and outsideWorkspace", async () => {
    const audit = new MemoryAuditSink();
    const ui = new TestProvider();
    core = await createTestCore(
      config(
        {
          rules: [
            { id: "remote-writes", match: { capabilities: ["filesystem.write"], principalKinds: ["remote"] } },
            { id: "outside", match: { outsideWorkspace: true, operations: ["filesystem.read_file"] } },
          ],
        },
        "full_control",
      ),
      audit,
      // A clean remote scope (without a store every remote scope is exposed).
      { approvalProviders: [ui], remoteExposure: RemoteExposureStore.inMemory() },
    );
    // Local principal: not matched by remote-writes.
    await core.filesystem.writeFile(ctx, { path: "a.txt", content: "x" });
    expect(ui.shown).toHaveLength(0);
    // Inside the workspace: not matched by outside.
    await core.filesystem.readFile(ctx, { path: "a.txt" });
    expect(ui.shown).toHaveLength(0);

    // AD-15: only relay principals are remote (loopback HTTP is local).
    const remote: AuthContext = {
      principal: remotePrincipal({
        id: "acct-1",
        transport: "relay",
        authMethod: "oauth",
        accountId: "acct-1",
        deviceId: "device-1",
        clientId: "client-1",
      }),
    };
    const writing = core.filesystem.writeFile(remote, { path: "b.txt", content: "x" });
    expect((await ui.next()).request.subject.rule).toBe("remote-writes");
    ui.approveLast();
    await writing;

    const reading = core.filesystem.readFile(ctx, { path: path.join(dirs.outside, "missing.txt") });
    const { request } = await ui.next();
    expect(request.subject.rule).toBe("outside");
    expect(request.subject.effects).toContainEqual({
      label: "path",
      value: path.join(dirs.outside, "missing.txt"),
      flag: "outside_workspace",
    });
    ui.approveLast();
    await expect(reading).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(audit.events.at(-1)).toMatchObject({ outcome: "error", approval: { status: "approved" } });
  });
});

describe("approval gates: ExecutionGuard", () => {
  const policy = createPermissionPolicy({ mode: "sandbox", capabilities: ["shell.execute"] });
  const op = { operation: "process.shell", capability: "shell.execute" as const, details: { script: "echo" } };

  function setup(
    engine: PermissionEngine = new PermissionEngine(policy, { approvals: { rules: [{ id: "all", match: {} }] } }),
  ) {
    const audit = new MemoryAuditSink();
    const broker = new ApprovalBroker();
    const ui = new TestProvider();
    broker.register(ui);
    const guard = new ExecutionGuard(engine, audit, { approvals: broker });
    return { audit, broker, ui, guard };
  }

  it("re-authorizes after the approval", async () => {
    const real = new PermissionEngine(policy, { approvals: { rules: [{ id: "all", match: {} }] } });
    let calls = 0;
    const flaky = Object.create(real) as PermissionEngine;
    flaky.authorize = (request) => {
      calls++;
      return calls === 1
        ? real.authorize(request)
        : {
            allowed: false,
            reason: "Capability 'shell.execute' is not granted (mode: sandbox).",
            missing: ["shell.execute"],
          };
    };
    const { audit, ui, guard } = setup(flaky);
    const execute = vi.fn(async () => "ran");
    const running = guard.run(ctx, op, execute);
    await ui.next();
    ui.approveLast();
    await expect(running).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
      details: { operation: "process.shell", missing: [], approval: { status: "approved" } },
    });
    expect(execute).not.toHaveBeenCalled();
    expect(calls).toBe(2);
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]?.approval?.reauthorization).toMatch(/not granted/);
  });

  it("never gates what authorize() denies, and an approval grants nothing", async () => {
    const denied = createPermissionPolicy({ mode: "sandbox", capabilities: ["filesystem.read"] });
    const { ui, guard } = setup(new PermissionEngine(denied, { approvals: { rules: [{ id: "all", match: {} }] } }));
    await expect(guard.run(ctx, op, async () => "ran")).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
      details: { missing: ["shell.execute"] },
    });
    expect(ui.shown).toHaveLength(0);
  });

  it("calls bind only for gated operations; a failing bind denies without a request", async () => {
    const bind = vi.fn(async () => {
      throw new CrotError("NOT_FOUND", "There is no active tab.");
    });
    const execute = vi.fn(async () => "ran");
    const ungated = setup(new PermissionEngine(policy));
    await expect(
      ungated.guard.run(ctx, { ...op, approval: { summary: "s", effects: [], bind } }, execute),
    ).resolves.toBe("ran");
    expect(bind).not.toHaveBeenCalled();

    const { audit, ui, guard } = setup();
    await expect(
      guard.run(ctx, { ...op, approval: { summary: "s", effects: [], bind } }, execute),
    ).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
      details: { approval: { status: "unavailable" } },
    });
    expect(bind).toHaveBeenCalledTimes(1);
    expect(ui.shown).toHaveLength(0);
    expect(execute).toHaveBeenCalledTimes(1); // only the ungated run
    expect(audit.events[0]).toMatchObject({ outcome: "denied", approval: { status: "unavailable" } });
    expect(audit.events[0]?.approval?.cancelReason).toBeUndefined();
  });

  it("puts the binding into the subject and denies when execute reports a broken binding", async () => {
    const browser = { tabId: 7, origin: "https://example.com", connectionId: "a".repeat(32) };
    const { audit, ui, guard } = setup();
    const running = guard.run(
      ctx,
      {
        ...op,
        approval: {
          summary: "Click",
          effects: [{ label: "selector", value: "#go" }],
          bind: async () => ({ browser, effects: [{ label: "tab", value: "7" }] }),
        },
      },
      async () => {
        throw new ApprovalBindingError("origin");
      },
    );
    const { request } = await ui.next();
    expect(request.subject.browser).toEqual(browser);
    expect(request.subject.effects).toEqual([
      { label: "selector", value: "#go" },
      { label: "tab", value: "7" },
    ]);
    ui.approveLast();
    await expect(running).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
      details: { approval: { requestId: request.requestId, status: "approved" } },
    });
    expect(audit.events.map((e) => e.outcome)).toEqual([undefined, "denied"]);
    expect(audit.events[1]?.approval?.reauthorization).toMatch(/binding/);
  });

  it("denies a binding Core cannot use (no http(s) origin)", async () => {
    const { ui, guard } = setup();
    await expect(
      guard.run(
        ctx,
        {
          ...op,
          approval: {
            summary: "s",
            effects: [],
            bind: async () => ({ browser: { tabId: 1, origin: "chrome://settings", connectionId: "a".repeat(32) } }),
          },
        },
        async () => "ran",
      ),
    ).rejects.toMatchObject({ details: { approval: { status: "unavailable" } } });
    expect(ui.shown).toHaveLength(0);
  });

  it("denies every gated operation without a broker", async () => {
    const engine = new PermissionEngine(policy, { approvals: { rules: [{ id: "all", match: {} }] } });
    const guard = new ExecutionGuard(engine, new MemoryAuditSink());
    await expect(guard.run({ principal: localPrincipal("t") }, op, async () => "ran")).rejects.toMatchObject({
      details: { approval: { status: "unavailable" } },
    });
  });
});
