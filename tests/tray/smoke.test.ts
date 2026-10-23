import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ServeCommand } from "../../src/cli/options.js";
import { createPrivateFileProtection } from "../../src/core/platform/private-files.js";
import { ControlClient } from "../../src/service/control-client.js";
import type { ControlOverview } from "../../src/service/protocol.js";
import { CrotService } from "../../src/service/service.js";
import { isWindows, makeTempDirs, testContext, waitFor, type TempDirs } from "../helpers.js";

/**
 * WP-22 UI smoke test: the built Electron tray (`dist/tray/main.js`) connects
 * to a real service with a pending approval, renders it, and reports what the
 * page shows (`--smoke-test`, which never decides). It needs a desktop
 * session: on Linux without DISPLAY it runs under xvfb-run. Where Electron
 * cannot start (no GUI libraries), it is skipped with the reason — except on
 * CI (CI=true), where it must run.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const mainScript = path.join(root, "dist/tray/main.js");
const onCi = process.env.CI === "true";
/**
 * Chromium switches for every Electron start of this test, the probe included.
 * Linux CI (Ubuntu 24.04) restricts unprivileged user namespaces and `npm ci`
 * leaves chrome-sandbox without SUID root, so the Chromium sandbox aborts at
 * start-up unless it is disabled. Test runs only; the tray itself is unchanged.
 */
const chromiumSwitches = process.platform === "linux" ? ["--no-sandbox", "--disable-gpu"] : [];

function electronBinary(): string | undefined {
  try {
    return createRequire(import.meta.url)("electron") as string;
  } catch {
    return undefined;
  }
}

/** Command prefix that gives Electron a display, and the reason Electron cannot run here (if it cannot). */
function launcher(): { prefix: string[]; problem?: string } {
  const electron = electronBinary();
  if (!electron || !existsSync(electron)) return { prefix: [], problem: "the Electron binary is not installed" };
  if (!existsSync(mainScript)) return { prefix: [], problem: "dist/tray/main.js is missing (run npm run build)" };
  const linux = process.platform === "linux";
  const needsXvfb = linux && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
  if (needsXvfb && spawnSync("xvfb-run", ["--help"], { stdio: "ignore" }).error)
    return { prefix: [], problem: "no DISPLAY and xvfb-run is not available" };
  const prefix = [...(needsXvfb ? ["xvfb-run", "-a"] : []), electron];
  const probe = spawnSync(prefix[0]!, [...prefix.slice(1), "--version", ...chromiumSwitches], {
    encoding: "utf8",
    timeout: 30_000,
    env: electronEnv(),
  });
  if (probe.status !== 0) {
    // xvfb-run runs the command as `"$@" 2>&1`: Electron's diagnostics arrive on stdout.
    const output = `${probe.stderr ?? ""}\n${probe.stdout ?? ""}`;
    const reason =
      output.split("\n").find((line) => /FATAL|error/i.test(line) && !/dbus/.test(line)) ??
      probe.error?.message ??
      `exit status ${probe.status}, signal ${probe.signal}`;
    return { prefix, problem: `Electron cannot start: ${reason.trim()}` };
  }
  return { prefix };
}

function electronEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

const launch = launcher();
if (launch.problem && !onCi) console.warn(`tray smoke test skipped: ${launch.problem}`);

const privateFiles = createPrivateFileProtection(isWindows);
let dirs: TempDirs;
let stateDir: string;
let service: CrotService | undefined;

beforeAll(async () => {
  dirs = await makeTempDirs();
  stateDir = isWindows ? path.join(dirs.outside, "state") : await mkdtemp(path.join("/tmp", "crot-ts-"));
});
afterAll(async () => {
  await service?.shutdown("test end");
  if (!isWindows) await rm(stateDir, { recursive: true, force: true });
  await dirs.cleanup();
});

describe.skipIf(launch.problem !== undefined && !onCi)("WP-22: Electron tray smoke test", () => {
  it("renders a pending approval from the service and never decides it", { timeout: 90_000 }, async () => {
    expect(launch.problem, "on CI the tray smoke test must run").toBeUndefined();
    const command: ServeCommand = {
      kind: "serve",
      config: {
        workspace: { root: dirs.workspace },
        audit: { sink: "file", path: path.join(dirs.outside, "audit.jsonl") },
        environment: { path: "inherited" },
        secrets: { store: "file" },
        permissions: {
          approvals: { rules: [{ id: "writes", match: { capabilities: ["filesystem.write"] } }], timeoutMs: 120_000 },
        },
      } as ServeCommand["config"],
      warnings: [],
    };
    const started = await CrotService.start({
      command,
      launch: "managed",
      stateDir,
      privateFiles,
      log: () => undefined,
      requestStop: () => undefined,
      resume: { intervalMs: 60_000, thresholdMs: 10_000 },
    });
    if (started === "already_running") throw new Error("already running");
    service = started;
    // A subscribed helper keeps the request waiting (with no approval UI it is denied at once).
    const helper = (await ControlClient.connect({ stateDir, privateFiles }))!;
    let requested = 0;
    helper.onevent = (e) => {
      if (e.event === "approval.requested") requested++;
    };
    await helper.request("approvals.subscribe");
    const pending = async () => ((await helper.request("overview")) as ControlOverview).approvals.pending;
    const writing = service.core.filesystem.writeFile(testContext, { path: "evil\u202etxt.exe", content: "x" }).then(
      () => "approved",
      (e: { details?: { approval?: { status?: string } } }) => e.details?.approval?.status ?? "error",
    );
    await waitFor(() => requested === 1);

    const report = path.join(dirs.outside, "smoke.json");
    const args = [
      ...launch.prefix.slice(1),
      mainScript,
      `--state-dir=${stateDir}`,
      `--smoke-test=${report}`,
      ...chromiumSwitches,
    ];
    const child = spawn(launch.prefix[0]!, args, { env: electronEnv(), stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (d) => (output += String(d)));
    child.stderr.on("data", (d) => (output += String(d)));
    const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
    const parsed = JSON.parse(await readFile(report, "utf8").catch(() => `{"missing":${JSON.stringify(output)}}`));
    expect(parsed, output).toMatchObject({ connection: "connected", viewCards: 1 });
    expect(code).toBe(0);
    const page = parsed.page as Record<string, unknown>;
    expect(page.cards).toBe(1);
    expect(page.nodeVisible).toBe(false);
    expect(page.api).toEqual(["action", "decide", "onView", "product", "ready", "repairL1", "tool"]);
    expect(page.links).toBe(0);
    expect(page.headline).toBe("1 request waiting for your approval");
    expect(page.text).toContain("evil[U+202E]txt.exe");

    // The smoke run never decides: the request is still waiting.
    expect(await pending()).toBe(1);
    helper.close();
    await service.shutdown("test end");
    service = undefined;
    expect(await writing).toBe("cancelled");
  });
});
