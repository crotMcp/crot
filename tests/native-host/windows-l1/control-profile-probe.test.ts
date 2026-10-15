import { describe, expect, it } from "vitest";
import { decodeControlProfileDiagnostic } from "../../../src/native-host/windows-l1/control-profile-probe.js";
const frame = (a: number, b: number) => ((0xa5b00000 | a | (b << 10)) >>> 0).toString(16);
describe("AppContainer/LPAC diagnostic protocol (not native evidence)", () => {
  it("distinguishes all four outcomes and NUL without claiming device grants", () => {
    expect(decodeControlProfileDiagnostic(frame(0x1e4, 0x55))).toEqual({
      completed: true,
      ownerControls: true,
      devicePackageAccessGranted: false,
      appContainer: {
        ready: true,
        win32Zero: "access-denied",
        win32Read: "opened",
        ntMetadata: "namespace-unreachable",
        ntRead: "other",
        nulReadWriteOpened: true,
      },
      lpac: {
        ready: true,
        win32Zero: "opened",
        win32Read: "opened",
        ntMetadata: "opened",
        ntRead: "opened",
        nulReadWriteOpened: false,
      },
    });
  });
  it("does not count loader or token readback failure as access denial", () => {
    expect(decodeControlProfileDiagnostic(frame(0x208, 0x204))).toMatchObject({
      appContainer: { ready: false, stage: "loader-0142" },
      lpac: { ready: false, stage: "suspended-token-readback" },
    });
  });
  it("distinguishes owner-control and cleanup failure from completed experiments", () => {
    expect(decodeControlProfileDiagnostic("a5d00000")).toEqual({ completed: false, stage: "owner-controls-or-setup" });
    expect(decodeControlProfileDiagnostic("a5c00000")).toEqual({ completed: false, stage: "cleanup" });
  });
  it("localizes a failed owner control without turning it into a profile result", () => {
    expect(decodeControlProfileDiagnostic("a5d00004")).toEqual({ completed: false, stage: "owner-nt-read" });
    expect(decodeControlProfileDiagnostic("a5d00007")).toEqual({ completed: false, stage: "owned-nonce" });
    expect(decodeControlProfileDiagnostic("a5d0000f")).toBeUndefined();
  });
  it.each(["a5b0000", "A5B00000", "a5b000000", "a5b00000\n", "00000000", "c0000142", frame(0x200, 0), frame(0x2ff, 0)])(
    "rejects malformed/reserved frame %j",
    (s) => {
      expect(decodeControlProfileDiagnostic(s)).toBeUndefined();
    },
  );
});
