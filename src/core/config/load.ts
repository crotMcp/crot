import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { CrotError } from "../errors.js";
import { expandHome, stripBom } from "./paths.js";
import { CrotConfigSchema, type CrotConfig, type CrotConfigInput } from "./schema.js";

/** Validate a configuration object. */
export function parseConfig(input: unknown): CrotConfig {
  const result = CrotConfigSchema.safeParse(input);
  if (!result.success) {
    throw new CrotError("CONFIG_ERROR", `Invalid CROT configuration: ${z.prettifyError(result.error)}`);
  }
  return result.data;
}

/**
 * Read a JSON configuration file (UTF-8, optional BOM). "~" is expanded and
 * relative paths (workspace root, audit path, HTTP token file) are resolved
 * against the file's directory.
 */
export async function loadConfigFile(file: string): Promise<CrotConfigInput> {
  const absolute = path.resolve(expandHome(file));
  let raw: string;
  try {
    raw = await readFile(absolute, "utf8");
  } catch (error) {
    throw new CrotError("CONFIG_ERROR", `Cannot read configuration file ${absolute}: ${(error as Error).message}`);
  }
  let data: unknown;
  try {
    data = JSON.parse(stripBom(raw));
  } catch (error) {
    throw new CrotError("CONFIG_ERROR", `Configuration file ${absolute} is not valid JSON: ${(error as Error).message}`);
  }
  let config = data as CrotConfigInput;
  const base = path.dirname(absolute);
  if (config && typeof config === "object") {
    if (config.workspace && typeof config.workspace.root === "string") {
      config = { ...config, workspace: { ...config.workspace, root: path.resolve(base, expandHome(config.workspace.root)) } };
    }
    if (config.audit && typeof config.audit.path === "string") {
      config = { ...config, audit: { ...config.audit, path: path.resolve(base, expandHome(config.audit.path)) } };
    }
    const http = config.http;
    if (http && typeof http === "object" && http.auth && typeof http.auth === "object" && typeof http.auth.tokenFile === "string") {
      config = {
        ...config,
        http: { ...http, auth: { ...http.auth, tokenFile: path.resolve(base, expandHome(http.auth.tokenFile)) } },
      };
    }
  }
  return config;
}
