import { mkdir, stat } from "node:fs/promises";
import type { PrivateFileProtection, PrivateFileStatus } from "./types.js";

/**
 * Protection of CROT's private files (audit log, future state) against other
 * local users.
 *
 * POSIX: files are created with mode 0600 and new directories with 0700, and
 * existing files are checked for group/other access.
 *
 * Windows: permission bits do not exist (Node maps the mode only to the
 * read-only attribute), so CROT does not claim owner-only access. Files
 * inherit the ACLs of their directory; the default per-user locations
 * (%LOCALAPPDATA%) are already private to the user, while other locations may
 * not be. Restricting ACLs is the responsibility of the Native Host/installer.
 *
 * This is independent of the PermissionEngine, which separately prevents
 * CROT's own tools from modifying these files.
 */
export function createPrivateFileProtection(windows: boolean): PrivateFileProtection {
  if (windows) {
    return {
      mechanism: "inherited-acl",
      enforced: false,
      fileMode: undefined,
      ensureDirectory: async (dir) => {
        await mkdir(dir, { recursive: true });
      },
      inspect: async () => ({
        mechanism: "inherited-acl",
        ownerOnly: null,
        detail: "Windows: access follows the ACLs inherited from the parent directory; CROT does not restrict them (Native Host/installer responsibility).",
      }),
    };
  }
  return {
    mechanism: "posix-mode",
    enforced: true,
    fileMode: 0o600,
    ensureDirectory: async (dir) => {
      // Applies only to directories created here; existing directories are left as they are.
      await mkdir(dir, { recursive: true, mode: 0o700 });
    },
    inspect: async (file): Promise<PrivateFileStatus> => {
      const info = await stat(file).catch(() => undefined);
      if (!info) return { mechanism: "posix-mode", ownerOnly: true, detail: "will be created with mode 0600" };
      const mode = info.mode & 0o777;
      const octal = mode.toString(8).padStart(4, "0");
      return mode & 0o077
        ? { mechanism: "posix-mode", ownerOnly: false, detail: `mode ${octal}: accessible by group/other users (restrict with chmod 600)` }
        : { mechanism: "posix-mode", ownerOnly: true, detail: `mode ${octal}` };
    },
  };
}
