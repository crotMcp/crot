/* Diagnostic fixture, not a production filesystem or process adapter. */
import process from "node:process";
import { readFileSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { setInterval, setTimeout, clearTimeout } from "node:timers";
import { snapshot, nativeChild } from "./stage6a-native.mjs";

const reportPath = process.env.CROT_6A_RESULT;
const childPath = process.env.CROT_6A_CHILD;
const fixture = fileURLToPath(import.meta.url);
if (process.argv[2] !== "child" && process.env.CROT_6A_WAIT_FOR_GO === "1")
  await new Promise((resolve) => process.stdin.once("data", resolve));
const errorRecord = (e) =>
  e ? { code: e.code ?? null, errno: e.errno ?? null, syscall: e.syscall?.split(" ")[0] ?? null } : null;
const readChild = () => {
  try {
    return JSON.parse(readFileSync(childPath, "utf8"));
  } catch {
    return null;
  }
};
if (process.argv[2] === "child") {
  let secret;
  try {
    readFileSync(process.env.CROT_6A_SECRET);
    secret = "EXPOSED";
  } catch (e) {
    secret = e.code;
  }
  writeFileSync(
    childPath,
    JSON.stringify({ snapshot: snapshot(process.env.CROT_6A_KOFFI), secret, ready: true, pid: process.pid }),
  );
  if (process.argv[3] === "hold") await new Promise(() => setInterval(() => {}, 1000));
  // A fixed ASCII marker makes stdout observation independent of code page.
  if (process.env.CROT_6A_EMIT === "1") {
    process.stdout.write("child-out");
    process.stderr.write("child-err");
  }
  process.exit(17);
}
const report = { rows: [] };
try {
  report.snapshot = snapshot(process.env.CROT_6A_KOFFI);
} catch (e) {
  report.complete = false;
  report.phase = "initial-snapshot-failed";
  report.error = { ...errorRecord(e), name: e.name, message: e.message?.slice(0, 400) };
  writeFileSync(reportPath, JSON.stringify(report));
  process.exit(98);
}
const persist = (phase) => {
  report.phase = phase;
  writeFileSync(reportPath, JSON.stringify(report));
};
persist("snapshot-complete");
const reset = () => writeFileSync(childPath, "null");
try {
  for (const suspended of [false, true]) {
    reset();
    persist(`before-CreateProcessW-${suspended}`);
    report.rows.push({
      api: "CreateProcessW",
      cwd: "workspace",
      stdio: "no-inheritance",
      suspended,
      ...nativeChild(process.env.CROT_6A_KOFFI, fixture, process.env.CROT_6A_WORKSPACE, suspended),
      child: readChild(),
    });
  }
  persist("native-controls-complete");
  for (const cwd of ["workspace", "privateLow"]) {
    for (const stdio of ["pipe", "ignore", "inherit"]) {
      reset();
      persist(`before-spawnSync-${cwd}-${stdio}`);
      const child = spawnSync(process.execPath, [fixture, "child"], {
        cwd: cwd === "workspace" ? process.env.CROT_6A_WORKSPACE : process.env.TEMP,
        env: { ...process.env, CROT_6A_EMIT: stdio === "pipe" ? "1" : "0" },
        stdio,
        windowsHide: true,
        encoding: "utf8",
        timeout: 8000,
      });
      report.rows.push({
        api: "spawnSync",
        cwd,
        stdio,
        attempted: true,
        error: errorRecord(child.error),
        status: child.status,
        signal: child.signal,
        stdoutMatched: child.stdout === "child-out",
        stderrMatched: child.stderr === "child-err",
        child: readChild(),
      });
      persist(`after-spawnSync-${cwd}-${stdio}`);
    }
  }
  for (const stdio of ["pipe", "ignore"]) {
    reset();
    persist(`before-spawn-${stdio}`);
    const row = await new Promise((resolve) => {
      const child = spawn(process.execPath, [fixture, "child"], {
        cwd: process.env.CROT_6A_WORKSPACE,
        env: { ...process.env, CROT_6A_EMIT: stdio === "pipe" ? "1" : "0" },
        windowsHide: true,
        stdio,
      });
      let error = null;
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (b) => (stdout = (stdout + String(b)).slice(0, 256)));
      child.stderr?.on("data", (b) => (stderr = (stderr + String(b)).slice(0, 256)));
      child.on("error", (e) => (error = errorRecord(e)));
      const timeout = setTimeout(() => child.kill(), 8000);
      child.on("close", (status, signal) => {
        clearTimeout(timeout);
        resolve({
          api: "spawn",
          cwd: "workspace",
          stdio,
          attempted: true,
          error,
          status,
          signal,
          stdoutMatched: stdout === "child-out",
          stderrMatched: stderr === "child-err",
          child: readChild(),
        });
      });
    });
    report.rows.push(row);
    persist(`after-spawn-${stdio}`);
  }
  reset();
  const held = spawn(process.execPath, [fixture, "child", "hold"], {
    cwd: process.env.CROT_6A_WORKSPACE,
    env: { ...process.env, CROT_6A_EMIT: "0" },
    windowsHide: true,
    stdio: "pipe",
    detached: true,
  });
  let holdError = null;
  let holdExit = null;
  held.on("exit", (code, signal) => {
    holdExit = { code, signal };
  });
  held.on("error", (e) => (holdError = errorRecord(e)));
  const deadline = Date.now() + 8000;
  while (!holdError && !readChild()?.ready && Date.now() < deadline) await delay(10);
  report.rows.push({
    api: "spawn-hold",
    attempted: true,
    error: holdError,
    pid: held.pid ?? null,
    exitBeforeParent: holdExit,
    child: readChild(),
  });
  held.unref();
  held.stdout?.destroy();
  held.stderr?.destroy();
  held.stdin?.destroy();
  report.complete = true;
  persist("complete");
} catch (e) {
  report.complete = false;
  report.error = errorRecord(e);
}
writeFileSync(reportPath, JSON.stringify(report));
// Parent exit is deliberately NOT treated as descendant cleanup evidence.
process.exit(0);
