import { describe, expect, it } from "vitest";
import { parseCli } from "../../src/cli/options.js";
describe("service autostart CLI", () => {
  it.each(["install", "status", "remove"] as const)("parses %s", async (action) => {
    expect(await parseCli(["service", "autostart", action], {})).toEqual({ kind: "service-autostart", action });
  });
  it("rejects unknown actions", async () => {
    await expect(parseCli(["service", "autostart", "enable"], {})).rejects.toThrow("install|status|remove");
  });
});
