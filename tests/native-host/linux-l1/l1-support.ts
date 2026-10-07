/**
 * Shared support of the L1 tests: building crot-l1-init from source, and the
 * CROT_L1_REQUIRED gate of the integration tests (the L1 workflow sets it;
 * there a missing mechanism fails the run instead of skipping it).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
export const l1Required = process.env.CROT_L1_REQUIRED === "1";
export const isLinux = process.platform === "linux";

let built: string | null | undefined;
/** Compile l1/native/crot-l1-init.c with the system C compiler; null when none is available. */
export function buildInit(): string | null {
  if (built !== undefined) return built;
  const out = path.join(mkdtempSync(path.join(os.tmpdir(), "crot-init-")), "crot-l1-init");
  try {
    execFileSync(
      "cc",
      ["-O2", "-Wall", "-Wextra", "-Werror", "-o", out, path.join(repoRoot, "l1/native/crot-l1-init.c")],
      { stdio: "pipe" },
    );
    built = out;
  } catch (error) {
    if (l1Required) throw new Error(`crot-l1-init does not build: ${(error as Error).message}`);
    built = null;
  }
  return built;
}

/** Read a stream to its end. */
export async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  let out = "";
  for await (const chunk of stream) out += (chunk as Buffer).toString("utf8");
  return out;
}

export const waitFor = async (predicate: () => Promise<boolean> | boolean, timeoutMs = 10_000): Promise<void> => {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("condition not met in time");
};

/** Whether a process with `pid` exists (a zombie counts as gone once reaped by its subreaper). */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
