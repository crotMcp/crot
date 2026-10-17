/** SDK-only build of the pinned user-mode compatibility DLL, outside workspace. */
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
export async function buildLocalShimFixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "crot-local-shim-"));
  const cleanup = () => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  try {
    await promisify(execFile)(
      path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        path.resolve("scripts/build-windows-local-shim.ps1"),
        "-OutputDirectory",
        dir,
        "-Architecture",
        process.arch === "arm64" ? "ARM64" : "x64",
      ],
      { timeout: 120000, maxBuffer: 1048576 },
    );
    return { library: path.join(dir, "crot-local-shim.dll"), cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
