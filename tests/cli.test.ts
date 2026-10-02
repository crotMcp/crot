import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseCli } from "../src/cli/options.js";
import { makeTempDirs, type TempDirs } from "./helpers.js";

let dirs: TempDirs;
beforeEach(async () => {
  dirs = await makeTempDirs();
});
afterEach(() => dirs.cleanup());

/** Default directories inside the test's temp dir, so a real user config never leaks in. */
const testDirectories = () => ({ config: path.join(dirs.outside, "cfg"), state: path.join(dirs.outside, "state"), logs: path.join(dirs.outside, "logs") });
const parse = (argv: string[], env: NodeJS.ProcessEnv = {}) => parseCli(argv, env, { directories: testDirectories() });

describe("parseCli", () => {
  it("requires a workspace", async () => {
    await expect(parse([], {})).rejects.toMatchObject({ code: "CONFIG_ERROR" });
  });

  it("builds a config from flags", async () => {
    const cmd = await parse(["--workspace", dirs.workspace, "--mode", "full-control", "--audit-log", "audit.jsonl"], {});
    expect(cmd).toEqual({
      kind: "serve",
      config: {
        workspace: { root: dirs.workspace },
        permissions: { mode: "full_control" },
        audit: { sink: "file", path: path.resolve("audit.jsonl") },
      },
      warnings: [expect.stringContaining("--audit-log 'audit.jsonl' is relative")],
    });
  });

  it("merges a config file (from CROT_CONFIG) with flag overrides", async () => {
    const file = path.join(dirs.outside, "crot.json");
    await writeFile(file, JSON.stringify({ workspace: { root: "../workspace", name: "proj" }, permissions: { mode: "full_control" } }));
    const cmd = await parse(["--mode", "sandbox", "--no-audit"], { CROT_CONFIG: file });
    expect(cmd).toEqual({
      kind: "serve",
      config: { workspace: { root: dirs.workspace, name: "proj" }, permissions: { mode: "sandbox" }, audit: { sink: "none" } },
      configFile: file,
      configSource: "env",
      warnings: [],
    });
  });

  it("rejects unknown modes and flags", async () => {
    await expect(parse(["-w", dirs.workspace, "-m", "root"], {})).rejects.toMatchObject({ code: "CONFIG_ERROR" });
    await expect(parse(["--bogus"], {})).rejects.toMatchObject({ code: "CONFIG_ERROR" });
  });

  it("expands ~ in path flags", async () => {
    const cmd = await parse(["-w", "~", "--audit-log", path.join("~", "crot.jsonl")], {});
    expect(cmd).toMatchObject({
      config: { workspace: { root: os.homedir() }, audit: { path: path.join(os.homedir(), "crot.jsonl") } },
      warnings: [],
    });
  });

  it("handles help and version", async () => {
    expect(await parse(["--help"], {})).toEqual({ kind: "help" });
    expect(await parse(["-v"], {})).toEqual({ kind: "version" });
  });
});

describe("parseCli default configuration", () => {
  async function writeDefault(config: unknown): Promise<string> {
    const file = path.join(testDirectories().config, "config.json");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(config));
    return file;
  }

  it("loads config.json from the platform config directory when no config is given", async () => {
    const file = await writeDefault({ workspace: { root: dirs.workspace }, permissions: { mode: "full_control" } });
    expect(await parse([])).toEqual({
      kind: "serve",
      config: { workspace: { root: dirs.workspace }, permissions: { mode: "full_control" } },
      configFile: file,
      configSource: "default",
      warnings: [],
    });
  });

  it("flags still override the default configuration", async () => {
    await writeDefault({ workspace: { root: dirs.outside }, permissions: { mode: "full_control" } });
    expect(await parse(["-w", dirs.workspace, "-m", "sandbox"])).toMatchObject({
      config: { workspace: { root: dirs.workspace }, permissions: { mode: "sandbox" } },
      configSource: "default",
    });
  });

  it("an explicit --config or CROT_CONFIG replaces the default file", async () => {
    await writeDefault({ workspace: { root: dirs.outside } });
    const explicit = path.join(dirs.outside, "explicit.json");
    await writeFile(explicit, JSON.stringify({ workspace: { root: dirs.workspace } }));
    expect(await parse(["--config", explicit])).toMatchObject({ config: { workspace: { root: dirs.workspace } }, configFile: explicit, configSource: "flag" });
    expect(await parse([], { CROT_CONFIG: explicit })).toMatchObject({ configFile: explicit, configSource: "env" });
  });

  it("without a default file, behaves as before", async () => {
    await expect(parse([])).rejects.toMatchObject({ code: "CONFIG_ERROR" });
    expect(await parse(["-w", dirs.workspace])).toEqual({ kind: "serve", config: { workspace: { root: dirs.workspace } }, warnings: [] });
  });
});
