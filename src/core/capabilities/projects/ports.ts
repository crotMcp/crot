/** Read-only OS observation. Caller must first authorize process.project_ports in ExecutionGuard. */
import { open, readdir, readlink, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { CrotError } from "../../errors.js";

export interface ProjectPort {
  pid: number;
  address: string;
  port: number;
}
export interface ProjectPorts {
  status: "observed" | "partial" | "unavailable";
  scope: "same-user-workspace-cwd";
  listeners: ProjectPort[];
  notes: string[];
}
const MAX_BYTES = 1024 * 1024;
const MAX_PIDS = 8192;
const MAX_PROJECT_PIDS = 128;
const MAX_FDS = 32768;
const MAX_LISTENERS = 512;
const inside = (root: string, target: string) => {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative));
};
async function bounded(file: string): Promise<string> {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const next = await handle.read(buffer, bytesRead, buffer.length - bytesRead, null);
      if (!next.bytesRead) break;
      bytesRead += next.bytesRead;
    }
    if (bytesRead > MAX_BYTES) throw new CrotError("LIMIT_EXCEEDED", "Process observation exceeded its limit");
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}
/** Linux /proc addresses are native little-endian words, including each IPv6 DWORD. */
export function procListeners(text: string): Map<string, { address: string; port: number }> {
  const found = new Map<string, { address: string; port: number }>();
  for (const line of text.split("\n").slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields[3] !== "0A" || !/^\d+$/.test(fields[9] ?? "")) continue;
    const match = /^([A-Fa-f0-9]{8}|[A-Fa-f0-9]{32}):([A-Fa-f0-9]{4})$/.exec(fields[1] ?? "");
    if (!match) continue;
    const hex = match[1]!;
    const words = hex.match(/.{8}/g)!.map((word) => Buffer.from(word.match(/../g)!.reverse().join(""), "hex"));
    const bytes = Buffer.concat(words);
    const address =
      bytes.length === 4
        ? [...bytes].join(".")
        : Array.from({ length: 8 }, (_, i) => bytes.readUInt16BE(i * 2).toString(16)).join(":");
    const port = Number.parseInt(match[2]!, 16);
    if (port > 0) found.set(fields[9]!, { address, port });
  }
  return found;
}
const vanished = (error: unknown) => ["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "");

export async function observeProjectPorts(root: string, signal?: AbortSignal): Promise<ProjectPorts> {
  const result: ProjectPorts = { status: "observed", scope: "same-user-workspace-cwd", listeners: [], notes: [] };
  if (process.platform !== "linux" || !process.getuid) {
    return {
      ...result,
      status: "unavailable",
      notes: ["Project process ownership observation is unavailable on this OS."],
    };
  }
  const deadline = Date.now() + 3000;
  const check = () => {
    if (signal?.aborted) throw new CrotError("OPERATION_FAILED", "Project inspection cancelled");
    if (Date.now() > deadline) throw new CrotError("TIMEOUT", "Project observation time limit exceeded");
  };
  const partial = () => {
    result.status = "partial";
  };
  let projectPids = 0,
    fds = 0;
  try {
    const pids = (await readdir("/proc")).filter((p) => /^\d+$/.test(p));
    if (pids.length > MAX_PIDS) partial();
    const sockets = new Map([
      ...procListeners(await bounded("/proc/net/tcp")),
      ...procListeners(await bounded("/proc/net/tcp6")),
    ]);
    for (const pid of pids.slice(0, MAX_PIDS)) {
      check();
      try {
        const base = `/proc/${pid}`;
        if ((await stat(base)).uid !== process.getuid()) continue;
        const cwd = await realpath(`${base}/cwd`);
        if (!inside(root, cwd)) continue;
        if (++projectPids > MAX_PROJECT_PIDS) {
          partial();
          break;
        }
        // Start time and cwd are rechecked before publishing: do not attribute a reused PID.
        const identity = await bounded(`${base}/stat`);
        const candidates: ProjectPort[] = [];
        const entries = await readdir(`${base}/fd`);
        for (const fd of entries) {
          check();
          if (++fds > MAX_FDS) {
            partial();
            break;
          }
          try {
            const inode = /^socket:\[(\d+)\]$/.exec(await readlink(`${base}/fd/${fd}`))?.[1];
            const listener = inode && sockets.get(inode);
            if (listener) candidates.push({ pid: Number(pid), ...listener });
          } catch (error) {
            if (!vanished(error)) partial();
          }
        }
        const current = await bounded(`${base}/stat`);
        const start = (value: string) => value.slice(value.lastIndexOf(")") + 2).split(/\s+/)[19];
        if (start(identity) === start(current) && (await realpath(`${base}/cwd`)) === cwd)
          result.listeners.push(...candidates);
        if (fds > MAX_FDS) break;
      } catch (error) {
        if (signal?.aborted) throw error;
        if (!vanished(error)) partial();
      }
    }
  } catch (error) {
    if (signal?.aborted) throw new CrotError("OPERATION_FAILED", "Project inspection cancelled");
    if (error instanceof CrotError && error.code === "TIMEOUT") partial();
    else result.status = "unavailable";
  }
  result.listeners = [...new Map(result.listeners.map((p) => [`${p.pid}:${p.address}:${p.port}`, p])).values()].sort(
    (a, b) => a.port - b.port || a.pid - b.pid,
  );
  if (result.listeners.length > MAX_LISTENERS) {
    result.listeners = result.listeners.slice(0, MAX_LISTENERS);
    partial();
  }
  result.notes.push(
    "Point-in-time TCP listeners of same-user processes whose current directory belongs to the workspace; in the service network namespace; not a network permission or a scan of remote hosts.",
  );
  if (result.status !== "observed")
    result.notes.push("Observation is incomplete; missing listeners are not proof that a port is free.");
  return result;
}
