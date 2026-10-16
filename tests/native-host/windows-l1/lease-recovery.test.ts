/** Injected native adapter: protocol ordering/fault tests, NOT kernel evidence. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  WindowsLeaseRecovery,
  type LeaseRecoveryNative,
  type PinnedLeaseObject,
} from "../../../src/native-host/windows-l1/lease-recovery.js";
import type { LeaseJournalStore, LeasePlan, LeaseRecord } from "../../../src/native-host/windows-l1/lease-journal.js";
import { leasePlan } from "./lease-fixture.js";

describe("Windows lease recovery protocol", () => {
  let records: Map<string, LeaseRecord>, states: Map<string, ReturnType<PinnedLeaseObject["state"]>>, log: string[];
  let store: LeaseJournalStore, native: LeaseRecoveryNative, owner: WindowsLeaseRecovery;
  const key = (p: LeasePlan, i: number) => p.objects[i]!.identity.fileId;
  const makeOwner = () => new WindowsLeaseRecovery(store, native);
  beforeEach(async () => {
    records = new Map();
    states = new Map();
    log = [];
    store = {
      create: vi.fn(async (plan) => {
        log.push("plan-flush");
        if (records.has(plan.id)) throw new Error("exists");
        records.set(plan.id, { plan: structuredClone(plan), active: false, closed: false, jobs: [] });
      }),
      read: vi.fn(async (id) => {
        const r = records.get(id);
        if (!r) throw new Error("missing");
        return structuredClone(r);
      }),
      list: vi.fn(async () => structuredClone([...records.values()])),
      append: vi.fn(async (id, event) => {
        log.push(`${event.type}-flush`);
        const r = records.get(id)!;
        records.set(id, {
          ...r,
          active: r.active || event.type === "active",
          closed: event.type === "closed" || r.closed,
          jobs: event.type === "job" ? [...r.jobs, event.name] : r.jobs,
        });
      }),
      close: vi.fn(async () => {}),
    };
    native = {
      validatePlan: vi.fn(async () => {
        log.push("validate");
      }),
      holdGuards: vi.fn(async () => {
        log.push("hold-guards");
        return {
          close: () => {
            log.push("release-guards");
          },
        };
      }),
      drainActors: vi.fn(async () => {
        log.push("drain");
      }),
      pin: vi.fn((o) => {
        const id = o.identity.fileId;
        log.push(`pin-${id}`);
        return {
          state: () => states.get(id) ?? "original",
          apply: () => {
            log.push(`apply-${id}`);
            states.set(id, "planned");
          },
          restore: () => {
            log.push(`restore-${id}`);
            states.set(id, "original");
          },
          close: () => {
            log.push(`unpin-${id}`);
          },
        };
      }),
      stripNewWorkspaceObjects: vi.fn(async () => {
        log.push("strip-new");
      }),
      removeNetwork: vi.fn(async () => {
        log.push("remove-network");
      }),
      deleteProfile: vi.fn(async () => {
        log.push("delete-profile");
      }),
    };
    owner = makeOwner();
    await owner.recoverAll();
    log = [];
  });
  it("requires successful startup recovery before the first lease", async () => {
    const cold = makeOwner();
    await expect(cold.acquire(leasePlan())).rejects.toThrow("recovery required");
    expect(store.create).not.toHaveBeenCalled();
  });
  it("commits the WAL before mutation and job intent before returning the name", async () => {
    const p = leasePlan();
    await owner.acquire(p);
    const job = await owner.registerJob(p.id);
    expect(job).toMatch(/^Local\\crot-l1-job-[a-f0-9]{48}$/);
    expect(log.indexOf("plan-flush")).toBeLessThan(log.indexOf(`apply-${key(p, 0)}`));
    expect(log.indexOf("active-flush")).toBeGreaterThan(log.indexOf(`apply-${key(p, 2)}`));
    expect(log.at(-1)).toBe("job-flush");
    expect(records.get(p.id)!.jobs).toContain(job);
  });
  it("normal stop drains first, restores leaves, strips only workspace then deletes profile last", async () => {
    const p = leasePlan();
    await owner.acquire(p);
    log = [];
    await owner.release(p.id);
    expect(log.indexOf("drain")).toBeLessThan(log.indexOf(`pin-${key(p, 0)}`));
    expect(log.filter((s) => s.startsWith("restore-"))).toEqual([2, 1, 0].map((i) => `restore-${key(p, i)}`));
    expect(log.indexOf("strip-new")).toBeGreaterThan(log.lastIndexOf(`unpin-${key(p, 0)}`));
    expect(log.slice(-5)).toEqual(["strip-new", "release-guards", "remove-network", "delete-profile", "closed-flush"]);
    expect(records.get(p.id)!.closed).toBe(true);
  });
  it("retains an open WAL and profile when network cleanup fails", async () => {
    const p = leasePlan();
    p.network = "on";
    await owner.acquire(p);
    vi.mocked(native.removeNetwork).mockRejectedValueOnce(new Error("loopback removal"));
    await expect(owner.release(p.id)).rejects.toThrow("loopback removal");
    expect(native.deleteProfile).not.toHaveBeenCalled();
    expect(records.get(p.id)!.closed).toBe(false);
    await owner.release(p.id);
    expect(records.get(p.id)!.closed).toBe(true);
  });
  it("recovers an uncommitted partial apply after owner death and is idempotent", async () => {
    const p = leasePlan();
    await store.create(p);
    states.set(key(p, 0), "planned");
    const restarted = makeOwner();
    await restarted.recoverAll();
    expect(states.get(key(p, 0))).toBe("original");
    expect(records.get(p.id)!.closed).toBe(true);
    vi.mocked(native.drainActors).mockClear();
    await makeOwner().recoverAll();
    expect(native.drainActors).not.toHaveBeenCalled();
  });
  it("recovers a durable job intent whose native job was never created", async () => {
    const p = leasePlan();
    await owner.acquire(p);
    const name = await owner.registerJob(p.id);
    // Simulate process death: new owner, same durable store/native state.
    await makeOwner().recoverAll();
    expect(native.drainActors).toHaveBeenCalledWith(expect.objectContaining({ jobs: [name] }));
    expect(records.get(p.id)!.closed).toBe(true);
  });
  it("validates every WAL before any recovery side effect", async () => {
    const p = leasePlan(),
      q = leasePlan();
    await store.create(p);
    await store.create(q);
    vi.mocked(native.validatePlan).mockImplementation(async (v) => {
      if (v.id === q.id) throw new Error("invalid SID");
    });
    await expect(makeOwner().recoverAll()).rejects.toThrow("invalid SID");
    expect(native.drainActors).not.toHaveBeenCalled();
    expect(native.pin).not.toHaveBeenCalled();
  });
  it("preflights the complete transaction: a late foreign change prevents ALL ACL writes", async () => {
    const p = leasePlan();
    await owner.acquire(p);
    states.set(key(p, 2), "conflict");
    log = [];
    await expect(owner.release(p.id)).rejects.toThrow("foreign descriptor conflict");
    expect(log.some((s) => s.startsWith("restore-"))).toBe(false);
    expect(native.deleteProfile).not.toHaveBeenCalled();
    expect(records.get(p.id)!.closed).toBe(false);
    await expect(owner.registerJob(p.id)).rejects.toThrow("recovery required");
  });
  it("missing/reused object identity never falls back to a saved path", async () => {
    const p = leasePlan();
    await owner.acquire(p);
    const orig = vi.mocked(native.pin).getMockImplementation()!;
    vi.mocked(native.pin).mockImplementation((o) => {
      if (o.identity.fileId === key(p, 2)) throw new Error("file ID reused");
      return orig(o);
    });
    await expect(owner.release(p.id)).rejects.toThrow("file ID reused");
    expect(native.deleteProfile).not.toHaveBeenCalled();
    expect(records.get(p.id)!.closed).toBe(false);
  });
  it("failure to drain the Job prevents even opening ACL mutation handles", async () => {
    const p = leasePlan();
    await owner.acquire(p);
    vi.mocked(native.pin).mockClear();
    vi.mocked(native.drainActors).mockRejectedValue(new Error("actors still live"));
    await expect(owner.release(p.id)).rejects.toThrow("actors still live");
    expect(native.pin).not.toHaveBeenCalled();
    expect(native.deleteProfile).not.toHaveBeenCalled();
  });
  it.each(["apply", "active", "job"])("a %s failure disables subsequent admission", async (stage) => {
    const p = leasePlan();
    if (stage === "apply")
      vi.mocked(native.pin).mockImplementation(() => ({
        state: () => "original",
        apply: () => {
          throw new Error("apply failed");
        },
        restore: () => {},
        close: () => {},
      }));
    if (stage === "active") vi.mocked(store.append).mockRejectedValue(new Error("flush failed"));
    if (stage !== "job") await expect(owner.acquire(p)).rejects.toThrow();
    else {
      await owner.acquire(p);
      vi.mocked(store.append).mockRejectedValue(new Error("flush failed"));
      await expect(owner.registerJob(p.id)).rejects.toThrow();
    }
    await expect(owner.acquire(leasePlan())).rejects.toThrow("recovery required");
    expect(records.get(p.id)!.closed).toBe(false);
  });
  it.each(["strip", "profile", "tombstone"])(
    "retries recovery after %s failure without advertising success",
    async (stage) => {
      const p = leasePlan();
      await owner.acquire(p);
      if (stage === "strip")
        vi.mocked(native.stripNewWorkspaceObjects).mockRejectedValueOnce(new Error("strip failed"));
      if (stage === "profile") vi.mocked(native.deleteProfile).mockRejectedValueOnce(new Error("profile busy"));
      if (stage === "tombstone") vi.mocked(store.append).mockRejectedValueOnce(new Error("flush failed"));
      await expect(owner.release(p.id)).rejects.toThrow();
      expect(records.get(p.id)!.closed).toBe(false);
      if (stage === "strip") expect(native.deleteProfile).not.toHaveBeenCalled();
      await owner.release(p.id);
      expect(records.get(p.id)!.closed).toBe(true);
      await makeOwner().recoverAll();
    },
  );
  it("failed CloseHandle remains owned and blocks admissions until explicitly retried", async () => {
    const p = leasePlan();
    let closeFails = true,
      closeCalls = 0;
    vi.mocked(native.pin).mockImplementation(() => ({
      state: () => "original",
      apply: () => {
        throw new Error("no mutation");
      },
      restore: () => {},
      close: () => {
        closeCalls++;
        if (closeFails) throw new Error("CloseHandle failed");
      },
    }));
    await expect(owner.acquire(p)).rejects.toThrow("pinned handle release");
    await expect(owner.recoverAll()).rejects.toThrow("pinned handle release");
    closeFails = false;
    await owner.recoverAll();
    expect(closeCalls).toBeGreaterThan(3);
    expect(records.get(p.id)!.closed).toBe(true);
  });
  it("recovery cannot compensate an active lease owned by this live instance", async () => {
    const p = leasePlan();
    await owner.acquire(p);
    await expect(owner.recoverAll()).rejects.toThrow("live owner recovery");
    expect(native.drainActors).not.toHaveBeenCalled();
    await owner.release(p.id);
  });
  it("concurrent job intents and shutdown are serialised; no post-close job is admitted", async () => {
    const p = leasePlan();
    await owner.acquire(p);
    const job = owner.registerJob(p.id),
      closed = owner.release(p.id),
      late = owner.registerJob(p.id);
    expect(await job).toMatch(/crot-l1-job/);
    await closed;
    await expect(late).rejects.toThrow("unowned active lease");
    expect(records.get(p.id)!.jobs).toHaveLength(1);
  });
  it("refuses overlapping identities across live Cores before a second WAL or ACL write", async () => {
    const p = leasePlan(),
      q = leasePlan();
    await owner.acquire(p);
    vi.mocked(store.create).mockClear();
    vi.mocked(native.pin).mockClear();
    await expect(owner.acquire(q)).rejects.toThrow("overlapping lease identities");
    expect(store.create).not.toHaveBeenCalled();
    expect(native.pin).not.toHaveBeenCalled();
    expect(records.has(q.id)).toBe(false);
    await owner.release(p.id);
  });
  it("keeps runtime rename guards until drain and successful cleanup; failed guard close is retryable", async () => {
    const p = leasePlan(),
      close = vi
        .fn()
        .mockImplementationOnce(() => {
          throw new Error("guard close failed");
        })
        .mockImplementation(() => {});
    vi.mocked(native.holdGuards).mockResolvedValue({ close });
    await owner.acquire(p);
    expect(close).not.toHaveBeenCalled();
    await expect(owner.release(p.id)).rejects.toThrow("guard close failed");
    expect(native.drainActors).toHaveBeenCalled();
    expect(native.deleteProfile).not.toHaveBeenCalled();
    await owner.release(p.id);
    expect(close).toHaveBeenCalledTimes(2);
    expect(records.get(p.id)!.closed).toBe(true);
  });
  it("does not mutate ACLs after WAL flush fails", async () => {
    vi.mocked(store.create).mockRejectedValueOnce(new Error("fsync failed"));
    await expect(owner.acquire(leasePlan())).rejects.toThrow("fsync failed");
    expect(native.pin).not.toHaveBeenCalled();
    expect(native.holdGuards).not.toHaveBeenCalled();
  });
  it("forgets an active lease when closed was durable but the storage completion failed", async () => {
    const p = leasePlan();
    await owner.acquire(p);
    const append = vi.mocked(store.append).getMockImplementation()!;
    vi.mocked(store.append).mockImplementationOnce(async (id, event) => {
      await append(id, event);
      throw new Error("close after durable tombstone failed");
    });
    await expect(owner.release(p.id)).rejects.toThrow("durable tombstone");
    expect(records.get(p.id)!.closed).toBe(true);
    await owner.release(p.id);
    await owner.recoverAll();
    // Without forgetting the active id, recovery would permanently refuse.
    expect(records.get(p.id)!.closed).toBe(true);
  });
});
