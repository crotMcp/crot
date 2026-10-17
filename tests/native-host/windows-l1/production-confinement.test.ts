/** Real NativeHost registration, delivery and Core commands; no fake availability. */
import { appendFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
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
        expect({ status, logs, release: os.release(), version: os.version() }).toMatchObject({
          status: { mechanism: "windows-appcontainer", available: true, reason: null, network },
        });
      }
      // No caller-controlled launch implementation: this is the registered
      // NativeHost platform used by production CrotCore.
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
      expect(core.status().confinement).toMatchObject({
        available: true,
        mechanism: "windows-appcontainer",
        reason: null,
      });
      await core.shutdown();
      core = undefined;
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
