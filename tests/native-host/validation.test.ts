import { describe, expect, it } from "vitest";
import { isOwnerOnly, parseAclReport, parseWhoamiSid, validatePid, validateSid, validateWindowsPath } from "../../src/native-host/validation.js";

function expectInvalid(fn: () => unknown): void {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toMatchObject({ code: "INVALID_INPUT" });
}

const USER = "S-1-5-21-1004336348-1177238915-682003330-1001";
const OTHER = "S-1-5-32-544";

describe("native-host validation: process ids", () => {
  it("accepts 32-bit positive integers", () => {
    expect(validatePid(1)).toBe(1);
    expect(validatePid(0xffff_ffff)).toBe(0xffff_ffff);
  });
  it("rejects everything else", () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 32, "12", null, undefined, 12n]) expectInvalid(() => validatePid(bad));
  });
});

describe("native-host validation: SIDs", () => {
  it("accepts well-formed SIDs", () => {
    expect(validateSid(USER)).toBe(USER);
    expect(validateSid("S-1-5-18")).toBe("S-1-5-18");
  });
  it("rejects malformed SIDs", () => {
    for (const bad of ["", "S-1", "S-1-5", "s-1-5-18", "S-1-5-18;x", "*S-1-5-18", "S-1-5-18\n", '"S-1-5-18"', `S-1-5-${"1-".repeat(150)}1`, 42]) {
      expectInvalid(() => validateSid(bad));
    }
  });
});

describe("native-host validation: Windows paths", () => {
  it("accepts absolute drive and UNC paths", () => {
    expect(validateWindowsPath("C:\\Users\\x\\file")).toBe("C:\\Users\\x\\file");
    expect(validateWindowsPath("\\\\server\\share\\f")).toBe("\\\\server\\share\\f");
  });
  it("rejects relative, ambiguous and unsafe paths", () => {
    const bad = ["", "relative\\x", "\\rooted", "C:relative", 'C:\\a"b', "C:\\a\nb", "C:\\a\u0000b", "C:\\a|b", `C:\\${"a".repeat(33_000)}`, 123, "\\\\?\\C:\\x"];
    for (const p of bad) expectInvalid(() => validateWindowsPath(p));
  });
});

describe("native-host validation: whoami output", () => {
  it("extracts the SID", () => {
    expect(parseWhoamiSid(`"host\\runner","${USER}"\r\n`)).toBe(USER);
  });
  it("rejects unexpected output", () => {
    for (const bad of ["", "garbage", `"a","${USER}"\n"b","${USER}"`, '"a","S-1-5"', `"a","${USER};rm"`, "x".repeat(5000)]) expectInvalid(() => parseWhoamiSid(bad));
  });
});

describe("native-host validation: ACL reports", () => {
  const report = (...rules: string[]) => ["protected=True", `owner=${USER}`, ...rules].join("\r\n");

  it("parses a report and evaluates owner-only", () => {
    const parsed = parseAclReport(report(`rule=${USER}|Allow|False`));
    expect(parsed).toEqual({ protected: true, owner: USER, rules: [{ sid: USER, type: "Allow", inherited: false }] });
    expect(isOwnerOnly(parsed, USER)).toBe(true);
    expect(isOwnerOnly(parseAclReport(report(`rule=${USER}|Allow|False`, `rule=${OTHER}|Allow|True`)), USER)).toBe(false);
    expect(isOwnerOnly(parseAclReport(report(`rule=${USER}|Allow|False`, `rule=${OTHER}|Deny|False`)), USER)).toBe(true);
    expect(isOwnerOnly(parseAclReport(report()), USER)).toBe(false);
  });

  it("rejects malformed reports", () => {
    const bad = [
      `protected=True\nrule=${USER}|Allow|False`,
      `protected=True\nprotected=False\nowner=${USER}`,
      report(`rule=${USER}|Maybe|False`),
      report(`rule=${USER}|Allow`),
      report("unexpected line"),
      report(`rule=${USER}|Allow|False;evil`),
      report(...Array.from({ length: 257 }, () => `rule=${USER}|Allow|False`)),
      "x".repeat(70_000),
      42,
    ];
    for (const b of bad) expectInvalid(() => parseAclReport(b));
  });
});
