import path from "node:path";
import { describe, expect, it } from "vitest";
import { platformDirectories } from "../../src/core/platform/directories.js";
import { createEnvironmentPolicy } from "../../src/core/platform/environment.js";
import { createNodePlatform, hostDirectories } from "../../src/core/platform/node-platform.js";

const lookup = (env: Record<string, string>, windows = false) => (name: string) => createEnvironmentPolicy(windows).get(env, name);

describe("platformDirectories", () => {
  it("Linux: XDG directories with spec fallbacks", () => {
    expect(platformDirectories("linux", lookup({}), "/home/u")).toEqual({
      config: "/home/u/.config/crot",
      state: "/home/u/.local/state/crot",
      logs: "/home/u/.local/state/crot/logs",
    });
    expect(platformDirectories("linux", lookup({ XDG_CONFIG_HOME: "/cfg", XDG_STATE_HOME: "/st" }), "/home/u")).toEqual({
      config: "/cfg/crot",
      state: "/st/crot",
      logs: "/st/crot/logs",
    });
    // Relative XDG values are invalid per the specification and ignored.
    expect(platformDirectories("linux", lookup({ XDG_CONFIG_HOME: "cfg" }), "/home/u").config).toBe("/home/u/.config/crot");
  });

  it("macOS: Application Support and Logs", () => {
    expect(platformDirectories("macos", lookup({ XDG_CONFIG_HOME: "/ignored" }), "/Users/u")).toEqual({
      config: "/Users/u/Library/Application Support/CROT",
      state: "/Users/u/Library/Application Support/CROT/State",
      logs: "/Users/u/Library/Logs/CROT",
    });
  });

  it("Windows: roaming config, local state and logs (case-insensitive variables)", () => {
    const env = { appdata: "C:\\Users\\u\\AppData\\Roaming", LocalAppData: "D:\\Local" };
    expect(platformDirectories("windows", lookup(env, true), "C:\\Users\\u")).toEqual({
      config: "C:\\Users\\u\\AppData\\Roaming\\CROT",
      state: "D:\\Local\\CROT",
      logs: "D:\\Local\\CROT\\Logs",
    });
    expect(platformDirectories("windows", lookup({}, true), "C:\\Users\\u")).toEqual({
      config: "C:\\Users\\u\\AppData\\Roaming\\CROT",
      state: "C:\\Users\\u\\AppData\\Local\\CROT",
      logs: "C:\\Users\\u\\AppData\\Local\\CROT\\Logs",
    });
  });

  it("the host platform reports absolute directories and honours overrides", async () => {
    const dirs = hostDirectories();
    for (const d of Object.values(dirs)) expect(path.isAbsolute(d)).toBe(true);
    const p = await createNodePlatform({ startupPath: "inherited" });
    expect(p.info.directories).toEqual(dirs);
    const custom = { config: dirs.config + "-x", state: dirs.state + "-x", logs: dirs.logs + "-x" };
    expect((await createNodePlatform({ startupPath: "inherited", directories: custom })).info.directories).toEqual(custom);
  });
});
