/**
 * L1 components and their verification (ARCHITECTURE.md §27 AD-20 point 3).
 *
 * The components of L1 version <v> live in /usr/lib/crot/l1/<v>/, owned by
 * root and not writable by the user:
 *
 * | File            | What                                                         |
 * | --------------- | ------------------------------------------------------------ |
 * | crot-bwrap      | bubblewrap built by CROT from the pinned upstream release    |
 * | crot-l1-init    | PID 1 of every sandbox (l1/native/crot-l1-init.c)            |
 * | crot-l1.apparmor| the policy source for this release's ABI (loaded by root)    |
 * | manifest.json   | <v>, the bubblewrap release and source digest, file digests  |
 *
 * The service only verifies them; it never installs, loads or replaces
 * anything (AD-20 point 4). A component of another <v>, a digest mismatch, or
 * a component not owned by root or writable by the user is a mismatch and is
 * never used.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

/** The L1 component version this build of CROT requires (<v>). */
export const L1_VERSION = "1";
/** Root of the installed L1 components. */
export const L1_ROOT = "/usr/lib/crot/l1";
/** The upstream bubblewrap release crot-bwrap is built from, and the SHA-256 of its release tarball. */
export const BUBBLEWRAP_RELEASE = {
  version: "0.11.0",
  source: "https://github.com/containers/bubblewrap/releases/download/v0.11.0/bubblewrap-0.11.0.tar.xz",
  sha256: "988fd6b232dafa04b8b8198723efeaccdb3c6aa9c1c7936219d5791a8b7a8646",
} as const;

export const COMPONENT_FILES = ["crot-bwrap", "crot-l1-init", "crot-l1.apparmor"] as const;
export type ComponentFile = (typeof COMPONENT_FILES)[number];

/** The AppArmor profile names of <v> (AD-20 point 3). */
export function profileNames(version: string = L1_VERSION): {
  readonly bwrap: string;
  readonly payload: string;
  readonly container: string;
  /** Label of every confined process: the stack of the bwrap and payload profiles. */
  readonly label: string;
} {
  const bwrap = `crot-l1-${version}`;
  const payload = `crot-l1-payload-${version}`;
  return { bwrap, payload, container: `crot-l1-container-${version}`, label: `${bwrap}//&${payload}` };
}

export interface L1Components {
  readonly version: string;
  readonly directory: string;
  readonly bwrap: string;
  readonly init: string;
  readonly policy: string;
}

export interface L1Manifest {
  readonly version: string;
  readonly bubblewrap: { readonly version: string; readonly sha256: string };
  /** SHA-256 (hex) of each component file. */
  readonly files: Readonly<Record<ComponentFile, string>>;
}

export type ComponentCheck =
  | { readonly ok: true; readonly components: L1Components }
  | { readonly ok: false; readonly reason: "components_missing" | "components_mismatch"; readonly detail: string };

/** File-system access used by the verification (test seam). */
export interface ComponentFs {
  lstat(p: string): Promise<{
    uid: number;
    mode: number;
    isFile(): boolean;
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
  } | null>;
  readFile(p: string): Promise<string>;
  sha256(p: string): Promise<string>;
}

export const nodeComponentFs: ComponentFs = {
  lstat: async (p) => {
    try {
      return await lstat(p);
    } catch {
      return null;
    }
  },
  readFile: (p) => readFile(p, "utf8"),
  sha256: (p) =>
    new Promise((resolve, reject) => {
      const hash = createHash("sha256");
      createReadStream(p)
        .on("data", (chunk) => hash.update(chunk))
        .on("error", reject)
        .on("end", () => resolve(hash.digest("hex")));
    }),
};

const HEX64 = /^[0-9a-f]{64}$/;

export function parseManifest(text: string): L1Manifest | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const m = value as Record<string, unknown>;
  const files = m.files as Record<string, unknown> | undefined;
  const bubblewrap = m.bubblewrap as Record<string, unknown> | undefined;
  if (typeof m.version !== "string" || !files || typeof files !== "object" || !bubblewrap) return null;
  if (typeof bubblewrap.version !== "string" || typeof bubblewrap.sha256 !== "string") return null;
  const digests: Partial<Record<ComponentFile, string>> = {};
  for (const name of COMPONENT_FILES) {
    const digest = files[name];
    if (typeof digest !== "string" || !HEX64.test(digest)) return null;
    digests[name] = digest;
  }
  return {
    version: m.version,
    bubblewrap: { version: bubblewrap.version, sha256: bubblewrap.sha256 },
    files: digests as Record<ComponentFile, string>,
  };
}

/** Owned by root, not a symbolic link, not writable by group or others. */
function rootOwned(st: { uid: number; mode: number; isSymbolicLink(): boolean }): boolean {
  return !st.isSymbolicLink() && st.uid === 0 && (st.mode & 0o022) === 0;
}

/**
 * Verify the installed components of `version` (AD-20 point 12:
 * components_missing, components_mismatch). Checks every directory from the
 * root down, the manifest version, ownership and mode, and each digest.
 */
export async function verifyComponents(
  version: string = L1_VERSION,
  root: string = L1_ROOT,
  fs: ComponentFs = nodeComponentFs,
): Promise<ComponentCheck> {
  const directory = path.posix.join(root, version);
  const dirStat = await fs.lstat(directory);
  if (!dirStat)
    return { ok: false, reason: "components_missing", detail: `L1 components ${version} are not installed` };
  if (!dirStat.isDirectory() && !dirStat.isSymbolicLink())
    return { ok: false, reason: "components_missing", detail: `L1 components ${version} are not installed` };
  // Every directory on the way must be root-owned and not writable by the user.
  for (let dir = directory; ; dir = path.posix.dirname(dir)) {
    const st = await fs.lstat(dir);
    if (!st || !st.isDirectory() || !rootOwned(st))
      return {
        ok: false,
        reason: "components_mismatch",
        detail: "an L1 component directory is not owned by root or is writable",
      };
    if (dir === "/" || dir === path.posix.dirname(dir)) break;
  }
  const manifestPath = path.posix.join(directory, "manifest.json");
  const manifestStat = await fs.lstat(manifestPath);
  if (!manifestStat) return { ok: false, reason: "components_missing", detail: "the L1 manifest is missing" };
  if (!manifestStat.isFile() || !rootOwned(manifestStat))
    return { ok: false, reason: "components_mismatch", detail: "the L1 manifest is not owned by root or is writable" };
  const manifest = parseManifest(await fs.readFile(manifestPath).catch(() => ""));
  if (!manifest) return { ok: false, reason: "components_mismatch", detail: "the L1 manifest is invalid" };
  if (manifest.version !== version)
    return {
      ok: false,
      reason: "components_mismatch",
      detail: `the L1 manifest is for version ${manifest.version}, CROT requires ${version}`,
    };
  for (const name of COMPONENT_FILES) {
    const file = path.posix.join(directory, name);
    const st = await fs.lstat(file);
    if (!st) return { ok: false, reason: "components_missing", detail: `L1 component ${name} is missing` };
    if (!st.isFile() || !rootOwned(st))
      return {
        ok: false,
        reason: "components_mismatch",
        detail: `L1 component ${name} is not owned by root or is writable`,
      };
    const digest = await fs.sha256(file).catch(() => "");
    if (digest !== manifest.files[name])
      return {
        ok: false,
        reason: "components_mismatch",
        detail: `L1 component ${name} does not match the manifest digest`,
      };
  }
  return {
    ok: true,
    components: {
      version,
      directory,
      bwrap: path.posix.join(directory, "crot-bwrap"),
      init: path.posix.join(directory, "crot-l1-init"),
      policy: path.posix.join(directory, "crot-l1.apparmor"),
    },
  };
}
