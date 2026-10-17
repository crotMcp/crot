import { mkdtemp, readFile, writeFile, rm, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { it, expect } from "vitest";
import { createPrivateFileProtection } from "../../src/core/platform/private-files.js";
import { connectToService } from "../../src/service/shim.js";
it("does not truncate the service log or spawn when private protection fails", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "crot-shim-protection-"));
  try {
    const log = path.join(dir, "service.log"),
      marker = path.join(dir, "spawned"),
      entry = path.join(dir, "probe.cjs");
    const content = "x".repeat(1024 * 1024 + 1);
    await writeFile(log, content);
    await writeFile(entry, `require('node:fs').writeFileSync(${JSON.stringify(marker)},'spawned')`);
    const privateFiles = {
      ...createPrivateFileProtection(process.platform === "win32"),
      protectFile: async () => {
        throw new Error("fixture protection refused");
      },
    };
    await expect(
      connectToService({
        command: { kind: "serve", config: { workspace: { root: dir }, audit: { sink: "none" } }, warnings: [] },
        argv: [],
        entry,
        stateDir: dir,
        privateFiles,
        log: () => undefined,
        signals: [],
      }),
    ).rejects.toThrow("fixture protection refused");
    expect((await readFile(log, "utf8")) === content).toBe(true);
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
