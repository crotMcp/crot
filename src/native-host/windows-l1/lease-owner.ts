/** Service-lifetime owner of the native journal lock and all admitted leases. */
import path from "node:path";
import type { PrivateFileProtection } from "../../core/platform/types.js";
import { CrotError } from "../../core/errors.js";
import { loadAppContainerProfiles, type AppContainerProfile } from "./appcontainer-profile.js";
import { loadAppContainerActorDrain } from "./actor-drain.js";
import { loadLeaseAclObjects } from "./lease-acl.js";
import { openLeaseJournalStore, type LeaseJournalStore, type LeasePlan } from "./lease-journal.js";
import { loadWindowsLeaseLock } from "./lease-lock.js";
import { createNativeLeaseAdapter, planNativeLease } from "./lease-native.js";
import { WindowsLeaseRecovery } from "./lease-recovery.js";
import { loadAppContainerNetworkNative } from "./network-native.js";
import { openAppContainerNetwork, type AppContainerNetworkLease } from "./network.js";
import { openDurableProfiles, type DurableProfiles } from "./profile-receipts.js";
import { loadProfileReceiptNative } from "./profile-receipts-native.js";
import { openMachineAdmission, type MachineAdmission } from "./machine-admission.js";
const fail = (stage: string) => new CrotError("CONFINEMENT_FAILED", `Windows lease owner: ${stage} failed.`, { stage });
export interface LeaseRuntime {
  /** Disable admissions synchronously before awaiting actor/stdio drain. */
  close(): Promise<void>;
  closeSync(): void;
}
export interface NativeLease {
  readonly plan: LeasePlan;
  readonly profile: AppContainerProfile;
  readonly network: AppContainerNetworkLease;
  close(): Promise<void>;
  closeSync(): void;
}
type Live = {
  profile: AppContainerProfile;
  network?: AppContainerNetworkLease;
  runtime?: LeaseRuntime;
  stop(): Promise<void>;
};
export class WindowsNativeLeases {
  private tail: Promise<unknown> = Promise.resolve();
  private closing = false;
  private closed = false;
  private failed = false;
  private constructor(
    private readonly store: LeaseJournalStore,
    private readonly profiles: DurableProfiles,
    private readonly acl: Awaited<ReturnType<typeof loadLeaseAclObjects>>,
    private readonly networkNative: Awaited<ReturnType<typeof loadAppContainerNetworkNative>>,
    private readonly recovery: WindowsLeaseRecovery,
    private readonly live: Map<string, Live>,
    private readonly admission: MachineAdmission,
  ) {}
  static async open(options: {
    directory: string;
    ownerSid: string;
    privateFiles: PrivateFileProtection;
  }): Promise<WindowsNativeLeases> {
    const journalDirectory = path.join(options.directory, "journals"),
      receiptDirectory = path.join(options.directory, "profiles");
    await options.privateFiles.ensureDirectory(options.directory);
    const admission = await openMachineAdmission(options);
    let store: LeaseJournalStore;
    try {
      store = await openLeaseJournalStore({
        directory: journalDirectory,
        privateFiles: options.privateFiles,
        lock: await loadWindowsLeaseLock(),
      });
    } catch (cause) {
      await admission.close(false);
      throw cause;
    }
    try {
      const acl = await loadLeaseAclObjects(),
        network = await loadAppContainerNetworkNative(),
        drain = await loadAppContainerActorDrain();
      const profiles = await openDurableProfiles({
        directory: receiptDirectory,
        ownerSid: options.ownerSid,
        privateFiles: options.privateFiles,
        profiles: await loadAppContainerProfiles(),
        native: await loadProfileReceiptNative(),
      });
      // Validate the WHOLE profile inventory before any native compensation.
      const receipts = await profiles.receipts();
      const live = new Map<string, Live>();
      const recovery = new WindowsLeaseRecovery(
        store,
        createNativeLeaseAdapter({
          acl,
          profiles,
          ownerSid: options.ownerSid,
          journalDirectory,
          receiptDirectory,
          network,
          drain,
          live,
        }),
      );
      await recovery.recoverAll();
      const records = await store.list();
      // A durable S_OK profile may precede its ACL plan. No actor or ACL change
      // is legal before acquire, nevertheless verify zero actors and loopback.
      for (const r of receipts)
        if (!r.closed && !records.some((p) => p.plan.id === r.id)) {
          await drain(options.ownerSid, r.sid);
          await network.remove(r.sid);
          if (await network.contains(r.sid)) throw fail("unplanned profile network cleanup");
          await profiles.remove(r);
        }
      return new WindowsNativeLeases(store, profiles, acl, network, recovery, live, admission);
    } catch (cause) {
      await store.close();
      await admission.close(false);
      throw cause;
    }
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.tail.then(fn);
    this.tail = p.catch(() => undefined);
    return p;
  }
  openLease(options: {
    workspace: string;
    network: "on" | "off";
    writableRuntime: readonly string[];
    readOnlyRuntime: readonly string[];
    protectedPaths: readonly string[];
    start(profile: AppContainerProfile, network: AppContainerNetworkLease): Promise<LeaseRuntime>;
  }): Promise<NativeLease> {
    return this.serial(async () => {
      if (this.closing || this.failed) throw fail("admissions disabled");
      // Shared-ancestor ACL transactions are not silently stacked. Until a
      // shared-ancestor owner is qualified, only one active lease is admitted.
      if (this.live.size) throw fail("overlapping live lease");
      // Keep recent evidence, not an ever-growing admission limit. Prune only
      // fully closed WALs before their closed profile receipts. A crash between
      // those deletes leaves a harmless closed receipt, never lost ACL proof.
      const records = await this.store.list();
      const closed = records.filter((r) => r.closed);
      for (const record of closed.slice(0, Math.max(0, closed.length - 32))) {
        if (!this.store.pruneClosed) throw fail("journal rotation unavailable");
        await this.store.pruneClosed(record.plan.id);
        await this.profiles.pruneClosed(record.plan.profile);
      }
      const retained = new Set((await this.store.list()).map((r) => r.plan.id));
      for (const receipt of await this.profiles.receipts())
        if (receipt.closed && !retained.has(receipt.id)) await this.profiles.pruneClosed(receipt);
      const profile = await this.profiles.create();
      const owner: Live = {
        profile,
        stop: async () => {
          await owner.runtime?.close();
        },
      };
      this.live.set(profile.name, owner);
      let prepared: Awaited<ReturnType<typeof planNativeLease>> | undefined,
        acquired = false,
        planned = false;
      try {
        prepared = await planNativeLease({ ...options, acl: this.acl, profile });
        // Once acquire starts, even an unsuccessful write may have reached the
        // durable journal. Never delete the profile speculatively on that path.
        planned = true;
        await this.recovery.acquire(prepared.plan);
        acquired = true;
        prepared.close();
        owner.network = await openAppContainerNetwork(profile, this.store, this.networkNative);
        owner.runtime = await options.start(profile, owner.network);
        let closed = false;
        const plan = prepared.plan;
        return Object.freeze({
          plan,
          profile,
          network: owner.network,
          closeSync: () => owner.runtime?.closeSync(),
          close: () =>
            this.serial(async () => {
              if (closed) return;
              try {
                await owner.stop();
                await this.recovery.release(plan.id);
                closed = true;
              } catch (cause) {
                this.failed = true;
                throw cause;
              }
            }),
        });
      } catch (cause) {
        this.failed = true;
        prepared?.close();
        if (acquired) await this.recovery.release(profile.name.slice(8));
        else if (planned) await this.recovery.recoverAll();
        else {
          await this.profiles.remove(profile, profile);
          this.live.delete(profile.name);
        }
        throw cause;
      }
    });
  }
  closeSync(): void {
    this.closing = true;
    let error: unknown;
    for (const owner of this.live.values())
      try {
        owner.runtime?.closeSync();
      } catch (cause) {
        error ??= cause;
      }
    // No false synchronous ACL/profile cleanup claim: the durable open WAL is
    // intentionally retained for startup recovery after an abrupt exit.
    if (error) throw error;
  }
  close(): Promise<void> {
    this.closing = true;
    return this.serial(async () => {
      if (this.closed) return;
      for (const owner of [...this.live.values()]) {
        await owner.stop();
        await this.recovery.release(owner.profile.name.slice(8));
      }
      await this.store.close();
      await this.admission.close(true);
      this.closed = true;
    });
  }
}
