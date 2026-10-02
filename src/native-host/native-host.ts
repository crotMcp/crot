import { createNodePlatform } from "../core/platform/node-platform.js";
import type { OsFamily, Platform, PrivateFileProtection, ProcessControlInfo, ProcessLauncher } from "../core/platform/types.js";
import { createJobObjectLauncher, guardLauncher, JobTracker } from "./job-launcher.js";
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
};

export interface NativeHostStatus {
  readonly state: "running" | "closed";
  readonly os: OsFamily;
  readonly processControl: ProcessControlInfo & {
    /** native-host: Job Objects; core: the Core launcher is used unchanged. */
    readonly provider: "native-host" | "core";
    readonly openJobs: number;
    readonly uncontainedLaunches: number;
  };
  readonly privateFiles: { readonly provider: "native-host" | "core"; readonly mechanism: PrivateFileProtection["mechanism"]; readonly enforced: boolean };
  /** Why a native mechanism is not used (fallbacks). Never contains secrets. */
  readonly notes: readonly string[];
}

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error)).split(/\r?\n/)[0]!.slice(0, 200);

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
  ) {}

  static async start(options: NativeHostOptions): Promise<NativeHost> {
    const { jobObjects = true, windowsAcl = true, loadFfi, ...platformOptions } = options;
    const base = await createNodePlatform(platformOptions);
    const lifecycle = { open: true };
    const isOpen = () => lifecycle.open;
    const notes: string[] = [];
    let launcher: ProcessLauncher = guardLauncher(base.launcher, isOpen);
    let privateFiles: PrivateFileProtection = base.privateFiles;
    let jobs: JobTracker | undefined;
    let nativeAcl = false;

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
          privateFiles = createWindowsAclProtection({ tools, userSid: await currentUserSid(tools) });
          nativeAcl = true;
        } catch (error) {
          notes.push(`owner-only ACLs unavailable (${describe(error)}); private files use inherited ACLs`);
        }
      } else {
        notes.push("owner-only ACLs disabled; private files use inherited ACLs");
      }
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
    };
    return new NativeHost(platform, lifecycle, jobs, nativeAcl, notes);
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
        uncontainedLaunches: this.jobs?.uncontained ?? 0,
      },
      privateFiles: { provider: this.nativeAcl ? "native-host" : "core", ...this.platform.info.privateFiles },
      notes: [...this.notes],
    };
  }

  /** Stop accepting launches and release native resources (terminating any job still open). Idempotent. */
  async close(): Promise<void> {
    this.closeSync();
  }

  /** Synchronous close for the host process 'exit' event and fatal errors. Idempotent. */
  closeSync(): void {
    if (!this.lifecycle.open) return;
    this.lifecycle.open = false;
    this.jobs?.terminateAll();
  }
}
