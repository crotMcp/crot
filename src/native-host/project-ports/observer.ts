/** Read-only native observations, never an authorizer or a port-availability probe. */
import { realpath } from "node:fs/promises";
import path from "node:path";
import { CrotError } from "../../core/errors.js";
import type { ProjectPort, ProjectPorts } from "../../core/platform/types.js";

export interface ProcessObservation {
  /** Kernel creation identity, not the executable/command line. */
  identity: string;
  cwd: string;
}
export interface NativePortApi {
  listeners(signal: AbortSignal): Promise<ProjectPort[]>;
  /** null means positively identified as another user or no longer alive. Errors mean unknown. */
  process(pid: number, signal: AbortSignal): Promise<ProcessObservation | null>;
}
const MAX_ROWS = 512,
  MAX_PIDS = 128;
const inside = (root: string, target: string) => {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative));
};
const key = (p: ProjectPort) => `${p.pid}:${p.address}:${p.port}`;
export async function observeNativePorts(
  root: string,
  api: NativePortApi,
  parent?: AbortSignal,
): Promise<ProjectPorts> {
  const result: ProjectPorts = { status: "observed", scope: "same-user-workspace-cwd", listeners: [], notes: [] };
  const abort = new AbortController(),
    deadline = Date.now() + 3000;
  const stop = () => abort.abort();
  parent?.addEventListener("abort", stop, { once: true });
  const timer = setTimeout(stop, 3000);
  const check = () => {
    if (parent?.aborted) throw new CrotError("OPERATION_FAILED", "Project inspection cancelled");
    if (abort.signal.aborted || Date.now() > deadline)
      throw new CrotError("TIMEOUT", "Project observation time limit exceeded");
  };
  const partial = () => {
    result.status = "partial";
  };
  try {
    check();
    const initial = await api.listeners(abort.signal);
    check();
    const pids = [...new Set(initial.map((p) => p.pid))];
    if (pids.length > MAX_PIDS) partial();
    const candidates = new Map<number, ProcessObservation>();
    for (const pid of pids.slice(0, MAX_PIDS)) {
      check();
      try {
        const seen = await api.process(pid, abort.signal);
        check();
        if (!seen) continue;
        const cwd = await realpath(seen.cwd);
        check();
        if (inside(root, cwd)) candidates.set(pid, { ...seen, cwd });
      } catch {
        check();
        partial();
      }
    }
    // Intersect with a fresh native table; a closed listener is not published from the first snapshot.
    const latest = new Set((await api.listeners(abort.signal)).map(key));
    check();
    for (const [pid, before] of candidates) {
      check();
      try {
        const after = await api.process(pid, abort.signal);
        check();
        if (!after || after.identity !== before.identity || (await realpath(after.cwd)) !== before.cwd) continue;
        check();
        result.listeners.push(...initial.filter((p) => p.pid === pid && latest.has(key(p))));
      } catch {
        check();
        partial();
      }
    }
  } catch (error) {
    if (parent?.aborted) throw new CrotError("OPERATION_FAILED", "Project inspection cancelled");
    if (abort.signal.aborted || (error instanceof CrotError && error.code === "TIMEOUT")) partial();
    else {
      result.status = "unavailable";
      result.listeners = [];
    }
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener("abort", stop);
  }
  result.listeners = [...new Map(result.listeners.map((p) => [key(p), p])).values()].sort(
    (a, b) => a.port - b.port || a.pid - b.pid,
  );
  if (result.listeners.length > MAX_ROWS) {
    result.listeners.length = MAX_ROWS;
    partial();
  }
  result.notes.push(
    "Point-in-time TCP listeners of same-user processes whose canonical current directory belongs to the workspace; creation identity and listener table rechecked. Not a network permission or a scan of remote hosts.",
  );
  if (result.status !== "observed")
    result.notes.push("Observation is incomplete; missing listeners are not proof that a port is free.");
  return result;
}
