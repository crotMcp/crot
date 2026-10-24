/**
 * Core side of command confinement L1 (AD-20 point 11): the decision in the
 * process service, CONFINEMENT_UNAVAILABLE (refused before admission of any
 * process) versus CONFINEMENT_FAILED (L1 was available, the sandbox launch
 * failed), status and audit.
 *
 * Mocks only: the platform's confinement is a stub and the launchers are
 * spies, so every test can prove which launcher was (not) called. The real
 * sandbox is tested in tests/native-host/linux-l1/l1-integration.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RemoteExposureStore } from "../../src/core/approvals/remote-exposure.js";
import { MemoryAuditSink } from "../../src/core/audit/audit.js";
import { FORWARDED_ENV } from "../../src/core/capabilities/docker/service.js";
import { remoteExposureScope, remotePrincipal, type AuthContext } from "../../src/core/auth/principal.js";
import type { CrotCore } from "../../src/core/crot-core.js";
import { CrotError } from "../../src/core/errors.js";
import { decideConfinement } from "../../src/core/platform/confinement.js";
import { createNodePlatform } from "../../src/core/platform/node-platform.js";
import type {
  CommandConfinement,
  ConfinementScope,
  ConfinementStatus,
  CoreConfinement,
  ManagedProcess,
  Platform,
  ProcessLauncher,
} from "../../src/core/platform/types.js";
import { createTestCore, makeTempDirs, testContext as local, type TempDirs } from "../helpers.js";

const remote: AuthContext = {
  principal: remotePrincipal({
    id: "remote-1",
    transport: "http",
    authMethod: "test",
    accountId: "a",
    deviceId: "d",
    clientId: "c",
  }),
};

const available: ConfinementStatus = {
  mechanism: "linux-bubblewrap",
  available: true,
  network: "on",
  reason: null,
  detail: null,
};
const unavailable: ConfinementStatus = {
  mechanism: "linux-bubblewrap",
  available: false,
  network: "on",
  reason: "components_missing",
  detail: "L1 components 1 are not installed",
};

describe("decideConfinement (AD-20 point 11)", () => {
  it("confines every principal when available, refuses remote and keeps local when unavailable", () => {
    expect(decideConfinement(available, "local")).toBe("confine");
    expect(decideConfinement(available, "remote")).toBe("confine");
    expect(decideConfinement(unavailable, "local")).toBe("unconfined");
    expect(decideConfinement(unavailable, "remote")).toBe("refuse");
    expect(decideConfinement(undefined, "remote")).toBe("unconfined");
    expect(decideConfinement(undefined, "local")).toBe("unconfined");
  });
});

interface Harness {
  core: CrotCore;
  audit: MemoryAuditSink;
  /** Calls of the platform (unconfined) launcher. */
  baseLaunch: ReturnType<typeof vi.fn>;
  /** Calls of the confined launcher. */
  confinedLaunch: ReturnType<typeof vi.fn>;
  scopes: ConfinementScope[];
  setStatus(status: ConfinementStatus): void;
  refreshes: () => number;
  failAdmission(): void;
}

let dirs: TempDirs;
let harness: Harness | undefined;

beforeEach(async () => {
  dirs = await makeTempDirs();
});
afterEach(async () => {
  await harness?.core.shutdown();
  harness = undefined;
  await dirs.cleanup();
});

/**
 * A Core on the real Node platform whose launcher is wrapped by a spy, with a
 * stub L1. `confined` decides what the confined launcher does.
 *
 * The remote scope starts clean (AD-15 point 8): without a remote exposure
 * store every remote scope is exposed (fail closed), and the built-in
 * untrusted-content rule (AD-12) would then gate every remote command before
 * the L1 decision is reached. That gate is covered on its own below.
 */
async function setup(
  initial: ConfinementStatus,
  confined: (base: ProcessLauncher) => ProcessLauncher["launch"],
  mode: "sandbox" | "full_control" = "sandbox",
  remoteExposure: RemoteExposureStore = RemoteExposureStore.inMemory(),
): Promise<Harness> {
  const node = await createNodePlatform();
  const baseLaunch = vi.fn(node.launcher.launch.bind(node.launcher));
  const base: ProcessLauncher = { ...node.launcher, launch: baseLaunch as ProcessLauncher["launch"] };
  let status = initial;
  let refreshes = 0;
  let admissionFailed = false;
  const scopes: ConfinementScope[] = [];
  const confinedLaunch = vi.fn(confined(node.launcher));
  const coreConfinement: CoreConfinement = {
    status: () => status,
    assertAdmission: () => {
      if (admissionFailed) throw new CrotError("CONFINEMENT_FAILED", "post-admission failure");
    },
    refresh: async () => {
      refreshes++;
      return status;
    },
    launcher: {
      ...node.launcher,
      launch: confinedLaunch as ProcessLauncher["launch"],
    },
    close: async () => undefined,
    closeSync: () => undefined,
  };
  const confinement: CommandConfinement = {
    probe: async () => status,
    open: async (scope) => {
      scopes.push(scope);
      return coreConfinement;
    },
  };
  const platform: Platform = { ...node, launcher: base, confinement };
  const audit = new MemoryAuditSink();
  const core = await createTestCore({ workspace: { root: dirs.workspace }, permissions: { mode } }, audit, {
    platform,
    remoteExposure,
  });
  harness = {
    core,
    audit,
    baseLaunch,
    confinedLaunch,
    scopes,
    setStatus: (s) => (status = s),
    refreshes: () => refreshes,
    failAdmission: () => {
      admissionFailed = true;
    },
  };
  return harness;
}

const node = process.execPath;
const exec = (core: CrotCore, ctx: AuthContext) =>
  core.processes.exec(ctx, { command: node, args: ["-e", "console.log('ran')"] });
const shell = (core: CrotCore, ctx: AuthContext) => core.processes.shell(ctx, { script: "echo ran" });
const start = (core: CrotCore, ctx: AuthContext) =>
  core.processes.start(ctx, { command: node, args: ["-e", "setTimeout(()=>{},200)"] });

const failingLaunch = () => async (): Promise<ManagedProcess> => {
  throw new CrotError("CONFINEMENT_FAILED", "Command confinement L1 failed: test. The command was not started.");
};

describe("ProcessService and L1 (mocked platform confinement)", () => {
  it("passes the Core's workspace, protected paths, network mode and Docker environment to L1", async () => {
    const h = await setup(available, (b) => b.launch.bind(b));
    expect(h.scopes).toHaveLength(1);
    expect(h.scopes[0]!.workspace).toBe(dirs.workspace);
    expect(h.scopes[0]!.network).toBe("on");
    expect(Array.isArray(h.scopes[0]!.protectedPaths)).toBe(true);
    // The service's Docker environment as docker.use forwards it (AD-3): the endpoint's upstream (AD-20 point 9).
    for (const name of Object.keys(h.scopes[0]!.dockerEnvironment))
      expect(FORWARDED_ENV.has(name.toUpperCase())).toBe(true);
  });

  for (const [name, run] of [
    ["exec", exec],
    ["shell", shell],
    ["start", start],
  ] as const) {
    it(`${name}: available → every principal runs through the confined launcher only`, async () => {
      const h = await setup(available, (b) => b.launch.bind(b));
      for (const ctx of [local, remote]) {
        h.baseLaunch.mockClear();
        h.confinedLaunch.mockClear();
        await run(h.core, ctx);
        expect(h.confinedLaunch).toHaveBeenCalledTimes(1);
        expect(h.baseLaunch).not.toHaveBeenCalled();
      }
    });

    it(`${name}: unavailable → remote refused with CONFINEMENT_UNAVAILABLE before any process starts, audited`, async () => {
      const h = await setup(unavailable, (b) => b.launch.bind(b));
      await expect(run(h.core, remote)).rejects.toMatchObject({
        code: "CONFINEMENT_UNAVAILABLE",
        details: { reason: "components_missing", network: "on" },
      });
      expect(h.baseLaunch).not.toHaveBeenCalled();
      expect(h.confinedLaunch).not.toHaveBeenCalled();
      const record = h.audit.events.at(-1)!;
      expect(record.outcome).toBe("error");
      expect(record.error?.code).toBe("CONFINEMENT_UNAVAILABLE");
      expect(record.principal.kind).toBe("remote");
    });

    it(`${name}: unavailable → local keeps its existing (unconfined) behaviour`, async () => {
      const h = await setup(unavailable, (b) => b.launch.bind(b));
      await run(h.core, local);
      expect(h.baseLaunch).toHaveBeenCalledTimes(1);
      expect(h.confinedLaunch).not.toHaveBeenCalled();
    });

    it(`${name}: available but the sandbox launch fails → CONFINEMENT_FAILED for every principal, never retried unconfined`, async () => {
      const h = await setup(available, failingLaunch);
      for (const ctx of [local, remote]) {
        await expect(run(h.core, ctx)).rejects.toMatchObject({ code: "CONFINEMENT_FAILED" });
        const record = h.audit.events.at(-1)!;
        expect(record.error?.code).toBe("CONFINEMENT_FAILED");
      }
      // The proof that nothing was launched outside L1: the platform launcher was never called.
      expect(h.baseLaunch).not.toHaveBeenCalled();
      expect(h.confinedLaunch).toHaveBeenCalledTimes(2);
      expect(h.core.processes.runningCount()).toBe(0);
    });

    it(`${name}: truthful unavailable status after admission cannot enable local fallback`, async () => {
      const h = await setup(available, (b) => b.launch.bind(b));
      h.failAdmission();
      h.setStatus(unavailable);
      for (const ctx of [local, remote])
        await expect(run(h.core, ctx)).rejects.toMatchObject({ code: "CONFINEMENT_FAILED" });
      expect(h.baseLaunch).not.toHaveBeenCalled();
      expect(h.confinedLaunch).not.toHaveBeenCalled();
    });
    it(`${name}: local full control is not restricted by an L1 admission failure`, async () => {
      const h = await setup(available, (b) => b.launch.bind(b), "full_control");
      h.failAdmission();
      h.setStatus(unavailable);
      await run(h.core, local);
      expect(h.baseLaunch).toHaveBeenCalledTimes(1);
      await expect(run(h.core, remote)).rejects.toMatchObject({ code: "CONFINEMENT_FAILED" });
    });

    it(`${name}: local full_control → local runs unconfined, remote runs only through L1 (WP-31)`, async () => {
      const h = await setup(available, (b) => b.launch.bind(b), "full_control");
      await run(h.core, local);
      expect(h.baseLaunch).toHaveBeenCalledTimes(1);
      expect(h.confinedLaunch).not.toHaveBeenCalled();
      await run(h.core, remote);
      expect(h.confinedLaunch).toHaveBeenCalledTimes(1);
      expect(h.baseLaunch).toHaveBeenCalledTimes(1);
    });

    it(`${name}: local full_control, L1 unavailable → remote refused before any process starts (WP-31)`, async () => {
      const h = await setup(unavailable, (b) => b.launch.bind(b), "full_control");
      await expect(run(h.core, remote)).rejects.toMatchObject({ code: "CONFINEMENT_UNAVAILABLE" });
      expect(h.baseLaunch).not.toHaveBeenCalled();
      expect(h.confinedLaunch).not.toHaveBeenCalled();
      await run(h.core, local);
      expect(h.baseLaunch).toHaveBeenCalledTimes(1);
    });
  }

  it("an exposed remote scope stays behind the approval gate (AD-12): denied before the L1 decision, nothing launched", async () => {
    const exposed = RemoteExposureStore.inMemory();
    exposed.markExposed(remoteExposureScope("a", "d", "c").remoteKey!);
    for (const status of [available, unavailable]) {
      const h = await setup(status, (b) => b.launch.bind(b), "sandbox", exposed);
      await expect(exec(h.core, remote)).rejects.toMatchObject({
        code: "PERMISSION_DENIED",
        details: { approval: { status: "unavailable" } },
      });
      expect(h.baseLaunch).not.toHaveBeenCalled();
      expect(h.confinedLaunch).not.toHaveBeenCalled();
      await h.core.shutdown();
      harness = undefined;
    }
  });

  it("follows the reported state at launch time (a failure that makes L1 unavailable)", async () => {
    const h = await setup(available, (b) => b.launch.bind(b));
    await exec(h.core, remote);
    h.setStatus(unavailable);
    await expect(exec(h.core, remote)).rejects.toMatchObject({ code: "CONFINEMENT_UNAVAILABLE" });
    await exec(h.core, local);
    expect(h.baseLaunch).toHaveBeenCalledTimes(1);
  });

  it("full_control: L1 is opened for remote clients; a failed confined launch is never retried unconfined; status note", async () => {
    const h = await setup(available, failingLaunch, "full_control");
    expect(h.scopes).toHaveLength(1);
    await exec(h.core, local);
    expect(h.baseLaunch).toHaveBeenCalledTimes(1);
    await expect(exec(h.core, remote)).rejects.toMatchObject({ code: "CONFINEMENT_FAILED" });
    expect(h.baseLaunch).toHaveBeenCalledTimes(1);
    expect(h.confinedLaunch).toHaveBeenCalledTimes(1);
    // CrotStatus.confinement (AD-20 point 12): in full_control the state is reported with a note.
    const note = "permission mode full_control: local commands run unconfined; remote commands need L1";
    expect(h.core.status().confinement).toEqual({ ...available, detail: note });
    h.setStatus(unavailable);
    expect(await h.core.refreshConfinement()).toEqual({ ...unavailable, detail: `${note}; ${unavailable.detail}` });
    await expect(exec(h.core, remote)).rejects.toMatchObject({ code: "CONFINEMENT_UNAVAILABLE" });
  });

  it("crot_status shape: the status of the Core's L1, refreshed on request", async () => {
    const h = await setup(unavailable, (b) => b.launch.bind(b));
    expect(h.core.status().confinement).toEqual(unavailable);
    const before = h.refreshes();
    h.setStatus(available);
    expect(await h.core.refreshConfinement()).toEqual(available);
    expect(h.refreshes()).toBe(before + 1);
    expect(h.core.status().confinement).toEqual(available);
  });

  it("crot_status reports the remote profile (WP-31)", async () => {
    const h = await setup(available, (b) => b.launch.bind(b), "full_control");
    expect(h.core.status().mode).toBe("full_control");
    expect(h.core.status().remote).toMatchObject({
      mode: "sandbox",
      untrustedContent: "require-approval",
      fullControl: { enabled: false },
    });
    expect(h.core.status().remote.capabilities).not.toContain("filesystem.full");
  });

  it("a platform without L1 reports not_implemented and refuses remote commands", async () => {
    const node = await createNodePlatform();
    const { confinement: _none, ...withoutL1 } = node;
    for (const mode of ["sandbox", "full_control"] as const) {
      const core = await createTestCore({ workspace: { root: dirs.workspace }, permissions: { mode } }, undefined, {
        platform: withoutL1 as Platform,
        remoteExposure: RemoteExposureStore.inMemory(),
      });
      try {
        expect(core.status().confinement).toMatchObject({
          mechanism: "none",
          available: false,
          reason: "not_implemented",
        });
        await expect(exec(core, remote)).rejects.toMatchObject({
          code: "CONFINEMENT_UNAVAILABLE",
          details: { reason: "not_implemented" },
        });
        await expect(exec(core, local)).resolves.toBeDefined();
      } finally {
        await core.shutdown();
      }
    }
  });
});

describe("Stage A named token lifecycle", () => {
  const scoped: AuthContext = {
    principal: {
      id: "verified-token",
      kind: "local",
      transport: "http",
      tokenAccess: { id: "token-id", generation: "v1", scopes: ["terminal"] },
    },
  };
  it("requires L1 for scoped commands even when owner configuration is full_control", async () => {
    const h = await setup(unavailable, (b) => b.launch.bind(b), "full_control");
    expect(h.core.permissions.modeFor(scoped)).toBe("sandbox");
    await expect(exec(h.core, scoped)).rejects.toMatchObject({ code: "CONFINEMENT_UNAVAILABLE" });
    expect(h.baseLaunch).not.toHaveBeenCalled();
    expect(h.confinedLaunch).not.toHaveBeenCalled();
  });
  it("cancels only the revoked token's real process without requesting approval for termination", async () => {
    // Launcher-selection/lifecycle fixture, not a native L1 qualification.
    const h = await setup(available, (b) => b.launch.bind(b), "full_control");
    const first = await h.core.processes.start(scoped, {
      command: process.execPath,
      args: ["-e", "setInterval(()=>{},1000)"],
    });
    const otherContext: AuthContext = {
      principal: { ...scoped.principal, tokenAccess: { id: "other", generation: "v1", scopes: ["terminal"] } },
    };
    const other = await h.core.processes.start(otherContext, {
      command: process.execPath,
      args: ["-e", "setInterval(()=>{},1000)"],
    });
    h.core.permissions.runtime.replace({ strict: true, rules: [] });
    await h.core.processes.cancelToken("token-id", "wrong-generation");
    await h.core.processes.cancelToken("token-id", "v1");
    h.core.permissions.runtime.replace({ strict: false, rules: [] });
    const listing = await h.core.processes.list(local);
    expect(listing.find((p) => p.id === first.id)?.status).toBe("exited");
    expect(listing.find((p) => p.id === other.id)?.status).toBe("running");
  });
});
