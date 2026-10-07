/**
 * L1 private storage (ARCHITECTURE.md §27 AD-20 point 7): the upper layers of
 * the private home layer and the private temp, in
 * /var/tmp/crot-l1-<uid>/<state key>/, one subdirectory per state directory.
 *
 * The service creates and verifies it: owned by the user, mode 0700, no
 * symbolic link on the path, a local file system. It holds no CROT secret and
 * is not a CROT-protected path. It persists across service restarts so tool
 * caches stay warm; deleting it only discards confined writes to the home.
 */
import { createHash, randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, readdir, rm, statfs, writeFile } from "node:fs/promises";
import path from "node:path";

export const STORAGE_PARENT = "/var/tmp";

/** File systems that cannot hold the L1 private storage (remote, FUSE, overlay). */
const NON_LOCAL_FS = new Map<number, string>([
  [0x6969, "nfs"],
  [0xff534d42, "cifs"],
  [0xfe534d42, "smb2"],
  [0x517b, "smb"],
  [0x65735546, "fuse"],
  [0x794c7630, "overlay"],
  [0x01021997, "9p"],
  [0x73757245, "coda"],
  [0x5346414f, "afs"],
  [0x47504653, "gpfs"],
  [0x0bd00bd0, "lustre"],
  [0x00c36400, "ceph"],
]);

export class StorageError extends Error {}

/** The directories of one state directory's L1 storage. */
export interface L1Storage {
  readonly root: string;
  /** Upper and work directory of the home layer. */
  readonly homeUpper: string;
  readonly homeWork: string;
  /** Upper/work pairs of file systems mounted below the home, by index. */
  layer(index: number): { readonly upper: string; readonly work: string };
  /** An empty file and an empty directory, mode 0000: what CROT-protected paths are replaced with. */
  readonly emptyFile: string;
  readonly emptyDir: string;
  /** Sockets of the Docker endpoints of this state directory. */
  readonly run: string;
  /** A fresh private temp (/tmp, /var/tmp) for one sandbox. */
  newTemp(): Promise<{ readonly tmp: string; readonly varTmp: string; remove(): Promise<void> }>;
}

export function storageKey(stateDir: string): string {
  return createHash("sha256").update(path.resolve(stateDir)).digest("hex").slice(0, 16);
}

/** Verify one existing directory: not a link, a directory, owned by `uid`, exactly mode 0700. */
async function verifyPrivateDir(dir: string, uid: number): Promise<void> {
  const st = await lstat(dir);
  if (st.isSymbolicLink()) throw new StorageError("a symbolic link is on the path");
  if (!st.isDirectory()) throw new StorageError("an entry on the path is not a directory");
  if (st.uid !== uid) throw new StorageError("a directory on the path is owned by another user");
  if ((st.mode & 0o777) !== 0o700) throw new StorageError("a directory on the path is not mode 0700");
}

async function ensurePrivateDir(dir: string, uid: number): Promise<void> {
  try {
    await mkdir(dir, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  await verifyPrivateDir(dir, uid);
}

/** Whether a process with this pid runs (a temp entry of a live service is kept). */
function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The empty, inaccessible replacement entries (mode 0000), created once and verified afterwards. */
async function ensureEmpty(p: string, kind: "file" | "dir"): Promise<void> {
  const st = await lstat(p).catch(() => null);
  if (!st) {
    if (kind === "dir") await mkdir(p, { mode: 0o700 });
    else await writeFile(p, "", { mode: 0o600, flag: "wx" });
  } else if (st.isSymbolicLink() || (kind === "dir" ? !st.isDirectory() : !st.isFile() || st.size !== 0)) {
    throw new StorageError("a replacement entry is not empty");
  } else if (kind === "dir") {
    await chmod(p, 0o700);
    const entries = await readdir(p);
    if (entries.length > 0) throw new StorageError("a replacement entry is not empty");
  }
  await chmod(p, 0o000);
}

/**
 * Create (if needed) and verify the L1 storage of a state directory. Throws
 * StorageError (reason private_storage_unavailable) with a message that names
 * no path.
 */
export async function openStorage(
  stateDir: string,
  options: { readonly uid?: number; readonly parent?: string } = {},
): Promise<L1Storage> {
  const uid = options.uid ?? process.getuid?.() ?? -1;
  const parent = options.parent ?? STORAGE_PARENT;
  try {
    const parentStat = await lstat(parent);
    if (parentStat.isSymbolicLink() || !parentStat.isDirectory())
      throw new StorageError("the parent directory is not a directory");
    const base = path.join(parent, `crot-l1-${uid}`);
    await ensurePrivateDir(base, uid);
    const fsInfo = await statfs(base);
    const kind = NON_LOCAL_FS.get(Number(fsInfo.type));
    if (kind) throw new StorageError(`it is on a ${kind} file system, not a local one`);
    const root = path.join(base, storageKey(stateDir));
    await ensurePrivateDir(root, uid);
    const dirs = ["home", "layers", "temp", "run", "empty"];
    for (const d of dirs) await ensurePrivateDir(path.join(root, d), uid);
    for (const d of ["home/upper", "home/work"]) await ensurePrivateDir(path.join(root, d), uid);
    const emptyDir = path.join(root, "empty", "dir");
    const emptyFile = path.join(root, "empty", "file");
    await ensureEmpty(emptyDir, "dir");
    await ensureEmpty(emptyFile, "file");
    // Private temps of sandboxes of services that ended without cleanup (never those of a live
    // process: several Cores of one service share the storage, and their sandboxes may run).
    for (const entry of await readdir(path.join(root, "temp"))) {
      if (!processAlive(Number(entry.split("-")[0])))
        await rm(path.join(root, "temp", entry), { recursive: true, force: true });
    }
    return {
      root,
      homeUpper: path.join(root, "home", "upper"),
      homeWork: path.join(root, "home", "work"),
      layer: (index) => ({
        upper: path.join(root, "layers", String(index), "upper"),
        work: path.join(root, "layers", String(index), "work"),
      }),
      emptyFile,
      emptyDir,
      run: path.join(root, "run"),
      newTemp: async () => {
        const dir = path.join(root, "temp", `${process.pid}-${randomBytes(8).toString("hex")}`);
        await mkdir(path.join(dir, "tmp"), { recursive: true, mode: 0o700 });
        await mkdir(path.join(dir, "var-tmp"), { recursive: true, mode: 0o700 });
        // The sandbox's /tmp and /var/tmp are sticky and world-writable inside, like the host's.
        await chmod(path.join(dir, "tmp"), 0o1777);
        await chmod(path.join(dir, "var-tmp"), 0o1777);
        return {
          tmp: path.join(dir, "tmp"),
          varTmp: path.join(dir, "var-tmp"),
          remove: () => rm(dir, { recursive: true, force: true }),
        };
      },
    };
  } catch (error) {
    if (error instanceof StorageError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    throw new StorageError(code ? `it cannot be created (${code})` : "it cannot be created");
  }
}

/** Create the layer directories of a file system mounted below the home. */
export async function ensureLayer(
  storage: L1Storage,
  index: number,
  uid: number,
): Promise<{ upper: string; work: string }> {
  const layer = storage.layer(index);
  await ensurePrivateDir(path.dirname(layer.upper), uid);
  await ensurePrivateDir(layer.upper, uid);
  await ensurePrivateDir(layer.work, uid);
  return layer;
}
