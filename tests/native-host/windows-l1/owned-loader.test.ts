import { describe, expect, it } from "vitest";
import { loaderTokens } from "./diagnostics/owned-loader.js";
describe("owned loader trace sanitization", () => {
  it("retains failing loader symbols, DLL basename and status, never paths, addresses or argument text", () => {
    const value = loaderTokens(
      "ERROR: LdrpInitializeProcess C:\\private\\state\\KERNELBASE.dll failed status 0xc0000142 addr 0x7ff12345 secret=do-not-retain",
    );
    expect(value).toEqual([
      { functions: ["LdrpInitializeProcess"], modules: ["kernelbase.dll"], statuses: ["0xc0000142"] },
    ]);
    expect(JSON.stringify(value)).not.toMatch(/private|state|7ff12345|do-not-retain/);
  });
  it("does not emit arbitrary debug output and bounds retained failure rows", () => {
    expect(loaderTokens("normal output with a token value")).toEqual([]);
    expect(loaderTokens(Array(1000).fill("ERROR LdrpCallInitRoutine failed 0xc0000022").join("\n"))).toHaveLength(64);
  });
});
