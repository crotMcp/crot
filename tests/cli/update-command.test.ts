import { expect, it } from "vitest";
import { runUpdate } from "../../src/cli/update.js";
import { USAGE } from "../../src/cli/options.js";
it("exposes the signed update CLI and rejects incomplete/unknown options before OS changes", async () => {
  expect(USAGE).toContain("crot-mcp update --package");
  await expect(runUpdate([])).rejects.toThrow("update requires");
  await expect(runUpdate(["--trust-package-key"])).rejects.toThrow();
});
