/** Explicit owner-run Windows bootstrap. Never called by CrotService. */
import process from "node:process";
import { URL } from "node:url";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { hostDirectories } from "../dist/core/platform/node-platform.js";
import { repairL1 } from "../dist/tray/l1-repair.js";
await repairL1({
  platform: process.platform,
  root: fileURLToPath(new URL("../", import.meta.url)),
  stateDir: hostDirectories(process.env).state,
});
for (const args of [["browser", "install"], ["service", "autostart", "install"], ["app"]]) {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("../dist/bin/crot-mcp.js", import.meta.url)), ...args],
    { stdio: "inherit", shell: false },
  );
  if (result.error || result.status !== 0) throw new Error("CROT setup failed: " + args.join(" "));
}
