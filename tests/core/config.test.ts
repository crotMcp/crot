import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfigFile, parseConfig } from "../../src/core/config/load.js";
import { CrotError } from "../../src/core/errors.js";
import { createTestCore, makeTempDirs, type TempDirs } from "../helpers.js";

let dirs: TempDirs;
beforeEach(async () => {
  dirs = await makeTempDirs();
});
afterEach(() => dirs.cleanup());

describe("configuration", () => {
  it("applies defaults", () => {
    const config = parseConfig({ workspace: { root: "/tmp" } });
    expect(config.version).toBe(1);
    expect(config.permissions.mode).toBe("sandbox");
    expect(config.limits.maxReadBytes).toBeGreaterThan(0);
  });

  it("requires a workspace root", () => {
    expect(() => parseConfig({})).toThrow(CrotError);
  });

  it("rejects unknown keys and capabilities", () => {
    expect(() => parseConfig({ workspace: { root: "/tmp" }, extra: 1 })).toThrow(CrotError);
    expect(() => parseConfig({ workspace: { root: "/tmp" }, permissions: { capabilities: ["root.everything"] } })).toThrow(
      CrotError,
    );
  });

  it("resolves a relative workspace root against the config file", async () => {
    const file = path.join(dirs.outside, "crot.json");
    await writeFile(file, JSON.stringify({ workspace: { root: "../workspace" } }));
    const input = await loadConfigFile(file);
    expect(input.workspace.root).toBe(dirs.workspace);
  });

  it("reports invalid JSON as a configuration error", async () => {
    const file = path.join(dirs.outside, "bad.json");
    await writeFile(file, "{ not json");
    await expect(loadConfigFile(file)).rejects.toThrow(CrotError);
  });
});

describe("CrotCore", () => {
  it("reports status", async () => {
    const core = await createTestCore({ workspace: { root: dirs.workspace, name: "demo" } });
    const status = core.status();
    expect(status.mode).toBe("sandbox");
    expect(status.workspace).toEqual({ name: "demo", root: dirs.workspace });
    expect(status.capabilities.find((c) => c.capability === "filesystem.full")).toEqual({
      capability: "filesystem.full",
      granted: false,
      enforced: true,
    });
  });

  it("rejects sandbox configs that grant filesystem.full", async () => {
    await expect(
      createTestCore({ workspace: { root: dirs.workspace }, permissions: { mode: "sandbox", capabilities: ["filesystem.full"] } }),
    ).rejects.toThrow(CrotError);
  });
});
