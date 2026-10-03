import { describe, expect, it } from "vitest";
import { createNodePlatform } from "../../src/core/platform/node-platform.js";
import { isWindows } from "../helpers.js";

describe("Node platform", () => {
  it("describes the host", async () => {
    const p = await createNodePlatform();
    expect(p.info.platform).toBe(process.platform);
    expect(p.info.pathStyle).toBe(isWindows ? "win32" : "posix");
    expect(p.info.caseInsensitiveEnvironment).toBe(isWindows);
    expect(p.info.defaultShell).toBe(isWindows ? "cmd" : "sh");
    expect(p.info.shells.map((s) => s.id)).toContain(p.info.defaultShell);
    expect(p.launcher.canTerminateOrphanedDescendants).toBe(!isWindows);
    expect(p.info.os).toBe(
      isWindows
        ? "windows"
        : process.platform === "darwin"
          ? "macos"
          : process.platform === "linux"
            ? "linux"
            : "posix",
    );
  });
});
