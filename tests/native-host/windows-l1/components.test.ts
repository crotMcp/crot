import { describe, expect, it } from "vitest";
import { qualifiedWindowsHost, verifyWindowsComponents } from "../../../src/native-host/windows-l1/components.js";
import { makeTempDirs } from "../../helpers.js";
import { createServicePrivateFiles } from "../../../src/service/private-files.js";
describe("Windows L1 qualification predicates", () => {
  const facts = { platform: "win32", arch: "x64", release: "10.0.26100", version: "Windows Server 2025 Datacenter" };
  it("qualifies only the explicitly tested Server 2025 x64 family", () => {
    expect(qualifiedWindowsHost(facts as never)).toBe(true);
    for (const unsupported of [
      { ...facts, arch: "arm64" },
      { ...facts, version: "Windows 11 Pro" },
      { ...facts, release: "10.0.20348" },
      { ...facts, platform: "linux" },
    ])
      expect(qualifiedWindowsHost(unsupported as never)).toBe(false);
  });
  it("reports components_missing before creating storage or claiming readiness", async () => {
    const dirs = await makeTempDirs();
    try {
      await expect(
        verifyWindowsComponents(dirs.outside, createServicePrivateFiles(process.platform === "win32")),
      ).rejects.toMatchObject({ reason: "components_missing" });
    } finally {
      await dirs.cleanup();
    }
  });
});
