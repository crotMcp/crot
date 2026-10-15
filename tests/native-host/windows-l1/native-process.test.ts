/** Real kernel byte transport + existing Core service. NOT full L1 acceptance. */
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Readable } from "node:stream";
import { NativeHost } from "../../../src/native-host/native-host.js";
import { currentUserSid, windowsTools } from "../../../src/native-host/windows-acl.js";
import { loadJobObjectApi } from "../../../src/native-host/windows-job.js";
import { loadProbeIntegrity } from "../../../src/native-host/windows-l1/probe-integrity.js";
import { loadRestrictedTokens, type RestrictedToken } from "../../../src/native-host/windows-l1/restricted-token.js";
import { loadBytePipeApi, quarantinedStdioOperations } from "../../../src/native-host/windows-l1/byte-stdio.js";
import { NativeProcessLauncher } from "../../../src/native-host/windows-l1/native-process.js";
import type { ManagedProcess } from "../../../src/core/platform/types.js";
import type { CrotCore } from "../../../src/core/crot-core.js";
import {
  createTestCore,
  isAlive,
  isWindows,
  makeTempDirs,
  testContext as ctx,
  waitFor,
  type TempDirs,
} from "../../helpers.js";

if (process.env.CROT_WINDOWS_TOKEN_REQUIRED === "1" && (!isWindows || !["x64", "arm64"].includes(process.arch)))
  throw new Error("Required Windows native process qualification cannot run here.");
async function bytes(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
describe.runIf(isWindows)("Windows owned native byte ProcessLauncher (not confinement)", () => {
  let dirs: TempDirs, host: NativeHost, token: RestrictedToken, launcher: NativeProcessLauncher, core: CrotCore;
  let cwd: string, env: Record<string, string>;
  beforeEach(async () => {
    dirs = await makeTempDirs();
    cwd = path.join(dirs.workspace, "проект space 😀");
    await mkdir(cwd);
    host = await NativeHost.start({ startupPath: "inherited", jobObjects: false });
    const n = randomBytes(16);
    token = (await loadRestrictedTokens()).create(
      `S-1-5-21-${n.readUInt32LE(0)}-${n.readUInt32LE(4)}-${n.readUInt32LE(8)}-${n.readUInt32LE(12)}`,
      false,
      undefined,
      "mic-only",
    );
    const ownerSid = await currentUserSid(windowsTools(process.env.SystemRoot ?? "C:\\Windows"));
    token.prepareProbeObjects(ownerSid);
    (await loadProbeIntegrity())(cwd, "low-write");
    token.lowerProbeIntegrity();
    launcher = new NativeProcessLauncher({
      token,
      ownerSid,
      pipes: await loadBytePipeApi(),
      jobs: await loadJobObjectApi(),
      environment: host.platform.environment,
      resolver: host.platform.launcher,
    });
    const root = process.env.SystemRoot ?? "C:\\Windows";
    env = {
      SystemRoot: root,
      PATH: `${path.dirname(process.execPath)};${path.join(root, "System32")}`,
      PATHEXT: ".EXE;.CMD;.BAT",
      TEMP: cwd,
      TMP: cwd,
    };
    // Injection exercises the existing authorized Core path, not an L1 backend
    // or a new authorization system. Ordinary Medium workspace stays unchanged.
    core = await createTestCore(
      { workspace: { root: dirs.workspace }, limits: { maxCommandTimeoutMs: 15000, maxOutputBytes: 2097152 } },
      undefined,
      { platform: { ...host.platform, launcher } },
    );
  });
  afterEach(async () => {
    await core?.shutdown();
    await launcher?.close();
    token?.close();
    await host?.close();
    expect(quarantinedStdioOperations()).toBe(0);
    await dirs?.cleanup();
  });
  const launch = (script: string, input = false, args: string[] = []) =>
    launcher.launch(
      { file: process.execPath, args: ["-e", script, "--", ...args], display: "native byte qualification" },
      { cwd, env, stdin: input },
    );
  const drain = async (child: ManagedProcess) => {
    const result = await Promise.all([child.exited, bytes(child.stdout), bytes(child.stderr)]);
    expect(child.failure).toBeUndefined();
    return result;
  };
  it("transfers simultaneous binary megabyte streams and stdin EOF without text conversion or deadlock", async () => {
    const payload = Buffer.alloc(1024 * 1024);
    for (let i = 0; i < payload.length; i++) payload[i] = i % 256;
    const child = await launch(
      "process.stderr.write(Buffer.alloc(1048576,255));process.stdin.pipe(process.stdout);",
      true,
    );
    const result = drain(child);
    child.stdin!.end(payload);
    const [status, out, err] = await result;
    expect(status).toEqual({ code: 0, signal: null });
    expect(out).toEqual(payload);
    expect(err).toEqual(Buffer.alloc(payload.length, 255));
    await child.terminate("force");
  });
  it("preserves argv, Unicode cwd, explicit environment, stderr and real exit 23", async () => {
    const args = ["", 'a"b', "trailing\\", "😀 & %PATH%", "line\nvalue"];
    const child = await launch(
      "console.log(JSON.stringify({argv:process.argv.slice(1),cwd:process.cwd(),secret:process.env.CROT_MUST_NOT_INHERIT}));console.error('ошибка 😀');process.exitCode=23",
      false,
      args,
    );
    const [status, out, err] = await drain(child);
    expect(status.code).toBe(23);
    expect(JSON.parse(out.toString())).toEqual({ argv: args, cwd });
    expect(err.toString().trim()).toBe("ошибка 😀");
    await child.terminate("force");
    expect((await child.exited).code).toBe(23);
  });
  it("uses Core foreground stdin/output, timeout and permission gates with the native launcher", async () => {
    const result = await core.processes.exec(ctx, {
      command: process.execPath,
      cwd,
      args: [
        "-e",
        "process.stdin.on('data',c=>process.stdout.write(c)).on('end',()=>{console.error('err');process.exitCode=23})",
      ],
      stdin: "输入 😀\n",
      env,
    });
    expect(result).toMatchObject({ exitCode: 23, stdout: "输入 😀\n", stderr: "err\n", timedOut: false });
    await expect(
      core.processes.exec(ctx, { command: process.execPath, cwd: dirs.outside, args: ["-v"] }),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    const timeout = await core.processes.exec(ctx, {
      command: process.execPath,
      cwd,
      args: ["-e", "setInterval(()=>{},1000)"],
      env,
      timeoutMs: 300,
    });
    expect(timeout.timedOut).toBe(true);
    expect(timeout.exitCode).not.toBe(0);
  });
  it.each(["cmd", "powershell"] as const)(
    "runs the unchanged production %s shell provider with native byte stdio",
    async (shell) => {
      const result = await core.processes.shell(ctx, {
        shell,
        cwd,
        env,
        script:
          shell === "cmd"
            ? "echo native-cmd & exit /b 23"
            : "Write-Output 'native-ps'; [Console]::Error.WriteLine('native-error'); exit 23",
        timeoutMs: 15000,
      });
      expect(result.exitCode).toBe(23);
      expect(result.stdout).toContain(shell === "cmd" ? "native-cmd" : "native-ps");
      if (shell === "powershell") expect(result.stderr).toContain("native-error");
      expect(result.timedOut).toBe(false);
    },
  );
  it("preserves trusted .cmd wrapper escaping and environment without double quoting", async () => {
    const script = path.join(cwd, "echo space.cmd");
    await writeFile(script, "@echo off\r\necho [%~1]\r\nexit /b 23\r\n");
    const result = await core.processes.exec(ctx, { command: script, args: ["a b"], cwd, env });
    expect(result.exitCode).toBe(23);
    expect(result.stdout.trim()).toBe("[a b]");
  });
  it("ends a ready detached descendant after its direct parent exited", async () => {
    const script = "process.stdout.write('READY:'+process.pid+'\\n');setInterval(()=>{},1000)";
    const child = await launch(
      `const c=require('child_process').spawn(process.execPath,['-e',${JSON.stringify(script)}],{detached:true,stdio:['ignore','pipe','ignore']});c.stdout.once('data',d=>{process.stdout.write(d,()=>process.exit(23))});c.on('error',()=>process.exit(99));`,
    );
    let output = "";
    child.stdout.on("data", (data: Buffer) => {
      output += data.toString();
    });
    child.stderr.resume();
    await waitFor(() => output.includes("READY:") && child.hasExited, 10000);
    const pid = Number(/READY:(\d+)/.exec(output)?.[1]);
    expect(pid).toBeGreaterThan(0);
    expect(isAlive(pid)).toBe(true);
    expect((await child.exited).code).toBe(23);
    await child.terminate("force");
    await waitFor(() => !isAlive(pid), 10000);
  });
  it("closes pending reads and a backpressured stdin writer during cancellation", async () => {
    const child = await launch("setInterval(()=>{},1000)", true);
    child.stdout.resume();
    child.stderr.resume();
    child.stdin!.write(Buffer.alloc(2 * 1024 * 1024));
    await child.terminate("force");
    await waitFor(() => !isAlive(child.pid!), 10000);
    expect(child.hasExited).toBe(true);
    expect(child.failure).toBeUndefined();
    await child.terminate("force");
  });
});
