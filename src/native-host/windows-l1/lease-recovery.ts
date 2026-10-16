/** AD-29 recovery ordering. Native adapter admission is deliberately separate. */
import { randomBytes } from "node:crypto";
import { CrotError } from "../../core/errors.js";
import type { LeaseJournalStore, LeaseObject, LeasePlan, LeaseRecord } from "./lease-journal.js";

const fail = (stage: string) =>
  new CrotError("CONFINEMENT_FAILED", `Windows lease recovery: ${stage} failed.`, { stage });

export interface PinnedLeaseObject {
  /**
   * Exact O/G/label/raw DACL/control comparison performed by native code.
   * A changed owner, label, foreign ACE, file identity or reparse is CONFLICT,
   * never absence and never permission to restore by a saved pathname.
   */
  state(): "original" | "planned" | "conflict";
  /** Native compare-and-write on the SAME pinned object; no inheritance walk. */
  apply(): void;
  restore(): void;
  /** Release resources only, MUST NOT implicitly change any ACL. */
  close(): void;
}
export interface LeaseRecoveryNative {
  /**
   * Validate a fresh profile receipt, SID derivation, actual volume identities,
   * before/after descriptors and scope BEFORE accepting a journal plan. The
   * journal location must be outside all writable sandbox trees, by handle,
   * not merely by case-folded pathname. No adoption of existing profiles.
   */
  validatePlan(plan: LeasePlan, phase: "acquire" | "recover"): Promise<void>;
  /** Retain root/ancestor/protected/link rename guards until actors drain.
   * Ordinary renameable files keep IDs rather than obstructing directory rename.
   * This owner performs no ACL writes or implicit cleanup on close. */
  holdGuards(plan: LeasePlan): Promise<{ close(): void }>;
  /**
   * Terminate/wait every owned Job AND verify no actor for this package SID
   * remains, including after owner crash or a job-create/journal boundary.
   * Unknown job, PID reuse, query failure or ambiguous drain is an error.
   * Called for incomplete (not-active) plans too; MUST be idempotent.
   */
  drainActors(record: LeaseRecord): Promise<void>;
  /** Open by volume + file ID + creation time, reject reparse/reuse, retain pin. */
  pin(object: LeaseObject): PinnedLeaseObject;
  /**
   * AFTER original snapshot restore: remove only owned SID ACEs on newly
   * created workspace descendants, preserving every foreign byte/control bit.
   * Do not traverse temp/cache or follow reparse/hardlink aliases. Any ambiguity
   * retains the journal. The native adapter identifies the saved workspace by
   * handle, and must make this pass repeatable across interrupted cleanup.
   */
  stripNewWorkspaceObjects(plan: LeasePlan): Promise<void>;
  /** Delete only this fresh owned profile; already-deleted success is verified. */
  deleteProfile(plan: LeasePlan): Promise<void>;
}

/**
 * Service-lifetime owner. Every public operation is serialised. A failed native
 * or storage operation blocks all subsequent launches/admissions; recoverAll
 * explicitly retries compensation. No failed close/recovery is reported as
 * success, and no catch path starts an unconfined replacement process.
 */
export class WindowsLeaseRecovery {
  private tail: Promise<unknown> = Promise.resolve();
  private blocked = true;
  private recovered = false;
  private readonly active = new Set<string>();
  private readonly guards = new Map<string, { close(): void }>();
  /** Pins whose CloseHandle failed remain owned until a successful retry. */
  private readonly pendingPins = new Set<PinnedLeaseObject>();
  constructor(
    private readonly store: LeaseJournalStore,
    private readonly native: LeaseRecoveryNative,
  ) {}

  private serial<T>(action: () => Promise<T>): Promise<T> {
    const result = this.tail.then(action);
    this.tail = result.catch(() => undefined);
    return result;
  }
  private releasePins(pins: readonly PinnedLeaseObject[]): void {
    let error: unknown;
    for (const pin of [...pins].reverse()) {
      this.pendingPins.add(pin);
      try {
        pin.close();
        this.pendingPins.delete(pin);
      } catch (cause) {
        error ??= cause;
      }
    }
    if (error) throw fail("pinned handle release");
  }
  private requireReady(): void {
    if (this.blocked || !this.recovered) throw fail("recovery required");
  }
  private async cleanup(record: LeaseRecord): Promise<void> {
    if (record.closed) return;
    await this.native.validatePlan(record.plan, "recover");
    // Never infer actor death from parent exit, a missing lock or elapsed time.
    await this.native.drainActors(record);
    const pins: PinnedLeaseObject[] = [];
    try {
      // Complete preflight BEFORE first ACL write. Hold every identity until
      // restore readback finishes. Native restore must recheck its SD as well.
      for (const object of record.plan.objects) pins.push(this.native.pin(object));
      for (const pin of pins) if (pin.state() === "conflict") throw fail("foreign descriptor conflict");
      // Plan is topologically ordered (ancestor/root before leaves); restore
      // leaves first, with direct nonpropagating object-handle writes.
      for (const pin of [...pins].reverse()) {
        if (pin.state() === "conflict") throw fail("descriptor changed during recovery");
        if (pin.state() === "planned") pin.restore();
        if (pin.state() !== "original") throw fail("restored descriptor readback");
      }
    } finally {
      this.releasePins(pins);
    }
    await this.native.stripNewWorkspaceObjects(record.plan);
    const guard = this.guards.get(record.plan.id);
    if (guard) {
      guard.close();
      this.guards.delete(record.plan.id);
    }
    await this.native.deleteProfile(record.plan);
    // Crash before this durable tombstone simply retries idempotent cleanup.
    await this.store.append(record.plan.id, { type: "closed" });
    this.active.delete(record.plan.id);
  }

  /** Startup gate. Do not call while this owner has live leases. */
  recoverAll(): Promise<void> {
    return this.serial(async () => {
      if (this.active.size) throw fail("live owner recovery");
      this.blocked = true;
      this.releasePins([...this.pendingPins]);
      const records = await this.store.list();
      // Validate every plan before a native compensation side effect anywhere.
      for (const r of records) if (!r.closed) await this.native.validatePlan(r.plan, "recover");
      for (const record of records) await this.cleanup(record);
      this.recovered = true;
      this.blocked = false;
    });
  }

  /**
   * Fresh native profile receipt + complete precomputed SD transaction only.
   * The caller must not resume ANY actor until this succeeds and its job intent
   * is durable. Failed apply is compensated from the already committed WAL.
   */
  acquire(plan: LeasePlan): Promise<void> {
    return this.serial(async () => {
      this.requireReady();
      const pins: PinnedLeaseObject[] = [];
      let failure: unknown;
      try {
        await this.native.validatePlan(plan, "acquire");
        const occupied = new Set(
          (await this.store.list())
            .filter((r) => !r.closed)
            .flatMap((r) => r.plan.objects.map((o) => `${o.identity.volume}:${o.identity.fileId}`)),
        );
        if (plan.objects.some((o) => occupied.has(`${o.identity.volume}:${o.identity.fileId}`)))
          throw fail("overlapping lease identities");
        await this.store.create(plan);
        const durable = await this.store.read(plan.id);
        this.guards.set(plan.id, await this.native.holdGuards(durable.plan));
        for (const object of durable.plan.objects) pins.push(this.native.pin(object));
        for (const pin of pins) if (pin.state() !== "original") throw fail("initial descriptor changed");
        for (let i = 0; i < pins.length; i++) {
          const pin = pins[i]!,
            object = durable.plan.objects[i]!;
          pin.apply();
          const state = pin.state();
          if (state !== "planned" && !(state === "original" && object.original === object.planned))
            throw fail("installed descriptor readback");
        }
        await this.store.append(plan.id, { type: "active" });
        this.active.add(plan.id);
      } catch (error) {
        this.blocked = true;
        failure = error;
      }
      try {
        this.releasePins(pins);
      } catch (error) {
        this.blocked = true;
        failure = error;
      }
      if (failure) throw failure;
    });
  }

  /** Durable job-create intent. Only after return may native code create it. */
  registerJob(id: string): Promise<string> {
    return this.serial(async () => {
      this.requireReady();
      if (!this.active.has(id)) throw fail("unowned active lease");
      const name = `Local\\crot-l1-job-${randomBytes(24).toString("hex")}`;
      try {
        await this.store.append(id, { type: "job", name });
      } catch (error) {
        this.blocked = true;
        throw error;
      }
      return name;
    });
  }

  /** Normal close: same stop -> exact restore -> new ACE cleanup -> profile order. */
  release(id: string): Promise<void> {
    return this.serial(async () => {
      // Cleanup is allowed in a blocked instance; actor admissions are not.
      try {
        const record = await this.store.read(id);
        // Exact plan membership is not inferred from a caller-provided name.
        if (!this.active.has(id) && !record.closed) throw fail("unowned lease release");
        await this.cleanup(record);
      } catch (error) {
        this.blocked = true;
        throw error;
      }
    });
  }
}
