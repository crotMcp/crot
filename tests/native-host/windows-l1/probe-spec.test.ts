import { describe, expect, it } from "vitest";
import { probeEnvironment, quoteProbeArgument } from "../../../src/native-host/windows-l1/probe-process.js";

describe("Windows probe argument/environment encoding (no shell)", () => {
  it.each([
    ["", '""'],
    ["a b", '"a b"'],
    ["Юникод", '"Юникод"'],
    ['a"b', '"a\\"b"'],
    ["trailing\\", '"trailing\\\\"'],
    ['a\\"b', '"a\\\\\\"b"'],
    ["%PATH%&echo", '"%PATH%&echo"'],
  ])("quotes %j as %j without shell interpretation", (input, expected) => {
    expect(quoteProbeArgument(input)).toBe(expected);
  });
  it("rejects NUL arguments", () => {
    expect(() => quoteProbeArgument("a\0b")).toThrow(/invalid/);
  });
  it("encodes an explicit sorted UTF-16 environment, double-NUL terminated", () => {
    expect(probeEnvironment({ z: "last", A: "Юникод", _FIRST: "v" }).toString("utf16le")).toBe(
      "A=Юникод\0z=last\0_FIRST=v\0\0",
    );
    expect(probeEnvironment({})).toEqual(Buffer.alloc(4));
  });
  it("preserves valid Windows environment names including ProgramFiles(x86)", () => {
    expect(
      probeEnvironment({ "ProgramFiles(x86)": "C:\\Program Files (x86)", "имя-переменной": "value" }).toString(
        "utf16le",
      ),
    ).toBe("ProgramFiles(x86)=C:\\Program Files (x86)\0имя-переменной=value\0\0");
  });
  it.each([
    { "": "empty name" },
    { "bad\0key": "value" },
    { PATH: "a", Path: "b" },
    { "a=b": "value" },
    { A: "bad\0value" },
    { A: "x".repeat(32768) },
  ] as Record<string, string>[])("rejects ambiguous/invalid environment %j", (env) => {
    expect(() => probeEnvironment(env)).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
  });
});
