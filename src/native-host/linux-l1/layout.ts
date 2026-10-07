/**
 * Host discovery for the sandbox layout (ARCHITECTURE.md §27 AD-20 points 6
 * and 7): which entries are hidden, which agent sockets and device nodes are
 * bound in, and which file systems below the home are layered.
 */
import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isWithin, type HiddenEntry } from "./bwrap-args.js";

/** Default system locations of container daemon sockets (AD-20 point 6). */
export const DAEMON_SOCKETS = [
  "/run/docker.sock",
  "/var/run/docker.sock",
  "/run/containerd/containerd.sock",
  "/run/containerd/containerd.sock.ttrpc",
  "/run/podman/podman.sock",
  "/run/crio/crio.sock",
  "/run/buildkit/buildkitd.sock",
] as const;

/** Secret Service backends that can hold CROT secrets, relative to the home (AD-20 point 6). */
export const SECRET_STORE_DIRS = [".local/share/keyrings", ".local/share/kwalletd"] as const;

/** Device classes beyond the minimal /dev (AD-20 point 6): GPU compute, FUSE and TUN. */
export async function allowedDevices(listDir: (dir: string) => Promise<string[]> = safeReaddir): Promise<string[]> {
  const out: string[] = [];
  for (const name of await listDir("/dev")) {
    if (/^nvidia(\d+|ctl|-uvm|-uvm-tools|-modeset)$/.test(name) || name === "kfd" || name === "fuse")
      out.push(`/dev/${name}`);
  }
  for (const name of await listDir("/dev/dri")) if (/^renderD\d+$/.test(name)) out.push(`/dev/dri/${name}`);
  for (const name of await listDir("/dev/net")) if (name === "tun") out.push("/dev/net/tun");
  return out.sort();
}

async function safeReaddir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

/** Unescape a mountinfo path field (\040 for space and so on). */
function unescapeMountPath(field: string): string {
  return field.replace(/\\([0-7]{3})/g, (_, oct: string) => String.fromCharCode(parseInt(oct, 8)));
}

/** Mount points strictly below `home`, from /proc/self/mountinfo, parents first. */
export function homeSubmounts(mountinfo: string, home: string): string[] {
  const points = new Set<string>();
  for (const line of mountinfo.split("\n")) {
    const fields = line.split(" ");
    const mountPoint = fields[4];
    if (!mountPoint) continue;
    const p = unescapeMountPath(mountPoint);
    if (p !== home && isWithin(home, p)) points.add(p);
  }
  return [...points].sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
}

/** The Unix socket path of a Docker host URL (unix:///path), or undefined. */
export function unixSocketOf(host: string | undefined): string | undefined {
  if (!host?.startsWith("unix://")) return undefined;
  const p = host.slice("unix://".length);
  return path.posix.isAbsolute(p) ? p : undefined;
}

/**
 * The Docker host of the current Docker context (DOCKER_CONTEXT, else
 * currentContext of config.json), read from the CLI's context store. No
 * connection is made.
 */
export async function currentContextHost(
  env: Readonly<Record<string, string | undefined>>,
  home: string,
): Promise<string | undefined> {
  const configDir = env.DOCKER_CONFIG ?? path.join(home, ".docker");
  let name = env.DOCKER_CONTEXT;
  if (!name) {
    try {
      const config = JSON.parse(await readFile(path.join(configDir, "config.json"), "utf8")) as {
        currentContext?: unknown;
      };
      if (typeof config.currentContext === "string") name = config.currentContext;
    } catch {
      return undefined;
    }
  }
  if (!name || name === "default") return undefined;
  const id = createHash("sha256").update(name).digest("hex");
  try {
    const meta = JSON.parse(await readFile(path.join(configDir, "contexts", "meta", id, "meta.json"), "utf8")) as {
      Endpoints?: { docker?: { Host?: unknown } };
    };
    const host = meta.Endpoints?.docker?.Host;
    return typeof host === "string" ? host : undefined;
  } catch {
    return undefined;
  }
}

/** lstat-based kind of an existing entry, following nothing; undefined when absent. */
async function kindOf(p: string): Promise<"dir" | "file" | undefined> {
  try {
    const st = await lstat(p);
    return st.isDirectory() ? "dir" : "file";
  } catch {
    return undefined;
  }
}

/**
 * Hidden entries for the given paths: every existing path, and its real path
 * when it is reached through a symbolic link, so neither name shows the
 * original. Paths that do not exist are skipped.
 */
export async function hiddenEntries(paths: readonly string[]): Promise<HiddenEntry[]> {
  const out = new Map<string, HiddenEntry>();
  for (const raw of paths) {
    const p = path.posix.resolve(raw);
    let real: string | undefined;
    try {
      real = await realpath(p);
    } catch {
      real = undefined;
    }
    for (const candidate of [real, p]) {
      if (!candidate) continue;
      const st = await lstat(candidate).catch(() => undefined);
      // A symbolic link itself cannot be a mount point; its target is covered by the real path.
      if (!st || st.isSymbolicLink()) continue;
      out.set(candidate, { path: candidate, kind: st.isDirectory() ? "dir" : "file" });
    }
  }
  return [...out.values()];
}

export interface DockerExposure {
  /** Daemon sockets and TLS key material hidden from the sandbox (AD-20 point 6). */
  readonly hidden: readonly string[];
}

/** Daemon sockets and Docker TLS keys of this user's Docker configuration (AD-20 point 6). */
export async function dockerHiddenPaths(
  env: Readonly<Record<string, string | undefined>>,
  home: string,
): Promise<string[]> {
  const configDir = env.DOCKER_CONFIG ?? path.join(home, ".docker");
  const out: string[] = [...DAEMON_SOCKETS];
  const fromEnv = unixSocketOf(env.DOCKER_HOST);
  if (fromEnv) out.push(fromEnv);
  const fromContext = unixSocketOf(await currentContextHost(env, home));
  if (fromContext) out.push(fromContext);
  if (env.DOCKER_CERT_PATH) out.push(env.DOCKER_CERT_PATH);
  out.push(
    path.join(configDir, "key.pem"),
    path.join(configDir, "contexts", "tls"),
    path.join(configDir, "machine", "certs"),
  );
  return out;
}

/** The SSH and GnuPG agent sockets bound back into the sandbox (AD-18 allowlist, AD-20 point 6). */
export async function agentSockets(env: Readonly<Record<string, string | undefined>>, home: string): Promise<string[]> {
  const candidates: string[] = [];
  if (env.SSH_AUTH_SOCK && path.posix.isAbsolute(env.SSH_AUTH_SOCK)) candidates.push(env.SSH_AUTH_SOCK);
  const gnupgDirs = [
    ...(env.XDG_RUNTIME_DIR ? [path.join(env.XDG_RUNTIME_DIR, "gnupg")] : []),
    ...(env.GNUPGHOME ? [env.GNUPGHOME] : [path.join(home, ".gnupg")]),
  ];
  for (const dir of gnupgDirs) {
    for (const name of ["S.gpg-agent", "S.gpg-agent.ssh", "S.gpg-agent.extra"]) candidates.push(path.join(dir, name));
  }
  const out: string[] = [];
  for (const c of candidates) {
    try {
      if ((await lstat(c)).isSocket()) out.push(c);
    } catch {
      // absent
    }
  }
  return out;
}

export function defaultHome(env: Readonly<Record<string, string | undefined>>): string {
  return path.posix.resolve(env.HOME && path.posix.isAbsolute(env.HOME) ? env.HOME : os.homedir());
}

export { kindOf };
