/** Injected lifecycle/config tests; not Windows kernel evidence. */
import { describe, expect, it, vi } from "vitest";
import { createAppContainerProfiles } from "../../../src/native-host/windows-l1/appcontainer-profile.js";
import {
  openAppContainerNetwork,
  pinAppContainerNetwork,
  WINDOWS_NETWORK_CAPABILITIES,
} from "../../../src/native-host/windows-l1/network.js";
import {
  createAppContainerNetworkNative,
  loadAppContainerNetworkNative,
  type LoopbackEntry,
} from "../../../src/native-host/windows-l1/network-native.js";
import type { LeaseJournalStore } from "../../../src/native-host/windows-l1/lease-journal.js";
import { leasePlan } from "./lease-fixture.js";
const id = "12345678-1234-4123-8123-123456789abc",
  sid = "S-1-15-2-1-2-3-4-5-6-7";
function fixture(mode: "on" | "off" = "on") {
  const removeProfile = vi.fn(() => 0);
  const profile = createAppContainerProfiles(
    {
      create: (_n, out) => {
        out.value = {};
        return 0;
      },
      sidText: () => sid,
      remove: removeProfile,
      freeSid: () => {},
    },
    () => id,
  ).create();
  const plan = leasePlan(id);
  plan.network = mode;
  const read = vi.fn(async () => ({ plan, closed: false, active: false, jobs: [] }));
  const store = { read } as unknown as LeaseJournalStore;
  let rows: LoopbackEntry[] = [{ sid: "S-1-15-2-9-9-9-9-9-9-9", attributes: 4 }];
  const change = vi.fn(async (target: string, add: boolean) => {
    rows = rows.filter((r) => r.sid !== target);
    if (add) rows.push({ sid: target, attributes: 4 });
  });
  const list = vi.fn(() => structuredClone(rows));
  const native = createAppContainerNetworkNative({ list, change });
  return { profile, plan, read, store, native, change, list, removeProfile };
}
describe("Windows owned network protocol (injected)", () => {
  it("uses exactly the three authorised capability SIDs", () => {
    expect(WINDOWS_NETWORK_CAPABILITIES).toEqual(["S-1-15-3-1", "S-1-15-3-2", "S-1-15-3-3"]);
    expect(Object.isFrozen(WINDOWS_NETWORK_CAPABILITIES)).toBe(true);
  });
  it.each(["on", "off"] as const)("owns only the durable SID for %s and preserves foreign config", async (mode) => {
    const f = fixture(mode),
      before = f.list();
    const lease = await openAppContainerNetwork(f.profile, f.store, f.native);
    const pin = pinAppContainerNetwork(lease, f.profile);
    expect(pin.capabilities).toEqual(mode === "on" ? WINDOWS_NETWORK_CAPABILITIES : []);
    expect(f.change.mock.calls).toEqual(mode === "on" ? [[sid, true]] : []);
    pin.release();
    pin.release();
    await lease.close();
    await lease.close();
    expect(f.list()).toEqual(before);
    expect(f.change.mock.calls).toEqual(
      mode === "on"
        ? [
            [sid, true],
            [sid, false],
          ]
        : [],
    );
    f.profile.close();
    expect(f.removeProfile).toHaveBeenCalledOnce();
  });
  it.each(["closed", "name", "sid", "id"])("refuses a %s plan before native changes", async (kind) => {
    const f = fixture();
    if (kind === "closed") f.read.mockResolvedValue({ plan: f.plan, closed: true, active: false, jobs: [] });
    if (kind === "name") f.plan.profile.name += "x";
    if (kind === "sid") f.plan.profile.sid += "-1";
    if (kind === "id") f.plan.id += "x";
    await expect(openAppContainerNetwork(f.profile, f.store, f.native)).rejects.toThrow("durable owned plan");
    expect(f.change).not.toHaveBeenCalled();
    f.profile.close();
  });
  it("reserves the profile before any await and rejects concurrent owners", async () => {
    const f = fixture();
    const first = openAppContainerNetwork(f.profile, f.store, f.native);
    await expect(openAppContainerNetwork(f.profile, f.store, f.native)).rejects.toThrow("already reserved");
    const lease = await first;
    expect(Object.isFrozen(lease)).toBe(true);
    await lease.close();
    f.profile.close();
  });
  it("rejects a structural profile before querying WAL or network state", async () => {
    const f = fixture();
    await expect(openAppContainerNetwork({ ...f.profile }, f.store, f.native)).rejects.toThrow("unowned profile");
    expect(f.read).not.toHaveBeenCalled();
    expect(f.list).not.toHaveBeenCalled();
    f.profile.close();
  });
  it("never grants without a successful durable WAL read", async () => {
    const f = fixture();
    f.read.mockRejectedValueOnce(new Error("disk"));
    await expect(openAppContainerNetwork(f.profile, f.store, f.native)).rejects.toThrow("disk");
    expect(f.list).not.toHaveBeenCalled();
    f.profile.close();
  });
  it("refuses adoption of an existing exception", async () => {
    const f = fixture();
    await f.native.add(sid);
    f.change.mockClear();
    await expect(openAppContainerNetwork(f.profile, f.store, f.native)).rejects.toThrow("pre-existing");
    expect(f.change).not.toHaveBeenCalled();
    await f.native.remove(sid);
    f.profile.close();
  });
  it("refuses network close while an actor pin is alive, then retries", async () => {
    const f = fixture(),
      lease = await openAppContainerNetwork(f.profile, f.store, f.native),
      pin = lease.pin(f.profile);
    await expect(lease.close()).rejects.toThrow("still owns actors");
    expect(() => lease.pin(f.profile)).toThrow("closed or foreign");
    expect(f.change).toHaveBeenCalledTimes(1);
    pin.release();
    await lease.close();
    f.profile.close();
  });
  it("pins the profile until network removal succeeds", async () => {
    const f = fixture(),
      lease = await openAppContainerNetwork(f.profile, f.store, f.native);
    f.change.mockRejectedValueOnce(new Error("remove denied"));
    await expect(lease.close()).rejects.toThrow("remove denied");
    expect(() => f.profile.close()).toThrow("still owns actors");
    expect(f.removeProfile).not.toHaveBeenCalled();
    await lease.close();
    f.profile.close();
  });
  it("does not accept a forged lease or a different profile object", async () => {
    const f = fixture(),
      lease = await openAppContainerNetwork(f.profile, f.store, f.native);
    expect(() => pinAppContainerNetwork({ ...lease }, f.profile)).toThrow("unowned");
    expect(() => lease.pin({ ...f.profile })).toThrow("foreign");
    await lease.close();
    f.profile.close();
  });
  it("detects ignored add/remove, never reports their readback as success", async () => {
    const f = fixture();
    f.change.mockImplementationOnce(async () => {});
    await expect(openAppContainerNetwork(f.profile, f.store, f.native)).rejects.toThrow("readback");
    f.profile.close();
  });
  it("detects foreign concurrent changes without writing a saved global list", async () => {
    let rows: LoopbackEntry[] = [],
      calls = 0;
    const native = createAppContainerNetworkNative({
      list: () => structuredClone(rows),
      change: async (target) => {
        calls++;
        rows = [
          { sid: target, attributes: 4 },
          { sid: "foreign", attributes: 4 },
        ];
      },
    });
    await expect(native.add(sid)).rejects.toThrow("foreign configuration");
    expect(calls).toBe(1);
    expect(rows.some((r) => r.sid === "foreign")).toBe(true);
  });
  it("validates target SIDs and never guesses query failure as absence", async () => {
    const f = fixture();
    await expect(f.native.add("S-1-1-0")).rejects.toThrow("admission");
    await expect(f.native.add("S-1-15-2-01-2-3-4-5-6-7")).rejects.toThrow("admission");
    f.list.mockImplementationOnce(() => {
      throw new Error("query denied");
    });
    await expect(f.native.contains(sid)).rejects.toThrow("query denied");
    expect(f.change).not.toHaveBeenCalled();
    f.profile.close();
  });
  it("serialises targeted modifications and refuses duplicate configuration SIDs", async () => {
    const f = fixture();
    await Promise.all([f.native.add(sid), f.native.remove(sid)]);
    expect(f.change.mock.calls).toEqual([
      [sid, true],
      [sid, false],
    ]);
    f.list.mockReturnValueOnce([
      { sid, attributes: 4 },
      { sid, attributes: 4 },
    ]);
    await expect(f.native.contains(sid)).rejects.toThrow("duplicate");
    f.profile.close();
  });
  it.runIf(process.platform !== "win32")("refuses the native adapter outside Windows", async () => {
    await expect(loadAppContainerNetworkNative()).rejects.toMatchObject({ code: "CONFINEMENT_UNAVAILABLE" });
  });
});
