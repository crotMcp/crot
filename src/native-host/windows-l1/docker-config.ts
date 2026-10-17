/** Resolve the trusted CLI endpoint before admission. Non-pipe transports are
 * not silently treated as a protected local daemon in the Windows profile. */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { WindowsPreparationError } from "./components.js";
const refuse = (): never => {
  throw new WindowsPreparationError(
    "self_test_failed",
    "The configured Windows Docker endpoint is not a qualified local named pipe.",
  );
};
export async function windowsDockerConfiguration(
  env: Readonly<Record<string, string>>,
  home: string,
): Promise<{ host: string; env: Record<string, string> }> {
  let host = env.DOCKER_HOST,
    context = env.DOCKER_CONTEXT;
  const directory = env.DOCKER_CONFIG ?? path.join(home, ".docker");
  if (!context && !host) {
    try {
      const value = JSON.parse(await readFile(path.join(directory, "config.json"), "utf8")) as {
        currentContext?: unknown;
      };
      if (value.currentContext !== undefined && typeof value.currentContext !== "string") return refuse();
      context = value.currentContext;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    }
  }
  // DOCKER_CONTEXT wins over DOCKER_HOST in the actual Docker CLI.
  if (context && context !== "default") {
    const id = createHash("sha256").update(context).digest("hex");
    const value = JSON.parse(await readFile(path.join(directory, "contexts", "meta", id, "meta.json"), "utf8")) as {
      Endpoints?: { docker?: { Host?: unknown } };
    };
    if (typeof value.Endpoints?.docker?.Host !== "string") return refuse();
    host = value.Endpoints.docker.Host;
  }
  host ??= "npipe:////./pipe/docker_engine";
  if (!/^npipe:\/\/\/\/\.\/pipe\/[A-Za-z0-9_.-]+$/.test(host)) return refuse();
  const fixed: Record<string, string> = { ...env, DOCKER_HOST: host };
  delete fixed.DOCKER_CONTEXT;
  delete fixed.DOCKER_TLS;
  delete fixed.DOCKER_TLS_VERIFY;
  return { host, env: fixed };
}
