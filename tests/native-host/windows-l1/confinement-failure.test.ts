import { describe, expect, it } from "vitest";
import type { ConfinementScope, ConfinementStatus } from "../../../src/core/platform/types.js";
import { WindowsConfinement } from "../../../src/native-host/windows-l1/confinement.js";
describe("Windows post-admission failure", () => {
  it("never lets refresh turn an admitted sandbox into a local unconfined launch", async () => {
    const provider = new WindowsConfinement({} as never);
    let available = true;
    provider.probe = async () =>
      ({
        mechanism: "windows-appcontainer",
        available,
        network: "off",
        reason: available ? null : "self_test_failed",
        detail: null,
      }) as ConfinementStatus;
    const confined = await provider.open({ network: "off" } as ConfinementScope);
    available = false;
    await expect(confined.refresh()).rejects.toMatchObject({ code: "CONFINEMENT_FAILED" });
    expect(confined.status().available).toBe(false);
    await expect(confined.launcher.resolveCommand("node", [], {} as never)).rejects.toMatchObject({
      code: "CONFINEMENT_FAILED",
    });
    await confined.close();
  });
  it("retains the distinct unavailable contract before any admission", async () => {
    const provider = new WindowsConfinement({} as never);
    provider.probe = async () => ({
      mechanism: "windows-appcontainer",
      available: false,
      network: "off",
      reason: "components_missing",
      detail: null,
    });
    const confined = await provider.open({ network: "off" } as ConfinementScope);
    expect((await confined.refresh()).available).toBe(false);
    await expect(confined.launcher.resolveCommand("node", [], {} as never)).rejects.toMatchObject({
      code: "CONFINEMENT_UNAVAILABLE",
    });
  });
});
