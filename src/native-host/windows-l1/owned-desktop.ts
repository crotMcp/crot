/** AD-24 owned lifetime; fixed helper under a host-owned kill-on-close Job. */
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { CrotError } from "../../core/errors.js";
import type { ExitStatus, ProcessLauncher } from "../../core/platform/types.js";
import { validateSid } from "../validation.js";
import { validateOwnedDesktopName } from "./user-objects.js";
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
}): Promise<OwnedDesktop> {
  validateSid(options.ownerSid);
  validateSid(options.restrictingSid);
  if (options.launcher.processControl.treeTermination !== "job-object")
    throw new CrotError("OPERATION_FAILED", "Owned desktop helper requires a host-owned Job.");
  const name = `crot-${randomBytes(24).toString("hex")}`;
  const expected = validateOwnedDesktopName(`${name}\\actor`);
  const proc = await options.launcher.launch(
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
                `Owned desktop helper: ${value.error.stage} failed (${value.error.nativeCode}).`,
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
            await proc.terminate("force");
            proc.stdout.destroy();
            proc.stderr.destroy();
          }
        })();
        return closing;
      },
      closeSync: () => {
        closed = true;
        proc.terminateSync();
        proc.stdout.destroy();
        proc.stderr.destroy();
      },
    });
  } catch (error) {
    await proc.terminate("force").catch(() => undefined);
    proc.stdout.destroy();
    proc.stderr.destroy();
    throw error;
  }
}
