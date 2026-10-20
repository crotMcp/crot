/** Fixed-scope staging lifecycle. No shell expansion and no arbitrary volume deletion. */
import process from "node:process";
import console from "node:console";
import { URL } from "node:url";
import { spawnSync } from "node:child_process";
import { request } from "node:https";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
export function composeArguments(action, confirmation = false) {
  const base = [
    "compose",
    "--project-name",
    "crot-staging",
    "--file",
    fileURLToPath(new URL("../deploy/staging/compose.yml", import.meta.url)),
  ];
  if (action === "up") return [...base, "up", "--detach", "--build"];
  if (action === "status") return [...base, "ps"];
  if (action === "down") return [...base, "down", "--remove-orphans"];
  if (action === "reset" && confirmation) return [...base, "down", "--volumes", "--remove-orphans"];
  throw new Error("usage: staging up|status|down|reset --confirm-staging-reset|health <HTTPS URL> <CA file>");
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const action = process.argv[2];
  if (action === "health") {
    const url = new URL("/.crot/health", process.argv[3]);
    if (url.protocol !== "https:") throw new Error("HTTPS required");
    const ca = await readFile(process.argv[4]);
    await new Promise((resolve, reject) => {
      const req = request(url, { ca, timeout: 5000 }, (res) => {
        res.resume();
        // Aggregate health only: no device diagnostics, bearer or payload.
        res.once("end", () =>
          res.statusCode === 200 ? resolve() : reject(new Error(`unexpected health status ${res.statusCode}`)),
        );
      });
      req.once("timeout", () => req.destroy(new Error("health timeout")));
      req.once("error", reject);
      req.end();
    });
    console.log("TLS relay reachable (aggregate health; no device metadata disclosed)");
  } else {
    const result = spawnSync("docker", composeArguments(action, process.argv.includes("--confirm-staging-reset")), {
      stdio: "inherit",
    });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  }
}
