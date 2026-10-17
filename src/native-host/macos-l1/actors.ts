/** Kernel policy identity, not parent PID / process-group membership.
 * posix_spawn(SETSID) can bypass a setsid syscall filter on Darwin. Each
 * command therefore has two unpredictable policy probes, inherited by every
 * descendant. __mac_syscall is denied inside L1: actors cannot replace/stack
 * a policy to hide their identity. No signal is based on a pathname or PPID.
 */
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";

export interface ActorIdentity {
  readonly denied: string;
  readonly allowed: string;
}
interface Snapshot {
  readonly pid: number;
  readonly uid: number;
  readonly birth: string;
  readonly zombie: boolean;
}
type Fn = (...args: unknown[]) => unknown;
interface Library {
  func(signature: string): Fn;
}
interface Ffi {
  load(name: string): Library;
}

export class MacosActors {
  private constructor(
    private readonly list: Fn,
    private readonly info: Fn,
    private readonly check: Fn,
  ) {}
  static async load(): Promise<MacosActors> {
    const name: string = "koffi";
    const imported = (await import(name)) as { default?: Ffi } & Partial<Ffi>;
    const ffi = (imported.default ?? imported) as Ffi;
    const proc = ffi.load("/usr/lib/libproc.dylib");
    const sandbox = ffi.load("/usr/lib/system/libsystem_sandbox.dylib");
    return new MacosActors(
      proc.func("int proc_listpids(uint32_t, uint32_t, void *, int)"),
      proc.func("int proc_pidinfo(int, int, uint64_t, void *, int)"),
      sandbox.func("int sandbox_check(int, const char *, int, ...)"),
    );
  }
  async identity(root: string): Promise<ActorIdentity> {
    const id = { denied: path.join(root, randomUUID()), allowed: path.join(root, randomUUID()) };
    for (const p of [id.denied, id.allowed])
      await writeFile(p, "policy identity, not a secret", { flag: "wx", mode: 0o600 });
    return id;
  }
  private snapshot(pid: number): Snapshot | undefined {
    // Darwin proc_bsdinfo, both x86_64 and arm64: 136 bytes, start time at120.
    const b = Buffer.alloc(136);
    if (Number(this.info(pid, 3, 0, b, b.length)) !== b.length) return undefined;
    if (b.readUInt32LE(12) !== pid) return undefined;
    return {
      pid,
      uid: b.readUInt32LE(20),
      birth: `${b.readBigUInt64LE(120)}:${b.readBigUInt64LE(128)}`,
      zombie: b.readUInt32LE(4) === 5,
    };
  }
  owns(pid: number, id: ActorIdentity): boolean {
    if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) return false;
    const before = this.snapshot(pid);
    if (!before || before.zombie || before.uid !== process.getuid?.()) return false;
    if (Number(this.check(pid, null, 0)) !== 1) return false;
    // Koffi variadic type/value pairs are required on Apple Silicon (not fixed-arg ABI).
    const denied = Number(this.check(pid, "file-read-data", 0x10001, "const char *", id.denied));
    const allowed = Number(this.check(pid, "file-read-data", 0x10001, "const char *", id.allowed));
    const after = this.snapshot(pid);
    return (
      denied === 1 &&
      allowed === 0 &&
      !!after &&
      !after.zombie &&
      after.uid === before.uid &&
      after.birth === before.birth
    );
  }
  private pids(): number[] {
    for (let capacity = 4096; capacity <= 1_048_576; capacity *= 2) {
      const b = Buffer.alloc(capacity * 4);
      const size = Number(this.list(1, 0, b, b.length));
      if (!Number.isSafeInteger(size) || size < 0 || size > b.length || size % 4)
        throw new Error("libproc enumeration failed");
      if (size === b.length) continue;
      const pids: number[] = [];
      for (let i = 0; i < size; i += 4) if (b.readInt32LE(i) > 1) pids.push(b.readInt32LE(i));
      return pids;
    }
    throw new Error("libproc enumeration did not converge");
  }
  signal(id: ActorIdentity, mode: "graceful" | "force"): void {
    const signal = (pid: number, sig: NodeJS.Signals) => {
      // Revalidate native policy + birth immediately before signalling; never
      // act on an old PPID, a process listing alone, or a user-supplied PID.
      if (this.owns(pid, id)) {
        try {
          process.kill(pid, sig);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
        }
      }
    };
    if (mode === "graceful") {
      for (const pid of this.pids()) signal(pid, "SIGTERM");
      return;
    }
    // Freeze before killing: no running parent may fork behind the scan.
    const stopped = new Set<number>();
    let stable = 0;
    for (let pass = 0; pass < 32 && stable < 2; pass++) {
      let added = false;
      for (const pid of this.pids())
        if (!stopped.has(pid) && this.owns(pid, id)) {
          signal(pid, "SIGSTOP");
          stopped.add(pid);
          added = true;
        }
      stable = added ? 0 : stable + 1;
    }
    for (const pid of stopped) signal(pid, "SIGKILL");
    if (stable < 2) throw new Error("actor drain did not converge");
  }
}
