import path from "node:path";
import type { OsFamily, PlatformDirectories } from "./types.js";

/**
 * OS-conventional default locations for CROT's own files. Used only when the
 * user has not given an explicit path; explicit paths always win.
 *
 * | OS      | config                                  | state                                        | logs                         |
 * | ------- | --------------------------------------- | -------------------------------------------- | ---------------------------- |
 * | Linux   | $XDG_CONFIG_HOME/crot (~/.config/crot)  | $XDG_STATE_HOME/crot (~/.local/state/crot)   | <state>/logs                 |
 * | macOS   | ~/Library/Application Support/CROT     | ~/Library/Application Support/CROT/State     | ~/Library/Logs/CROT          |
 * | Windows | %APPDATA%\CROT                          | %LOCALAPPDATA%\CROT                          | %LOCALAPPDATA%\CROT\Logs     |
 */
export function platformDirectories(
  os: OsFamily,
  get: (name: string) => string | undefined,
  home: string,
): PlatformDirectories {
  if (os === "windows") {
    const w = path.win32;
    const absolute = (name: string, fallback: string) => {
      const v = get(name);
      return v && w.isAbsolute(v) ? v : w.join(home, fallback);
    };
    const roaming = absolute("APPDATA", "AppData\\Roaming");
    const local = absolute("LOCALAPPDATA", "AppData\\Local");
    return { config: w.join(roaming, "CROT"), state: w.join(local, "CROT"), logs: w.join(local, "CROT", "Logs") };
  }
  const p = path.posix;
  if (os === "macos") {
    const support = p.join(home, "Library", "Application Support", "CROT");
    return { config: support, state: p.join(support, "State"), logs: p.join(home, "Library", "Logs", "CROT") };
  }
  // XDG Base Directory specification: relative values are invalid and ignored.
  const xdg = (name: string, fallback: string) => {
    const v = get(name);
    return v && p.isAbsolute(v) ? v : p.join(home, fallback);
  };
  const state = p.join(xdg("XDG_STATE_HOME", ".local/state"), "crot");
  return { config: p.join(xdg("XDG_CONFIG_HOME", ".config"), "crot"), state, logs: p.join(state, "logs") };
}

/** Default configuration file inside the config directory. */
export const DEFAULT_CONFIG_FILE_NAME = "config.json";
/** Default audit log file inside the logs directory. */
export const DEFAULT_AUDIT_FILE_NAME = "audit.jsonl";
