import { describe, expect, it, vi } from "vitest";
import { WindowsNativeLeases } from "../../../src/native-host/windows-l1/lease-owner.js";
const fixture = vi.hoisted(() => ({
  prepared: { plan: { id: "00000000-0000-4000-8000-000000000001" }, close: vi.fn() },
}));
vi.mock("../../../src/native-host/windows-l1/lease-native.js", () => ({
  planNativeLease: vi.fn(async () => fixture.prepared),
  createNativeLeaseAdapter: vi.fn(),
}));
describe("fresh profile cleanup when admission refuses before any WAL", () => {
  it.each([false, true])("retires only proven absence, retains unreadable evidence (corrupt=%s)", async (corrupt) => {
    const profile = { name: "crot.l1.00000000-0000-4000-8000-000000000001", sid: "S-1-15-2-1-2-3-4-5-6-7" };
    const live = new Map(),
      remove = vi.fn(async () => undefined),
      start = vi.fn(),
      acquire = vi.fn(async () => {
        throw new Error("validation refused before store.create");
      });
    const recoverAll = vi.fn(async () => undefined);
    const list = vi.fn(async () => []);
    if (corrupt)
      list
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockImplementationOnce(async () => {
          throw new Error("corrupt WAL inventory");
        });
    const owner = Reflect.construct(WindowsNativeLeases, [
      { list },
      { create: async () => profile, receipts: async () => [], remove },
      {},
      {},
      { acquire, recoverAll },
      live,
      {},
    ]) as WindowsNativeLeases;
    await expect(
      owner.openLease({
        workspace: "C:\\workspace",
        network: "off",
        writableRuntime: [],
        readOnlyRuntime: [],
        protectedPaths: [],
        start,
      }),
    ).rejects.toThrow(corrupt ? "corrupt WAL inventory" : "validation refused");
    expect(acquire).toHaveBeenCalledOnce();
    expect(recoverAll).toHaveBeenCalledOnce();
    expect(start).not.toHaveBeenCalled();
    if (corrupt) {
      expect(remove).not.toHaveBeenCalled();
      expect(live.size).toBe(1);
    } else {
      expect(remove).toHaveBeenCalledExactlyOnceWith(profile, profile);
      expect(live.size).toBe(0);
    }
    await expect(
      owner.openLease({
        workspace: "C:\\workspace",
        network: "off",
        writableRuntime: [],
        readOnlyRuntime: [],
        protectedPaths: [],
        start,
      }),
    ).rejects.toThrow("admissions disabled");
  });
});
