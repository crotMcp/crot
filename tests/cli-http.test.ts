import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseCli } from "../src/cli/options.js";
import { CrotError } from "../src/core/errors.js";
import { makeTempDirs, type TempDirs } from "./helpers.js";

let dirs: TempDirs;
beforeEach(async () => {
  dirs = await makeTempDirs();
});
afterEach(() => dirs.cleanup());

const parse = (argv: string[]) =>
  parseCli(argv, {}, { directories: { config: dirs.outside, state: dirs.outside, logs: dirs.outside } });

describe("CLI http flags", () => {
  it("keeps stdio as the default", async () => {
    const command = await parse(["--workspace", dirs.workspace]);
    expect(command.kind).toBe("serve");
    if (command.kind === "serve") expect(command.config.http).toBeUndefined();
  });

  it("enables HTTP with host and port", async () => {
    const command = await parse(["--workspace", dirs.workspace, "--http", "--http-host", "::1", "--http-port", "0"]);
    if (command.kind !== "serve") throw new Error("expected serve");
    expect(command.config.http).toEqual({ enabled: true, host: "::1", port: 0 });
  });

  it("rejects invalid ports", async () => {
    for (const port of ["-1", "65536", "abc", "1.5"]) {
      await expect(parse(["--workspace", dirs.workspace, "--http", "--http-port", port])).rejects.toThrow(CrotError);
    }
  });
});
