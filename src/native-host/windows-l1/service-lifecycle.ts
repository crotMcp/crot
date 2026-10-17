/** Recovery is independent of runtime DLL availability and precedes Core creation. */
import { lstat } from "node:fs/promises";
import path from "node:path";
import type { PrivateFileProtection } from "../../core/platform/types.js";
import { CrotError } from "../../core/errors.js";
import { WindowsNativeLeases } from "./lease-owner.js";
export class WindowsLeaseServiceLifecycle {
  readonly directory: string;
  private owner?: WindowsNativeLeases;
  private pending?: Promise<WindowsNativeLeases>;
  private stopped = false;
  private error?: unknown;
  constructor(private readonly options: { stateDir: string; ownerSid: string; privateFiles: PrivateFileProtection }) {
    this.directory = path.join(options.stateDir, "windows-l1", "leases");
  }
  get failure(): unknown {
    return this.error;
  }
  async recoverExisting(): Promise<void> {
    const exists = await lstat(this.directory).catch((e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") return undefined;
      throw e;
    });
    if (exists) await this.get();
  }
  get(): Promise<WindowsNativeLeases> {
    if (this.stopped) return Promise.reject(new CrotError("CONFINEMENT_FAILED", "Windows lease service is stopped."));
    if (this.error) return Promise.reject(this.error);
    return (this.pending ??= WindowsNativeLeases.open({
      directory: this.directory,
      ownerSid: this.options.ownerSid,
      privateFiles: this.options.privateFiles,
    })
      .then((owner) => (this.owner = owner))
      .catch((cause) => {
        this.error = cause;
        throw cause;
      }));
  }
  async close(): Promise<void> {
    this.stopped = true;
    if (this.pending) {
      try {
        await this.pending;
      } catch {
        return;
      }
    }
    await this.owner?.close();
  }
  closeSync(): void {
    this.stopped = true;
    this.owner?.closeSync();
  }
}
