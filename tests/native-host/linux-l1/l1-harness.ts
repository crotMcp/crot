/**
 * Harness of the REAL L1 integration tests: a CrotCore on the Native Host
 * platform with the installed L1 (/usr/lib/crot/l1/<v>, policy loaded), as
 * the CROT service builds it. Used only when CROT_L1_REQUIRED=1 (the L1
 * workflow); there an unavailable L1 is a test failure with its reason.
 */
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RemoteExposureStore } from "../../../src/core/approvals/remote-exposure.js";
import { MemoryAuditSink } from "../../../src/core/audit/audit.js";
import { localPrincipal, type AuthContext } from "../../../src/core/auth/principal.js";
import { CrotCore } from "../../../src/core/crot-core.js";
import type { ConfinementNetwork } from "../../../src/core/platform/types.js";
import { Sandbox, SandboxError } from "../../../src/native-host/linux-l1/sandbox.js";
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
    {
      platform: native.platform,
      auditSink: audit,
      protectedPaths: [stateDir],
      secretPaths: [canary],
      // The remote scopes of these tests start clean, as for a newly paired client: without a store
      // Core treats every remote scope as exposed (fail closed, AD-15 point 8), so the untrusted-content
      // gate (AD-12) would refuse a remote shell command for want of an approval UI before the L1
      // decision is reached. The gate itself and its order before L1 are covered by
      // tests/core/confinement.test.ts ("an exposed remote scope stays behind the approval gate").
      remoteExposure: RemoteExposureStore.inMemory(),
    },
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
      `L1 is required (CROT_L1_REQUIRED=1) but unavailable: ${s.reason} — ${s.detail ?? ""}; log: ${f.log.join(" | ")}` +
        sandboxDiagnostics(),
    );
}

/*
 * Diagnostics of a failing L1 check (test only; production behaviour is
 * unchanged). Status and the CONFINEMENT_FAILED message carry only "the
 * sandbox ended (exit N)": crot-bwrap's stderr, which names the immediate
 * cause, never leaves the Sandbox. Every Sandbox.start of this test process is
 * recorded (argv, how it ended, crot-bwrap/crot-l1-init stderr, the label in
 * crot-l1-init's HELLO) and printed with assertAvailable's error, together
 * with the minimal invocation of the workflow's "L1 sandbox label" step run
 * at that moment and the AppArmor denials logged since this file started.
 */
interface SandboxRecord {
  readonly argv: readonly string[];
  sandbox?: Sandbox;
  ended?: string;
  startError?: string;
  startDiagnostics?: string;
}
const sandboxRecords: SandboxRecord[] = [];
const kernelLog = (): string[] => {
  for (const [file, args] of [
    ["sudo", ["-n", "dmesg"]],
    ["dmesg", []],
  ] as const) {
    const r = spawnSync(file, args, { encoding: "utf8", timeout: 10_000 });
    if (r.status === 0) return r.stdout.split("\n");
  }
  return [];
};
// Only in the L1 workflow (CROT_L1_REQUIRED=1); elsewhere the harness is imported by skipped suites.
const diagnose = process.platform === "linux" && process.env.CROT_L1_REQUIRED === "1";
const kernelLogStart = diagnose ? kernelLog().length : 0;
const originalStart = Sandbox.start.bind(Sandbox);
if (diagnose)
  Sandbox.start = async (spec, onEnd, timeoutMs) => {
    const record: SandboxRecord = { argv: [spec.file, ...spec.args] };
    sandboxRecords.push(record);
    try {
      const sandbox = await originalStart(spec, onEnd, timeoutMs);
      record.sandbox = sandbox;
      void sandbox.whenEnded.then((e) => (record.ended = e.message));
      return sandbox;
    } catch (error) {
      record.startError = (error as Error).message;
      record.startDiagnostics = error instanceof SandboxError ? error.diagnostics : "";
      throw error;
    }
  };

function sandboxDiagnostics(): string {
  const out = ["", "--- L1 sandbox diagnostics (test harness) ---"];
  sandboxRecords.forEach((r, i) => {
    out.push(`sandbox #${i + 1}: argv ${JSON.stringify(r.argv)}`);
    out.push(
      `  start: ${r.startError ? `failed: ${r.startError}` : "ok"}; HELLO label: ${JSON.stringify(r.sandbox?.label ?? null)}; ended: ${r.ended ?? (r.sandbox?.running ? "still running" : "unknown")}`,
    );
    out.push(`  crot-bwrap/crot-l1-init stderr: ${JSON.stringify(r.startDiagnostics ?? r.sandbox?.diagnostics ?? "")}`);
  });
  const bwrap = sandboxRecords[0]?.argv[0];
  if (bwrap) {
    const args = ["--unshare-user", "--unshare-pid", "--die-with-parent", "--ro-bind", "/", "/", "--dev", "/dev"];
    const m = spawnSync(bwrap, [...args, "--proc", "/proc", "--", "/bin/cat", "/proc/self/attr/current"], {
      encoding: "utf8",
      env: {},
      timeout: 10_000,
    });
    out.push(
      `minimal invocation (workflow "L1 sandbox label" step): exit ${m.status ?? m.signal}; stdout ${JSON.stringify(m.stdout)}; stderr ${JSON.stringify(m.stderr)}`,
    );
  }
  const denials = kernelLog()
    .slice(kernelLogStart)
    .filter((l) => l.includes('apparmor="DENIED"'));
  out.push(`AppArmor denials since this file started: ${denials.length}`);
  for (const l of denials.slice(-30)) out.push(`  ${l}`);
  out.push("--- end of L1 sandbox diagnostics ---");
  return out.join("\n");
}
