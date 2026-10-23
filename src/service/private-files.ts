/** Actual service bootstrap, separate from the generic compatibility provider. */
import { createPrivateFileProtection } from "../core/platform/private-files.js";
import type { PrivateFileProtection } from "../core/platform/types.js";
export function createServicePrivateFiles(
  windows: boolean,
  sandboxSids: readonly string[] = [],
): PrivateFileProtection {
  if (!windows) return createPrivateFileProtection(false);
  let loading: Promise<PrivateFileProtection> | undefined;
  const provider = () =>
    (loading ??= (async () => {
      const { currentUserSid, windowsTools } = await import("../native-host/windows-acl.js");
      const { loadWindowsPrivateState } = await import("../native-host/windows-state.js");
      return loadWindowsPrivateState(
        await currentUserSid(windowsTools(process.env.SystemRoot ?? "C:\\Windows")),
        sandboxSids,
      );
    })());
  return {
    mechanism: "windows-acl",
    enforced: true,
    fileMode: undefined,
    ensureDirectory: async (dir) => (await provider()).ensureDirectory(dir),
    protectFile: async (file) => (await provider()).protectFile!(file),
    inspect: async (file) => (await provider()).inspect(file),
  };
}

/** Fixed CROT state names only; no recursive scan or external config files. */
export async function existingPrivateStateFiles(stateDir: string): Promise<string[]> {
  const [
    { lstat },
    path,
    { stateSecretPaths, secretStoreProtectedPaths },
    { serviceProtectedPaths },
    { dpapiDirectory },
    { SECRET_NAMES },
    { REMOTE_EXPOSURE_FILE_NAME },
  ] = await Promise.all([
    import("node:fs/promises"),
    import("node:path"),
    import("./secrets/store.js"),
    import("./endpoints.js"),
    import("./secrets/dpapi.js"),
    import("./secrets/types.js"),
    import("../core/approvals/index.js"),
  ]);
  const names = [
    ...stateSecretPaths(stateDir),
    ...secretStoreProtectedPaths(stateDir),
    ...serviceProtectedPaths(stateDir),
    path.join(stateDir, REMOTE_EXPOSURE_FILE_NAME),
    path.join(stateDir, "product-state.json"),
    ...SECRET_NAMES.map((name) => path.join(dpapiDirectory(stateDir), `${name}.dpapi`)),
  ];
  const found: string[] = [];
  for (const file of new Set(names)) {
    const item = await lstat(file).catch((e) => {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw e;
    });
    if (item && !item.isDirectory()) found.push(file); // reparse/nonregular objects are rejected by native protection, not followed here.
  }
  return found;
}
