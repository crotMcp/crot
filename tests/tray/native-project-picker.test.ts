import { execFile } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { expect, inject, it } from "vitest";
const nativeHost = process.platform === "darwin" || process.platform === "win32";
it.skipIf(!nativeHost)(
  "actual OS folder chooser: cancel preserves Core, chosen path changes real service and shipped UI with audit",
  { timeout: 120000 },
  async () => {
    const buildRoot = path.dirname(path.dirname(inject("crotMcpBin")));
    const output = path.join(buildRoot, "native-project-picker-evidence.json");
    await rm(output, { force: true });
    let failure: unknown;
    try {
      await promisify(execFile)(
        process.execPath,
        ["scripts/project-picker-native-qa.mjs", `--build-root=${buildRoot}`, `--output=${output}`],
        { timeout: 110000, maxBuffer: 65536, env: process.env },
      );
    } catch (error) {
      failure = error;
    }
    const report = JSON.parse(
      await readFile(output, "utf8").catch(() => '{"status":"missing","errors":["Native driver produced no report"]}'),
    );
    process.stdout.write(`NATIVE_PROJECT_PICKER ${JSON.stringify({ platform: process.platform, ...report })}\n`);
    expect(failure, JSON.stringify(report)).toBeUndefined();
    expect(report.status).toBe("passed");
    expect(report.checks).toHaveLength(3);
    expect(report.errors).toEqual([]);
  },
);
