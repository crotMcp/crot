import { describe, expect, it } from "vitest";
import { macosPlatformSupported } from "../../../src/native-host/macos-l1/platform.js";
describe("macOS target matrix readiness predicates", () => {
  it("does not invent unsupported OS/architecture combinations", () => {
    for (const kernel of ["24.0.0", "25.0.0", "26.1.0"]) expect(macosPlatformSupported("arm64", kernel)).toBe(true);
    for (const kernel of ["24.0.0", "25.0.0"]) expect(macosPlatformSupported("x64", kernel)).toBe(true);
    for (const [arch, kernel] of [
      ["x64", "26.0.0"],
      ["arm64", "23.0.0"],
      ["arm64", "27.0.0"],
      ["ia32", "24.0.0"],
      ["arm64", "invalid"],
    ])
      expect(macosPlatformSupported(arch!, kernel!)).toBe(false);
  });
});
