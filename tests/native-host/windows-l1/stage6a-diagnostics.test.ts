/**
 * Stage 6A: a passing diagnostic test means a bounded report was collected,
 * NOT that a failing compatibility row is accepted. Stage-6 gates stay intact.
 */
import { randomBytes } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import { beforeEach, afterEach, describe, expect, it, inject } from "vitest";
import { NativeHost } from "../../../src/native-host/native-host.js";
import { currentUserSid, windowsTools } from "../../../src/native-host/windows-acl.js";
import { loadJobObjectApi, type JobObjectApi } from "../../../src/native-host/windows-job.js";
import { loadRestrictedTokens, type RestrictedToken } from "../../../src/native-host/windows-l1/restricted-token.js";
import { loadProbeIntegrity } from "../../../src/native-host/windows-l1/probe-integrity.js";
import type { ProbeProcess } from "../../../src/native-host/windows-l1/probe-process.js";
import { isAlive, isWindows, makeTempDirs, waitFor, type TempDirs } from "../../helpers.js";

const emit = (section: string, value: unknown) => {
  const data = JSON.stringify(value).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  if (Buffer.byteLength(data) > 48000) throw new Error("Diagnostic annotation too large.");
  appendFileSync(inject("stage6aEvidence"), JSON.stringify({ title: `CROT-6A-${section}`, value }) + "\n");
};
const fixture = fileURLToPath(new URL("./fixtures/stage6a-client.mjs", import.meta.url));
const koffi = createRequire(import.meta.url).resolve("koffi");
if (process.env.CROT_WINDOWS_TOKEN_REQUIRED === "1" && (!isWindows || !["x64", "arm64"].includes(process.arch)))
  throw new Error("Required native Windows stage 6A diagnostics cannot run here.");

describe.runIf(isWindows)("Windows stage 6A diagnostic observations, not L1 acceptance", () => {
  let dirs: TempDirs, host: NativeHost, token: RestrictedToken, jobs: JobObjectApi;
  let workspace: string, low: string, secret: string;
  const processes: ProbeProcess[] = [];
  let baseEnv: Record<string, string>;
  beforeEach(async () => {
    dirs = await makeTempDirs();
    host = await NativeHost.start({ startupPath: "inherited", jobObjects: false });
    jobs = await loadJobObjectApi();
    const label = await loadProbeIntegrity();
    workspace = path.join(dirs.workspace, "проект space 😀");
    low = path.join(dirs.outside, "private-low");
    await mkdir(workspace);
    await mkdir(low);
    label(workspace, "medium-write");
    label(low, "low-write");
    secret = path.join(dirs.outside, "synthetic-state.txt");
    await writeFile(secret, randomBytes(32));
    await host.platform.privateFiles.protectFile!(secret);
    label(secret, "medium-no-read");
    const owner = await currentUserSid(windowsTools(process.env.SystemRoot ?? "C:\\Windows"));
    const n = randomBytes(16);
    token = (await loadRestrictedTokens()).create(
      `S-1-5-21-${n.readUInt32LE(0)}-${n.readUInt32LE(4)}-${n.readUInt32LE(8)}-${n.readUInt32LE(12)}`,
      false,
      undefined,
      "mic-only",
    );
    token.prepareProbeObjects(owner);
    token.lowerProbeIntegrity();
    baseEnv = {
      SystemRoot: process.env.SystemRoot ?? "C:\\Windows",
      TEMP: low,
      TMP: low,
      CROT_6A_KOFFI: koffi,
      CROT_6A_SECRET: secret,
      CROT_6A_WORKSPACE: workspace,
      CROT_6A_RESULT: path.join(low, "report.json"),
      CROT_6A_CHILD: path.join(low, "child.json"),
      CROT_6A_NODE: process.execPath,
      CROT_6A_CLIENT: fixture,
      CROT_6A_PS_REPORT: path.join(low, "powershell.txt"),
    };
  });
  afterEach(async () => {
    for (const child of processes.splice(0)) child.close();
    token?.close();
    await host?.close();
    await dirs?.cleanup();
  });
  it("records exact build, own-token/std-handle state and a trusted runtime control", async () => {
    const moduleUrl = new URL("./fixtures/stage6a-native.mjs", import.meta.url).href;
    const native = await import(moduleUrl);
    const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
    const registry = execFileSync(
      path.join(systemRoot, "System32", "reg.exe"),
      ["query", "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion", "/v", "UBR"],
      { encoding: "utf8", windowsHide: true },
    );
    const ubr = /\bREG_DWORD\s+(0x[0-9a-f]+)/i.exec(registry)?.[1];
    expect(ubr).toBeDefined();
    emit("metadata", {
      sourceBaseline: "4031536a45d67743e5fe25b18faaf36895692f67",
      testedCheckout: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true }).trim(),
      githubSha: process.env.GITHUB_SHA ?? null,
      osVersion: os.version(),
      ubr: Number.parseInt(ubr!, 16),
      parent: native.snapshot(koffi),
      trustedSecretReadable: (await readFile(secret)).length === 32,
      experimentalSandboxApi: native.sandboxApiAvailability(koffi),
      workspaceSpelling: "проект space 😀",
      configuration: "mic-only Low token; unchanged Medium workspace; private Low temp; explicit environment",
    });
    // Trusted fixture waits for GO before creating any child. It is not an
    // untrusted launch boundary; the Low launcher still assigns before resume.
    const trusted = spawn(process.execPath, [fixture], {
      cwd: workspace,
      env: { ...baseEnv, CROT_6A_WAIT_FOR_GO: "1" },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    trusted.stdout.resume();
    trusted.stderr.resume();
    const owned = jobs.createKillOnCloseJob();
    try {
      expect(trusted.pid).toBeGreaterThan(0);
      expect(owned.assign(trusted.pid!)).toBe(true);
      trusted.stdin.end("GO");
      await waitFor(() => trusted.exitCode !== null, 100000);
      const report = JSON.parse(await readFile(baseEnv.CROT_6A_RESULT!, "utf8"));
      emit("trusted-control", report);
      expect(report.complete).toBe(true);
      expect(report.rows.every((r: { attempted: boolean }) => r.attempted)).toBe(true);
      const held = report.rows.find((r: { api: string }) => r.api === "spawn-hold");
      if (held?.pid && held?.child?.ready) expect(isAlive(held.pid)).toBe(true);
    } finally {
      owned.terminate(1);
      owned.close();
      if (trusted.exitCode === null) trusted.kill();
    }
  }, 110000);
  it("records Low spawn failures explicitly and proves tree cleanup only after readiness", async () => {
    const job = jobs.createKillOnCloseJob();
    const child = token.launchProbe(
      { executable: process.execPath, args: [fixture], cwd: workspace, env: baseEnv },
      job,
    );
    processes.push(child);
    await waitFor(() => child.exitCode() !== null, 110000);
    const text = await readFile(baseEnv.CROT_6A_RESULT!, "utf8").catch(() => null);
    if (!text) emit("low-missing", { exitCode: child.exitCode(), accounting: job.accounting() });
    expect(text).not.toBeNull();
    const report = JSON.parse(text!);
    const held = report.rows.find((r: { api: string }) => r.api === "spawn-hold");
    const ready = !!held?.child?.ready && Number.isInteger(held.pid) && isAlive(held.pid);
    const before = job.accounting();
    const parentExitCode = child.exitCode();
    child.close();
    if (ready) await waitFor(() => !isAlive(held.pid), 10000);
    emit("low-runtime", report);
    emit("low-cleanup", {
      parentExited: true,
      parentExitCode,
      before,
      readyObserved: ready,
      descendantGoneAfterJobClose: ready ? !isAlive(held.pid) : null,
      status: ready ? "exercised" : "NOT_EXERCISED_CHILD_NOT_READY",
    });
    expect(report.complete).toBe(true);
    expect(report.snapshot.integrity).toBe("S-1-16-4096");
    expect(report.rows.every((r: { attempted: boolean }) => r.attempted)).toBe(true);
    if (ready) expect(isAlive(held.pid)).toBe(false);
  }, 130000);
  it("separates ordinary CRUD and shell redirection from explicit mediation", async () => {
    const label = await loadProbeIntegrity();
    const outsideLow = path.join(dirs.outside, "unapproved-low-control");
    await mkdir(outsideLow);
    // NEW disposable control only; never relabel a user's file or workspace.
    label(outsideLow, "low-write");
    const roots = { mediumWorkspace: workspace, privateLowControl: low, outsideLowControl: outsideLow };
    for (const root of Object.values(roots))
      for (const op of ["read", "write", "rename", "remove"])
        await writeFile(path.join(root, `${op} проба.txt`), "before");
    const file = fileURLToPath(new URL("./fixtures/stage6a-writes.mjs", import.meta.url));
    const process = token.launchProbe(
      {
        executable: baseEnv.CROT_6A_NODE!,
        args: [file],
        cwd: workspace,
        env: { ...baseEnv, CROT_6A_OUTSIDE_LOW: outsideLow },
      },
      jobs.createKillOnCloseJob(),
    );
    processes.push(process);
    await waitFor(() => process.exitCode() !== null, 20000);
    const report = JSON.parse(await readFile(baseEnv.CROT_6A_RESULT!, "utf8"));
    const observed = [];
    for (const [area, root] of Object.entries(roots)) {
      const exists = async (name: string) =>
        access(path.join(root, name)).then(
          () => true,
          () => false,
        );
      observed.push({
        area,
        created: await exists("create проба.txt"),
        written: await readFile(path.join(root, "write проба.txt"), "utf8"),
        renamed: await exists("renamed проба.txt"),
        sourceStillPresent: await exists("rename проба.txt"),
        removed: !(await exists("remove проба.txt")),
      });
    }
    emit("ordinary-crud", { exitCode: process.exitCode(), ...report, observed });
    expect(report.cwdMatched).toBe(true);
    expect(report.rows).toHaveLength(15);
    expect(report.rows.every((r: { attempted: boolean }) => r.attempted)).toBe(true);
    // Redirection is attempted independently of launching a Node client.
    for (const shell of ["cmd", "powershell"]) {
      const mediumOutput = path.join(workspace, `${shell}-redirection.txt`);
      const controlOutput = path.join(low, `${shell}-redirection.txt`);
      const env = { ...baseEnv, CROT_6A_REDIRECT_MEDIUM: mediumOutput, CROT_6A_REDIRECT_LOW: controlOutput };
      const tools = windowsTools(baseEnv.SystemRoot!);
      const script =
        shell === "cmd"
          ? '@echo off\r\necho marker>"%CROT_6A_REDIRECT_MEDIUM%"\r\necho marker>"%CROT_6A_REDIRECT_LOW%"\r\n'
          : "'marker' > $env:CROT_6A_REDIRECT_MEDIUM; 'marker' > $env:CROT_6A_REDIRECT_LOW";
      const scriptPath = path.join(workspace, "redirect.cmd");
      if (shell === "cmd") await writeFile(scriptPath, script);
      const child = token.launchProbe(
        {
          executable: shell === "cmd" ? path.join(baseEnv.SystemRoot!, "System32", "cmd.exe") : tools.powershell,
          args:
            shell === "cmd"
              ? ["/d", "/c", "redirect.cmd"]
              : ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
          cwd: workspace,
          env,
        },
        jobs.createKillOnCloseJob(),
      );
      processes.push(child);
      let exited = false;
      try {
        await waitFor(() => child.exitCode() !== null, 15000);
        exited = true;
      } catch {
        /* reported */
      }
      emit("redirection", {
        shell,
        attempted: true,
        exited,
        exitCode: exited ? child.exitCode() : null,
        mediumFilePresent: await access(mediumOutput).then(
          () => true,
          () => false,
        ),
        lowFilePresent: await access(controlOutput).then(
          () => true,
          () => false,
        ),
      });
      child.close();
    }
  }, 65000);
  it("localizes PowerShell native invocation versus fully redirected ProcessStartInfo", async () => {
    const script = await readFile(new URL("./fixtures/stage6a-powershell.ps1", import.meta.url), "utf8");
    const child = token.launchProbe(
      {
        executable: windowsTools(process.env.SystemRoot ?? "C:\\Windows").powershell,
        args: ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
        cwd: workspace,
        env: baseEnv,
      },
      jobs.createKillOnCloseJob(),
    );
    processes.push(child);
    let exited = false;
    try {
      await waitFor(() => child.exitCode() !== null, 35000);
      exited = true;
    } catch {
      // A diagnostic timeout is reported, not silently counted as compatibility.
    }
    const text = await readFile(baseEnv.CROT_6A_PS_REPORT!, "utf8").catch(() => "");
    const fields = Object.fromEntries(
      text
        .trim()
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
    );
    emit("powershell", { exited, exitCode: exited ? child.exitCode() : null, fields });
    child.close();
    expect(fields.entry, "PowerShell diagnostic entry must actually execute").toBe("1");
    // Specific failed invocation rows remain failures in the original stage-6 gate.
  }, 50000);
});
