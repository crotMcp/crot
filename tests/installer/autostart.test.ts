import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { autostartPlan, autostartStatus, installAutostart, removeAutostart } from "../../src/installer/autostart.js";
import type { OsFamily } from "../../src/core/platform/types.js";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function spec(osFamily: OsFamily) {
  const home = await mkdtemp(path.join(os.tmpdir(), "crot-autostart-"));
  roots.push(home);
  return {
    os: osFamily,
    home,
    executable: path.join(home, "CROT bin", "crot-mcp"),
    configFile: path.join(home, "config.json"),
  };
}

describe("WP-34 per-user autostart", () => {
  it.each(["linux", "macos", "windows"] as const)("installs, reports and removes %s", async (osFamily) => {
    const input = await spec(osFamily);
    const calls: string[][] = [];
    const runner = async (file: string, args: readonly string[]) => {
      calls.push([file, ...args]);
    };
    const plan = await installAutostart(input, runner);
    expect(await autostartStatus(input, runner)).toBe(true);
    for (const artifact of plan.artifacts) expect(await readFile(artifact.file, "utf8")).toBe(artifact.content);
    await removeAutostart(input, runner);
    expect(await autostartStatus(input, runner)).toBe(false);
    expect(calls.length).toBeGreaterThanOrEqual(3);
  });
  it("uses failure restart and protects Linux L1 storage", async () => {
    const input = await spec("linux");
    const plan = autostartPlan(input);
    expect(plan.artifacts[0]?.content).toContain("Restart=on-failure");
    expect(plan.artifacts[1]?.content).toContain("x /var/tmp/crot-l1-*");
  });
  it("uses launchd unsuccessful-exit KeepAlive and a Windows per-user logon task", async () => {
    expect(autostartPlan(await spec("macos")).artifacts[0]?.content).toContain("<key>SuccessfulExit</key><false/>");
    const windows = autostartPlan(await spec("windows")).artifacts[0]?.content ?? "";
    expect(windows).toContain("<LogonTrigger>");
    expect(windows).toContain("<RestartOnFailure>");
    expect(windows).toContain("LeastPrivilege");
  });
});
