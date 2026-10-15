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
  "package-profile-create",
  "package-sid-format",
  "owner-sid-format",
  "owned-descriptor",
  "owned-directory-create",
  "owned-executable-copy",
  "owned-executable-dacl",
  "process-create-access-denied",
  "process-create-privilege",
  "process-create-path",
  "process-create-unsupported-or-parameter",
  "process-create-image",
  "process-create-not-found",
  "process-create-other",
  "created-job-membership",
  "created-token-open",
  "appcontainer-query",
  "package-sid-query",
  "capabilities-query",
  "integrity-query",
  "lpac-query",
  "not-appcontainer",
  "package-sid-mismatch",
  "capabilities-not-zero",
  "invalid-integrity-label",
  "lpac-mismatch",
  "integrity-medium-not-low",
  "integrity-high-not-low",
  "integrity-other-not-low",
] as const;
function profile(bits: number) {
  if (bits & 0x800) {
    const stage = stages[bits & 0x7ff];
    if (!stage || stage === "reserved") return undefined;
    return { ready: false as const, stage };
  }
  return {
    ready: true as const,
    win32Zero: opens[bits & 3],
    win32Read: opens[(bits >> 2) & 3],
    ntMetadata: opens[(bits >> 4) & 3],
    ntRead: opens[(bits >> 6) & 3],
    nulReadWriteOpened: !!(bits & 0x100),
    ntLiteralZero: opens[(bits >>> 9) & 3],
  };
}
export function decodeControlProfileDiagnostic(hex: string) {
  if (!/^[0-9a-f]{8}$/.test(hex)) return undefined;
  const value = Number.parseInt(hex, 16);
  if (value === 0xb4000000)
    return { protocolVersion: 2 as const, completed: false as const, stage: "cleanup" as const };
  if (value >>> 4 === 0xb500000) {
    const stage = [
      "owner-controls-or-setup",
      "owner-win32-zero",
      "owner-nt-metadata",
      "owner-win32-read",
      "owner-nt-read",
      "module-path",
      "source-path",
      "owned-nonce",
      "controller-exception",
    ][value & 15];
    if (!stage) return undefined;
    return { protocolVersion: 2 as const, completed: false as const, stage };
  }
  const header = value >>> 24;
  if (header < 0xb0 || header > 0xb3) return undefined;
  const appContainer = profile(value & 0xfff),
    lpac = profile((value >>> 12) & 0xfff);
  if (!appContainer || !lpac) return undefined;
  return {
    protocolVersion: 2 as const,
    completed: true as const,
    ownerControls: true as const,
    ownerNtLiteralZero: opens[header & 3],
    devicePackageAccessGranted: false as const,
    appContainer,
    lpac,
  };
}
