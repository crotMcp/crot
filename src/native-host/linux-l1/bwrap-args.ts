/**
 * The crot-bwrap command line of a sandbox (ARCHITECTURE.md §27 AD-20
 * points 5-10). Pure: the caller supplies the host facts in a SandboxLayout.
 *
 * Mount order (later mounts are on top of earlier ones):
 *  1. the host file system, read-only;
 *  2. a minimal /dev plus the device classes of point 6, the sandbox's own /proc,
 *     a private /dev/shm;
 *  3. the private temp on /tmp and /var/tmp;
 *  4. the private home layer: an overlay with the real home as the read-only
 *     lower layer, and one per file system mounted below the home;
 *  5. the workspace, read-write;
 *  6. a private $XDG_RUNTIME_DIR, then the agent sockets bound back at their paths;
 *  7. the CROT-protected paths and the other hidden entries of point 6, replaced
 *     by empty, inaccessible entries;
 *  8. the Docker endpoint socket at its own path.
 *
 * bubblewrap options relied on (pinned release, see components.ts):
 * --unshare-user --unshare-pid --unshare-ipc --unshare-uts --unshare-cgroup-try
 * --unshare-net --disable-userns --die-with-parent --new-session --as-pid-1
 * --clearenv --setenv --ro-bind --bind --bind-try --dev --dev-bind-try --proc --tmpfs
 * --perms --overlay-src --overlay --chdir. bubblewrap always sets
 * no-new-privileges.
 */
import path from "node:path";

export interface HiddenEntry {
  readonly path: string;
  readonly kind: "dir" | "file";
}

export interface SandboxLayout {
  readonly bwrap: string;
  readonly init: string;
  readonly network: "on" | "off";
  readonly workspace: string;
  readonly home: string;
  readonly homeLayer: { readonly upper: string; readonly work: string };
  /** File systems mounted below the home, each layered like the home. */
  readonly homeSubmounts: readonly { readonly path: string; readonly upper: string; readonly work: string }[];
  readonly temp: { readonly tmp: string; readonly varTmp: string };
  /** $XDG_RUNTIME_DIR, replaced by a private directory. */
  readonly runtimeDir?: string;
  /** Sockets bound back at their own paths after the private runtime directory and temp (SSH and GnuPG agents). */
  readonly agentSockets: readonly string[];
  /** Existing device nodes of the classes of point 6 beyond the minimal /dev. */
  readonly devices: readonly string[];
  /** Existing entries replaced by empty, inaccessible ones. */
  readonly hidden: readonly HiddenEntry[];
  readonly emptyFile: string;
  readonly emptyDir: string;
  /** The Docker endpoint socket, bound at its own path. */
  readonly dockerSocket?: string;
}

/** Whether `p` is `ancestor` or inside it (absolute, normalized POSIX paths). */
export function isWithin(ancestor: string, p: string): boolean {
  if (ancestor === "/") return true;
  return p === ancestor || p.startsWith(ancestor.endsWith("/") ? ancestor : `${ancestor}/`);
}

/** Paths that the sandbox shows from somewhere else than the host's view, so a hidden entry below them needs no mount. */
function replacedRoots(layout: SandboxLayout): string[] {
  return ["/tmp", "/var/tmp", "/proc", "/dev", ...(layout.runtimeDir ? [layout.runtimeDir] : [])];
}

export function bwrapArgs(layout: SandboxLayout): string[] {
  const a: string[] = [];
  a.push("--unshare-user", "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--unshare-cgroup-try");
  if (layout.network === "off") a.push("--unshare-net");
  a.push("--disable-userns", "--die-with-parent", "--new-session", "--as-pid-1");
  a.push("--clearenv", "--setenv", "PATH", "/usr/sbin:/usr/bin:/sbin:/bin");

  // 1-2. Host file system read-only; own /dev, /proc and /dev/shm.
  a.push("--ro-bind", "/", "/");
  a.push("--dev", "/dev");
  for (const device of layout.devices) a.push("--dev-bind-try", device, device);
  a.push("--proc", "/proc");
  a.push("--tmpfs", "/dev/shm");

  // 3. Private temp.
  a.push("--bind", layout.temp.tmp, "/tmp");
  a.push("--bind", layout.temp.varTmp, "/var/tmp");

  // 4. Private home layer.
  a.push("--overlay-src", layout.home, "--overlay", layout.homeLayer.upper, layout.homeLayer.work, layout.home);
  for (const sub of layout.homeSubmounts) {
    a.push("--overlay-src", sub.path, "--overlay", sub.upper, sub.work, sub.path);
  }

  // 5. Workspace.
  a.push("--bind", layout.workspace, layout.workspace);

  // 6. Private runtime directory, then the agent sockets at their paths.
  if (layout.runtimeDir) a.push("--perms", "0700", "--tmpfs", layout.runtimeDir);
  for (const socket of layout.agentSockets) a.push("--bind-try", socket, socket);

  // 7. Hidden entries (CROT-protected paths, secret stores, daemon sockets, TLS keys).
  const replaced = replacedRoots(layout);
  const shownAgain = [layout.workspace, layout.home, ...layout.homeSubmounts.map((sub) => sub.path)];
  const seen = new Set<string>();
  for (const entry of layout.hidden) {
    if (seen.has(entry.path)) continue;
    seen.add(entry.path);
    // Not visible anyway: below a replaced root (and not the root itself), unless a later mount shows
    // the host's view there again (a workspace or home below /tmp).
    if (
      replaced.some((root) => isWithin(root, entry.path) && entry.path !== root) &&
      !shownAgain.some((shown) => isWithin(shown, entry.path))
    )
      continue;
    if (
      layout.hidden.some(
        (other) => other.kind === "dir" && other.path !== entry.path && isWithin(other.path, entry.path),
      )
    )
      continue;
    a.push("--ro-bind", entry.kind === "dir" ? layout.emptyDir : layout.emptyFile, entry.path);
  }

  // 8. The Docker endpoint (a pathname socket in the L1 private storage).
  if (layout.dockerSocket) a.push("--bind", layout.dockerSocket, layout.dockerSocket);

  a.push("--chdir", layout.workspace);
  return a;
}

/** The full command: crot-bwrap <options> -- crot-l1-init. */
export function sandboxCommand(layout: SandboxLayout): { file: string; args: string[] } {
  return { file: layout.bwrap, args: [...bwrapArgs(layout), "--", layout.init] };
}

/** Normalize an absolute POSIX path (no trailing slash). */
export function normalizeAbsolute(p: string): string {
  return path.posix.resolve(p);
}
