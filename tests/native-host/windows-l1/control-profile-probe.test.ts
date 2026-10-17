import { describe, expect, it } from "vitest";
import { decodeControlProfileDiagnostic } from "../../../src/native-host/windows-l1/control-profile-probe.js";
const frame = (a: number, b: number) => ((0xb1000000 | a | (b << 12)) >>> 0).toString(16);
describe("AppContainer/LPAC diagnostic protocol (not native evidence)", () => {
  it("distinguishes all four outcomes and NUL without claiming device grants", () => {
    expect(decodeControlProfileDiagnostic(frame(0x1e4, 0x55))).toEqual({
      protocolVersion: 2,
      completed: true,
      ownerControls: true,
      ownerNtLiteralZero: "opened",
      devicePackageAccessGranted: false,
      appContainer: {
        ready: true,
        win32Zero: "access-denied",
        win32Read: "opened",
        ntMetadata: "namespace-unreachable",
        ntRead: "other",
        nulReadWriteOpened: true,
        ntLiteralZero: "access-denied",
      },
      lpac: {
        ready: true,
        win32Zero: "opened",
        win32Read: "opened",
        ntMetadata: "opened",
        ntRead: "opened",
        nulReadWriteOpened: false,
        ntLiteralZero: "access-denied",
      },
    });
  });
  it("does not count loader or token readback failure as access denial", () => {
    expect(decodeControlProfileDiagnostic(frame(0x808, 0x804))).toMatchObject({
      appContainer: { ready: false, stage: "loader-0142" },
      lpac: { ready: false, stage: "suspended-token-readback" },
    });
  });
  it("distinguishes owner-control and cleanup failure from completed experiments", () => {
    expect(decodeControlProfileDiagnostic("b5000000")).toEqual({
      protocolVersion: 2,
      completed: false,
      stage: "owner-controls-or-setup",
    });
    expect(decodeControlProfileDiagnostic("b4000000")).toEqual({
      protocolVersion: 2,
      completed: false,
      stage: "cleanup",
    });
  });
  it("distinguishes new-profile creation, owned-directory and executable ACL setup failures", () => {
    expect(decodeControlProfileDiagnostic(frame(0x80b, 0x80f))).toMatchObject({
      appContainer: { ready: false, stage: "package-profile-create" },
      lpac: { ready: false, stage: "owned-directory-create" },
    });
    expect(decodeControlProfileDiagnostic(frame(0x811, 0x810))).toMatchObject({
      appContainer: { ready: false, stage: "owned-executable-dacl" },
      lpac: { ready: false, stage: "owned-executable-copy" },
    });
  });
  it("keeps process-creation errors separate from child entry or access denial", () => {
    expect(decodeControlProfileDiagnostic(frame(0x812, 0x813))).toMatchObject({
      appContainer: { ready: false, stage: "process-create-access-denied" },
      lpac: { ready: false, stage: "process-create-privilege" },
    });
    expect(decodeControlProfileDiagnostic(frame(0x815, 0x814))).toMatchObject({
      appContainer: { ready: false, stage: "process-create-unsupported-or-parameter" },
      lpac: { ready: false, stage: "process-create-path" },
    });
  });
  it("does not collapse strict token/Job predicates into denial or allow elevated IL", () => {
    expect(decodeControlProfileDiagnostic(frame(0x825, 0x826))).toMatchObject({
      appContainer: { ready: false, stage: "integrity-medium-not-low" },
      lpac: { ready: false, stage: "integrity-high-not-low" },
    });
    expect(decodeControlProfileDiagnostic(frame(0x819, 0x822))).toMatchObject({
      appContainer: { ready: false, stage: "created-job-membership" },
      lpac: { ready: false, stage: "capabilities-not-zero" },
    });
  });
  it("does not mistake metadata denial for literal-zero native control isolation", () => {
    expect(decodeControlProfileDiagnostic(frame(0x200, 0x600))).toMatchObject({
      ownerNtLiteralZero: "opened",
      appContainer: { ready: true, ntMetadata: "access-denied", ntLiteralZero: "opened" },
      lpac: { ready: true, ntMetadata: "access-denied", ntLiteralZero: "other" },
    });
  });
  it("reports an unsupported owner literal-zero open, never a positive control", () => {
    expect(decodeControlProfileDiagnostic("b3000000")).toMatchObject({
      completed: true,
      ownerControls: true,
      ownerNtLiteralZero: "other",
    });
    expect(decodeControlProfileDiagnostic("a5b00000")).toBeUndefined(); // stale v1 helper
  });
  it("localizes a failed owner control without turning it into a profile result", () => {
    expect(decodeControlProfileDiagnostic("b5000004")).toEqual({
      protocolVersion: 2,
      completed: false,
      stage: "owner-nt-read",
    });
    expect(decodeControlProfileDiagnostic("b5000007")).toEqual({
      protocolVersion: 2,
      completed: false,
      stage: "owned-nonce",
    });
    expect(decodeControlProfileDiagnostic("b500000f")).toBeUndefined();
  });
  it.each(["b100000", "B1000000", "b10000000", "b1000000\n", "00000000", "c0000142", frame(0x800, 0), frame(0x8ff, 0)])(
    "rejects malformed/reserved frame %j",
    (s) => {
      expect(decodeControlProfileDiagnostic(s)).toBeUndefined();
    },
  );
});
