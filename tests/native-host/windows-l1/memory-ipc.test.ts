/** Native attack probes against disposable canaries, not full L1 acceptance. */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { beforeEach, afterEach, describe, it, expect } from "vitest";
import { NativeHost } from "../../../src/native-host/native-host.js";
import { currentUserSid, windowsTools } from "../../../src/native-host/windows-acl.js";
import { loadJobObjectApi, type JobObjectApi, type JobObject } from "../../../src/native-host/windows-job.js";
import { loadProbeIntegrity } from "../../../src/native-host/windows-l1/probe-integrity.js";
import { loadRestrictedTokens, type RestrictedToken } from "../../../src/native-host/windows-l1/restricted-token.js";
import type { ProbeProcess } from "../../../src/native-host/windows-l1/probe-process.js";
import { isWindows, makeTempDirs, waitFor, type TempDirs } from "../../helpers.js";
if (process.env.CROT_WINDOWS_TOKEN_REQUIRED === "1" && (!isWindows || !["x64", "arm64"].includes(process.arch)))
  throw new Error("Required native Windows memory/IPC probes cannot run here.");
interface Victim {
  pid: number;
  address: string;
  handle: string;
  pipes: { control: string; ordinary: string; protected: string; low: string };
}
const fixtureUrl = new URL("./fixtures/memory-ipc.mjs", import.meta.url).href;
const koffi = createRequire(import.meta.url).resolve("koffi");
describe.runIf(isWindows)("Windows L1 spike: real memory/handle/readonly IPC canaries", () => {
  let dirs: TempDirs, host: NativeHost, token: RestrictedToken, jobs: JobObjectApi, ownedJob: JobObject;
  let victim: ChildProcess, info: Victim, executable: string, expected: string;
  let stderr = "";
  const probes: ProbeProcess[] = [];
  beforeEach(async () => {
    dirs = await makeTempDirs();
    host = await NativeHost.start({ startupPath: "inherited", jobObjects: false });
    jobs = await loadJobObjectApi();
    const label = await loadProbeIntegrity();
    const n = randomBytes(16);
    const sid = `S-1-5-21-${n.readUInt32LE(0)}-${n.readUInt32LE(4)}-${n.readUInt32LE(8)}-${n.readUInt32LE(12)}`;
    const owner = await currentUserSid(windowsTools(process.env.SystemRoot ?? "C:\\Windows"));
    token = (await loadRestrictedTokens()).create(sid, false, undefined, "mic-only");
    token.prepareProbeObjects(owner);
    label(dirs.workspace, "low-write");
    token.lowerProbeIntegrity();
    executable = path.join(dirs.workspace, "node probe.exe");
    await copyFile(process.execPath, executable);
    expected = randomBytes(32).toString("hex");
    const file = path.join(dirs.outside, "artificial-secret.bin");
    await writeFile(file, Buffer.from(expected, "hex"));
    await host.platform.privateFiles.protectFile!(file);
    label(file, "medium-no-read");
    const ready = path.join(dirs.outside, "victim-ready.json");
    const prefix = `\\\\.\\pipe\\crot-canary-${randomBytes(16).toString("hex")}`;
    stderr = "";
    victim = spawn(
      process.execPath,
      [
        fileURLToPath(new URL("./fixtures/memory-victim.mjs", import.meta.url)),
        koffi,
        ready,
        file,
        owner,
        prefix,
        expected,
      ],
      {
        cwd: dirs.outside,
        env: { ...host.platform.baseEnvironment },
        windowsHide: true,
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    victim.stderr!.on("data", (b) => {
      stderr = (stderr + String(b)).slice(-1600);
    });
    // This trusted fixture is not an untrusted launch boundary. All its work
    // and blocking native pipe threads are owned by a disposable Job.
    ownedJob = jobs.createKillOnCloseJob();
    expect(victim.pid).toBeGreaterThan(0);
    expect(ownedJob.assign(victim.pid!)).toBe(true);
    await waitFor(async () => {
      if (victim.exitCode !== null || victim.signalCode !== null) throw new Error(`Canary fixture exited: ${stderr}`);
      const text = await readFile(ready, "utf8").catch(() => "");
      if (!text) return false;
      info = JSON.parse(text) as Victim;
      return true;
    }, 10000);
    expect(info.pid).toBe(victim.pid);
  });
  afterEach(async () => {
    for (const p of probes.splice(0)) p.close();
    ownedJob?.terminate(1);
    ownedJob?.close();
    if (victim) {
      if (victim.exitCode === null && victim.signalCode === null) victim.kill();
      await waitFor(() => victim.exitCode !== null || victim.signalCode !== null);
    }
    token?.close();
    await host?.close();
    await dirs?.cleanup();
  });
  const attack = async (body: string) => {
    const result = path.join(dirs.workspace, "attack.json");
    const script = `void(async()=>{const m=await import(${JSON.stringify(fixtureUrl)});const r=await(${body});require('fs').writeFileSync(${JSON.stringify(result)},JSON.stringify(r));})();`;
    const p = token.launchProbe(
      {
        executable,
        args: ["-e", script],
        cwd: dirs.workspace,
        env: { SystemRoot: process.env.SystemRoot ?? "C:\\Windows", TEMP: dirs.workspace, TMP: dirs.workspace },
      },
      jobs.createKillOnCloseJob(),
    );
    probes.push(p);
    await waitFor(() => p.exitCode() !== null, 10000);
    expect(p.exitCode()).toBe(0);
    return JSON.parse(await readFile(result, "utf8"));
  };
  it("denies memory reads and handle theft after trusted controls actually read the synthetic canary", async () => {
    const native = await import(fixtureUrl);
    const control = native.probeProcess(koffi, info, expected);
    expect(control.memory.matched).toBe(true);
    expect(control.duplicate.matched).toBe(true);
    const r = await attack(
      `m.probeProcess(${JSON.stringify(koffi)},${JSON.stringify(info)},${JSON.stringify(expected)})`,
    );
    for (const key of ["memory", "duplicate"]) {
      expect(r[key].matched ?? false).toBe(false);
      expect([5, 1314]).toContain(r[key].error);
      if (r[key].opened) expect(key === "memory" ? r[key].read : r[key].copied).toBe(0);
    }
  });
  it("readonly IPC exposes an ordinary pipe but NR denies it; a Low local fixture pipe still works", async () => {
    const native = await import(fixtureUrl);
    const control = native.readCanaryPipe(koffi, info.pipes.control, expected);
    expect(control.matched).toBe(true);
    const r = await attack(
      `{plain:m.readCanaryPipe(${JSON.stringify(koffi)},${JSON.stringify(info.pipes.ordinary)},${JSON.stringify(expected)}),protected:m.readCanaryPipe(${JSON.stringify(koffi)},${JSON.stringify(info.pipes.protected)},${JSON.stringify(expected)}),low:m.readCanaryPipe(${JSON.stringify(koffi)},${JSON.stringify(info.pipes.low)},${JSON.stringify(expected)})}`,
    );
    // Expected exposure rejects relying on Low/NW alone for secret-bearing IPC.
    expect(r.plain.matched).toBe(true);
    expect(r.protected.opened).toBe(false);
    expect([5, 1314]).toContain(r.protected.error);
    expect(r.low.matched).toBe(true);
  });
});
