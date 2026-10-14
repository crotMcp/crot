import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { TestProject } from "vitest/node";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Inside node_modules so the built files resolve the project's dependencies; never touches dist/.
const outDir = path.join(root, "node_modules", ".cache", "crot-test-build");

declare module "vitest" {
  export interface ProvidedContext {
    /** Absolute path of the freshly built crot-mcp stdio entry point. */
    crotMcpBin: string;
    stage6aEvidence: string;
  }
}

/**
 * Build the production sources once per test run, so the stdio end-to-end
 * test always exercises the current code instead of a missing or stale dist/.
 */
export default function setup(project: TestProject): () => void {
  rmSync(outDir, { recursive: true, force: true });
  const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
  execFileSync(process.execPath, [tsc, "-p", path.join(root, "tsconfig.build.json"), "--outDir", outDir], {
    cwd: root,
    stdio: "inherit",
  });
  const evidence = path.join(outDir, "stage6a-evidence.jsonl");
  project.provide("stage6aEvidence", evidence);
  process.env.CROT_6A_EVIDENCE_FILE = evidence;
  project.provide("crotMcpBin", path.join(outDir, "bin", "crot-mcp.js"));
  return () => rmSync(outDir, { recursive: true, force: true });
}
