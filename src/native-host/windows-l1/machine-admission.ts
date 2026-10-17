/** One machine-wide ACL transaction owner. A different crashed state store is
 * never adopted: its durable WAL must be recovered by its original service. */
import { createHash } from "node:crypto";
import { lstat, open, readFile } from "node:fs/promises";
import path from "node:path";
import type { PrivateFileProtection } from "../../core/platform/types.js";
import { CrotError } from "../../core/errors.js";
import { loadWindowsLeaseLock } from "./lease-lock.js";
const fail = () =>
  new CrotError(
    "CONFINEMENT_FAILED",
    "Machine-wide Windows ACL lease ownership is unavailable; no overlapping admission is permitted.",
  );
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const held = new Set<string>();
export interface MachineAdmission {
  close(clean: boolean): Promise<void>;
}
interface AdmissionOptions {
  directory: string;
  ownerSid: string;
  privateFiles: PrivateFileProtection;
}
/** Dependency binding for native ownership and portable crash tests. */
export function bindMachineAdmission(
  root: string,
  acquire: Awaited<ReturnType<typeof loadWindowsLeaseLock>>,
  timeoutMs = 60_000,
) {
  return async (options: AdmissionOptions): Promise<MachineAdmission> => {
    const lockPath = path.join(root, "owner.lock"),
      recordPath = path.join(root, "owner.jsonl");
    const check = async (file: string, directory: boolean) => {
      const stat = await lstat(file);
      if (
        stat.isSymbolicLink() ||
        (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) ||
        !(await options.privateFiles.inspect(file)).ownerOnly
      )
        throw fail();
    };
    await options.privateFiles.ensureDirectory(root);
    await check(root, true);
    try {
      const h = await open(lockPath, "wx+", options.privateFiles.fileMode);
      try {
        await options.privateFiles.protectFile?.(lockPath);
        await h.sync();
      } finally {
        await h.close();
      }
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
    }
    await check(lockPath, false);
    const deadline = Date.now() + timeoutMs;
    while (true) {
      let lock: Awaited<ReturnType<typeof acquire>> | undefined;
      try {
        if (held.has(root)) throw fail();
        held.add(root);
        try {
          lock = await acquire(lockPath);
        } catch (cause) {
          held.delete(root);
          throw cause;
        }
        let previous = "0".repeat(64),
          last: { directory: string; ownerSid: string; active: boolean } | undefined;
        const existing = await lstat(recordPath).catch((cause: NodeJS.ErrnoException) => {
          if (cause.code === "ENOENT") return undefined;
          throw cause;
        });
        if (existing) {
          await check(recordPath, false);
          if (existing.size > 4 * 1024 * 1024) throw fail();
          const text = await readFile(recordPath, "utf8");
          if (!text.endsWith("\n")) throw fail();
          for (const line of text.slice(0, -1).split("\n")) {
            const entry = JSON.parse(line) as { previous: string; payload: string; hash: string };
            if (entry.previous !== previous || digest(previous + entry.payload) !== entry.hash) throw fail();
            const value = JSON.parse(entry.payload) as {
              version: number;
              directory: string;
              ownerSid: string;
              active: boolean;
            };
            if (
              value.version !== 1 ||
              typeof value.directory !== "string" ||
              typeof value.ownerSid !== "string" ||
              typeof value.active !== "boolean"
            )
              throw fail();
            last = value;
            previous = entry.hash;
          }
        }
        const directory = path.win32.resolve(options.directory).toLowerCase();
        if (last?.active && (last.directory !== directory || last.ownerSid !== options.ownerSid)) throw fail();
        const append = async (active: boolean) => {
          const payload = JSON.stringify({ version: 1, directory, ownerSid: options.ownerSid, active });
          const hash = digest(previous + payload);
          const h = await open(recordPath, existing ? "a" : "a+", options.privateFiles.fileMode);
          try {
            await options.privateFiles.protectFile?.(recordPath);
            await check(recordPath, false);
            await h.writeFile(JSON.stringify({ previous, payload, hash }) + "\n");
            await h.sync();
            previous = hash;
          } finally {
            await h.close();
          }
        };
        await append(true); // durable barrier before ANY ACL mutation/recovery
        const owned = lock;
        lock = undefined;
        let closed = false;
        return {
          close: async (clean) => {
            if (closed) return;
            if (clean) await append(false); // only after every WAL/profile is closed
            owned.close();
            held.delete(root);
            closed = true;
          },
        };
      } catch (cause) {
        if (lock) {
          lock.close();
          held.delete(root);
        }
        if (Date.now() >= deadline) throw cause;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  };
}
export async function openMachineAdmission(options: AdmissionOptions): Promise<MachineAdmission> {
  const root = path.win32.join(
    process.env.ProgramData ?? path.win32.join(process.env.SystemRoot ?? "C:\\Windows", "..", "ProgramData"),
    "CROT-Windows-L1-Admission",
  );
  return bindMachineAdmission(root, await loadWindowsLeaseLock())(options);
}
