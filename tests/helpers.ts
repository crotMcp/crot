import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { localPrincipal, type AuthContext } from "../src/core/auth/principal.js";

export const testContext: AuthContext = { principal: localPrincipal("test") };

export interface TempDirs {
  /** Canonical workspace root. */
  readonly workspace: string;
  /** Canonical directory outside the workspace. */
  readonly outside: string;
  cleanup(): Promise<void>;
}

export async function makeTempDirs(): Promise<TempDirs> {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "crot-test-")));
  const { mkdir } = await import("node:fs/promises");
  const workspace = path.join(base, "workspace");
  const outside = path.join(base, "outside");
  await mkdir(workspace);
  await mkdir(outside);
  return { workspace, outside, cleanup: () => rm(base, { recursive: true, force: true }) };
}
