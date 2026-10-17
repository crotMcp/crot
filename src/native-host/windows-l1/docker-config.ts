/** Resolve the trusted CLI endpoint before admission, including context
 * precedence. AD-20.14 keeps unauthenticated host-network endpoints a reported
 * residual risk, never a reason to silently narrow network=on. */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { WindowsPreparationError } from "./components.js";
const refuse = (): never => {
  throw new WindowsPreparationError(
    "self_test_failed",
    "The configured Windows Docker endpoint is malformed or unsupported.",
  );
};
export async function windowsDockerConfiguration(
  env: Readonly<Record<string, string>>,
  home: string,
): Promise<{ host: string; tls: boolean; unauthenticatedNetwork: boolean; env: Record<string, string> }> {
  let host = env.DOCKER_HOST,
    context = env.DOCKER_CONTEXT,
    contextTls = false;
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
  if (context && context !== "default") {
    const id = createHash("sha256").update(context).digest("hex");
    const value = JSON.parse(await readFile(path.join(directory, "contexts", "meta", id, "meta.json"), "utf8")) as {
      Endpoints?: { docker?: { Host?: unknown } };
      TLSMaterial?: { docker?: unknown };
    };
    if (typeof value.Endpoints?.docker?.Host !== "string") return refuse();
    host = value.Endpoints.docker.Host;
    contextTls =
      Array.isArray(value.TLSMaterial?.docker) &&
      value.TLSMaterial.docker.includes("cert.pem") &&
      value.TLSMaterial.docker.includes("key.pem");
  }
  host ??= "npipe:////./pipe/docker_engine";
  const pipe = /^npipe:\/\/\/\/\.\/pipe\/[A-Za-z0-9_.-]+$/.test(host);
  if (!pipe && !/^(?:tcp|https?|ssh):\/\/[^\s\x00-\x1f]+$/.test(host)) return refuse();
  const tls = contextTls || !!env.DOCKER_TLS || !!env.DOCKER_TLS_VERIFY || host.startsWith("https://");
  const fixed: Record<string, string> = { ...env, DOCKER_HOST: host };
  // Keep a selected context so dial-stdio uses its protected TLS material.
  if (context) fixed.DOCKER_CONTEXT = context;
  return { host, tls, unauthenticatedNetwork: /^(?:tcp|http):\/\//.test(host) && !tls, env: fixed };
}
