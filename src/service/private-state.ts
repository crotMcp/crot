/**
 * Small owner-only JSON state files of the service (ARCHITECTURE.md §27,
 * AD-19): written to a private temporary file in the same directory, then
 * renamed over the old one, so a reader sees either the old or the new state.
 */
import { randomBytes } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PrivateFileProtection } from "../core/platform/types.js";

export type ReadStateResult = { readonly kind: "missing" } | { readonly kind: "text"; readonly text: string };

/** Read a state file; a missing file is not an error, any other problem throws. */
export async function readStateFile(file: string): Promise<ReadStateResult> {
  try {
    return { kind: "text", text: await readFile(file, "utf8") };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    throw error;
  }
}

/** Replace a state file with `text`, owner-only where the platform supports it. */
export async function writeStateFile(file: string, text: string, privateFiles: PrivateFileProtection): Promise<void> {
  const dir = path.dirname(file);
  await privateFiles.ensureDirectory(dir);
  const temp = path.join(dir, `.${path.basename(file)}.${randomBytes(6).toString("hex")}.tmp`);
  const mode = privateFiles.fileMode !== undefined ? { mode: privateFiles.fileMode } : {};
  try {
    await writeFile(temp, "", { flag: "wx", ...mode });
    if (privateFiles.protectFile) await privateFiles.protectFile(temp);
    await writeFile(temp, text, { encoding: "utf8", flag: "r+" });
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
