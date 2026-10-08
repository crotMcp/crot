/**
 * Host facts the L1 availability checks depend on (AD-20 point 12). Read from
 * /proc and /sys only; nothing here needs or uses root.
 */
import { access, readFile } from "node:fs/promises";
import { profileNames } from "./components.js";

/** Reads a host file; null when it is absent or unreadable (test seam). */
export type HostReader = (file: string) => Promise<string | null>;
/** Whether a host path exists (test seam). */
export type HostExists = (file: string) => Promise<boolean>;

export const readHostFile: HostReader = async (file) => {
  try {
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
};

export const hostPathExists: HostExists = async (file) => {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
};

export interface HostFacts {
  /** Unprivileged user namespaces are possible (not disabled by a sysctl). */
  readonly userns: boolean;
  /** AppArmor is enabled in the kernel. */
  readonly apparmorEnabled: boolean;
  /** Ubuntu's kernel.apparmor_restrict_unprivileged_userns is 1. */
  readonly usernsRestricted: boolean;
  /** The kernel mediates Unix sockets through AppArmor. */
  readonly unixMediation: boolean;
  /**
   * Whether the profiles of <v> are loaded: true/false when the kernel's
   * profile list is readable, null when it is not (the sandbox label decides).
   */
  readonly profilesLoaded: boolean | null;
}

const trimmed = (v: string | null) => (v === null ? null : v.trim());

/** AppArmor feature directories that mean the kernel mediates Unix sockets. */
export const UNIX_MEDIATION_FEATURES = [
  "/sys/kernel/security/apparmor/features/network/af_unix",
  "/sys/kernel/security/apparmor/features/network_v8/af_unix",
  "/sys/kernel/security/apparmor/features/network_v9/af_unix",
  "/sys/kernel/security/apparmor/features/unix",
] as const;

export async function readHostFacts(
  version: string,
  read: HostReader = readHostFile,
  exists: HostExists = hostPathExists,
): Promise<HostFacts> {
  const clone = trimmed(await read("/proc/sys/kernel/unprivileged_userns_clone"));
  const maxNs = trimmed(await read("/proc/sys/user/max_user_namespaces"));
  const userns = clone !== "0" && maxNs !== "0";
  const enabled = trimmed(await read("/sys/module/apparmor/parameters/enabled"));
  const apparmorEnabled = enabled === "Y" || enabled === "y";
  const usernsRestricted = trimmed(await read("/proc/sys/kernel/apparmor_restrict_unprivileged_userns")) === "1";
  let unixMediation = false;
  if (apparmorEnabled) {
    for (const feature of UNIX_MEDIATION_FEATURES) if (await exists(feature)) unixMediation = true;
  }
  let profilesLoaded: boolean | null = null;
  const profiles = apparmorEnabled ? await read("/sys/kernel/security/apparmor/profiles") : null;
  if (profiles !== null) {
    const names = new Set(
      profiles
        .split("\n")
        .map((line) => line.replace(/\s+\([a-z]+\)\s*$/, "").trim())
        .filter(Boolean),
    );
    // The policy of <v> is its three profiles; the container profile is applied by the endpoint (point 9).
    const { bwrap, payload, container } = profileNames(version);
    profilesLoaded = names.has(bwrap) && names.has(payload) && names.has(container);
  }
  return { userns, apparmorEnabled, usernsRestricted, unixMediation, profilesLoaded };
}

/** Whether L1 needs AppArmor on this host in this network mode (AD-20 point 12, apparmor_unavailable). */
export function apparmorRequired(facts: HostFacts, network: "on" | "off"): boolean {
  return facts.usernsRestricted || network === "on";
}
