/**
 * Harness of the REAL L1 integration tests: a CrotCore on the Native Host
 * platform with the installed L1 (/usr/lib/crot/l1/<v>, policy loaded), as
 * the CROT service builds it. Used only when CROT_L1_REQUIRED=1 (the L1
 * workflow); there an unavailable L1 is a test failure with its reason.
 */
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MemoryAuditSink } from "../../../src/core/audit/audit.js";
import { localPrincipal, type AuthContext } from "../../../src/core/auth/principal.js";
import { CrotCore } from "../../../src/core/crot-core.js";
import type { ConfinementNetwork } from "../../../src/core/platform/types.js";
import { NativeHost } from "../../../src/native-host/native-host.js";

export const ctx: AuthContext = { principal: localPrincipal("test") };

export interface L1Fixture {
  readonly home: string;
  readonly workspace: string;
  readonly stateDir: string;
  /** A file in a CROT-protected path (the state directory). */
  readonly canary: string;
  readonly native: NativeHost;
  readonly core: CrotCore;
  readonly audit: MemoryAuditSink;
  readonly log: string[];
  readonly env: Record<string, string>;
  sh(script: string, timeoutMs?: number): Promise<{ exitCode: number | null; stdout: string; stderr: string }>;
  close(): Promise<void>;
}

/** Directories in the real home (the home layer applies there) unless `under` is given. */
export async function l1Fixture(
  options: { network?: ConfinementNetwork; env?: Record<string, string | undefined>; under?: string } = {},
): Promise<L1Fixture> {
  const home = await realpath(os.homedir());
  const base = await realpath(await mkdtemp(path.join(options.under ?? home, "crot-l1-it-")));
  const workspace = path.join(base, "ws");
  const stateDir = path.join(base, "state");
  await mkdir(workspace);
  await mkdir(stateDir, { mode: 0o700 });
  const canary = path.join(stateDir, "secret-canary");
  await writeFile(canary, "CANARY-SECRET", { mode: 0o600 });
  const env = Object.fromEntries(
    Object.entries({ ...process.env, ...(options.env ?? {}) }).filter((e): e is [string, string] => e[1] !== undefined),
  );
  const log: string[] = [];
  const native = await NativeHost.start({
    env,
    startupPath: "inherited",
    stateDir,
    log: (l) => log.push(l),
    confinement: { env },
  });
  const audit = new MemoryAuditSink();
  const core = await CrotCore.create(
    { workspace: { root: workspace }, confinement: { network: options.network ?? "on" } },
    { platform: native.platform, auditSink: audit, protectedPaths: [stateDir], secretPaths: [canary] },
  );
  return {
    home,
    workspace,
    stateDir,
    canary,
    native,
    core,
    audit,
    log,
    env,
    sh: async (script, timeoutMs = 60_000) => {
      const r = await core.processes.shell(ctx, { script, timeoutMs });
      return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr };
    },
    close: async () => {
      await core.shutdown();
      await native.close();
      await rm(base, { recursive: true, force: true });
    },
  };
}

/** Fail with the reported reason instead of skipping: the mandatory checks of the L1 workflow. */
export function assertAvailable(f: L1Fixture): void {
  const s = f.core.status().confinement;
  if (!s.available)
    throw new Error(
      `L1 is required (CROT_L1_REQUIRED=1) but unavailable: ${s.reason} — ${s.detail ?? ""}; log: ${f.log.join(" | ")}`,
    );
}
