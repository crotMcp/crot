import { describe, expect, it, vi } from "vitest";
import {
  createAppContainerProfiles,
  assertOwnedAppContainerProfile,
  loadAppContainerProfiles,
  type AppContainerProfileNative,
} from "../../../src/native-host/windows-l1/appcontainer-profile.js";
const nonce = () => "12345678-1234-4123-8123-123456789abc";
const sid = "S-1-15-2-1-2-3-4-5-6-7";
function fixture() {
  const allocation = {};
  const native: AppContainerProfileNative = {
    create: vi.fn((_name, out) => {
      out.value = allocation;
      return 0;
    }),
    sidText: vi.fn(() => sid),
    remove: vi.fn(() => 0),
    freeSid: vi.fn(),
  };
  return { native, profiles: createAppContainerProfiles(native, nonce), allocation };
}
describe("AppContainer profile ownership (portable lifecycle, not kernel isolation)", () => {
  it("owns only a fresh S_OK profile and releases exactly once", () => {
    const { native, profiles, allocation } = fixture();
    const p = profiles.create();
    expect(p.sid).toBe(sid);
    expect(native.create).toHaveBeenCalledWith(`crot.l1.${nonce()}`, { value: allocation });
    p.close();
    p.close();
    expect(p.closed).toBe(true);
    expect(native.remove).toHaveBeenCalledTimes(1);
    expect(native.freeSid).toHaveBeenCalledExactlyOnceWith(allocation);
    expect(() => p.pin()).toThrow(/closed profile/);
  });
  it("brands only fresh S_OK owners, freezes identity and rejects copies/closed owners", () => {
    const { profiles } = fixture(),
      p = profiles.create();
    expect(Object.isFrozen(p)).toBe(true);
    expect(p.name).toBe(`crot.l1.${nonce()}`);
    expect(() => assertOwnedAppContainerProfile(p)).not.toThrow();
    expect(() => assertOwnedAppContainerProfile({ ...p })).toThrow("unowned profile");
    p.close();
    expect(() => assertOwnedAppContainerProfile(p)).toThrow("unowned profile");
  });
  it("holds the profile until all Job owners release their pins", () => {
    const { native, profiles } = fixture();
    const p = profiles.create(),
      a = p.pin(),
      b = p.pin();
    expect(a.sid).toBe(sid);
    expect(() => p.close()).toThrow(/still owns actors/);
    expect(native.remove).not.toHaveBeenCalled();
    expect(() => p.pin()).toThrow(/closed profile/);
    a.release();
    a.release();
    expect(() => p.close()).toThrow(/still owns actors/);
    b.release();
    p.close();
    expect(p.closed).toBe(true);
  });
  it.each([1, -2147024713, -2147024891])("does not adopt/delete a non-S_OK profile (%i)", (status) => {
    const { native, profiles, allocation } = fixture();
    vi.mocked(native.create).mockImplementation((_name, out) => {
      out.value = allocation;
      return status;
    });
    expect(() => profiles.create()).toThrow(/profile creation/);
    expect(native.remove).not.toHaveBeenCalled();
    expect(native.freeSid).toHaveBeenCalledExactlyOnceWith(allocation);
  });
  it.each(["S-1-5-32-545", "S-1-15-2-1", "S-1-15-2-1-2-3-4-5-6-4294967296", "S-1-15-2-01-2-3-4-5-6-7"])(
    "rejects malformed package SID %s",
    (invalid) => {
      const { native, profiles } = fixture();
      vi.mocked(native.sidText).mockReturnValue(invalid);
      expect(() => profiles.create()).toThrow(/SID validation/);
      expect(native.remove).toHaveBeenCalledOnce();
      expect(native.freeSid).toHaveBeenCalledOnce();
    },
  );
  it("cleans an owned S_OK profile with a missing SID", () => {
    const { native, profiles } = fixture();
    vi.mocked(native.create).mockReturnValue(0);
    expect(() => profiles.create()).toThrow(/SID allocation/);
    expect(native.remove).toHaveBeenCalledOnce();
    expect(native.freeSid).not.toHaveBeenCalled();
  });
  it("retains failed setup cleanup and blocks new allocation until recovery", () => {
    const { native, profiles } = fixture();
    vi.mocked(native.sidText).mockImplementation(() => {
      throw new Error("native output");
    });
    vi.mocked(native.remove).mockReturnValue(-1);
    expect(() => profiles.create()).toThrow(/profile setup/);
    expect(() => profiles.create()).toThrow(/profile removal/);
    expect(native.create).toHaveBeenCalledOnce();
    expect(native.freeSid).not.toHaveBeenCalled();
    vi.mocked(native.remove).mockReturnValue(0);
    profiles.recover();
    profiles.recover();
    expect(native.freeSid).toHaveBeenCalledOnce();
  });
  it("retries failed SID release without deleting the profile twice", () => {
    const { native, profiles } = fixture();
    const p = profiles.create();
    vi.mocked(native.freeSid).mockImplementationOnce(() => {
      throw new Error("release");
    });
    expect(() => p.close()).toThrow();
    expect(p.closed).toBe(false);
    expect(() => p.pin()).toThrow(/closed profile/);
    p.close();
    expect(native.remove).toHaveBeenCalledOnce();
    expect(native.freeSid).toHaveBeenCalledTimes(2);
  });
  it("retries failed profile deletion without freeing its SID early", () => {
    const { native, profiles } = fixture();
    const p = profiles.create();
    vi.mocked(native.remove).mockReturnValueOnce(-1);
    expect(() => p.close()).toThrow(/profile removal/);
    expect(native.freeSid).not.toHaveBeenCalled();
    p.close();
    expect(p.closed).toBe(true);
  });
  it("never deletes a profile after a throwing creation only populated an output", () => {
    const { native, profiles, allocation } = fixture();
    vi.mocked(native.create).mockImplementation((_name, out) => {
      out.value = allocation;
      throw new Error("create");
    });
    expect(() => profiles.create()).toThrow(/profile setup/);
    expect(native.remove).not.toHaveBeenCalled();
    expect(native.freeSid).toHaveBeenCalledExactlyOnceWith(allocation);
  });
  it("rejects an injected non-fresh name before any native call", () => {
    const { native } = fixture();
    expect(() => createAppContainerProfiles(native, () => "existing-profile").create()).toThrow(/fresh identity/);
    expect(native.create).not.toHaveBeenCalled();
  });
});
describe.runIf(process.platform === "win32")("real Windows AppContainer profile API", () => {
  it("creates two independent profiles, holds ownership and deletes both", async () => {
    const api = await loadAppContainerProfiles();
    const first = api.create();
    let second: ReturnType<typeof api.create> | undefined;
    let pin: ReturnType<typeof first.pin> | undefined;
    try {
      second = api.create();
      expect(first.sid).toMatch(/^S-1-15-2-(?:[0-9]+-){6}[0-9]+$/);
      expect(second.sid).not.toBe(first.sid);
      pin = first.pin();
      expect(() => first.close()).toThrow(/still owns actors/);
      pin.release();
      first.close();
      expect(first.closed).toBe(true);
    } finally {
      pin?.release();
      second?.close();
      first.close();
    }
  });
});
it.skipIf(process.platform === "win32")("refuses unsupported platforms without importing an OS binding", async () => {
  await expect(loadAppContainerProfiles()).rejects.toMatchObject({ code: "CONFINEMENT_UNAVAILABLE" });
});
