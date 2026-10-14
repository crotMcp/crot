/**
 * Stage 6 bounded experiment: real Medium workspace, explicit filesystem RPC.
 * Not transparent cmd/PowerShell/Node filesystem compatibility or full L1.
 */
import { randomBytes } from "node:crypto";
import { link, mkdir, readFile, rename, symlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NativeHost } from "../../../src/native-host/native-host.js";
import { currentUserSid, windowsTools } from "../../../src/native-host/windows-acl.js";
import { loadJobObjectApi, type JobObjectApi } from "../../../src/native-host/windows-job.js";
import { loadProbeIntegrity } from "../../../src/native-host/windows-l1/probe-integrity.js";
import { loadRestrictedTokens, type RestrictedToken } from "../../../src/native-host/windows-l1/restricted-token.js";
import type { ProbeProcess } from "../../../src/native-host/windows-l1/probe-process.js";
import {
  startWorkspacePipeProbe,
  type WorkspacePipeProbe,
} from "../../../src/native-host/windows-l1/workspace-pipe-probe.js";
import { loadWorkspaceProbe } from "../../../src/native-host/windows-l1/workspace-probe.js";
import { isAlive, isWindows, makeTempDirs, waitFor, type TempDirs } from "../../helpers.js";

if (process.env.CROT_WINDOWS_TOKEN_REQUIRED === "1" && (!isWindows || !["x64", "arm64"].includes(process.arch)))
  throw new Error("Required native Windows workspace experiment cannot run here.");

describe.runIf(isWindows)("Windows stage 6: bounded explicit workspace mediation", () => {
  let dirs: TempDirs, host: NativeHost, token: RestrictedToken, jobs: JobObjectApi;
  let broker: WorkspacePipeProbe, low: string, secret: string, outside: string;
  const children: ProbeProcess[] = [];
  const client = fileURLToPath(new URL("./fixtures/workspace-client.mjs", import.meta.url));
  beforeEach(async () => {
    dirs = await makeTempDirs();
    host = await NativeHost.start({ startupPath: "inherited", jobObjects: false });
    jobs = await loadJobObjectApi();
    const label = await loadProbeIntegrity();
    const owner = await currentUserSid(windowsTools(process.env.SystemRoot ?? "C:\\Windows"));
    const n = randomBytes(16);
    token = (await loadRestrictedTokens()).create(
      `S-1-5-21-${n.readUInt32LE(0)}-${n.readUInt32LE(4)}-${n.readUInt32LE(8)}-${n.readUInt32LE(12)}`,
      false,
      undefined,
      "mic-only",
    );
    token.prepareProbeObjects(owner);
    // Ordinary Medium root. No Low label and no new SID grant on this workspace.
    label(dirs.workspace, "medium-write");
    await mkdir(path.join(dirs.workspace, "nested"));
    await writeFile(path.join(dirs.workspace, "project.txt"), "existing project");
    outside = path.join(dirs.outside, "outside.txt");
    secret = path.join(dirs.outside, "synthetic-secret.txt");
    await writeFile(outside, "outside unchanged");
    await writeFile(secret, "synthetic canary");
    await host.platform.privateFiles.protectFile!(secret);
    label(secret, "medium-no-read");
    await symlink(dirs.outside, path.join(dirs.workspace, "junction"), "junction");
    await link(secret, path.join(dirs.workspace, "secret-hard.txt"));
    await link(outside, path.join(dirs.workspace, "ordinary-hard.txt"));
    // Only the disposable private result/temp area is Low.
    low = path.join(dirs.outside, "private-low");
    await mkdir(low);
    label(low, "low-write");
    token.lowerProbeIntegrity();
    broker = await startWorkspacePipeProbe(dirs.workspace, owner);
  });
  afterEach(async () => {
    for (const child of children.splice(0)) child.close();
    await broker?.close();
    token?.close();
    await host?.close();
    await dirs?.cleanup();
  });
  it("trusted positive control performs real handle-relative CRUD without the pipe", async () => {
    const direct = await loadWorkspaceProbe(dirs.workspace);
    try {
      expect(() => direct.execute({ op: "create", path: "control.txt", text: "before" }), "create").not.toThrow();
      expect(await readFile(path.join(dirs.workspace, "control.txt"), "utf8")).toBe("before");
      expect(() => direct.execute({ op: "write", path: "control.txt", text: "after" }), "write").not.toThrow();
      expect(await readFile(path.join(dirs.workspace, "control.txt"), "utf8")).toBe("after");
      expect(
        () => direct.execute({ op: "rename", path: "control.txt", destination: "nested/control.txt" }),
        "rename",
      ).not.toThrow();
      expect(await readFile(path.join(dirs.workspace, "nested/control.txt"), "utf8")).toBe("after");
      expect(() => direct.execute({ op: "remove", path: "nested/control.txt" }), "remove").not.toThrow();
      await expect(readFile(path.join(dirs.workspace, "nested/control.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      direct.close();
    }
  });
  it("pins the actual workspace against root substitution; idle close releases native handles", async () => {
    const moved = path.join(dirs.outside, "substituted");
    await expect(rename(dirs.workspace, moved)).rejects.toMatchObject({
      code: expect.stringMatching(/^(EPERM|EACCES|EBUSY)$/),
    });
    await broker.close();
    await broker.close();
    await rename(dirs.workspace, moved);
    await rename(moved, dirs.workspace);
  });
  it("stopping a mediated run ends its native descendant tree", async () => {
    const report = path.join(low, "tree.json");
    const grandchild = `require('fs').writeFileSync(${JSON.stringify(report)},JSON.stringify({pid:process.pid}));setInterval(()=>{},1000);`;
    const script = `const c=require('child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{detached:true,stdio:'ignore'});c.on('exit',code=>require('fs').writeFileSync(${JSON.stringify(report + ".exit")},JSON.stringify({code})));c.on('error',e=>require('fs').writeFileSync(${JSON.stringify(report + ".exit")},JSON.stringify({spawnError:e.code,errno:e.errno})));setInterval(()=>{},1000);`;
    const child = token.launchProbe(
      {
        executable: process.execPath,
        args: ["-e", script],
        cwd: dirs.workspace,
        env: { SystemRoot: process.env.SystemRoot ?? "C:\\Windows", TEMP: low, TMP: low, CROT_PROBE_PIPE: broker.pipe },
      },
      jobs.createKillOnCloseJob(),
    );
    children.push(child);
    await waitFor(
      async () =>
        !!(await readFile(report, "utf8").catch(() => "")) ||
        !!(await readFile(report + ".exit", "utf8").catch(() => "")),
      10000,
    );
    expect(await readFile(report + ".exit", "utf8").catch(() => null), "descendant exited before readiness").toBeNull();
    const descendant = JSON.parse(await readFile(report, "utf8")) as { pid: number };
    expect(isAlive(descendant.pid)).toBe(true);
    child.close();
    await waitFor(() => !isAlive(child.pid) && !isAlive(descendant.pid), 10000);
  });
  it.each(["node", "cmd", "powershell"] as const)(
    "%s changes the real Medium root via explicit RPC; direct writes and forbidden RPC remain denied",
    async (shell) => {
      const resultFile = path.join(low, "result.json");
      const stdout = path.join(low, "stdout.txt");
      const stderr = path.join(low, "stderr.txt");
      const env = {
        SystemRoot: process.env.SystemRoot ?? "C:\\Windows",
        TEMP: low,
        TMP: low,
        CROT_PROBE_PIPE: broker.pipe,
        CROT_PROBE_CAP: broker.capability,
        CROT_PROBE_RESULT: resultFile,
        CROT_PROBE_OUTSIDE: outside,
        CROT_PROBE_SECRET: secret,
        CROT_PROBE_CLIENT: client,
        CROT_PROBE_NODE: process.execPath,
        CROT_PROBE_STDOUT: stdout,
        CROT_PROBE_CAPTURE: shell === "node" ? "0" : "1",
        CROT_PROBE_STDERR: stderr,
        CROT_PROBE_SHELL_READY: path.join(low, "shell-ready.txt"),
        CROT_PROBE_SHELL_EXIT: path.join(low, "shell-exit.txt"),
      };
      let executable = process.execPath;
      let args = [client, "", "Unicode 😀", 'quote"slash\\'];
      if (shell === "cmd") {
        const script = path.join(dirs.workspace, "run.cmd");
        await writeFile(
          script,
          '@echo off\r\n"%CROT_PROBE_NODE%" "%CROT_PROBE_CLIENT%" 1>"%CROT_PROBE_STDOUT%" 2>"%CROT_PROBE_STDERR%"\r\nexit /b %errorlevel%\r\n',
        );
        executable = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe");
        args = ["/d", "/c", "run.cmd"];
      } else if (shell === "powershell") {
        executable = windowsTools(process.env.SystemRoot ?? "C:\\Windows").powershell;
        const command =
          "[IO.File]::WriteAllText($env:CROT_PROBE_SHELL_READY,'entered'); & $env:CROT_PROBE_NODE $env:CROT_PROBE_CLIENT 1> $env:CROT_PROBE_STDOUT 2> $env:CROT_PROBE_STDERR; [IO.File]::WriteAllText($env:CROT_PROBE_SHELL_EXIT,[string]$LASTEXITCODE); exit $LASTEXITCODE";
        args = ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")];
      }
      const child = token.launchProbe({ executable, args, cwd: dirs.workspace, env }, jobs.createKillOnCloseJob());
      children.push(child);
      await waitFor(() => child.exitCode() !== null, 60000);
      const text = await readFile(resultFile, "utf8").catch(() => null);
      const shellReady = await readFile(env.CROT_PROBE_SHELL_READY, "utf8").catch(() => null);
      const shellExit = await readFile(env.CROT_PROBE_SHELL_EXIT, "utf8").catch(() => null);
      expect(
        text,
        JSON.stringify({ exit: child.exitCode(), shellReady, shellExit, diagnostics: broker.diagnostics }),
      ).not.toBeNull();
      const result = JSON.parse(text!);
      expect(result.failure, JSON.stringify({ result, diagnostics: broker.diagnostics })).toBeUndefined();
      expect(child.exitCode()).toBe(23);
      expect(result.cwd.toLowerCase()).toBe(dirs.workspace.toLowerCase());
      expect(result.project).toBe("existing project");
      if (shell === "node") expect(result.argv).toEqual(args.slice(1));
      for (const key of ["create", "write", "rename", "remove", "persist"]) expect(result[key]).toBe(true);
      expect(result.created).toBe("исходный 😀");
      expect(result.renamed).toBe("изменён 😀");
      expect(result.removed).toBe("ENOENT");
      for (const key of ["before", "after", "outside", "secret"]) expect(["EACCES", "EPERM"]).toContain(result[key]);
      expect(result.refused).toEqual(Array(10).fill(false));
      expect(result.badCapability).toBe(false);
      expect(result.descendant).toEqual({ code: 0, stdout: '{"ok":true}', stderr: "", error: null });
      expect(await readFile(path.join(dirs.workspace, "host-visible.txt"), "utf8")).toBe("настоящий Medium workspace");
      expect(await readFile(path.join(dirs.workspace, "descendant.txt"), "utf8")).toBe("child");
      expect(await readFile(outside, "utf8")).toBe("outside unchanged");
      expect(await readFile(secret, "utf8")).toBe("synthetic canary");
      expect(await readFile(path.join(dirs.workspace, "project.txt"), "utf8")).toBe("existing project");
      if (shell === "cmd") {
        expect(await readFile(stdout, "utf8")).toContain("stdout: Привет 😀");
        expect(await readFile(stderr, "utf8")).toContain("stderr: проверка");
      }
      // PowerShell's own native-command stream encoding is NOT equated with a
      // byte-preserving stdio bridge. The production launcher still has none.
    },
    90000,
  );
});
