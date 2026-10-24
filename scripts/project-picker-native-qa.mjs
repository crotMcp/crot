/** Native chooser qualification: shipped Electron + real CrotService.
 * Linux runs under X11; AppKit/Windows use actual owned native dialog controls.
 * Never replaces dialog.showOpenDialog or IPC. No external accessibility bypass.
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { _electron } from "playwright-core";
import { pathToFileURL } from "node:url";
import { nativePickerDriver } from "./project-picker-native-driver.mjs";
const buildRoot = path.resolve(process.argv.find((arg) => arg.startsWith("--build-root="))?.slice(13) || "dist");
const load = (name) => import(pathToFileURL(path.join(buildRoot, name)).href);
const { createPrivateFileProtection } = await load("core/platform/private-files.js");
const { ControlClient } = await load("service/control-client.js");
const { CrotService } = await load("service/service.js");
if (process.platform === "linux" && !process.env.DISPLAY)
  throw Error("Linux native qualification requires X11; use xvfb-run -a.");
const output = process.argv.find((arg) => arg.startsWith("--output="))?.slice(9);
if (!output) throw Error("Pass --output=<report.json>; failure evidence must be retained.");
const until = async (predicate, label) => {
  const end = Date.now() + 20_000;
  while (Date.now() < end) {
    if (await predicate()) return;
    await delay(100);
  }
  throw Error("Timed out: " + label);
};
const startedAt = Date.now();
const base = await realpath(await mkdtemp(path.join(tmpdir(), "crot-native-picker-")));
const workspace = path.join(base, "initial"),
  selected = path.join(base, "chosen project"),
  stateDir = path.join(base, "state"),
  auditFile = path.join(base, "audit.jsonl");
let service, electron, client, driver, electronChild, page;
const report = { platform: process.platform, checks: [], errors: [] };
try {
  for (const dir of [workspace, selected, stateDir]) await mkdir(dir, { mode: 0o700 });
  await writeFile(path.join(stateDir, "secrets.json"), JSON.stringify({ version: 1, backend: "file" }), {
    mode: 0o600,
  });
  const privateFiles = createPrivateFileProtection(process.platform === "win32");
  service = await CrotService.start({
    command: {
      kind: "serve",
      config: {
        workspace: { root: workspace },
        environment: { path: "inherited" },
        audit: { sink: "file", path: auditFile },
        secrets: { store: "file" },
      },
      warnings: [],
    },
    launch: "managed",
    stateDir,
    privateFiles,
    log: () => {},
    requestStop: () => {},
  });
  assert.notEqual(service, "already_running");
  client = await ControlClient.connect({ stateDir, privateFiles });
  assert.ok(client);
  const configHome = path.join(base, "config");
  await mkdir(path.join(configHome, "gtk-3.0"), { recursive: true });
  // Stable GTK native controls in the isolated test desktop, not a replacement dialog.
  await writeFile(path.join(configHome, "gtk-3.0", "settings.ini"), "[Settings]\ngtk-dialogs-use-header=false\n");
  const env = {
    ...process.env,
    HOME: base,
    XDG_CONFIG_HOME: configHome,
    GTK_USE_PORTAL: "0",
    ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
  };
  delete env.ELECTRON_RUN_AS_NODE;
  electron = await _electron.launch({
    executablePath: createRequire(import.meta.url)("electron"),
    args: [
      path.join(buildRoot, "tray/main.js"),
      `--state-dir=${stateDir}`,
      ...(process.platform === "linux" ? ["--no-sandbox", "--disable-gpu"] : []),
    ],
    env,
    timeout: 30_000,
  });
  electronChild = electron.process();
  page = await electron.firstWindow();
  page.on("pageerror", (error) => report.errors.push(String(error)));
  await page.locator("#local-mode").click();
  await page.locator("#choose-free").click();
  await page.locator("#nav-projects").click();
  const button = page.getByRole("button", { name: "Open Folder", exact: true });
  await button.waitFor();
  const list = () => client.request("projects.list");
  const initial = await list();
  driver = await nativePickerDriver(electron, output, until);
  report.phase = "native cancellation";
  await button.click();
  await driver.wait();
  await driver.cancel();
  await delay(300);
  assert.deepEqual(await list(), initial);
  assert.equal(service.core.workspace.root, workspace);
  report.checks.push("Native folder cancellation preserves registry and Core workspace");

  report.phase = "native folder selection";
  await button.click();
  await driver.wait();
  await driver.choose(selected);
  await until(async () => {
    const result = await list();
    return result.projects.some((project) => project.path === selected && project.id === result.active);
  }, "service registration and workspace switch after OS folder choice");
  assert.equal(service.core.workspace.root, selected);
  await page.getByText(selected, { exact: true }).first().waitFor();
  const journal = (await readFile(auditFile, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.ok(journal.some((event) => event.operation === "projects.open"));
  assert.ok(journal.some((event) => event.operation === "projects.select"));
  report.checks.push("Native choice (including spaces) registers, selects, changes real Core and refreshes shipped UI");
  report.checks.push("Real audit records projects.open and projects.select");
  assert.deepEqual(report.errors, []);
  report.electron = await electron.evaluate(({ app }) => app.getVersion());
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.electronProcess = electronChild
    ? { exitCode: electronChild.exitCode, signalCode: electronChild.signalCode }
    : null;
  report.registry = await client?.request("projects.list").catch(() => null);
  report.coreWorkspace = service?.core?.workspace?.root;
  report.nativeDialog = await driver?.diagnostics().catch((error) => String(error));
  report.rendererNotice = await page
    ?.locator('[role="alert"], #toast')
    .allTextContents()
    .catch(() => []);
  if (
    process.platform === "darwin" &&
    electronChild &&
    (electronChild.exitCode !== null || electronChild.signalCode !== null)
  ) {
    const diagnostics = path.join(homedir(), "Library", "Logs", "DiagnosticReports");
    const names = (await readdir(diagnostics).catch(() => []))
      .filter((name) => /^Electron.*\.ips$/.test(name))
      .slice(-100);
    for (const name of names) {
      try {
        const file = path.join(diagnostics, name),
          meta = await stat(file);
        if (meta.mtimeMs < startedAt - 1000 || meta.size > 2 * 1024 * 1024) continue;
        const raw = await readFile(file, "utf8");
        let crash;
        try {
          crash = JSON.parse(raw);
        } catch {
          crash = JSON.parse(raw.slice(raw.indexOf("\n") + 1));
        }
        if (crash.pid !== electronChild.pid) continue;
        report.nativeCrash = {
          exception: crash.exception,
          termination: crash.termination,
          faultingThread: crash.faultingThread,
          frames: crash.threads?.[crash.faultingThread]?.frames
            ?.slice(0, 16)
            .map((frame) => ({ symbol: frame.symbol, imageIndex: frame.imageIndex })),
        };
        break;
      } catch {
        /* Crash reports are optional diagnostics, never an acceptance signal. */
      }
    }
  }
  report.errors.push(String(error?.stack ?? error));
  process.exitCode = 1;
} finally {
  const cleanup = async (label, fn) => {
    try {
      await fn();
    } catch (error) {
      report.errors.push(label + ": " + error);
    }
  };
  if (driver) await cleanup("Native dialog close", () => driver.cancel());
  if (electron) await cleanup("Electron close", () => electron.close());
  client?.close();
  if (service && service !== "already_running")
    await cleanup("Service shutdown", () => service.shutdown("native picker test end"));
  await cleanup("Fixture cleanup", () => rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  if (report.errors.length) {
    report.status = "failed";
    process.exitCode = 1;
  }
  await writeFile(output, JSON.stringify(report, null, 2) + "\n");
  process.stdout.write(
    JSON.stringify({ status: report.status, checks: report.checks.length, errors: report.errors.length }) + "\n",
  );
}
