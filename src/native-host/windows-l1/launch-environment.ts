/**
 * Deterministic Windows child paths, not a filesystem or Docker security policy.
 * Core applies AD-18's source allowlist before this layer. This layer never reads
 * process.env and cannot grant access to the directories named by its settings.
 */
import path from "node:path";
import { CrotError } from "../../core/errors.js";
import { createEnvironmentPolicy } from "../../core/platform/environment.js";
import { validateWindowsPath } from "../validation.js";
import { probeEnvironment } from "./probe-process.js";
export interface WindowsLaunchLayout {
  /** Trusted host discovery, not a remotely supplied environment override. */
  readonly systemRoot: string;
  /** New CROT-owned root, provisioned/verified by the confinement owner. */
  readonly privateRoot: string;
  /** Explicit approved runtime directories; never the entire inherited PATH. */
  readonly runtimeBins: readonly string[];
}
export class WindowsLaunchEnvironment {
  readonly directories: Readonly<{ home: string; temp: string; cache: string; roaming: string; local: string }>;
  readonly path: string;
  private readonly fixed: Readonly<Record<string, string>>;
  constructor(layout: WindowsLaunchLayout) {
    const local = (value: string): string => {
      const p = validateWindowsPath(value);
      if (!/^[A-Za-z]:\\/.test(p) || /[;%]/.test(p))
        throw new CrotError("INVALID_INPUT", "Windows launch layout requires literal local drive paths.");
      return p;
    };
    const root = local(layout.systemRoot),
      privateRoot = local(layout.privateRoot);
    const dirs = {
      home: path.win32.join(privateRoot, "home"),
      temp: path.win32.join(privateRoot, "temp"),
      cache: path.win32.join(privateRoot, "cache"),
      roaming: path.win32.join(privateRoot, "home", "AppData", "Roaming"),
      local: path.win32.join(privateRoot, "home", "AppData", "Local"),
    };
    this.directories = Object.freeze(dirs);
    const bins = [
      ...layout.runtimeBins.map(local),
      path.win32.join(root, "System32"),
      root,
      path.win32.join(root, "System32", "Wbem"),
      path.win32.join(root, "System32", "WindowsPowerShell", "v1.0"),
    ];
    const seen = new Set<string>();
    this.path = bins
      .filter((bin) => {
        const k = bin.toUpperCase();
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .join(";");
    this.fixed = Object.freeze({
      SystemRoot: root,
      WINDIR: root,
      SystemDrive: path.win32.parse(root).root.slice(0, 2),
      COMSPEC: path.win32.join(root, "System32", "cmd.exe"),
      PATH: this.path,
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      HOME: dirs.home,
      USERPROFILE: dirs.home,
      HOMEDRIVE: path.win32.parse(dirs.home).root.slice(0, 2),
      HOMEPATH: dirs.home.slice(2),
      TEMP: dirs.temp,
      TMP: dirs.temp,
      TMPDIR: dirs.temp,
      APPDATA: dirs.roaming,
      LOCALAPPDATA: dirs.local,
      XDG_CACHE_HOME: dirs.cache,
      PSModuleAnalysisCachePath: path.win32.join(dirs.cache, "ModuleAnalysisCache"),
      npm_config_cache: path.win32.join(dirs.cache, "npm"),
      PIP_CACHE_DIR: path.win32.join(dirs.cache, "pip"),
    });
    probeEnvironment(this.fixed);
  }
  prepare(input: Readonly<Record<string, string>>): Record<string, string> {
    // Validate before filtering: malformed input is never silently repaired.
    probeEnvironment(input);
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(input)) {
      const name = key.toUpperCase();
      if (name === "PSMODULEPATH" || name.startsWith("DOCKER_")) continue;
      out[key] = value;
    }
    const merged = createEnvironmentPolicy(true).merge(out, this.fixed);
    probeEnvironment(merged);
    return merged;
  }
}
