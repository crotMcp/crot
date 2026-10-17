import { describe, expect, it } from "vitest";
import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import { makeTempDirs } from "../../helpers.js";
import { createPrivateFileProtection } from "../../../src/core/platform/private-files.js";
import { bindMachineAdmission } from "../../../src/native-host/windows-l1/machine-admission.js";
describe.skipIf(process.platform === "win32")("machine ACL admission durability", () => {
  it("excludes concurrent stores, retains crash ownership, and only hands off after clean recovery", async () => {
    const dirs = await makeTempDirs();
    let locked = false;
    const open = bindMachineAdmission(
      path.join(dirs.outside, "machine"),
      async () => {
        if (locked) throw new Error("locked");
        locked = true;
        return {
          close: () => {
            locked = false;
          },
        };
      },
      0,
    );
    const first = { directory: "C:\\first", ownerSid: "S-1-5-21-1", privateFiles: createPrivateFileProtection(false) };
    const second = { ...first, directory: "C:\\second" };
    try {
      const one = await open(first);
      await expect(open(second)).rejects.toMatchObject({ code: "CONFINEMENT_FAILED" });
      await one.close(false);
      await expect(open(second)).rejects.toMatchObject({ code: "CONFINEMENT_FAILED" });
      const recovery = await open(first);
      await recovery.close(true);
      const next = await open(second);
      await next.close(true);
      const record = path.join(dirs.outside, "machine", "owner.jsonl");
      expect((await readFile(record, "utf8")).trim().split("\n")).toHaveLength(5);
      await appendFile(record, '{"torn":');
      await expect(open(second)).rejects.toThrow();
      expect(locked).toBe(false);
    } finally {
      await dirs.cleanup();
    }
  });
});
