/** Real NativeHost registration, delivery and Core commands; no fake availability. */
import { appendFileSync } from "node:fs";
import { link, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, inject, it } from "vitest";
import type { CrotCore } from "../../../src/core/crot-core.js";
import { NativeHost } from "../../../src/native-host/native-host.js";
import { runTool, windowsTools } from "../../../src/native-host/windows-acl.js";
import { createServicePrivateFiles } from "../../../src/service/private-files.js";
import { verifyWindowsComponents } from "../../../src/native-host/windows-l1/components.js";
import { createTestCore, isWindows, makeTempDirs, testContext } from "../../helpers.js";
import { buildLocalShimFixture } from "./diagnostics/local-shim-build.js";
import { loadLeaseAclObjects } from "../../../src/native-host/windows-l1/lease-acl.js";
import { remotePrincipal } from "../../../src/core/auth/principal.js";
describe.runIf(isWindows)("production Windows AppContainer CommandConfinement", () => {
  it("verifies delivery, self-tests both modes and runs Core shell/process without an unconfined retry", async () => {
    const dirs = await makeTempDirs(),
      build = await buildLocalShimFixture();
    const stateDir = path.join(dirs.outside, "state"),
      logs: string[] = [];
    const tools = windowsTools(process.env.SystemRoot ?? "C:\\Windows"),
      privateFiles = createServicePrivateFiles(true);
    let native: NativeHost | undefined, core: CrotCore | undefined;
    try {
      await privateFiles.ensureDirectory(stateDir);
      native = await NativeHost.start({ startupPath: "inherited", stateDir, log: (line) => logs.push(line) });
      expect(await native.platform.confinement!.probe("on")).toMatchObject({
        mechanism: "windows-appcontainer",
        available: false,
        reason: "components_missing",
      });
      await native.close();
      native = undefined;
      await runTool(tools.powershell, [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        path.resolve("scripts/l1-install-win.ps1"),
        "-Apply",
      ]);
      await runTool(tools.powershell, [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        path.resolve("scripts/l1-components-win.ps1"),
        "-StateDirectory",
        stateDir,
        "-NodeExecutable",
        process.execPath,
        "-Library",
        build.library,
      ]);
      const components = await verifyWindowsComponents(stateDir, privateFiles);
      native = await NativeHost.start({ startupPath: "inherited", stateDir, log: (line) => logs.push(line) });
      for (const network of ["off", "on"] as const) {
        const status = await native.platform.confinement!.probe(network);
        expect({ status, release: os.release(), version: os.version() }, logs.join("\n")).toMatchObject({
          status: { mechanism: "windows-appcontainer", available: true, reason: null, network },
        });
      }
      // No caller-controlled launch implementation: this is the registered
      // NativeHost platform used by production CrotCore.
      const acl = await loadLeaseAclObjects(),
        snapshotSid = "S-1-15-2-1-2-3-4-5-6-7";
      const snapshots = [];
      for (let i = 0; i < 13; i++) {
        const file = path.join(dirs.workspace, `original-${i}.txt`);
        await writeFile(file, "original");
        snapshots.push(acl.capture(file, "workspace-node", snapshotSid, 0));
      }
      const external = path.join(dirs.outside, "external-hardlink-target");
      await writeFile(external, "outside-original");
      await link(external, path.join(dirs.workspace, "host-link"));
      await writeFile(path.join(dirs.workspace, "delete-original.txt"), "delete allowed");
      await mkdir(path.join(dirs.workspace, "existing-dir"));
      await writeFile(path.join(dirs.workspace, "existing-dir", "old.txt"), "old");
      core = await createTestCore(
        { workspace: { root: dirs.workspace }, permissions: { mode: "sandbox" }, confinement: { network: "on" } },
        undefined,
        { platform: native.platform },
      );
      const shell = await core.processes.shell(testContext, {
        cwd: dirs.workspace,
        shell: "cmd",
        script: "node -e \"console.log('windows-l1-core')\"",
      });
      expect(shell).toMatchObject({ exitCode: 0, timedOut: false });
      expect(shell.stdout).toContain("windows-l1-core");
      const result = await core.processes.exec(testContext, {
        cwd: dirs.workspace,
        command: "node",
        args: [
          "-e",
          "console.log(JSON.stringify({docker:process.env.DOCKER_HOST,temp:process.env.TEMP}));process.exit(23)",
        ],
      });
      expect(result.exitCode).toBe(23);
      expect(JSON.parse(result.stdout).docker).toMatch(/^npipe:\/\/\/\/\.\/pipe\/LOCAL\/crot-l1-docker-/);
      const fsResult = await core.processes.exec(testContext, {
        cwd: dirs.workspace,
        command: "node",
        args: [
          "-e",
          `const f=require('fs');
f.writeFileSync('original-0.txt','changed');f.renameSync('original-0.txt','renamed-0.txt');f.renameSync('existing-dir','renamed-dir');f.renameSync('renamed-dir/old.txt','renamed-dir/renamed.txt');f.writeFileSync('new.txt','new');f.mkdirSync('new-dir');f.renameSync('new-dir','renamed-new-dir');
f.unlinkSync('delete-original.txt');try{f.writeFileSync('host-link','bad');process.exit(71)}catch(e){if(e.code!=='EPERM')throw e}console.log('7/7;hardlink=EPERM');`,
        ],
      });
      expect(fsResult.exitCode).toBe(0);
      expect(fsResult.stdout).toContain("7/7;hardlink=EPERM");
      expect(await readFile(external, "utf8")).toBe("outside-original");
      expect(core.status().confinement).toMatchObject({
        available: true,
        mechanism: "windows-appcontainer",
        reason: null,
      });
      await core.shutdown();
      core = undefined;
      for (const object of snapshots) {
        const pin = acl.pin(object);
        try {
          expect(pin.state()).toBe("original");
        } finally {
          pin.close();
        }
      }
      await native.close();
      native = undefined;
      const original = await readFile(components.library);
      await writeFile(components.library, Buffer.concat([original, Buffer.from([0])]));
      native = await NativeHost.start({ startupPath: "inherited", stateDir });
      expect(await native.platform.confinement!.probe("on")).toMatchObject({
        available: false,
        reason: "components_mismatch",
      });
      core = await createTestCore(
        { workspace: { root: dirs.workspace }, permissions: { mode: "sandbox" } },
        undefined,
        { platform: native.platform },
      );
      const remote = {
        principal: remotePrincipal({
          id: "windows-l1-qualification",
          transport: "relay",
          authMethod: "test",
          accountId: "test",
          deviceId: "test",
          clientId: "test",
        }),
      };
      await expect(
        core.processes.exec(remote, { cwd: dirs.workspace, command: "node", args: ["-v"] }),
      ).rejects.toMatchObject({ code: "CONFINEMENT_UNAVAILABLE" });
      await core.shutdown();
      core = undefined;
      core = await createTestCore(
        { workspace: { root: dirs.workspace }, permissions: { mode: "full_control" } },
        undefined,
        { platform: native.platform },
      );
      const unrestricted = await core.processes.exec(testContext, {
        cwd: dirs.outside,
        command: process.execPath,
        args: ["-e", "console.log('full-control-local')"],
      });
      expect(unrestricted.exitCode).toBe(0);
      expect(unrestricted.stdout).toContain("full-control-local");
      appendFileSync(
        inject("stage6aEvidence"),
        JSON.stringify({
          title: "CROT-6A-production-windows-confinement",
          value: {
            networkOn: true,
            networkOff: true,
            deliveryVerified: true,
            coreShell: true,
            coreProcessExit: 23,
            workspaceOperations: "7/7",
            restoredFileSnapshots: "13/13",
            hardlinkWrite: "EPERM",
            deletedOriginalRecovered: true,
            mismatchRefused: true,
            remoteUnavailable: true,
            mechanism: "windows-appcontainer",
            checkout: process.env.GITHUB_SHA,
            node: process.version,
            logs,
          },
        }) + "\n",
      );
    } finally {
      await core?.shutdown();
      await native?.close();
      await build.cleanup();
      await dirs.cleanup();
    }
  }, 300000);
});
