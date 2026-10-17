/** Owner-provisioned Windows L1 delivery. Hashes are pinned before any DLL load. */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { ConfinementReason, PrivateFileProtection } from "../../core/platform/types.js";
export const WINDOWS_L1_VERSION = "windows-l1-v1";
export class WindowsPreparationError extends Error {
  constructor(
    readonly reason: ConfinementReason,
    message: string,
  ) {
    super(message);
  }
}
export interface WindowsComponents {
  readonly root: string;
  readonly library: string;
  readonly executable: string;
  readonly hashes: Readonly<Record<string, string>>;
}
export function qualifiedWindowsHost(
  facts = { platform: process.platform, arch: process.arch, release: os.release(), version: os.version() },
): boolean {
  return (
    facts.platform === "win32" &&
    facts.arch === "x64" &&
    /^10\.0\.26100(?:\.|$)/.test(facts.release) &&
    /Windows Server 2025/i.test(facts.version)
  );
}
const bad = (reason: ConfinementReason, message: string): never => {
  throw new WindowsPreparationError(reason, message);
};
/** No UAC, host mutation, runtime download, inferred capability or fallback. */
export async function verifyWindowsComponents(
  stateDir: string,
  privateFiles: PrivateFileProtection,
): Promise<WindowsComponents> {
  const root = path.join(stateDir, "windows-l1", "components"),
    manifest = path.join(root, "manifest.json");
  const exists = await lstat(manifest).catch((cause: NodeJS.ErrnoException) => {
    if (cause.code === "ENOENT") return undefined;
    throw cause;
  });
  if (!exists) return bad("components_missing", "Windows L1 components have not been provisioned.");
  if (!qualifiedWindowsHost())
    return bad("components_mismatch", "This Windows edition, build or architecture is not qualified.");
  if (!privateFiles.enforced) return bad("private_storage_unavailable", "Owner-only Windows storage is unavailable.");
  let value: unknown;
  try {
    for (const p of [path.dirname(root), root, manifest]) {
      const s = await lstat(p);
      if (
        s.isSymbolicLink() ||
        (p === manifest ? !s.isFile() || s.nlink !== 1 : !s.isDirectory()) ||
        !(await privateFiles.inspect(p)).ownerOnly
      )
        return bad("private_storage_unavailable", "Windows L1 component storage is not private.");
    }
    if (exists.size > 16384) return bad("components_mismatch", "Windows L1 manifest is too large.");
    value = JSON.parse(await readFile(manifest, "utf8"));
  } catch (cause) {
    if (cause instanceof WindowsPreparationError) throw cause;
    return bad("components_mismatch", "Windows L1 manifest could not be verified.");
  }
  const v = value as { version?: unknown; arch?: unknown; files?: Record<string, unknown> };
  if (
    v?.version !== WINDOWS_L1_VERSION ||
    v.arch !== "x64" ||
    !v.files ||
    Object.keys(v.files).sort().join() !== "crot-local-shim.dll,node.exe"
  )
    return bad("components_mismatch", "Windows L1 manifest version or component set differs.");
  const hashes: Record<string, string> = {};
  for (const name of ["crot-local-shim.dll", "node.exe"]) {
    const file = path.join(root, name),
      expected = v.files[name];
    if (typeof expected !== "string" || !/^[a-f0-9]{64}$/.test(expected))
      return bad("components_mismatch", "Windows L1 manifest hash is invalid.");
    try {
      const s = await lstat(file);
      if (
        !s.isFile() ||
        s.isSymbolicLink() ||
        s.nlink !== 1 ||
        s.size < 64 ||
        s.size > 256 * 1024 * 1024 ||
        !(await privateFiles.inspect(file)).ownerOnly
      )
        return bad("components_mismatch", "Windows L1 component file is not admitted.");
      const handle = await open(file, constants.O_RDONLY);
      try {
        const before = await handle.stat(),
          hash = createHash("sha256");
        for await (const bytes of handle.createReadStream({ autoClose: false })) hash.update(bytes);
        const after = await handle.stat();
        if (
          before.ino !== after.ino ||
          before.size !== after.size ||
          before.mtimeMs !== after.mtimeMs ||
          hash.digest("hex") !== expected
        )
          return bad("components_mismatch", "Windows L1 component integrity differs.");
      } finally {
        await handle.close();
      }
      hashes[name] = expected;
    } catch (cause) {
      if (cause instanceof WindowsPreparationError) throw cause;
      return bad("components_missing", "A Windows L1 component could not be opened.");
    }
  }
  return Object.freeze({
    root,
    library: path.join(root, "crot-local-shim.dll"),
    executable: path.join(root, "node.exe"),
    hashes: Object.freeze(hashes),
  });
}
