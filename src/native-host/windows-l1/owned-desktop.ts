/** AD-24 owned lifetime; fixed helper under a host-owned kill-on-close Job. */
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { CrotError } from "../../core/errors.js";
import type { EnvironmentPolicy, ExitStatus, ProcessLauncher } from "../../core/platform/types.js";
import { validateSid } from "../validation.js";
import { validateOwnedDesktopName } from "./user-objects.js";
import { loadRestrictedTokens } from "./restricted-token.js";
import { loadBytePipeApi } from "./byte-stdio.js";
import { loadJobObjectApi } from "../windows-job.js";
import { WindowsLaunchEnvironment } from "./launch-environment.js";
import { NativeProcessLauncher } from "./native-process.js";
// Failed cleanup owners stay reachable; no fresh helper is launched by retry.
const failedHelperOwners = new Set<object>();
export interface OwnedDesktop {
  readonly desktop: string;
  readonly restrictingSid: string;
  readonly closed: boolean;
  readonly exited: Promise<ExitStatus>;
  close(): Promise<void>;
  closeSync(): void;
}
export async function createOwnedDesktop(options: {
  readonly launcher: ProcessLauncher;
  readonly ownerSid: string;
  readonly restrictingSid: string;
  readonly systemRoot: string;
  readonly privateRoot: string;
  readonly environment: EnvironmentPolicy;
}): Promise<OwnedDesktop> {
  if (failedHelperOwners.size) throw new CrotError("OPERATION_FAILED", "Owned desktop helper has incomplete cleanup.");
  validateSid(options.ownerSid);
  validateSid(options.restrictingSid);
  const name = `crot-${randomBytes(24).toString("hex")}`;
  const expected = validateOwnedDesktopName(`${name}\\actor`);
  const n = randomBytes(16);
  const helperSid = `S-1-5-21-${n.readUInt32LE(0)}-${n.readUInt32LE(4)}-${n.readUInt32LE(8)}-${n.readUInt32LE(12)}`;
  const helperToken = (await loadRestrictedTokens()).create(helperSid, false, undefined, "mic-only");
  let helper: NativeProcessLauncher | undefined;
  const owner = {
    helperToken,
    get helper() {
      return helper;
    },
  };
  const dispose = async () => {
    try {
      await helper?.close();
      helperToken.close();
      failedHelperOwners.delete(owner);
    } catch (error) {
      failedHelperOwners.add(owner);
      throw error;
    }
  };
  try {
    helperToken.prepareProbeObjects(options.ownerSid);
    // The fixed trusted helper retains source integrity. It never runs actor
    // code. Unlike the general host launcher, this path has NO uncontained
    // assignment fallback: suspended native creation verifies its Job first.
    helper = new NativeProcessLauncher({
      token: helperToken,
      ownerSid: options.ownerSid,
      pipes: await loadBytePipeApi(),
      jobs: await loadJobObjectApi(),
      environment: options.environment,
      resolver: options.launcher,
      childEnvironment: new WindowsLaunchEnvironment({
        systemRoot: options.systemRoot,
        privateRoot: options.privateRoot,
        runtimeBins: [],
      }),
    });
  } catch (error) {
    await dispose().catch(() => undefined);
    throw error;
  }
  let proc;
  try {
    proc = await helper.launch(
      {
        file: process.execPath,
        args: [
          fileURLToPath(new URL("./desktop-helper.js", import.meta.url)),
          "--crot-owned-desktop",
          name,
          options.ownerSid,
          options.restrictingSid,
        ],
        display: "CROT owned desktop helper",
      },
      {
        cwd: options.systemRoot,
        env: { SystemRoot: options.systemRoot },
        stdin: true,
      },
    );
  } catch (error) {
    await dispose().catch(() => undefined);
    throw error;
  }
  const failed = () => new CrotError("OPERATION_FAILED", "Owned desktop helper is unavailable.");
  try {
    if (!proc.stdin) throw failed();
    await new Promise<void>((resolve, reject) => {
      let text = "";
      const timer = setTimeout(() => reject(failed()), 10000);
      const finish = (error?: Error) => {
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };
      proc.stdout.on("data", (chunk: Buffer) => {
        text += chunk.toString("utf8");
        if (text.length > 1024) {
          finish(failed());
          return;
        }
        if (!text.endsWith("\n")) return;
        try {
          const value = JSON.parse(text);
          if (value.error && /^[a-z ]{1,80}$/.test(value.error.stage) && Number.isInteger(value.error.nativeCode)) {
            finish(
              new CrotError(
                "OPERATION_FAILED",
                `Owned desktop helper: ${value.error.stage} failed (${value.error.nativeCode}).` +
                  (typeof value.error.layout === "string" && /^[A-Z0-9:;() ,._-]{1,1024}$/.test(value.error.layout)
                    ? ` Layout: ${value.error.layout}`
                    : ""),
              ),
            );
            return;
          }
          if (value.desktop !== expected || Object.keys(value).length !== 1) throw failed();
          finish();
        } catch {
          finish(failed());
        }
      });
      proc.stdout.on("error", () => finish(failed()));
      proc.stderr.on("error", () => finish(failed()));
      proc.stderr.resume();
      void proc.exited.then(
        () => finish(failed()),
        () => finish(failed()),
      );
    });
    if (proc.hasExited || proc.failure) throw failed();
    let closed = false;
    let closing: Promise<void> | undefined;
    return Object.freeze({
      desktop: expected,
      restrictingSid: options.restrictingSid,
      get closed() {
        return closed || proc.hasExited;
      },
      exited: proc.exited,
      close: () => {
        if (closing) return closing;
        closed = true;
        closing = (async () => {
          let timer: NodeJS.Timeout | undefined;
          try {
            proc.stdin!.on("error", () => undefined);
            proc.stdin!.end("close\n");
            const status = await Promise.race([
              proc.exited,
              new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => reject(failed()), 5000);
              }),
            ]);
            if (status.code !== 0 || proc.failure) throw failed();
          } finally {
            if (timer) clearTimeout(timer);
            await dispose();
            proc.stdout.destroy();
            proc.stderr.destroy();
          }
        })().catch((error: unknown) => {
          closing = undefined;
          throw error;
        });
        return closing;
      },
      closeSync: () => {
        closed = true;
        try {
          helper.closeSync();
          helperToken.close();
          failedHelperOwners.delete(owner);
        } catch (error) {
          failedHelperOwners.add(owner);
          throw error;
        }
        proc.stdout.destroy();
        proc.stderr.destroy();
      },
    });
  } catch (error) {
    await dispose().catch(() => undefined);
    proc.stdout.destroy();
    proc.stderr.destroy();
    throw error;
  }
}
