/**
 * Host-network notes (ARCHITECTURE.md §27 AD-20 point 14): best-effort
 * detection, from local non-secret facts, of host-local services a confined
 * command could use over the shared host network. Category and port only;
 * never addresses of other hosts, credentials or file contents. The absence
 * of a note is no guarantee, and no note ever changes availability.
 */
import type { HostExists, HostReader } from "./host.js";

/** Well-known ports of services that accept the user's authority without a CROT credential. */
export const NOTED_PORTS: ReadonlyMap<number, string> = new Map([
  [22, "SSH server"],
  [2375, "Docker daemon without TLS"],
  [9229, "Node.js inspector"],
  [9222, "Chrome DevTools"],
  [5678, "Python debugger"],
  [8888, "Jupyter notebook"],
  [5005, "Java debugger"],
]);

/** Listening TCP ports on loopback or wildcard addresses, from /proc/net/tcp{,6}. */
export function listeningLocalPorts(procNetTcp: string): number[] {
  const ports = new Set<number>();
  for (const line of procNetTcp.split("\n").slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 4 || f[3] !== "0A") continue; // LISTEN
    const [addr, portHex] = (f[1] ?? "").split(":");
    if (!addr || !portHex) continue;
    const local =
      /^0+$/.test(addr) || // 0.0.0.0 / ::
      /7F$/i.test(addr) || // 127.x.x.x (little-endian IPv4)
      addr === "00000000000000000000000001000000"; // ::1
    if (local) ports.add(parseInt(portHex, 16));
  }
  return [...ports].sort((a, b) => a - b);
}

export interface NoteInputs {
  readonly docker?: {
    readonly transport: string;
    readonly local: boolean;
    readonly port?: number;
    readonly apparmor?: boolean;
  };
  readonly runtimeDir?: string;
}

export async function hostNetworkNotes(inputs: NoteInputs, read: HostReader, exists: HostExists): Promise<string[]> {
  const notes: string[] = [];
  const d = inputs.docker;
  if (d && d.transport === "tcp" && d.local)
    notes.push(`Docker daemon over TCP without TLS on local port ${d.port ?? 2375}`);
  if (d && d.local && d.apparmor === false)
    notes.push("the local Docker daemon does not report AppArmor; containers run without crot-l1-container");
  const tcp = `${(await read("/proc/net/tcp")) ?? ""}\n${(await read("/proc/net/tcp6")) ?? ""}`;
  for (const port of listeningLocalPorts(tcp)) {
    const what = NOTED_PORTS.get(port);
    if (what && !(port === 2375 && d?.transport === "tcp")) notes.push(`${what} listening on local port ${port}`);
  }
  if (inputs.runtimeDir && (await exists(`${inputs.runtimeDir}/podman/podman.sock`)))
    notes.push("a rootless Podman socket exists (hidden from the sandbox)");
  return notes;
}
