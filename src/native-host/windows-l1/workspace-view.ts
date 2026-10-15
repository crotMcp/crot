/** AD-27 native same-backing component; not a production confinement backend. */
import { randomBytes } from "node:crypto";
import { mkdir, lstat, rmdir } from "node:fs/promises";
import path from "node:path";
import { CrotError } from "../../core/errors.js";
import type { ManagedProcess, ProcessLauncher } from "../../core/platform/types.js";
import { ownedViewJobName, type JobObject, type JobObjectApi } from "../windows-job.js";
import { validateSid, validateWindowsPath, isSameOrAncestorWindowsPath } from "../validation.js";
const fail = (stage: string) => new CrotError("OPERATION_FAILED", `Workspace view: ${stage} failed.`, { stage });
export interface WorkspaceViewOptions {
  /** Trusted packaged helper, never an executable selected by the actor. */
  readonly helper: string;
  readonly helperLauncher: ProcessLauncher;
  readonly jobs: JobObjectApi;
  readonly root: string;
  readonly privateRoot: string;
  readonly ownerSid: string;
  readonly restrictingSid: string;
  /** Trusted Core profile exclusions relative to root, not client policy. */
  readonly protectedRelativeRoots: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
}
export function workspaceViewFrame(options: {
  root: string;
  mount: string;
  ownerSid: string;
  restrictingSid: string;
  jobName: string;
  protectedRelativeRoots: readonly string[];
}): Buffer {
  validateSid(options.ownerSid);
  validateSid(options.restrictingSid);
  if (options.ownerSid === options.restrictingSid || !/^Local\\crot-view-job-[0-9a-f]{48}$/.test(options.jobName))
    throw fail("identity");
  for (const p of [options.root, options.mount]) {
    validateWindowsPath(p);
    if (!/^[A-Za-z]:\\/.test(p)) throw fail("local root");
  }
  if (options.protectedRelativeRoots.length > 1024) throw fail("exclusions");
  for (const name of options.protectedRelativeRoots) {
    if (
      !/^\\[^\\]/.test(name) ||
      name.length > 32000 ||
      /[\u0000-\u001f/:*?"<>|~]/.test(name) ||
      name
        .slice(1)
        .split("\\")
        .some((p) => !p || p === "." || p === ".." || /[. ]$/.test(p))
    )
      throw fail("exclusion path");
  }
  const number = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n);
    return b;
  };
  const field = (s: string) => {
    if (s.length > 32000 || s.includes("\0")) throw fail("frame field");
    return Buffer.concat([number(s.length), Buffer.from(s, "utf16le")]);
  };
  const b = Buffer.concat([
    number(0x43525631),
    ...[options.root, options.mount, options.ownerSid, options.restrictingSid, options.jobName].map(field),
    number(options.protectedRelativeRoots.length),
    ...options.protectedRelativeRoots.map(field),
  ]);
  if (b.length > 256 * 1024) throw fail("frame limit");
  return b;
}
export interface OwnedWorkspaceView {
  readonly mount: string;
  /** One actor root per view; original empty-Job verification is unchanged. */
  readonly jobs: JobObjectApi;
  readonly exited: ManagedProcess["exited"];
  close(): Promise<void>;
}
interface FailedOwner {
  close(): Promise<void>;
}
const failedOwners = new Set<FailedOwner>();
export async function createOwnedWorkspaceView(options: WorkspaceViewOptions): Promise<OwnedWorkspaceView> {
  for (const owner of failedOwners) {
    try {
      await owner.close();
    } catch {
      /* retry every exact owner */
    }
  }
  if (failedOwners.size) throw fail("prior cleanup");
  const root = validateWindowsPath(options.root),
    privateRoot = validateWindowsPath(options.privateRoot);
  if (isSameOrAncestorWindowsPath(root, privateRoot) || isSameOrAncestorWindowsPath(privateRoot, root))
    throw fail("overlapping roots");
  validateWindowsPath(options.helper);
  // No existing directory is claimed or rewritten. The caller has provisioned
  // the private parent using the fixed CROT-owned object policy.
  const mount = path.win32.join(privateRoot, `view-${randomBytes(24).toString("hex")}`);
  let job: JobObject | undefined,
    helper: ManagedProcess | undefined,
    consumed = false,
    disposed = false,
    helperAlive = false,
    unmountFailureReported = false;
  let created = false;
  const owner: FailedOwner = {
    close: async () => {
      if (disposed) return;
      let failure: unknown;
      if (job && !job.closed) {
        try {
          const n = job.activeProcessCount();
          if (n === null || (n > 0 && !job.terminate(1))) throw fail("actor Job termination");
        } catch (e) {
          failure = e;
        }
      }
      if (helper) {
        try {
          if (helper.stdin && !helper.stdin.destroyed) helper.stdin.end();
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            const exit = await Promise.race([
              helper.exited,
              new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(fail("unmount deadline")), 8000);
              }),
            ]);
            if (exit.code !== 0 && !unmountFailureReported) {
              unmountFailureReported = true;
              failure ??= fail("helper unmount status");
            }
          } finally {
            if (timer) clearTimeout(timer);
          }
        } catch (e) {
          failure ??= e;
        }
        try {
          await helper.terminate("force");
        } catch (e) {
          failure ??= e;
        }
      }
      if (job) {
        try {
          job.close();
        } catch (e) {
          failure ??= e;
        }
      }
      if (created) {
        try {
          const item = await lstat(mount).catch((e) => {
            if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
            throw e;
          });
          if (item?.isSymbolicLink()) throw fail("mount still attached");
          if (item) await rmdir(mount); // never recursive: never follow an attached view into real files
        } catch (e) {
          failure ??= e;
        }
      }
      if (failure) {
        failedOwners.add(owner);
        throw failure;
      }
      disposed = true;
      failedOwners.delete(owner);
    },
  };
  try {
    job = options.jobs.createKillOnCloseJob();
    const jobName = ownedViewJobName(job);
    await mkdir(mount);
    created = true;
    const frame = workspaceViewFrame({ ...options, root, mount, jobName });
    const spec = await options.helperLauncher.resolveCommand(options.helper, [], {
      cwd: privateRoot,
      env: options.environment,
    });
    helper = await options.helperLauncher.launch(spec, { cwd: privateRoot, env: options.environment, stdin: true });
    const process = helper;
    helperAlive = true;
    const helperLost = () => {
      helperAlive = false;
      // Loss of the filesystem owner must not leave its actor running.
      if (job && !job.closed) {
        try {
          if (!job.terminate(1)) throw fail("helper loss actor termination");
        } catch {
          failedOwners.add(owner);
        }
      }
    };
    void process.exited.then(helperLost, helperLost);
    let output = "",
      bytes = 0;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => finish(fail("mount readiness deadline")), 20000);
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        process.stdout.off("data", data);
        process.stderr.off("data", stderr);
        process.stdin?.off("error", pipeError);
        if (error) reject(error);
        else resolve();
      };
      const data = (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 128) return finish(fail("readiness protocol"));
        output += chunk.toString("ascii");
        if (output === "CROT_VIEW_READY\n") finish();
        else if (output.includes("\n")) finish(fail("readiness protocol"));
      };
      const stderr = (chunk: Buffer) => {
        if (chunk.length) {
          const code = /^CROT_VIEW_ERROR:([0-9a-f]{8}|internal)\r?\n$/.exec(chunk.toString("ascii"))?.[1];
          finish(fail(code ? `helper startup ${code}` : "helper startup"));
        }
      };
      const pipeError = () => finish(fail("configuration pipe"));
      process.stdin?.on("error", pipeError);
      process.stdout.on("data", data);
      process.stderr.on("data", stderr);
      void process.exited.then(
        () => finish(fail("helper exited before readiness")),
        () => finish(fail("helper exit observation")),
      );
      if (!process.stdin) return finish(fail("owned configuration pipe"));
      process.stdin.write(frame, (e) => {
        if (e) finish(fail("configuration delivery"));
      });
    });
    // Drain without publishing native diagnostics, paths, content or identity.
    helper.stdout.resume();
    helper.stderr.resume();
    const exactJob = job;
    return {
      mount,
      exited: helper.exited,
      jobs: {
        createKillOnCloseJob: () => {
          if (consumed || disposed || !helperAlive || exactJob.closed) throw fail("actor Job already consumed");
          consumed = true;
          return exactJob;
        },
      },
      close: () => owner.close(),
    };
  } catch (e) {
    try {
      await owner.close();
    } catch {
      failedOwners.add(owner);
    }
    throw e;
  }
}
