import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Windows PowerShell 5.1 host preparation source", () => {
  it("is ASCII-safe for -File without BOM or a host ANSI code-page dependency", async () => {
    const script = await readFile(new URL("../../../scripts/l1-install-win.ps1", import.meta.url));
    expect([...script].every((byte) => byte < 128)).toBe(true);
    expect(script.toString("ascii")).toContain("param([switch]$Apply)");
    expect(script.toString("ascii")).toContain("const int mask=0x0012019f;");
  });
});
