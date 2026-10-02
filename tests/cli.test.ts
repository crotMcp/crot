import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseCli } from "../src/cli/options.js";
import { makeTempDirs, type TempDirs } from "./helpers.js";

let dirs: TempDirs;
beforeEach(async () => {
  dirs = await makeTempDirs();
});
afterEach(() => dirs.cleanup());

describe("parseCli", () => {
  it("requires a workspace", async () => {
    await expect(parseCli([], {})).rejects.toMatchObject({ code: "CONFIG_ERROR" });
  });

  it("builds a config from flags", async () => {
    const cmd = await parseCli(["--workspace", dirs.workspace, "--mode", "full-control", "--audit-log", "audit.jsonl"], {});
    expect(cmd).toEqual({
      kind: "serve",
      config: {
        workspace: { root: dirs.workspace },
        permissions: { mode: "full_control" },
        audit: { sink: "file", path: path.resolve("audit.jsonl") },
      },
    });
  });

  it("merges a config file (from CROT_CONFIG) with flag overrides", async () => {
    const file = path.join(dirs.outside, "crot.json");
    await writeFile(file, JSON.stringify({ workspace: { root: "../workspace", name: "proj" }, permissions: { mode: "full_control" } }));
    const cmd = await parseCli(["--mode", "sandbox", "--no-audit"], { CROT_CONFIG: file });
    expect(cmd).toEqual({
      kind: "serve",
      config: { workspace: { root: dirs.workspace, name: "proj" }, permissions: { mode: "sandbox" }, audit: { sink: "none" } },
    });
  });

  it("rejects unknown modes and flags", async () => {
    await expect(parseCli(["-w", dirs.workspace, "-m", "root"], {})).rejects.toMatchObject({ code: "CONFIG_ERROR" });
    await expect(parseCli(["--bogus"], {})).rejects.toMatchObject({ code: "CONFIG_ERROR" });
  });

  it("handles help and version", async () => {
    expect(await parseCli(["--help"], {})).toEqual({ kind: "help" });
    expect(await parseCli(["-v"], {})).toEqual({ kind: "version" });
  });
});
