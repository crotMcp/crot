import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { CrotError } from "../errors.js";
import { CrotConfigSchema, type CrotConfig, type CrotConfigInput } from "./schema.js";

/** Validate a configuration object. */
export function parseConfig(input: unknown): CrotConfig {
  const result = CrotConfigSchema.safeParse(input);
  if (!result.success) {
    throw new CrotError("CONFIG_ERROR", `Invalid CROT configuration: ${z.prettifyError(result.error)}`);
  }
  return result.data;
}

/** Read a JSON configuration file. A relative workspace root is resolved against the file's directory. */
export async function loadConfigFile(file: string): Promise<CrotConfigInput> {
  const absolute = path.resolve(file);
  let raw: string;
  try {
    raw = await readFile(absolute, "utf8");
  } catch (error) {
    throw new CrotError("CONFIG_ERROR", `Cannot read configuration file ${absolute}: ${(error as Error).message}`);
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    throw new CrotError("CONFIG_ERROR", `Configuration file ${absolute} is not valid JSON: ${(error as Error).message}`);
  }
  const config = data as CrotConfigInput;
  if (config && typeof config === "object" && config.workspace && typeof config.workspace.root === "string") {
    return { ...config, workspace: { ...config.workspace, root: path.resolve(path.dirname(absolute), config.workspace.root) } };
  }
  return config;
}
