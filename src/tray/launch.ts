/** Fixed owner-UI launcher. No paths, commands or URLs from the browser are accepted. */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

export async function launchControlCenter(stateDir: string): Promise<boolean> {
  try {
    const electron: unknown = createRequire(import.meta.url)("electron");
    if (typeof electron !== "string") return false;
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    // Compatibility requested for Linux installations without a usable SUID/userns sandbox.
    // This is an explicit Electron sandbox trade-off; it does not enable Node in the renderer.
    const args = [
      ...(process.platform === "linux" ? ["--no-sandbox"] : []),
      fileURLToPath(new URL("./main.js", import.meta.url)),
      "--state-dir=" + stateDir,
    ];
    return await new Promise<boolean>((resolve) => {
      const child = spawn(electron, args, { detached: true, stdio: "ignore", env });
      child.once("error", () => resolve(false));
      child.once("spawn", () => {
        child.unref();
        resolve(true);
      });
    });
  } catch {
    return false;
  }
}
