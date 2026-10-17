import { loadWindowsPrivateState } from "./windows-state.js";
import { WindowsConfinement } from "./windows-l1/confinement.js";
import { WindowsLeaseServiceLifecycle } from "./windows-l1/service-lifecycle.js";
import { createNodePlatform } from "../core/platform/node-platform.js";
import type {
  CommandConfinement,
  OsFamily,
  Platform,
  PrivateFileProtection,
  ProcessControlInfo,
  ProcessLauncher,
} from "../core/platform/types.js";
import { createJobObjectLauncher, guardLauncher, JobTracker } from "./job-launcher.js";
import { LinuxConfinement, type LinuxConfinementOptions } from "./linux-l1/confinement.js";
import { createWindowsAclProtection, currentUserSid, windowsTools } from "./windows-acl.js";
import { loadJobObjectApi, type FfiLoader } from "./windows-job.js";

type NodePlatformOptions = NonNullable<Parameters<typeof createNodePlatform>[0]>;

export type NativeHostOptions = NodePlatformOptions & {
  /** Use Windows Job Objects (default true). */
  readonly jobObjects?: boolean;
  /** Use owner-only Windows ACLs for private files (default true). */
  readonly windowsAcl?: boolean;
  /** Test seam: loader of the FFI module. */
  readonly loadFfi?: FfiLoader;
  /**
   * The service's state directory: the L1 private storage has one
   * subdirectory per state directory (AD-20 point 7). Defaults to the
   * platform's state directory.
   */
  readonly stateDir?: string;
  /** Service log, for changes of L1 availability (AD-20 point 13). */
  readonly log?: (line: string) => void;
  /** Linux command confinement L1 (default true). Test seam: options for the L1 implementation. */
  readonly confinement?: boolean | Partial<Omit<LinuxConfinementOptions, "base" | "stateDir">>;
};

export interface NativeHostStatus {
  readonly state: "running" | "closed";
  readonly os: OsFamily;
  readonly processControl: ProcessControlInfo & {
    /** native-host: Job Objects; core: the Core launcher is used unchanged. */
    readonly provider: "native-host" | "core";
    readonly openJobs: number;
    readonly incompleteProcessCleanup: number;
    readonly uncontainedLaunches: number;
  };
  readonly privateFiles: {
    readonly provider: "native-host" | "core";
    readonly mechanism: PrivateFileProtection["mechanism"];
    readonly enforced: boolean;
  };
  /** Why a native mechanism is not used (fallbacks). Never contains secrets. */
  readonly notes: readonly string[];
}

const describe = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).split(/\r?\n/)[0]!.slice(0, 200);

/**
 * CROT Native Host: OS-specific implementations of the Core platform
 * interfaces (ProcessLauncher, PrivateFileProtection). Not a second Core.
 *
 * - It performs no authorization and exposes no operations of its own: its
 *   only output is a Platform handed to CrotCore, whose PermissionEngine
 *   authorizes every operation before a platform method runs.
 * - Windows: kill-on-close Job Object per command; owner-only ACLs.
 * - Linux/macOS: the Core mechanisms (process groups, 0600/0700) are kept.
 * - Lifecycle: start() before CrotCore.create; close() after core.shutdown();
 *   closeSync() after core.terminateProcessesSync() in emergencies. The CLI
 *   lifecycle remains the only shutdown authority.
 *
 * Future adapters (e.g. a browser-extension native-messaging adapter) call
 * CrotCore, never the Native Host directly.
 */
export class NativeHost {
  private constructor(
    readonly platform: Platform,
    private readonly lifecycle: { open: boolean },
    private readonly jobs: JobTracker | undefined,
    private readonly nativeAcl: boolean,
    private readonly notes: readonly string[],
    readonly windowsLeases?: WindowsLeaseServiceLifecycle,
  ) {}

  static async start(options: NativeHostOptions): Promise<NativeHost> {
    const {
      jobObjects = true,
      windowsAcl = true,
      loadFfi,
      stateDir,
      log,
      confinement: confinementOption = true,
      ...platformOptions
    } = options;
    const base = await createNodePlatform(platformOptions);
    const lifecycle = { open: true };
    const isOpen = () => lifecycle.open;
    const notes: string[] = [];
    let launcher: ProcessLauncher = guardLauncher(base.launcher, isOpen);
    let privateFiles: PrivateFileProtection = base.privateFiles;
    let jobs: JobTracker | undefined;
    let nativeAcl = false;
    let windowsOwnerSid: string | undefined;

    if (base.info.os === "windows") {
      if (jobObjects) {
        try {
          const api = await loadJobObjectApi(loadFfi);
          jobs = new JobTracker();
          launcher = createJobObjectLauncher(base.launcher, api, jobs, isOpen);
        } catch (error) {
          notes.push(`Job Objects unavailable (${describe(error)}); using Core taskkill tree termination`);
        }
      } else {
        notes.push("Job Objects disabled; using Core taskkill tree termination");
      }
      if (windowsAcl) {
        try {
          const tools = windowsTools(base.environment.get(process.env, "SystemRoot") ?? "C:\\Windows");
          windowsOwnerSid = await currentUserSid(tools);
          privateFiles = createWindowsAclProtection({ tools, userSid: windowsOwnerSid });
          nativeAcl = true;
        } catch (error) {
          notes.push(`owner-only ACLs unavailable (${describe(error)}); private files use inherited ACLs`);
        }
      } else {
        notes.push("owner-only ACLs disabled; private files use inherited ACLs");
      }
    }

    let windowsLeases: WindowsLeaseServiceLifecycle | undefined;
    let leasePrivateFiles = privateFiles,
      runtimePrivateFiles = privateFiles;
    if (base.info.os === "windows" && stateDir && windowsOwnerSid && nativeAcl) {
      try {
        // WAL/profile/admission records are NR secrets; executable/runtime
        // trees deliberately are not NR, so a granted AppContainer can read.
        leasePrivateFiles = await loadWindowsPrivateState(windowsOwnerSid);
        runtimePrivateFiles = await loadWindowsPrivateState(windowsOwnerSid, [], "runtime");
        windowsLeases = new WindowsLeaseServiceLifecycle({
          stateDir,
          ownerSid: windowsOwnerSid,
          privateFiles: leasePrivateFiles,
        });
        await windowsLeases.recoverExisting();
      } catch (cause) {
        notes.push(`Windows L1 startup recovery failed (${describe(cause)}); confinement remains unavailable`);
      }
    }

    // Command confinement L1: qualified native backends only, no launch fallback.
    let confinement: CommandConfinement | undefined;
    if (base.info.os === "linux" && confinementOption !== false) {
      confinement = new LinuxConfinement({
        stateDir: stateDir ?? base.info.directories.state,
        base: launcher,
        env: process.env,
        ...(log ? { log } : {}),
        ...(typeof confinementOption === "object" ? confinementOption : {}),
      });
    }

    if (base.info.os === "windows" && confinementOption !== false) {
      confinement = new WindowsConfinement({
        stateDir: stateDir ?? base.info.directories.state,
        ownerSid: windowsOwnerSid,
        privateFiles: leasePrivateFiles,
        runtimeFiles: runtimePrivateFiles,
        lifecycle: windowsLeases,
        base: launcher,
        environment: base.environment,
        env: base.baseEnvironment,
        ...(log ? { log } : {}),
      });
    }

    const platform: Platform = {
      info: {
        ...base.info,
        processControl: launcher.processControl,
        privateFiles: { mechanism: privateFiles.mechanism, enforced: privateFiles.enforced },
      },
      paths: base.paths,
      environment: base.environment,
      baseEnvironment: base.baseEnvironment,
      shells: base.shells,
      launcher,
      encodings: base.encodings,
      privateFiles,
      probeCaseSensitivity: (directory) => base.probeCaseSensitivity(directory),
      ...(confinement ? { confinement } : {}),
    };
    return new NativeHost(platform, lifecycle, jobs, nativeAcl, notes, windowsLeases);
  }

  get running(): boolean {
    return this.lifecycle.open;
  }

  status(): NativeHostStatus {
    return {
      state: this.lifecycle.open ? "running" : "closed",
      os: this.platform.info.os,
      processControl: {
        ...this.platform.info.processControl,
        provider: this.jobs ? "native-host" : "core",
        openJobs: this.jobs?.size ?? 0,
        incompleteProcessCleanup: this.jobs?.incompleteProcessCleanup ?? 0,
        uncontainedLaunches: this.jobs?.uncontained ?? 0,
      },
      privateFiles: { provider: this.nativeAcl ? "native-host" : "core", ...this.platform.info.privateFiles },
      notes: [...this.notes],
    };
  }

  /** Stop accepting launches and release native resources (terminating any job still open). Idempotent. */
  async close(): Promise<void> {
    this.lifecycle.open = false;
    await this.windowsLeases?.close();
    this.closeSync();
  }

  /** Synchronous close for the host process 'exit' event and fatal errors. Idempotent. */
  closeSync(): void {
    this.lifecycle.open = false;
    // A previous CloseHandle failure must remain retryable even after launches
    // have been permanently disabled.
    let failure: unknown;
    try {
      this.windowsLeases?.closeSync();
    } catch (cause) {
      failure = cause;
    }
    try {
      this.jobs?.terminateAll();
    } catch (cause) {
      failure ??= cause;
    }
    if (failure) throw failure;
  }
}
