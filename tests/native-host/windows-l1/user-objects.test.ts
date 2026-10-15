/** Portable native-contract injection; not Windows kernel qualification. */
import { describe, expect, it, vi } from "vitest";
import { bindOwnedUserObjects, validateOwnedDesktopName } from "../../../src/native-host/windows-l1/user-objects.js";
const name = `crot-${"a".repeat(48)}`,
  owner = "S-1-5-21-1-2-3-1001",
  unique = "S-1-5-21-4-5-6-1002";
function fixture(failure?: string) {
  let last = 0;
  const events: string[] = [];
  const canonical = `O:${owner}D:P(A;;GA;;;${owner})(A;;GA;;;SY)(A;;GA;;;${unique})S:(ML;;NW;;;LW)`;
  let encoded = canonical;
  const calls = {
    GetLastError: vi.fn(() => last),
    SetLastError: vi.fn((n: number) => {
      last = n;
    }),
    LocalFree: vi.fn(() => null),
    GetCurrentThreadId: vi.fn(() => 4),
    ConvertStringSecurityDescriptorToSecurityDescriptorW: vi.fn((_s, _r, out) => {
      out.value = 50n;
      return 1;
    }),
    ConvertSecurityDescriptorToStringSecurityDescriptorW: vi.fn((_sd, _r, _i, out, length) => {
      encoded = failure === "bad-label" && Buffer.isBuffer(_sd) ? canonical.replace(";;;LW)", ";;;ME)") : canonical;
      out.value = 60n;
      length.value = encoded.length + 1;
      return 1;
    }),
    GetUserObjectSecurity: vi.fn((_h, _i, sd, _length, needed) => {
      needed.value = 64;
      return sd === null ? 0 : 1;
    }),
    SetUserObjectSecurity: vi.fn((_h: unknown, _info: Buffer, _sd: unknown) => (failure === "label-set" ? 0 : 1)),
    GetProcessWindowStation: vi.fn(() => 10n),
    GetThreadDesktop: vi.fn(() => 11n),
    SetProcessWindowStation: vi.fn((h) => {
      events.push(`station:${h}`);
      return failure === "associate" && h === 20n ? 0 : 1;
    }),
    SetThreadDesktop: vi.fn((h) => {
      events.push(`desktop:${h}`);
      return 1;
    }),
    CreateWindowStationW: vi.fn(() => {
      if (failure === "collision") last = 183;
      return 20n;
    }),
    GetUserObjectInformationW: vi.fn((_h, _k, b: Buffer) => {
      b.writeUInt32LE(failure === "visible" ? 1 : 0, 8);
      return 1;
    }),
    CreateDesktopW: vi.fn(() => (failure === "create" ? null : 21n)),
    CloseDesktop: vi.fn((h) => {
      events.push(`closeDesktop:${h}`);
      return failure === "close" ? 0 : 1;
    }),
    CloseWindowStation: vi.fn((h) => {
      events.push(`closeStation:${h}`);
      return 1;
    }),
  };
  const ffi = {
    decode: { string16: () => encoded },
    struct: () => undefined,
    sizeof: () => 24,
    load: () => ({
      func: (s: string) => {
        const n = /\b(\w+)\(/.exec(s)?.[1];
        if (!n || !(n in calls)) throw new Error("Unexpected declaration");
        return calls[n as keyof typeof calls];
      },
    }),
  } as unknown as Parameters<typeof bindOwnedUserObjects>[0];
  return { create: bindOwnedUserObjects(ffi), calls, events };
}
describe("Owned noninteractive Win32 desktop contract", () => {
  it("grants only explicit owner, SYSTEM and unique SID on NEW noninheritable objects", () => {
    const f = fixture(),
      owned = f.create(name, owner, unique);
    expect(f.calls.ConvertStringSecurityDescriptorToSecurityDescriptorW.mock.calls[0]![0]).toBe(
      `O:${owner}D:P(A;;GA;;;${owner})(A;;GA;;;SY)(A;;GA;;;${unique})S:(ML;;NW;;;LW)`,
    );
    expect(f.calls.CreateWindowStationW).toHaveBeenCalledWith(name, 0, 0xf037f, {
      length: 24,
      descriptor: 50n,
      inherit: 0,
    });
    expect(f.calls.CreateDesktopW).toHaveBeenCalledWith("actor", null, null, 0, 0xf01ff, {
      length: 24,
      descriptor: 50n,
      inherit: 0,
    });
    expect(f.events).toEqual(["station:20", "station:10", "desktop:11"]);
    expect(owned.desktop).toBe(`${name}\\actor`);
    owned.close();
    owned.close();
    expect(f.calls.CloseDesktop.mock.calls).toEqual([[21n]]);
    expect(f.calls.CloseWindowStation.mock.calls).toEqual([[20n]]);
    expect(f.calls.LocalFree).toHaveBeenCalledWith(50n);
    expect(
      f.calls.SetUserObjectSecurity.mock.calls.map((args) => [args[0], (args[1] as Buffer).readUInt32LE(), args[2]]),
    ).toEqual([
      [20n, 0x10, 50n],
      [21n, 0x10, 50n],
    ]);
  });
  it.each(["collision", "visible", "associate", "create"])(
    "fails closed at %s and never closes borrowed handles",
    (failure) => {
      const f = fixture(failure);
      expect(() => f.create(name, owner, unique)).toThrow();
      expect(f.calls.CloseWindowStation.mock.calls).toEqual([[20n]]);
      expect(f.calls.CloseDesktop).not.toHaveBeenCalled();
      expect(f.calls.LocalFree).toHaveBeenCalledWith(50n);
      if (failure === "create") expect(f.events.slice(0, 3)).toEqual(["station:20", "station:10", "desktop:11"]);
    },
  );
  it("rejects a kernel descriptor whose actual label differs, before readiness", () => {
    const f = fixture("bad-label");
    expect(() => f.create(name, owner, unique)).toThrow("security descriptor verification");
    expect(f.calls.CloseDesktop).toHaveBeenCalledWith(21n);
    expect(f.calls.CloseWindowStation).toHaveBeenCalledWith(20n);
  });
  it("fails closed if explicit Low-label installation fails and still restores/closes only owned objects", () => {
    const f = fixture("label-set");
    expect(() => f.create(name, owner, unique)).toThrow("station low label install");
    expect(f.calls.CloseDesktop).toHaveBeenCalledWith(21n);
    expect(f.calls.CloseWindowStation).toHaveBeenCalledWith(20n);
    expect(f.events.slice(0, 3)).toEqual(["station:20", "station:10", "desktop:11"]);
  });
  it("retains failed owned close for retry without claiming success", () => {
    const f = fixture("close"),
      owned = f.create(name, owner, unique);
    expect(() => owned.close()).toThrow("desktop close");
    f.calls.CloseDesktop.mockImplementation(() => 1);
    owned.close();
    expect(f.calls.CloseDesktop.mock.calls).toEqual([[21n], [21n]]);
    expect(f.calls.CloseWindowStation.mock.calls).toEqual([[20n]]);
  });
  it("rejects interactive/arbitrary names and identical SIDs before creating objects", () => {
    for (const n of ["WinSta0\\Default", `${name}\\other`, "crot-1\\actor"])
      expect(() => validateOwnedDesktopName(n)).toThrow();
    const f = fixture();
    expect(() => f.create(name, owner, owner)).toThrow();
    expect(f.calls.CreateWindowStationW).not.toHaveBeenCalled();
  });
});
