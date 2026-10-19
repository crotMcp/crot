/** Native runner evidence; missing/skipped cases are a failure, not qualification. */
import { spawnSync } from "node:child_process";
import process from "node:process";
import console from "node:console";
import { mkdtempSync, readFileSync, rmSync, copyFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
const directory = mkdtempSync(path.join(os.tmpdir(), "crot-browser-native-"));
try {
  const report = path.join(directory, "results.json");
  const r = spawnSync(
    process.execPath,
    [
      "node_modules/vitest/vitest.mjs",
      "run",
      "tests/core/browser-files.test.ts",
      "tests/core/browser-files-integration.test.ts",
      "--reporter=default",
      "--reporter=json",
      "--outputFile=" + report,
    ],
    { stdio: "inherit", env: process.env },
  );
  if (r.status !== 0) process.exitCode = r.status ?? 1;
  else {
    const result = JSON.parse(readFileSync(report, "utf8"));
    const cases = result.testResults.flatMap((s) => s.assertionResults);
    if (cases.length < 28 || cases.some((c) => c.status !== "passed"))
      throw new Error("Native browser file qualification requires every case passed, no skipped/pending cases.");
    if (process.env.GITHUB_WORKSPACE)
      copyFileSync(report, path.join(process.env.RUNNER_TEMP ?? directory, "crot-browser-files-native.json"));
    console.log(
      JSON.stringify({
        qualification: "browser-files-native",
        platform: process.platform,
        arch: process.arch,
        node: process.version,
        passed: cases.length,
        skipped: 0,
      }),
    );
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}
