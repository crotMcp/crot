/** AD-29 owned network component. Not a complete Windows L1 backend. */
import { CrotError } from "../../core/errors.js";
import type { AppContainerProfile } from "./appcontainer-profile.js";
import type { LeaseJournalStore } from "./lease-journal.js";

export const WINDOWS_NETWORK_CAPABILITIES = Object.freeze([
  "S-1-15-3-1", // WinCapabilityInternetClientSid
  "S-1-15-3-2", // WinCapabilityInternetClientServerSid
  "S-1-15-3-3", // WinCapabilityPrivateNetworkClientServerSid
]);
export interface AppContainerNetworkNative {
  /** Read current state, never infer absence from a failed query. */
  contains(sid: string): Promise<boolean>;
  /** Target ONLY this SID; no saved global-list replacement, UAC or elevation. */
  add(sid: string): Promise<void>;
  remove(sid: string): Promise<void>;
}
export interface AppContainerNetworkPin {
  readonly capabilities: readonly string[];
  release(): void;
}
export interface AppContainerNetworkLease {
  readonly mode: "on" | "off";
  readonly sid: string;
  pin(profile: AppContainerProfile): AppContainerNetworkPin;
  /** Called only after every owned actor has drained; retryable on failure. */
  close(): Promise<void>;
}
const owners = new WeakSet<object>();
const fail = (stage: string) => new CrotError("CONFINEMENT_FAILED", `Windows network: ${stage} failed.`, { stage });

/** Branded owner check before the launch path consumes capabilities. */
export function pinAppContainerNetwork(
  lease: AppContainerNetworkLease,
  profile: AppContainerProfile,
): AppContainerNetworkPin {
  if (!owners.has(lease)) throw fail("unowned network lease");
  return lease.pin(profile);
}

/**
 * The complete immutable plan (including mode) MUST already be durable. A crash
 * after add but before return is compensated using that plan, not this object.
 * Profile freshness and native actor-drain validation remain the full adapter's
 * obligation; this component never adopts or deletes a profile.
 */
export async function openAppContainerNetwork(
  profile: AppContainerProfile,
  store: LeaseJournalStore,
  native: AppContainerNetworkNative,
): Promise<AppContainerNetworkLease> {
  const id = profile.name.slice("crot.l1.".length);
  const record = await store.read(id);
  if (
    record.closed ||
    record.plan.profile.name !== profile.name ||
    record.plan.profile.sid !== profile.sid ||
    record.plan.id !== id
  )
    throw fail("durable owned plan");
  const mode = record.plan.network;
  const profilePin = profile.pin();
  let users = 0,
    closing = false,
    closed = false;
  try {
    // A fresh owned profile must not already have an exemption. Never adopt it.
    if (await native.contains(profile.sid)) throw fail("unexpected pre-existing loopback exemption");
    if (mode === "on") await native.add(profile.sid);
    if ((await native.contains(profile.sid)) !== (mode === "on")) throw fail("loopback readback");
  } catch (cause) {
    // Do not guess whether add succeeded. Leave the durable plan open so the
    // recovery owner removes ONLY this SID before deleting the owned profile.
    profilePin.release();
    throw cause;
  }
  const lease: AppContainerNetworkLease = {
    mode,
    sid: profile.sid,
    pin: (expected) => {
      if (expected !== profile || closing || closed) throw fail("closed or foreign network lease");
      users++;
      let released = false;
      return {
        capabilities: mode === "on" ? WINDOWS_NETWORK_CAPABILITIES : Object.freeze([]),
        release: () => {
          if (!released) {
            released = true;
            users--;
          }
        },
      };
    },
    close: async () => {
      if (closed) return;
      closing = true;
      if (users !== 0) throw fail("network still owns actors");
      if (mode === "on") await native.remove(profile.sid);
      if (await native.contains(profile.sid)) throw fail("loopback removal readback");
      profilePin.release();
      closed = true;
    },
  };
  owners.add(lease);
  return lease;
}
