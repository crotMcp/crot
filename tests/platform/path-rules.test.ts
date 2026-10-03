import { describe, expect, it } from "vitest";
import { posixPathRules as posix, win32PathRules as win } from "../../src/core/platform/path-rules.js";

const invalid = (fn: () => void) => expect(fn).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));

describe("win32 path rules (pure, run on every OS)", () => {
  it.each([
    ["CON"],
    ["con.txt"],
    ["dir\\NUL"],
    ["dir/aux.log"],
    ["COM1"],
    ["lpt9.dat"],
    ["CONIN$"],
    ["file.txt:stream"],
    ["C:\\dir\\file.txt:$DATA"],
    ["C:relative"],
    ["D:"],
    ["\\\\?\\C:\\x"],
    ["\\\\.\\PhysicalDrive0"],
    ["//?/C:/x"],
    ["name."],
    ["name "],
    ["dir\\trailing.\\x"],
    ["a<b"],
    ["a|b"],
    ['a"b'],
    ["a?b"],
    ["a*b"],
    ["a\u0001b"],
    ["a\0b"],
  ])("rejects %j", (input) => invalid(() => win.validate(input)));

  it.each([
    ["C:\\Users\\dev\\proj"],
    ["C:/Users/dev/proj"],
    ["src\\index.ts"],
    ["src/index.ts"],
    ["..\\x"],
    ["\\\\server\\share\\dir"],
    ["console.log"],
    ["con-fig"],
    ["COM10"],
    ["."],
    [".."],
    [".gitignore"],
  ])("accepts %j", (input) => expect(() => win.validate(input)).not.toThrow());

  it("compares case-insensitively regardless of the flag", () => {
    expect(win.relativeSegments("C:\\Work\\Proj", "c:\\work\\PROJ\\Src\\a.ts", true)).toEqual(["Src", "a.ts"]);
    expect(win.equals("C:\\Work\\Proj", "c:/work/proj/", true)).toBe(true);
  });

  it("does not treat sibling prefixes or other drives as inside", () => {
    expect(win.relativeSegments("C:\\proj", "C:\\proj-other\\x", false)).toBeNull();
    expect(win.relativeSegments("C:\\proj", "D:\\proj\\x", false)).toBeNull();
    expect(win.relativeSegments("C:\\proj", "C:\\", false)).toBeNull();
  });

  it("handles UNC roots", () => {
    expect(win.root("\\\\server\\share\\dir\\f")).toBe("\\\\server\\share\\");
    expect(win.relativeSegments("\\\\server\\share\\dir", "\\\\SERVER\\share\\dir\\f", true)).toEqual(["f"]);
    expect(win.relativeSegments("\\\\server\\share\\dir", "\\\\server\\other\\dir\\f", true)).toBeNull();
  });
});

describe("posix path rules", () => {
  it("only rejects NUL", () => {
    invalid(() => posix.validate("a\0b"));
    for (const ok of ["CON", "a:b", "name.", "a<b", "back\\slash"]) expect(() => posix.validate(ok)).not.toThrow();
  });

  it("honours the case-sensitivity flag", () => {
    expect(posix.relativeSegments("/Users/dev/Proj", "/users/dev/proj/a", true)).toBeNull();
    expect(posix.relativeSegments("/Users/dev/Proj", "/users/dev/proj/a", false)).toEqual(["a"]);
    expect(posix.equals("/a/B", "/a/b", false)).toBe(true);
    expect(posix.equals("/a/B", "/a/b", true)).toBe(false);
  });

  it("normalizes Unicode when comparing case-insensitively (macOS)", () => {
    const nfc = "/Users/dev/Caf\u00e9";
    const nfd = "/Users/dev/Cafe\u0301";
    expect(posix.equals(nfc, nfd, false)).toBe(true);
  });

  it("does not treat sibling prefixes as inside and handles the root", () => {
    expect(posix.relativeSegments("/proj", "/proj-other/x", true)).toBeNull();
    expect(posix.relativeSegments("/", "/etc/passwd", true)).toEqual(["etc", "passwd"]);
  });
});
