/** AD-28 fixed diagnostic protocol, NOT a confinement availability predicate. */
const opens = ["access-denied", "opened", "namespace-unreachable", "other"] as const;
const stages = [
  "reserved",
  "owned-profile-setup",
  "job-or-attributes",
  "process-create",
  "suspended-token-readback",
  "resume",
  "child-wait",
  "child-exit-readback",
  "loader-0142",
  "child-not-ready",
  "cleanup",
] as const;
function profile(bits: number) {
  if (bits & 0x200) {
    const stage = stages[bits & 0x1ff];
    if (!stage || stage === "reserved") return undefined;
    return { ready: false as const, stage };
  }
  return {
    ready: true as const,
    win32Zero: opens[bits & 3],
    win32Read: opens[(bits >> 2) & 3],
    ntZero: opens[(bits >> 4) & 3],
    ntRead: opens[(bits >> 6) & 3],
    nulReadWriteOpened: !!(bits & 0x100),
  };
}
export function decodeControlProfileDiagnostic(hex: string) {
  if (!/^[0-9a-f]{8}$/.test(hex)) return undefined;
  const value = Number.parseInt(hex, 16);
  if (value === 0xa5c00000) return { completed: false as const, stage: "cleanup" as const };
  if (value === 0xa5d00000) return { completed: false as const, stage: "owner-controls-or-setup" as const };
  if (value >>> 20 !== 0xa5b) return undefined;
  const appContainer = profile(value & 0x3ff),
    lpac = profile((value >>> 10) & 0x3ff);
  if (!appContainer || !lpac) return undefined;
  return {
    completed: true as const,
    ownerControls: true as const,
    devicePackageAccessGranted: false as const,
    appContainer,
    lpac,
  };
}
