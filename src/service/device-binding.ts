/**
 * Device binding (ARCHITECTURE.md §27, AD-21 points 4 and 5; WP-28): which
 * account this device is paired with, its device id and the identity
 * environment of the pairing, plus the device credential.
 *
 * - The binding is kept in the service's protected private state
 *   (`device-binding.json`); the device credential's seed in the CROT secret
 *   store (`device-key`, AD-18). Both are written only by pairing and
 *   unpairing, which run only for requests on the authenticated control
 *   channel (AD-17 point 7, AD-19).
 * - Every pairing assigns a new device id (AD-21 point 5) and a new device
 *   key: a device that was unpaired is a new resource when it is paired
 *   again, so no token, client grant or tunnel credential of the earlier
 *   pairing applies to it.
 * - Fail closed: a binding file that cannot be read or is malformed, or a
 *   paired binding whose device key is missing or invalid, is "unavailable":
 *   no token is accepted and no tunnel credential is given out. Unpairing
 *   resets that state.
 * - Unpairing takes effect in memory at once, even when the state cannot be
 *   written (reported to the user, as client revocation does, AD-19 point 8).
 * - The device key is generated before the pairing finishes, because the
 *   relay registers its public key during pairing (AD-22 point 4; WP-30).
 *   Before registration the seed and an inactive recovery intent are stored
 *   and read back. They survive failed registration/commit until signed
 *   compensation succeeds. Without a staged key `pair` generates one.
 */
import { rm } from "node:fs/promises";
import type { RemovalCredential } from "../identity/relay-registration.js";
import type { KeyObject } from "node:crypto";
import {
  devicePublicKey,
  deviceKeyFromSeed,
  signTunnelProof,
  signDeregistrationProof,
  type DevicePublicKey,
} from "../identity/device-credential.js";
import { isDeviceId, isRelayHost } from "../identity/device-id.js";
import { isIssuer, type IdentityEnvironment } from "../identity/environment.js";
import type { BindingView } from "../identity/verifier.js";
import type { PrivateFileProtection } from "../core/platform/types.js";
import { isRecord, readStateFile, writeStateFile } from "./private-state.js";
import { generateSecret, type SecretStore } from "./secrets/store.js";
import { isValidRemoteId } from "./remote-clients.js";

export const DEVICE_BINDING_FILE_NAME = "device-binding.json";
const FORMAT_VERSION = 1;

/** The secret-store operations the binding needs (the device key only). */
export type DeviceKeyStore = Pick<SecretStore, "read" | "write"> & {
  readonly backend: { delete(name: "device-key"): Promise<void>; readonly description: string };
};

export interface PairedBinding {
  readonly deviceId: string;
  readonly accountId: string;
  readonly environment: string;
  readonly issuer: string;
  readonly relayHost: string;
  readonly pairedAt: string;
}

type Stored =
  { readonly state: "unpaired"; readonly unpairedAt?: string } | ({ readonly state: "paired" } & PairedBinding);

/** The tunnel credential of a paired device (WP-29/WP-30 use it to open the tunnel). */
export interface TunnelCredential {
  readonly deviceId: string;
  readonly relayHost: string;
  readonly publicKey: DevicePublicKey;
  /** Sign a relay challenge (domain-separated, device-credential.ts). */
  prove(challenge: Uint8Array): Buffer;
}

export type TunnelCredentialResult =
  | { readonly ok: true; readonly credential: TunnelCredential }
  | {
      readonly ok: false;
      readonly reason: "not_paired" | "state_unavailable" | "environment_mismatch" | "no_environment";
    };

function parse(text: string): Stored | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || value.version !== FORMAT_VERSION) return undefined;
  if (value.state === "unpaired") {
    if (value.unpairedAt !== undefined && typeof value.unpairedAt !== "string") return undefined;
    return { state: "unpaired", ...(typeof value.unpairedAt === "string" ? { unpairedAt: value.unpairedAt } : {}) };
  }
  if (value.state !== "paired") return undefined;
  const { deviceId, accountId, environment, issuer, relayHost, pairedAt } = value;
  if (!isDeviceId(deviceId) || !isValidRemoteId(accountId) || !isIssuer(issuer) || !isRelayHost(relayHost))
    return undefined;
  if (typeof environment !== "string" || typeof pairedAt !== "string") return undefined;
  return { state: "paired", deviceId, accountId, environment, issuer, relayHost, pairedAt };
}

function serialize(stored: Stored): string {
  return JSON.stringify({ version: FORMAT_VERSION, ...stored }) + "\n";
}

export class DeviceBindingStore {
  private key: KeyObject | undefined;
  /** The key a pairing registered at the relay, until `pair` stores it (memory only). */
  private staged: { readonly deviceId: string; readonly seed: string } | undefined;

  private constructor(
    readonly file: string,
    private readonly privateFiles: PrivateFileProtection,
    private readonly secrets: DeviceKeyStore,
    private stored: Stored,
    private failure: string | undefined,
    key: KeyObject | undefined,
    private readonly now: () => number,
  ) {
    this.key = key;
  }

  static async open(
    file: string,
    privateFiles: PrivateFileProtection,
    secrets: DeviceKeyStore,
    options: { readonly now?: () => number } = {},
  ): Promise<DeviceBindingStore> {
    const now = options.now ?? Date.now;
    const make = (stored: Stored, failure?: string, key?: KeyObject) =>
      new DeviceBindingStore(file, privateFiles, secrets, stored, failure, key, now);
    let read;
    try {
      read = await readStateFile(file);
    } catch (error) {
      return make({ state: "unpaired" }, `cannot read ${file}: ${message(error)}`);
    }
    if (read.kind === "missing") return make({ state: "unpaired" });
    const stored = parse(read.text);
    if (!stored) return make({ state: "unpaired" }, `${file} is malformed`);
    if (stored.state !== "paired") return make(stored);
    let key: KeyObject;
    try {
      const seed = await secrets.read("device-key");
      if (seed === undefined) return make(stored, `the device key is missing from ${secrets.backend.description}`);
      key = deviceKeyFromSeed(seed);
    } catch (error) {
      return make(stored, `the device key cannot be read: ${message(error)}`);
    }
    // A crash after the binding commit can leave its now-obsolete inactive intent.
    await rm(file + ".registration", { force: true }).catch(() => undefined);
    return make(stored, undefined, key);
  }

  /** Why the binding cannot be used; undefined when it can. */
  get error(): string | undefined {
    return this.failure;
  }

  /** The paired binding, if the device is paired and its state is usable. */
  get paired(): PairedBinding | undefined {
    if (this.failure !== undefined || this.stored.state !== "paired") return undefined;
    const { state: _state, ...binding } = this.stored;
    return binding;
  }

  /** What the token verifier sees (read on every request). */
  view(): BindingView {
    if (this.failure !== undefined) return { state: "unavailable", error: this.failure };
    if (this.stored.state !== "paired") return { state: "unpaired" };
    const { deviceId, accountId, issuer, relayHost } = this.stored;
    return { state: "paired", deviceId, accountId, issuer, relayHost };
  }

  /** The public key of the paired device (shown in the tray, recorded by the CROT cloud). */
  get publicKey(): DevicePublicKey | undefined {
    return this.paired && this.key ? devicePublicKey(this.key) : undefined;
  }

  /** Durable, inactive intent and verified secret BEFORE any remote registration. */
  async prepareRegistration(deviceId: string, seed: string, relayHost: string): Promise<void> {
    if (this.paired || this.failure) throw new Error("not unpaired");
    if (!isDeviceId(deviceId) || !isRelayHost(relayHost)) throw new Error("invalid registration intent");
    deviceKeyFromSeed(seed);
    await this.secrets.write("device-key", seed);
    if ((await this.secrets.read("device-key")) !== seed) throw new Error("device key readback failed");
    const text = JSON.stringify({ version: 1, deviceId, relayHost }) + "\n";
    await writeStateFile(this.file + ".registration", text, this.privateFiles);
    const read = await readStateFile(this.file + ".registration");
    if (read.kind !== "text" || read.text !== text) throw new Error("registration intent readback failed");
    this.stageDeviceKey(deviceId, seed);
  }

  /** A pending intent is never an active binding or tunnel credential. */
  async pendingRegistration(): Promise<RemovalCredential | undefined> {
    if (this.paired) return undefined;
    const read = await readStateFile(this.file + ".registration");
    if (read.kind === "missing") return undefined;
    const value = JSON.parse(read.text) as { version?: number; deviceId?: unknown; relayHost?: unknown };
    if (value.version !== 1 || !isDeviceId(value.deviceId) || !isRelayHost(value.relayHost))
      throw new Error("invalid registration intent");
    const seed = await this.secrets.read("device-key");
    if (!seed) throw new Error("pending registration key missing");
    const key = deviceKeyFromSeed(seed),
      deviceId = value.deviceId,
      relayHost = value.relayHost;
    return { deviceId, relayHost, prove: (challenge) => signDeregistrationProof(key, deviceId, relayHost, challenge) };
  }
  async clearRegistration(): Promise<void> {
    await rm(this.file + ".registration", { force: true });
    if (!this.paired) await this.secrets.backend.delete("device-key");
  }
  removalCredential(): RemovalCredential | undefined {
    const paired = this.paired,
      key = this.key;
    if (!paired || !key) return undefined;
    const { deviceId, relayHost } = paired;
    return { deviceId, relayHost, prove: (challenge) => signDeregistrationProof(key, deviceId, relayHost, challenge) };
  }

  /**
   * Record a completed pairing: a new device key in the secret store first,
   * then the binding. Only from the unpaired state; failure leaves no active
   * binding. A pending registration retains its key for signed compensation;
   * a legacy local-only failed write removes its unused key.
   */
  async pair(binding: Omit<PairedBinding, "pairedAt">, environment: IdentityEnvironment): Promise<PairedBinding> {
    const staged = this.staged?.deviceId === binding.deviceId ? this.staged.seed : undefined;
    this.staged = undefined;
    if (this.failure !== undefined || this.stored.state !== "unpaired")
      throw new Error("the device is not in the unpaired state");
    if (binding.issuer !== environment.issuer || binding.relayHost !== environment.relayHost)
      throw new Error("the pairing does not belong to the active identity environment");
    if (!isDeviceId(binding.deviceId) || !isValidRemoteId(binding.accountId))
      throw new Error("the pairing has an invalid device id or account");
    const seed = staged ?? generateSecret();
    const key = deviceKeyFromSeed(seed);
    await this.secrets.write("device-key", seed);
    const paired: PairedBinding = { ...binding, pairedAt: new Date(this.now()).toISOString() };
    try {
      await writeStateFile(this.file, serialize({ state: "paired", ...paired }), this.privateFiles);
    } catch (error) {
      const pending = await this.pendingRegistration().catch(() => undefined);
      if (!pending) await this.secrets.backend.delete("device-key").catch(() => undefined);
      throw error;
    }
    this.stored = { state: "paired", ...paired };
    this.key = key;
    await rm(this.file + ".registration", { force: true }).catch(() => undefined);
    return paired;
  }

  /**
   * Unpair: no token is accepted and no tunnel credential is given out from
   * now on (in memory at once). Then the state is written and the device key
   * removed; problems are reported, never undone. If only one of the two
   * succeeds, a restart still finds no usable pairing: a paired binding
   * without its key is unavailable (fail closed).
   */
  async unpair(): Promise<{ readonly persisted: boolean; readonly keyRemoved: boolean; readonly errors: string[] }> {
    const wasPaired = this.stored.state === "paired";
    this.staged = undefined;
    this.stored = { state: "unpaired", unpairedAt: new Date(this.now()).toISOString() };
    this.failure = undefined;
    this.key = undefined;
    const errors: string[] = [];
    let persisted = true;
    try {
      await writeStateFile(this.file, serialize(this.stored), this.privateFiles);
    } catch (error) {
      persisted = false;
      errors.push(`the device binding could not be written: ${message(error)}`);
    }
    if (wasPaired) {
      try {
        await rm(this.file + ".registration", { force: true });
      } catch (error) {
        errors.push(`obsolete registration intent could not be removed: ${message(error)}`);
      }
    }
    let keyRemoved = true;
    try {
      await this.secrets.backend.delete("device-key");
    } catch (error) {
      keyRemoved = false;
      errors.push(`the device key could not be removed from ${this.secrets.backend.description}: ${message(error)}`);
    }
    return { persisted, keyRemoved, errors };
  }

  /**
   * Stage the device key of a pairing in progress whose public key the relay
   * registered (AD-22 point 4). Memory only; replaced by the next pairing and
   * dropped by `pair`, `unpair` and `clearStagedKey`.
   */
  stageDeviceKey(deviceId: string, seed: string): void {
    if (!isDeviceId(deviceId)) throw new Error("invalid device id");
    deviceKeyFromSeed(seed);
    this.staged = { deviceId, seed };
  }

  /** Drop a staged key (the pairing failed); only the given device id's. */
  clearStagedKey(deviceId: string): void {
    if (this.staged?.deviceId === deviceId) this.staged = undefined;
  }

  /**
   * The tunnel credential (AD-15 point 10): only for a paired device in the
   * identity environment of its pairing. An unpaired device, a device whose
   * state is unavailable, or one paired in another environment has none.
   */
  tunnelCredential(environment: IdentityEnvironment | undefined): TunnelCredentialResult {
    if (this.failure !== undefined) return { ok: false, reason: "state_unavailable" };
    const paired = this.paired;
    const key = this.key;
    if (!paired || !key) return { ok: false, reason: "not_paired" };
    if (!environment) return { ok: false, reason: "no_environment" };
    if (paired.issuer !== environment.issuer || paired.relayHost !== environment.relayHost)
      return { ok: false, reason: "environment_mismatch" };
    const { deviceId, relayHost } = paired;
    return {
      ok: true,
      credential: {
        deviceId,
        relayHost,
        publicKey: devicePublicKey(key),
        prove: (challenge) => {
          // A credential handed out before an unpairing stops working with it.
          if (this.key !== key || this.paired?.deviceId !== deviceId) throw new Error("the device is no longer paired");
          return signTunnelProof(key, deviceId, relayHost, challenge);
        },
      },
    };
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
