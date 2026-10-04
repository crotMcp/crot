import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CrotError } from "../../src/core/errors.js";
import { createTestCore, makeTempDirs, testContext, type TempDirs } from "../helpers.js";

let dirs: TempDirs;
beforeEach(async () => {
  dirs = await makeTempDirs();
});
afterEach(async () => {
  await dirs.cleanup();
});

describe("network.access in CrotCore", () => {
  it("is denied by default in sandbox mode", async () => {
    const core = await createTestCore({ workspace: { root: dirs.workspace } });
    try {
      const error = await core.network.request(testContext, { url: "http://127.0.0.1:9/" }).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(CrotError);
      expect((error as CrotError).code).toBe("PERMISSION_DENIED");
      const status = core.status();
      expect(status.capabilities.find((c) => c.capability === "network.access")).toEqual({
        capability: "network.access",
        granted: false,
        enforced: true,
      });
      expect(status.network).toMatchObject({ allow: [], deny: [] });
    } finally {
      await core.shutdown();
    }
  });

  it("is refused without an allow rule even when granted", async () => {
    const core = await createTestCore({
      workspace: { root: dirs.workspace },
      permissions: { mode: "sandbox", capabilities: ["network.access"] },
    });
    try {
      const error = await core.network.request(testContext, { url: "http://127.0.0.1:9/" }).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect((error as CrotError).code).toBe("PERMISSION_DENIED");
    } finally {
      await core.shutdown();
    }
  });

  it("rejects sandbox configs with an unrestricted network policy", async () => {
    await expect(
      createTestCore({
        workspace: { root: dirs.workspace },
        permissions: { mode: "sandbox", capabilities: ["network.access"], network: { allow: ["*"] } },
      }),
    ).rejects.toThrow(CrotError);
  });
});
