/**
 * Host discovery for the sandbox layout (ARCHITECTURE.md §27 AD-20 points 6
 * and 7): which entries are hidden, which agent sockets and device nodes are
 * bound in, and which file systems below the home are layered.
 */
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readdir, readFile, realpath, utimes } from "node:fs/promises";
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
 * Hidden entries for the given paths: the real path of every existing path,
 * with symbolic links resolved in the final component and in every parent.
 * Paths that do not exist are skipped.
 *
 * One mount at the real path hides every name of the entry: the sandbox shows
 * the host's file system, so another name (/var/run/docker.sock with
 * /var/run -> /run) resolves to the real path there. A mount at such a name
 * adds nothing, and bubblewrap cannot even create it when a parent is an
 * absolute symbolic link: it resolves the destination after pivot_root, where
 * the link's target does not exist ("Can't create file at
 * /var/run/docker.sock: No such file or directory" on Ubuntu), and the
 * sandbox fails to start.
 */
export async function hiddenEntries(paths: readonly string[]): Promise<HiddenEntry[]> {
  const out = new Map<string, HiddenEntry>();
  for (const raw of paths) {
    let real: string;
    try {
      real = await realpath(path.posix.resolve(raw));
    } catch {
      continue;
    }
    const st = await lstat(real).catch(() => undefined);
    if (!st) continue;
    out.set(real, { path: real, kind: st.isDirectory() ? "dir" : "file" });
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

/** A directory of the group layer: its path relative to the layered root, mode and times on the host. */
export interface GroupLayerDir {
  readonly relative: string;
  readonly mode: number;
  readonly atimeMs: number;
  readonly mtimeMs: number;
}

/** Upper bound of the directories one group-layer scan visits (breadth first: the shallow ones first). */
export const GROUP_LAYER_MAX_DIRS = 20_000;

/**
 * The directories below `root` that the private layer cannot copy up, and
 * their ancestors (AD-20 point 7): owned by the user (`uid`) but with a group
 * other than `gid`, the one group mapped into the sandbox's user namespace
 * (bubblewrap maps the caller's uid and gid only). overlayfs refuses to copy
 * up an inode whose owner or group has no mapping in the mounter's namespace
 * (EOVERFLOW, "Value too large for defined data type"), so nothing can be
 * created below such a directory in the sandbox although the user can write
 * there on the host: e.g. ~/.docker of group docker on the GitHub runners,
 * where `docker buildx` fails to create ~/.docker/buildx.
 *
 * Directories of other owners are neither listed nor entered: the user's
 * permissions there would change if they appeared as the user's own. Symbolic
 * links are not followed, other file systems (layered separately) and the
 * `skip` subtrees (the workspace, mounted above the layer) are not entered.
 * Unreadable directories are skipped. At most `maxDirs` directories are visited.
 */
export async function groupLayerDirs(
  root: string,
  options: { readonly uid: number; readonly gid: number; readonly skip?: readonly string[]; readonly maxDirs?: number },
): Promise<GroupLayerDir[]> {
  const maxDirs = options.maxDirs ?? GROUP_LAYER_MAX_DIRS;
  const skip = options.skip ?? [];
  let rootStat;
  try {
    rootStat = await lstat(root);
  } catch {
    return [];
  }
  if (!rootStat.isDirectory()) return [];
  const dev = rootStat.dev;
  const found = new Map<string, GroupLayerDir>();
  // Every queued directory is owned by the user; its ancestors are too (only those are entered).
  const queue: { abs: string; rel: string; chain: GroupLayerDir[] }[] = [{ abs: root, rel: "", chain: [] }];
  for (let next = 0; next < queue.length && next < maxDirs; next++) {
    const dir = queue[next]!;
    let names: string[];
    try {
      names = (await readdir(dir.abs, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      continue;
    }
    for (const name of names) {
      const abs = path.join(dir.abs, name);
      if (skip.some((s) => isWithin(s, abs))) continue;
      const st = await lstat(abs).catch(() => undefined);
      if (!st?.isDirectory() || st.dev !== dev || st.uid !== options.uid) continue;
      const rel = dir.rel ? `${dir.rel}/${name}` : name;
      const entry: GroupLayerDir = { relative: rel, mode: st.mode & 0o7777, atimeMs: st.atimeMs, mtimeMs: st.mtimeMs };
      const chain = [...dir.chain, entry];
      if (st.gid !== options.gid) for (const c of chain) found.set(c.relative, c);
      queue.push({ abs, rel, chain });
    }
  }
  return [...found.values()].sort((a, b) => a.relative.split("/").length - b.relative.split("/").length);
}

/**
 * Create the group layer at `dest` (a fresh, empty directory is created): an
 * empty directory owned by the user and the mapped group for every entry of
 * `dirs`, with the host's mode and times. It is mounted as a lower layer
 * directly above the real file system (bwrap-args.ts), so the private layer
 * copies these directories up from it (owner and group mapped) and the
 * directory contents still come from the real file system below: nothing is
 * copied, the user's later changes stay visible as for any lower layer, and
 * the upper layer's whiteouts and opaque directories still hide what they
 * hide. Returns false (and creates nothing) when `dirs` is empty.
 */
export async function createGroupLayer(dest: string, dirs: readonly GroupLayerDir[]): Promise<boolean> {
  if (dirs.length === 0) return false;
  await mkdir(dest, { recursive: true, mode: 0o700 });
  // Parents first (dirs is sorted by depth); modes and times last and deepest first, so that
  // neither a read-only mode nor a child's creation interferes.
  for (const d of dirs) await mkdir(path.join(dest, d.relative), { recursive: true, mode: 0o700 });
  for (const d of [...dirs].reverse()) {
    const p = path.join(dest, d.relative);
    await chmod(p, d.mode);
    await utimes(p, d.atimeMs / 1000, d.mtimeMs / 1000);
  }
  return true;
}
