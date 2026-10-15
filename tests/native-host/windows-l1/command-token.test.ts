import { describe, expect, it, vi } from "vitest";
import { createCommandToken } from "../../../src/native-host/windows-l1/command-token.js";
import type { RestrictedToken, RestrictedTokenApi } from "../../../src/native-host/windows-l1/restricted-token.js";
const owner = "S-1-5-21-1-2-3-1000";
function fixture(stage?: "prepare" | "lower") {
  const token: RestrictedToken = {
    closed: false,
    restrictingSid: "S-1-5-21-1-2-3-1001",
    prepareProbeObjects: vi.fn(() => {
      if (stage === "prepare") throw new Error("prepare failed");
    }),
    lowerProbeIntegrity: vi.fn(() => {
      if (stage === "lower") throw new Error("lower failed");
    }),
    close: vi.fn(),
    fileDaclAccess: vi.fn(),
    launchProbe: vi.fn(),
  };
  const api: RestrictedTokenApi = { create: vi.fn(() => token) };
  return { api, token };
}
describe("unique write-filter command token", () => {
  it("uses a fresh unique write SID with no common/logon restricting grants, then prepares and lowers", () => {
    const f = fixture();
    expect(createCommandToken(f.api, owner)).toBe(f.token);
    createCommandToken(f.api, owner);
    const calls = vi.mocked(f.api.create).mock.calls;
    expect(calls[0]).toEqual([expect.stringMatching(/^S-1-5-21-(\d+-){3}\d+$/), false, undefined, "write-only"]);
    expect(calls[0]![0]).not.toBe(calls[1]![0]);
    expect(f.token.prepareProbeObjects).toHaveBeenCalledWith(owner);
    expect(f.token.lowerProbeIntegrity).toHaveBeenCalledTimes(2);
    expect(f.token.close).not.toHaveBeenCalled();
  });
  it.each(["prepare", "lower"] as const)(
    "closes the new token and never returns a weaker fallback after %s failure",
    (stage) => {
      const f = fixture(stage);
      expect(() => createCommandToken(f.api, owner)).toThrow(`${stage} failed`);
      expect(f.api.create).toHaveBeenCalledOnce();
      expect(f.token.close).toHaveBeenCalledOnce();
    },
  );
  it("does not create a token for a malformed trusted owner identity", () => {
    const f = fixture();
    expect(() => createCommandToken(f.api, "invalid")).toThrow();
    expect(f.api.create).not.toHaveBeenCalled();
  });
});
