import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { KNOWN_OPERATIONS } from "../../src/core/approvals/operations.js";
import { CAPABILITIES } from "../../src/core/permissions/capabilities.js";

async function sources(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((e) => (e.isDirectory() ? sources(path.join(dir, e.name)) : [path.join(dir, e.name)])),
  );
  return files.flat().filter((f) => f.endsWith(".ts"));
}

describe("gate rule operation names", () => {
  it("KNOWN_OPERATIONS lists exactly the operation names the capability services use", async () => {
    const found = new Set<string>();
    for (const file of await sources(path.join(import.meta.dirname, "../../src/core/capabilities"))) {
      const text = await readFile(file, "utf8");
      for (const match of text.matchAll(/"((?:filesystem|process|git|docker|network|browser)\.[a-z_]+)"/g))
        found.add(match[1] as string);
    }
    for (const capability of CAPABILITIES) found.delete(capability);
    expect([...found].sort()).toEqual([...KNOWN_OPERATIONS].sort());
  });
});
