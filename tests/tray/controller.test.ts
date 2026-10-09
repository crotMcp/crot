import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ServeCommand } from "../../src/cli/options.js";
import { createPrivateFileProtection } from "../../src/core/platform/private-files.js";
import { ControlClient } from "../../src/service/control-client.js";
import { CrotService } from "../../src/service/service.js";
import { TrayController } from "../../src/tray/controller.js";
import type { TrayState } from "../../src/tray/view-model.js";
import { isWindows, makeTempDirs, testContext, waitFor, type TempDirs } from "../helpers.js";
import { TestAuthorizationServer } from "../identity/test-authorization-server.js";

/**
 * WP-22 / AD-19 point 1: the tray controller against a real service — it
 * decides with the subject digest it was shown, and it reconnects when the
 * service restarts.
 */

const privateFiles = createPrivateFileProtection(isWindows);

let dirs: TempDirs;
let stateDir: string;
let services: CrotService[];
let controllers: TrayController[];
beforeEach(async () => {
  dirs = await makeTempDirs();
  stateDir = isWindows ? path.join(dirs.outside, "state") : await mkdtemp(path.join("/tmp", "crot-tc-"));
  services = [];
  controllers = [];
});
afterEach(async () => {
  for (const c of controllers) c.stop();
  for (const s of services) await s.shutdown("test end");
  if (!isWindows) await rm(stateDir, { recursive: true, force: true });
  await dirs.cleanup();
});

function serveCommand(): ServeCommand {
  return {
    kind: "serve",
    config: {
      workspace: { root: dirs.workspace },
      audit: { sink: "file", path: path.join(dirs.outside, "audit.jsonl") },
      environment: { path: "inherited" },
      secrets: { store: "file" },
      permissions: {
        approvals: { rules: [{ id: "writes", match: { capabilities: ["filesystem.write"] } }], timeoutMs: 10_000 },
      },
    } as ServeCommand["config"],
    warnings: [],
  };
}

async function startService(authServer?: TestAuthorizationServer): Promise<CrotService> {
  const service = await CrotService.start({
    identity: authServer
      ? { environment: authServer.environment(), http: authServer.http() }
      : { environment: { unavailable: "no identity environment in this test" } },
    command: serveCommand(),
    launch: "managed",
    stateDir,
    privateFiles,
    log: () => undefined,
    requestStop: () => undefined,
    resume: { intervalMs: 60_000, thresholdMs: 10_000 },
  });
  if (service === "already_running") throw new Error("already running");
  services.push(service);
  return service;
}

interface Sent {
  method: string;
  params?: Readonly<Record<string, unknown>>;
}

function controller(sent: Sent[] = [], opened: string[] = []): { tray: TrayController; states: TrayState[] } {
  const states: TrayState[] = [];
  const tray = new TrayController({
    openSignIn: (url) => opened.push(url),
    stateDir,
    privateFiles,
    retryMs: 100,
    pollMs: 60_000,
    onUpdate: (s) => states.push(s),
    connect: async () => {
      const client = await ControlClient.connect({ stateDir, privateFiles });
      if (!client) return undefined;
      const request = client.request.bind(client);
      client.request = (method, params) => {
        sent.push({ method, ...(params ? { params } : {}) });
        return request(method, params);
      };
      return client;
    },
  });
  controllers.push(tray);
  return { tray, states };
}

describe("WP-22: tray controller", () => {
  it("shows the pending request and approves it with the presented digest", async () => {
    const service = await startService();
    const sent: Sent[] = [];
    const { tray } = controller(sent);
    await tray.start();
    expect(tray.state.connection).toBe("connected");
    expect(tray.state.overview?.approvals.trays).toBe(1);

    const writing = service.core.filesystem.writeFile(testContext, { path: "a.txt", content: "approved" });
    await waitFor(() => tray.state.pending.length === 1);
    const shown = tray.state.pending[0]!;
    expect(shown.subject.operation).toBe("filesystem.write_file");
    expect(await tray.decide(shown.requestId, "approve")).toBe(true);
    await writing;
    expect(await readFile(path.join(dirs.workspace, "a.txt"), "utf8")).toBe("approved");
    expect(sent.find((s) => s.method === "approvals.decide")?.params).toEqual({
      requestId: shown.requestId,
      decision: "approve",
      subjectDigest: shown.subjectDigest,
    });
    expect(tray.state.pending).toEqual([]);
    expect(tray.state.notice).toBe("Approved.");

    // Unknown request: nothing is sent.
    const before = sent.length;
    expect(await tray.decide("no-such-request", "approve")).toBe(false);
    expect(sent.length).toBe(before);
  });

  it("rejects, reports refused actions, and picks up requests that were pending before it connected", async () => {
    const service = await startService();
    const first = controller();
    await first.tray.start();
    const writing = service.core.filesystem.writeFile(testContext, { path: "b.txt", content: "x" });
    await waitFor(() => first.tray.state.pending.length === 1);

    const second = controller();
    await second.tray.start();
    expect(second.tray.state.pending.map((p) => p.requestId)).toEqual(first.tray.state.pending.map((p) => p.requestId));
    expect(await second.tray.setPreset("autonomous-browser")).toBe(false);
    expect(second.tray.state.notice).toBeTruthy();
    expect(await second.tray.startPairing()).toBe(false);

    expect(await second.tray.decide(second.tray.state.pending[0]!.requestId, "reject")).toBe(true);
    await expect(writing).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await waitFor(() => first.tray.state.pending.length === 0);
  });

  it("goes offline when the service stops and reconnects when it is back", async () => {
    const { tray, states } = controller();
    await tray.start();
    expect(tray.state.connection).toBe("not_running");

    const service = await startService();
    await waitFor(() => tray.state.connection === "connected");
    const writing = service.core.filesystem.writeFile(testContext, { path: "c.txt", content: "x" });
    await waitFor(() => tray.state.pending.length === 1);

    await service.shutdown("restart");
    services.splice(services.indexOf(service), 1);
    await expect(writing).rejects.toBeTruthy();
    await waitFor(() => tray.state.connection !== "connected");
    expect(tray.state.pending).toEqual([]);
    expect(tray.state.overview).toBeUndefined();
    expect(await tray.setRemoteMode(true)).toBe(false);
    expect(tray.state.notice).toBe("The CROT service is not connected.");

    await startService();
    await waitFor(() => tray.state.connection === "connected", 10_000);
    expect(states.some((s) => s.connection === "connected")).toBe(true);
    expect(tray.state.overview?.approvals.trays).toBe(1);
  });
});

describe("WP-28: tray pairing", () => {
  it("opens the sign-in page, shows the paired device and unpairs", async () => {
    const authServer = new TestAuthorizationServer();
    await startService(authServer);
    const opened: string[] = [];
    const { tray } = controller([], opened);
    await tray.start();
    expect(await tray.startPairing()).toBe(true);
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatch(/^https:\/\/auth\.crot-dev\.example\/oauth2\/authorize\?/);
    expect(await tray.cancelPairing()).toBe(true);
    await waitFor(() => tray.state.overview?.pairing.state === "unpaired");
    expect(await tray.startPairing()).toBe(true);
    const callback = await fetch(authServer.authorize(opened[1]!, { sub: "user_tray" }).redirect);
    await callback.text();
    await waitFor(async () => {
      await tray.refresh();
      return tray.state.overview?.pairing.state === "paired";
    });
    expect(tray.state.overview?.pairing.device).toMatchObject({ accountId: "user_tray" });
    expect(await tray.startPairing()).toBe(false);
    expect(await tray.unpair()).toBe(true);
    expect(tray.state.overview?.pairing.state).toBe("unpaired");
    expect(await tray.unpair()).toBe(true);
    expect(tray.state.notice).toBe("This device is not paired.");
  });
});
