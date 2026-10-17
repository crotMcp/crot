/** Injected inventory protocol, never a native actor-drain proof. */
import { describe, expect, it, vi } from "vitest";
import {
  drainAppContainerActors,
  loadAppContainerActorDrain,
  type ActorInventory,
} from "../../../src/native-host/windows-l1/actor-drain.js";
describe("owned AppContainer actor drain protocol (injected)", () => {
  it("requires two complete inventories, not parent exit or an empty Job name", async () => {
    const inspect = vi.fn(),
      candidates = vi.fn(() => []);
    expect(await drainAppContainerActors({ candidates, inspect })).toEqual({ terminated: 0, scans: 2, emptyScans: 2 });
    expect(candidates).toHaveBeenCalledTimes(2);
    expect(inspect).not.toHaveBeenCalled();
  });
  it("terminates only exact-token-owned actors and closes every observed owner", async () => {
    let alive = true;
    const kill = vi.fn(() => {
        alive = false;
      }),
      close = vi.fn(),
      foreignKill = vi.fn();
    const inventory: ActorInventory = {
      candidates: () => (alive ? [10, 20] : [20]),
      inspect: (pid) => ({
        state: pid === 10 ? "owned" : "foreign",
        terminateAndWait: pid === 10 ? kill : foreignKill,
        close,
      }),
    };
    expect(await drainAppContainerActors(inventory)).toEqual({ terminated: 1, scans: 3, emptyScans: 2 });
    expect(kill).toHaveBeenCalledOnce();
    expect(foreignKill).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(4);
  });
  it("rescans disappeared PIDs instead of treating a failed lookup as absence", async () => {
    let calls = 0;
    const close = vi.fn();
    const result = await drainAppContainerActors({
      candidates: () => (++calls === 1 ? [42] : []),
      inspect: () => ({ state: "gone", terminateAndWait: vi.fn(), close }),
    });
    expect(result.scans).toBe(3);
    expect(close).toHaveBeenCalledOnce();
  });
  it("includes newly-created descendants in subsequent inventories", async () => {
    let round = 0;
    const kills: number[] = [];
    const result = await drainAppContainerActors({
      candidates: () => (++round <= 2 ? [round] : []),
      inspect: (pid) => ({
        state: "owned",
        terminateAndWait: () => {
          kills.push(pid);
        },
        close: () => {},
      }),
    });
    expect(kills).toEqual([1, 2]);
    expect(result.scans).toBe(4);
  });
  it("does not hide inventory or token-query errors behind a success result", async () => {
    const inspect = vi.fn();
    await expect(
      drainAppContainerActors({
        candidates: () => {
          throw new Error("incomplete inventory");
        },
        inspect,
      }),
    ).rejects.toThrow("incomplete inventory");
    expect(inspect).not.toHaveBeenCalled();
    await expect(
      drainAppContainerActors({
        candidates: () => [1],
        inspect: () => {
          throw new Error("token denied");
        },
      }),
    ).rejects.toThrow("token denied");
  });
  it.each(["terminate", "close"])("retains failure instead of claiming drain on %s error", async (stage) => {
    const close = vi.fn(() => {
      if (stage === "close") throw new Error("close failed");
    });
    await expect(
      drainAppContainerActors({
        candidates: () => [1],
        inspect: () => ({
          state: "owned",
          terminateAndWait: () => {
            if (stage === "terminate") throw new Error("terminate failed");
          },
          close,
        }),
      }),
    ).rejects.toThrow(stage + " failed");
    expect(close).toHaveBeenCalledOnce();
  });
  it.each([{ pids: [1, 1] }, { pids: [-1] }, { pids: [0] }, { pids: [4294967296] }])(
    "refuses an ambiguous PID inventory $pids",
    async ({ pids }) => {
      const inspect = vi.fn();
      await expect(drainAppContainerActors({ candidates: () => pids, inspect })).rejects.toThrow("inventory shape");
      expect(inspect).not.toHaveBeenCalled();
    },
  );
  it("bounds repeated actor churn rather than allowing cleanup indefinitely", async () => {
    await expect(
      drainAppContainerActors({
        candidates: () => [1],
        inspect: () => ({ state: "gone", terminateAndWait: () => {}, close: () => {} }),
      }),
    ).rejects.toThrow("deadline");
  });
  it.runIf(process.platform !== "win32")("does not load native recovery on other operating systems", async () => {
    await expect(loadAppContainerActorDrain()).rejects.toMatchObject({ code: "CONFINEMENT_UNAVAILABLE" });
  });
});
