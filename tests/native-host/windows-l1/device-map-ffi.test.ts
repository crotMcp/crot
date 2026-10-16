/** Regression: the rejected mechanism cannot allocate objects or invoke native code. */
import { describe, expect, it } from "vitest";
import { bindPrivatePipeMaps } from "../../../src/native-host/windows-l1/device-map.js";
describe("rejected private DeviceMap", () => {
  it("fails closed without a native binding", () => {
    expect(bindPrivatePipeMaps).toThrow(/not a supported Windows L1 mechanism/);
    try {
      bindPrivatePipeMaps();
    } catch (error) {
      expect(error).toHaveProperty("code", "CONFINEMENT_UNAVAILABLE");
    }
  });
});
