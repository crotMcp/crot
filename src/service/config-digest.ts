/**
 * Configuration identity of a service (WP-20).
 *
 * A shim may only use a service that runs the configuration the shim was
 * started with: the same configuration file and the same effective settings
 * (policy, workspace, limits, browser, audit) and the same CROT version.
 * HTTP settings are excluded: whether the service also serves HTTP does not
 * change what a stdio client may do.
 */
import { createHash } from "node:crypto";
import path from "node:path";
import { parseConfig } from "../core/config/load.js";
import { expandHome } from "../core/config/paths.js";
import { CORE_VERSION } from "../core/crot-core.js";

/** Stable JSON: object keys sorted, so equal configurations give equal digests. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) out[key] = canonical((value as Record<string, unknown>)[key]);
    return out;
  }
  return value;
}

export function configDigest(configFile: string, config: unknown): string {
  const { http: _http, ...parsed } = parseConfig(config);
  void _http;
  // Paths as Core resolves them, so equal effective paths compare equal.
  const effective = {
    ...parsed,
    workspace: { ...parsed.workspace, root: path.resolve(expandHome(parsed.workspace.root)) },
    audit: parsed.audit.path ? { ...parsed.audit, path: path.resolve(expandHome(parsed.audit.path)) } : parsed.audit,
  };
  return createHash("sha256")
    .update(JSON.stringify(canonical({ version: CORE_VERSION, configFile, config: effective })), "utf8")
    .digest("hex");
}
