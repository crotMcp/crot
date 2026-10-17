/** Real owner kill -> startup recovery, with actors/network/new nodes/profile. */
import { CrotService } from "../../../src/service/service.js";
import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { appendFileSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, inject, it } from "vitest";
import { WindowsNativeLeases } from "../../../src/native-host/windows-l1/lease-owner.js";
import { loadLeaseAclObjects, prepareNewWorkspaceSidRemoval } from "../../../src/native-host/windows-l1/lease-acl.js";
import type { LeasePlan } from "../../../src/native-host/windows-l1/lease-journal.js";
import { loadAppContainerNetworkNative } from "../../../src/native-host/windows-l1/network-native.js";
import { createServicePrivateFiles } from "../../../src/service/private-files.js";
import { currentUserSid, runTool, windowsTools } from "../../../src/native-host/windows-acl.js";
import { isAlive, isWindows, makeTempDirs, waitFor } from "../../helpers.js";
import { buildLocalShimFixture } from "./diagnostics/local-shim-build.js";
const fixture = fileURLToPath(new URL("./fixtures/native-lease-owner.mjs", import.meta.url));
describe.runIf(isWindows)("full native Windows lease recovery after owner death", () => {
  it("drains actors, restores originals by ID, strips new nodes, removes loopback and profile", async () => {
    const dirs = await makeTempDirs(),
      build = await buildLocalShimFixture();
    let child: ChildProcess | undefined, recovery: WindowsNativeLeases | undefined, service: CrotService | undefined;
    try {
      const tools = windowsTools(process.env.SystemRoot ?? "C:\\Windows"),
        ownerSid = await currentUserSid(tools);
      await runTool(tools.powershell, [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        path.resolve("scripts/l1-install-win.ps1"),
        "-Apply",
      ]);
      const runtime = path.join(dirs.outside, "runtime"),
        compat = path.join(dirs.outside, "compat"),
        stateDir = path.join(dirs.outside, "service-state"),
        storage = path.join(stateDir, "windows-l1", "leases");
      for (const p of [
        runtime,
        compat,
        path.join(runtime, "home"),
        path.join(runtime, "temp"),
        path.join(runtime, "cache"),
      ])
        await mkdir(p, { recursive: true });
      const executable = path.join(runtime, "node.exe");
      await copyFile(process.execPath, executable);
      await copyFile(build.library, path.join(compat, "crot-local-shim.dll"));
      // Thirteen independent, pre-lease snapshots, not just an ACL projection.
      const paths = Array.from({ length: 13 }, (_, i) => path.join(dirs.workspace, `original-${i}.txt`));
      for (const p of paths) await writeFile(p, "original");
      const secret = path.join(dirs.outside, "service-token");
      await writeFile(secret, "secret");
      const privateFiles = createServicePrivateFiles(true);
      await privateFiles.protectFile!(secret);
      const compiledRoot = path.resolve(path.dirname(inject("crotMcpBin")), "..");
      const config = {
        workspace: dirs.workspace,
        runtime,
        compat,
        storage,
        executable,
        protectedPaths: [secret],
        ownerSid,
      };
      child = fork(fixture, [compiledRoot, JSON.stringify(config)], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
      let errors = "";
      child.stderr?.on("data", (b) => {
        errors += b.toString();
      });
      const ready = await Promise.race([
        new Promise<{
          ready: true;
          plan: LeasePlan;
          actors: { pid: number; child: number; docker: number[]; dockerHost: string };
          refusals: { event: string; request: string; reason: string }[];
          forwarded: string[];
        }>((resolve, reject) => {
          child!.once("message", (v) => resolve(v as never));
          child!.once("exit", () => reject(new Error(errors)));
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`native owner deadline: ${errors}`)), 45000).unref(),
        ),
      ]);
      expect(ready.ready).toBe(true);
      expect(ready.actors.docker).toEqual([200, 403, 403, 403]);
      expect(ready.actors.dockerHost).toMatch(/^npipe:\/\/\/\/\.\/pipe\/LOCAL\/crot-l1-docker-/);
      expect(ready.forwarded).toEqual(["GET /_ping HTTP/1.1"]);
      expect(ready.refusals).toHaveLength(3);
      expect(ready.refusals.every((r) => r.event === "confinement.docker_refused")).toBe(true);
      const network = await loadAppContainerNetworkNative();
      expect(await network.contains(ready.plan.profile.sid)).toBe(true);
      expect(isAlive(ready.actors.pid)).toBe(true);
      expect(isAlive(ready.actors.child)).toBe(true);
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
      child = undefined;
      const started = await CrotService.start({
        command: {
          kind: "serve",
          config: {
            workspace: { root: dirs.workspace },
            audit: { sink: "none" },
            secrets: { store: "file" },
            browser: { enabled: false },
          },
          warnings: [],
        },
        launch: "managed",
        stateDir,
        privateFiles,
        log: () => undefined,
        requestStop: () => undefined,
      });
      if (started === "already_running") throw new Error("unexpected service owner collision");
      service = started;
      await waitFor(() => !isAlive(ready.actors.pid) && !isAlive(ready.actors.child));
      expect(await network.contains(ready.plan.profile.sid)).toBe(false);
      const acl = await loadLeaseAclObjects();
      for (const original of ready.plan.objects) {
        const p = acl.pin(original);
        try {
          expect(p.state()).toBe("original");
        } finally {
          p.close();
        }
      }
      for (const name of ["new-dir", "new-dir/after.txt", "actor-ready.json"]) {
        const node = acl.capture(path.join(dirs.workspace, name), "workspace-node", ready.plan.profile.sid, 0);
        expect(prepareNewWorkspaceSidRemoval(node, ready.plan.profile.sid).planned).toBe(node.original);
      }
      expect(await readFile(path.join(dirs.workspace, "renamed-0.txt"), "utf8")).toBe("original");
      expect(await readFile(secret, "utf8")).toBe("secret");
      const receipt = await readFile(path.join(storage, "profiles", `profile-${ready.plan.id}.wal`), "utf8");
      expect(JSON.parse(JSON.parse(receipt.trimEnd().split("\n").at(-1)!).body).frame.stage).toBe("closed");
      await service.shutdown("recovery qualification complete");
      service = undefined;
      // Reopening the closed transaction must be idempotent, not profile adoption.
      recovery = await WindowsNativeLeases.open({ directory: storage, ownerSid, privateFiles });
      const evidence = {
        restoredOriginals: ready.plan.objects.length,
        independentFileSnapshots: 13,
        actorsDead: true,
        newNodesStripped: 3,
        loopbackRemoved: true,
        profileReceiptClosed: true,
        startupIdempotent: true,
        serviceLifecycleTested: true,
        dockerLocalTransport: true,
        dockerResponses: ready.actors.docker,
        dockerRefusalsAudited: ready.refusals.length,
        dockerUpstream: "mock-byte-stream-not-real-daemon",
        checkout: process.env.GITHUB_SHA,
        node: process.version,
      };
      appendFileSync(
        inject("stage6aEvidence"),
        JSON.stringify({ title: "CROT-6A-full-native-lease-recovery", value: evidence }) + "\n",
      );
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        await exited;
      }
      await service?.shutdown("recovery test cleanup");
      await recovery?.close();
      await build.cleanup();
      await dirs.cleanup();
    }
  }, 240000);
});
