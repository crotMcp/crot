import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { CoreHolder } from "../../src/service/core-holder.js";
import type { CoreCompositionHandle } from "../../src/core/crot-core.js";
import { createTestCore, makeTempDirs, testContext } from "../helpers.js";
it("a retired Core rejects held capability references, and an exclusive holder lease closes workflow/adapter admission", async () => {
  const dirs = await makeTempDirs();
  let handle: CoreCompositionHandle | undefined;
  const core = await createTestCore(
    { workspace: { root: dirs.workspace }, permissions: { mode: "full_control" } },
    undefined,
    {
      composition: (h) => {
        handle = h;
      },
    },
  );
  try {
    await writeFile(path.join(dirs.workspace, "public.txt"), "public");
    const holder = new CoreHolder(core, handle!),
      held = holder.core.filesystem,
      lease = holder.pauseAdmission();
    expect(() => held.readFile(testContext, { path: "public.txt" })).toThrow("transition");
    await expect(holder.hold(async () => "unexpected")).rejects.toMatchObject({ code: "RESOURCE_BUSY" });
    expect(() => holder.swap(core, handle!)).toThrow("transition");
    await core.shutdown();
    await expect(core.filesystem.readFile(testContext, { path: "public.txt" })).rejects.toMatchObject({
      code: "RESOURCE_BUSY",
    });
    lease.release();
    await expect(held.readFile(testContext, { path: "public.txt" })).rejects.toMatchObject({ code: "RESOURCE_BUSY" });
    expect(() => lease.install(core, handle!)).toThrow("lease");
  } finally {
    await core.shutdown();
    await dirs.cleanup();
  }
});
