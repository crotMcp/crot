import { describe, expect, it } from "vitest";
import { createEnvironmentPolicy } from "../../src/core/platform/environment.js";

describe("environment policy (Windows semantics)", () => {
  const win = createEnvironmentPolicy(true);

  it("overrides differently-cased names without duplicating them", () => {
    const env = win.merge({ Path: "C:\\bin", SystemRoot: "C:\\Windows" }, { PATH: "C:\\other" });
    expect(env).toEqual({ Path: "C:\\other", SystemRoot: "C:\\Windows" });
  });

  it("removes variables case-insensitively", () => {
    expect(win.merge({ Path: "x", TEMP: "t" }, { path: null })).toEqual({ TEMP: "t" });
  });

  it("looks up case-insensitively", () => {
    expect(win.get({ Path: "x" }, "PATH")).toBe("x");
    expect(win.get({ ComSpec: "c" }, "COMSPEC")).toBe("c");
  });
});

describe("environment policy (POSIX semantics)", () => {
  const posix = createEnvironmentPolicy(false);

  it("treats names as case-sensitive", () => {
    expect(posix.merge({ PATH: "/bin" }, { path: "x" })).toEqual({ PATH: "/bin", path: "x" });
    expect(posix.get({ PATH: "/bin" }, "Path")).toBeUndefined();
  });

  it("adds, overrides, removes and drops undefined values", () => {
    expect(posix.merge({ A: "1", B: "2", C: undefined }, { A: "x", B: null, D: "4" })).toEqual({ A: "x", D: "4" });
  });
});
