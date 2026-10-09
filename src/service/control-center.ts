/**
 * Device-side controls of the service on the authenticated control channel
 * (ARCHITECTURE.md §27, AD-19): the tray approval provider, the preset,
 * remote mode, the remote full-control opt-in, exposure reset, client
 * revocation and re-grant, device pairing and unpairing (WP-28), the
 * overview and the admission of remote requests.
 *
 * This is the only code that changes these settings, and it runs only for
 * requests on the control channel (AD-17 point 7). It makes no permission
 * decision: approvals are decided by the user through the broker's tickets,
 * and the preset becomes policy only by building a new Core (AD-19 point 5).
 */
import type {
  RemoteAdmission,
  RemoteAdmissionDecision,
  RemoteClientKey,
  RemoteTokenFacts,
} from "../adapters/http/server.js";
import type { PairingOutcome } from "../identity/pairing.js";
import type { UntrustedContentSetting } from "../core/approvals/exposure.js";
import type { RemoteExposureResettable, RemoteExposureStore } from "../core/approvals/remote-exposure.js";
import type { PresentedApproval, TerminalApprovalStatus } from "../core/approvals/types.js";
import { newAuditEventId, type ControlAuditAction, type ControlAuditRecord } from "../core/audit/audit.js";
import { remoteExposureScope } from "../core/auth/principal.js";
import type { CoreCompositionHandle, CrotCore } from "../core/crot-core.js";
import type { BrowserConnectionState } from "../core/capabilities/browser/connection.js";
import type { ServiceStatus } from "../core/service-status.js";
import type { CoreHolder } from "./core-holder.js";
import type { DeviceBindingStore } from "./device-binding.js";
import type { DeviceSettingsStore } from "./device-settings.js";
import type { DeviceIdentity } from "./identity.js";
import type {
  ControlEvent,
  ControlOverview,
  ControlRefusal,
  ControlRequest,
  PairingView,
  PresetValue,
  RemoteClientParams,
  RemoteClientView,
} from "./protocol.js";
import { isValidRemoteId, type RemoteClientRegistry } from "./remote-clients.js";
import { TrayApprovalProvider, type ApprovalSubscriber } from "./tray-provider.js";

/** Presets the PermissionEngine implements today (AD-19 point 5). */
export const SELECTABLE_PRESETS: readonly PresetValue[] = Object.freeze(["require-approval", "off"]);
const UNAVAILABLE_PRESETS = Object.freeze([
  {
    value: "autonomous-browser" as const,
    reason: "The Autonomous browser preset is implemented by WP-31 (remote permission profile and presets).",
  },
]);
/** How restrictive a preset is: higher gates more. */
const PRESET_RANK: Readonly<Record<PresetValue, number>> = { off: 0, "autonomous-browser": 1, "require-approval": 2 };

export const FULL_CONTROL_NOTE =
  "Recorded and audited only: it does not change any permission yet. How it takes effect is decided by WP-31.";
export const TUNNEL_NOTE = "The relay tunnel is not available yet (WP-30); no remote request can reach this device.";
export const CDP_REASON = "The CDP browser backend is implemented by WP-24.";
export const PROVIDER_REVOCATION_NOTE =
  "The authorization at the identity provider is not revoked from this device (that needs the CROT account service, WP-36). " +
  "The client is refused on this device now; tokens it already holds expire within 15 minutes and cannot be used here.";

/** Result of asking the identity provider to revoke a client's authorization (AD-21 point 4, best effort). */
export type ProviderRevocationResult = "requested" | "not_available" | "failed";

/** Something that can end a remote client's sessions and requests (the relay entry point). */
export interface RemoteEntry {
  endRemoteClient(client: RemoteClientKey): Promise<{ sessions: number; requests: number }>;
}

/** A control connection as seen by the control center. */
export interface ControlConnection {
  send(message: ControlEvent): void;
}

export interface ControlCenterHost {
  readonly holder: CoreHolder;
  readonly settings: DeviceSettingsStore;
  readonly clients: RemoteClientRegistry;
  /** Device binding (WP-28): the paired account, device id and device credential. */
  readonly binding: DeviceBindingStore;
  /** Identity runtime: environment, verifier, pairing flow (WP-28). */
  readonly identity: DeviceIdentity;
  /**
   * Ask the identity provider to revoke a client's authorization after a
   * device-side revocation (AD-21 point 4, best effort). Absent: not
   * available on this device (WP-36 provides the account service).
   */
  readonly providerRevocation?: (client: RemoteClientKey) => Promise<ProviderRevocationResult>;
  /** The persisted remote exposure (absent when HTTP, and so any remote entry, is disabled). */
  readonly remoteExposure:
    (RemoteExposureResettable & Pick<RemoteExposureStore, "isExposed" | "failedClosed">) | undefined;
  /** The preset in the configuration file. */
  readonly configuredPreset: UntrustedContentSetting;
  /** Build (do not install) a Core with this preset and the exposure state of the current one. */
  buildCore(preset: UntrustedContentSetting): Promise<{ core: CrotCore; handle: CoreCompositionHandle }>;
  serviceStatus(): ServiceStatus;
  browserState(): BrowserConnectionState | undefined;
  agents(): { stdio: number; httpSessions: number; httpSessionlessInFlight: number };
  log(message: string): void;
}

type Result = Record<string, unknown> | ControlRefusal | PresentedApproval[];

const refusal = (reason: string, message: string): ControlRefusal => ({ ok: false, reason, message });

export class ControlCenter implements RemoteAdmission {
  private readonly provider: TrayApprovalProvider;
  private unregisterProvider: (() => void) | undefined;
  private readonly subscribers = new Map<ControlConnection, ApprovalSubscriber>();
  private readonly remoteEntries = new Set<RemoteEntry>();
  /** Device-control requests run one at a time. */
  private queue: Promise<unknown> = Promise.resolve();
  private lastPairingFailure: { reason: string; at: string } | undefined;

  constructor(private readonly host: ControlCenterHost) {
    this.provider = new TrayApprovalProvider({
      onFirstSubscriber: () => {
        this.unregisterProvider = this.host.holder.composition.registerApprovalProvider(this.provider);
      },
      onLastSubscriberGone: () => {
        this.unregisterProvider?.();
        this.unregisterProvider = undefined;
      },
    });
  }

  /** The preset in effect and where it comes from (AD-19 point 5). */
  static effectivePreset(
    settings: DeviceSettingsStore,
    configured: UntrustedContentSetting,
  ): { effective: UntrustedContentSetting; source: "device" | "configuration" | "fail-closed" } {
    if (settings.error !== undefined) return { effective: "require-approval", source: "fail-closed" };
    const chosen = settings.settings.preset;
    return chosen !== undefined
      ? { effective: chosen, source: "device" }
      : { effective: configured, source: "configuration" };
  }

  /** Wait for pending writes of the device state (shutdown). */
  async flush(): Promise<void> {
    await this.host.clients.flush();
  }

  /** For crot_status (ServiceStatus.controls). */
  statusSummary(): NonNullable<ServiceStatus["controls"]> {
    const preset = ControlCenter.effectivePreset(this.host.settings, this.host.configuredPreset);
    return {
      preset: { value: preset.effective, source: preset.source },
      remoteMode: this.host.settings.settings.remoteMode,
      remoteFullControl: this.host.settings.settings.remoteFullControl,
      approvalUis: this.provider.subscriberCount,
    };
  }

  get approvalsSubscribed(): number {
    return this.provider.subscriberCount;
  }

  /** Register a relay entry point (WP-30) so that revocation can end its requests; returns the unregister function. */
  addRemoteEntry(entry: RemoteEntry): () => void {
    this.remoteEntries.add(entry);
    return () => this.remoteEntries.delete(entry);
  }

  // ---- remote admission (AD-19 points 6 and 8) -------------------------------------------------

  admit(client: RemoteClientKey, token: RemoteTokenFacts = {}): RemoteAdmissionDecision {
    if (this.host.settings.error !== undefined) return { admitted: false, reason: "state_unavailable" };
    if (!this.host.settings.settings.remoteMode) return { admitted: false, reason: "remote_mode_off" };
    // The verifier bound the token to the paired account and device; checked again against the current binding.
    const binding = this.host.binding.view();
    if (binding.state === "unavailable") return { admitted: false, reason: "state_unavailable" };
    if (binding.state !== "paired" || binding.deviceId !== client.deviceId || binding.accountId !== client.accountId)
      return { admitted: false, reason: "not_paired" };
    if (this.host.clients.failedClosed) return { admitted: false, reason: "state_unavailable" };
    if (!isValidRemoteId(client.accountId) || !isValidRemoteId(client.deviceId) || !isValidRemoteId(client.clientId))
      return { admitted: false, reason: "invalid_client" };
    if (this.host.clients.isRevoked(client)) return { admitted: false, reason: "client_revoked" };
    if (this.host.clients.predatesGrant(client, token.issuedAt))
      return { admitted: false, reason: "token_predates_grant" };
    if (this.host.clients.seen(client)) this.stateChanged();
    return { admitted: true };
  }

  // ---- control requests ------------------------------------------------------------------------

  /** A control connection closed: it no longer receives or decides approvals. */
  connectionClosed(connection: ControlConnection): void {
    const subscriber = this.subscribers.get(connection);
    if (!subscriber) return;
    this.subscribers.delete(connection);
    this.provider.unsubscribe(subscriber);
    this.stateChanged();
  }

  /** Handle a WP-22 control request; undefined for methods the service handles itself (ping, status, shutdown). */
  handle(connection: ControlConnection, request: ControlRequest): Promise<Result> | undefined {
    switch (request.method) {
      case "overview":
        return Promise.resolve(this.overview() as unknown as Result);
      case "approvals.subscribe":
        return Promise.resolve(this.subscribe(connection));
      case "approvals.unsubscribe":
        this.connectionClosed(connection);
        return Promise.resolve({ ok: true });
      case "approvals.decide": {
        const subscriber = this.subscribers.get(connection);
        if (!subscriber)
          return Promise.resolve(refusal("unknown_request", "This connection has not subscribed to approvals."));
        const { requestId, decision, subjectDigest } = request.params;
        const result = this.provider.decide(subscriber, requestId, decision, subjectDigest);
        return Promise.resolve(result.ok ? { ok: true } : refusal(result.reason, DECIDE_MESSAGES[result.reason]));
      }
      case "preset.set":
        return this.serial(() => this.setPreset(request.params.value));
      case "remote.setMode":
        return this.serial(() => this.setFlag("remote_mode", request.params.enabled));
      case "remote.setFullControl":
        return this.serial(() => this.setFlag("remote_full_control", request.params.enabled));
      case "remote.resetExposure":
        return this.serial(() => this.resetExposure(request.params));
      case "remote.revokeClient":
        return this.serial(() => this.revokeClient(request.params));
      case "remote.regrantClient":
        return this.serial(() => this.regrantClient(request.params));
      case "pairing.start":
        return this.serial(() => this.startPairing());
      case "pairing.cancel":
        return Promise.resolve(
          this.host.identity.cancelPairing() ? { ok: true } : refusal("not_pairing", "No pairing is in progress."),
        );
      case "device.unpair":
        return this.serial(() => this.unpair());
      default:
        return undefined;
    }
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private subscribe(connection: ControlConnection): Result {
    if (this.subscribers.has(connection)) return { ok: true, pending: [] };
    const subscriber: ApprovalSubscriber = {
      requested: (approval: PresentedApproval) =>
        connection.send({ t: "event", event: "approval.requested", approval }),
      resolved: (requestId: string, status: TerminalApprovalStatus) =>
        connection.send({ t: "event", event: "approval.resolved", requestId, status }),
    };
    this.subscribers.set(connection, subscriber);
    const pending = this.provider.subscribe(subscriber);
    this.stateChanged();
    return { ok: true, pending };
  }

  /** Send the current overview to every subscribed connection. */
  stateChanged(): void {
    if (this.subscribers.size === 0) return;
    let overview: ControlOverview;
    try {
      overview = this.overview();
    } catch {
      return;
    }
    for (const connection of this.subscribers.keys()) connection.send({ t: "event", event: "state.changed", overview });
  }

  /**
   * After the service installed a new Core (preset change): the provider moves to its broker.
   * Called synchronously right after the swap, while no request is pending.
   */
  private moveProvider(handle: CoreCompositionHandle): void {
    if (!this.unregisterProvider) return;
    this.unregisterProvider();
    this.provider.forgetPending();
    this.unregisterProvider = handle.registerApprovalProvider(this.provider);
  }

  // ---- audit (AD-19 point 9) ---------------------------------------------------------------------

  private async audit(
    action: ControlAuditAction,
    outcome: ControlAuditRecord["outcome"],
    fields: Partial<Pick<ControlAuditRecord, "reason" | "previous" | "value" | "client" | "device">> = {},
  ): Promise<void> {
    const record: ControlAuditRecord = {
      kind: "control",
      id: newAuditEventId(),
      timestamp: new Date().toISOString(),
      action,
      actor: { channel: "control" },
      outcome,
      ...fields,
    };
    await this.host.holder.composition.recordControlEvent(record);
  }

  /** Narrowing changes and refusals: an audit failure is reported, never blocking (AD-19 point 9). */
  private async auditBestEffort(...args: Parameters<ControlCenter["audit"]>): Promise<string | undefined> {
    try {
      await this.audit(...args);
      return undefined;
    } catch (error) {
      const message = `the audit record could not be written: ${error instanceof Error ? error.message : String(error)}`;
      this.host.log(`control: ${message}`);
      return message;
    }
  }

  // ---- preset (AD-19 point 5) --------------------------------------------------------------------

  private async setPreset(value: PresetValue): Promise<Result> {
    const before = ControlCenter.effectivePreset(this.host.settings, this.host.configuredPreset);
    if (!SELECTABLE_PRESETS.includes(value)) {
      const reason = UNAVAILABLE_PRESETS.find((p) => p.value === value)?.reason ?? "This preset is not available.";
      await this.auditBestEffort("preset", "refused", { reason: "not_available", previous: before.effective, value });
      return refusal("not_available", reason);
    }
    const preset = value as UntrustedContentSetting;
    if (preset === before.effective && before.source === "device") return { ok: true, preset, unchanged: true };
    const widening = PRESET_RANK[value] < PRESET_RANK[before.effective];
    const needsCore = preset !== before.effective;
    if (needsCore) {
      const busy = this.host.holder.busyReason();
      if (busy) {
        await this.auditBestEffort("preset", "refused", { reason: "busy", previous: before.effective, value });
        return refusal("busy", `The preset can be changed only while CROT is idle: ${busy}.`);
      }
    }
    if (widening) {
      try {
        await this.audit("preset", "applied", { previous: before.effective, value });
      } catch (error) {
        return refusal("audit_failed", `Not changed: the audit record could not be written (${errorText(error)}).`);
      }
    }
    const previousChoice = this.host.settings.error === undefined ? this.host.settings.settings.preset : undefined;
    const restore = async () => {
      try {
        await this.host.settings.update(
          previousChoice === undefined ? { clearPreset: true } : { preset: previousChoice },
        );
      } catch (error) {
        this.host.log(`control: cannot restore the previous preset: ${errorText(error)}`);
      }
    };
    const failed = async (reason: string, message: string) => {
      if (widening) await this.auditBestEffort("preset", "failed", { reason, previous: before.effective, value });
      else await this.auditBestEffort("preset", "refused", { reason, previous: before.effective, value });
      return refusal(reason, message);
    };
    try {
      await this.host.settings.update({ preset });
    } catch (error) {
      return failed(
        "state_write_failed",
        `Not changed: the device settings could not be written (${errorText(error)}).`,
      );
    }
    if (needsCore) {
      let built: { core: CrotCore; handle: CoreCompositionHandle };
      try {
        built = await this.host.buildCore(preset);
      } catch (error) {
        await restore();
        return failed("core_failed", `Not changed: CROT could not apply the preset (${errorText(error)}).`);
      }
      // The idle check and the switch are one synchronous step (AD-19 point 5).
      const busy = this.host.holder.busyReason();
      if (busy) {
        await built.core.shutdown().catch(() => undefined);
        await restore();
        return failed("busy", `The preset can be changed only while CROT is idle: ${busy}.`);
      }
      const previous = this.host.holder.swap(built.core, built.handle);
      this.moveProvider(built.handle);
      await previous
        .shutdown()
        .catch((error: unknown) => this.host.log(`control: old Core shutdown: ${errorText(error)}`));
    }
    const warning = widening
      ? undefined
      : await this.auditBestEffort("preset", "applied", { previous: before.effective, value });
    this.host.log(`control: preset set to ${preset}`);
    this.stateChanged();
    return { ok: true, preset, ...(warning ? { warning } : {}) };
  }

  // ---- remote mode and full-control opt-in (AD-19 points 6 and 7) --------------------------------

  private async setFlag(action: "remote_mode" | "remote_full_control", enabled: boolean): Promise<Result> {
    const key = action === "remote_mode" ? "remoteMode" : "remoteFullControl";
    const previous = this.host.settings.settings[key];
    if (previous === enabled && this.host.settings.error === undefined) return { ok: true, enabled, unchanged: true };
    const widening = enabled;
    if (widening) {
      try {
        await this.audit(action, "applied", { previous, value: enabled });
      } catch (error) {
        return refusal("audit_failed", `Not changed: the audit record could not be written (${errorText(error)}).`);
      }
    }
    try {
      await this.host.settings.update({ [key]: enabled });
    } catch (error) {
      await this.auditBestEffort(action, "failed", { reason: "state_write_failed", previous, value: enabled });
      return refusal(
        "state_write_failed",
        `Not changed: the device settings could not be written (${errorText(error)}).`,
      );
    }
    if (action === "remote_mode" && !enabled) {
      // Remote mode off: nothing remote keeps running (AD-15 point 9).
      for (const client of this.host.clients.list()) await this.endRemote(client);
    }
    const warning = widening ? undefined : await this.auditBestEffort(action, "applied", { previous, value: enabled });
    this.host.log(
      `control: ${action === "remote_mode" ? "remote mode" : "remote full-control opt-in"} ${enabled ? "on" : "off"}`,
    );
    this.stateChanged();
    return { ok: true, enabled, ...(warning ? { warning } : {}) };
  }

  // ---- exposure reset and revocation (AD-19 point 8) ---------------------------------------------

  private knownClient(params: RemoteClientParams): ControlRefusal | undefined {
    if (this.host.clients.failedClosed)
      return refusal("state_unavailable", `The remote client list cannot be read: ${this.host.clients.error ?? ""}`);
    if (!this.host.clients.get(params))
      return refusal("unknown_client", "This remote client is not known on this device.");
    return undefined;
  }

  private async resetExposure(params: RemoteClientParams): Promise<Result> {
    const client = { accountId: params.accountId, deviceId: params.deviceId, clientId: params.clientId };
    const unknown = this.knownClient(client);
    if (unknown) return unknown;
    const store = this.host.remoteExposure;
    if (!store)
      return refusal("no_exposure_state", "Remote exposure is not tracked by this service (HTTP is disabled).");
    if (store.failedClosed) {
      await this.auditBestEffort("exposure_reset", "refused", { reason: "failed_closed", client });
      return refusal(
        "failed_closed",
        "The remote exposure state cannot be read, so every remote client stays exposed.",
      );
    }
    const key = remoteExposureScope(client.accountId, client.deviceId, client.clientId).remoteKey!;
    if (!store.isExposed(key)) return { ok: true, result: "already_clean" };
    // A reset widens what runs without asking: its audit record comes first (AD-19 point 9).
    try {
      await this.audit("exposure_reset", "applied", { client });
    } catch (error) {
      return refusal("audit_failed", `Not reset: the audit record could not be written (${errorText(error)}).`);
    }
    const result = store.reset(key);
    if (result === "write_failed" || result === "failed_closed") {
      await this.auditBestEffort("exposure_reset", "failed", { reason: result, client });
      return refusal(result, "Not reset: the remote exposure state could not be written.");
    }
    this.host.log("control: exposure of a remote client reset");
    this.stateChanged();
    return { ok: true, result };
  }

  private async revokeClient(params: RemoteClientParams): Promise<Result> {
    const client = { accountId: params.accountId, deviceId: params.deviceId, clientId: params.clientId };
    const unknown = this.knownClient(client);
    if (unknown) return unknown;
    const revoked = await this.host.clients.revoke(client);
    if (!revoked.ok) return refusal(revoked.reason, REVOKE_MESSAGES[revoked.reason]);
    const store = this.host.remoteExposure;
    const exposure = store
      ? store.reset(remoteExposureScope(client.accountId, client.deviceId, client.clientId).remoteKey!)
      : "no_exposure_state";
    const ended = await this.endRemote(client);
    const warning = await this.auditBestEffort("client_revoke", "applied", {
      client,
      ...(revoked.persisted ? {} : { reason: "not_persisted" }),
    });
    // Recorded on the device first; the provider is asked afterwards, best effort (AD-21 point 4).
    let provider: ProviderRevocationResult = "not_available";
    if (this.host.providerRevocation) {
      provider = await this.host.providerRevocation(client).catch(() => "failed" as const);
    }
    this.host.log("control: a remote client was revoked");
    this.stateChanged();
    return {
      ok: true,
      persisted: revoked.persisted,
      exposure,
      ended,
      provider,
      ...(provider !== "requested" ? { providerNote: PROVIDER_REVOCATION_NOTE } : {}),
      ...(warning ? { warning } : {}),
    };
  }

  /**
   * Re-grant a revoked client (WP-28). It widens access: its audit record
   * comes first (AD-19 point 9), and it takes effect only once written. The
   * client starts with the exposure its revocation left (clean, AD-15 point
   * 8); tokens issued before the re-grant are not accepted for it.
   */
  private async regrantClient(params: RemoteClientParams): Promise<Result> {
    const client = { accountId: params.accountId, deviceId: params.deviceId, clientId: params.clientId };
    const unknown = this.knownClient(client);
    if (unknown) return unknown;
    if (this.host.clients.get(client)?.revokedAt === undefined)
      return refusal("not_revoked", "This remote client is not revoked.");
    try {
      await this.audit("client_regrant", "applied", { client });
    } catch (error) {
      return refusal("audit_failed", `Not re-granted: the audit record could not be written (${errorText(error)}).`);
    }
    const result = await this.host.clients.regrant(client);
    if (!result.ok) {
      await this.auditBestEffort("client_regrant", "failed", { reason: result.reason, client });
      return refusal(result.reason, REGRANT_MESSAGES[result.reason]);
    }
    this.host.log("control: a remote client was re-granted");
    this.stateChanged();
    return { ok: true, grantedAt: result.grantedAt };
  }

  // ---- pairing and unpairing (WP-28, AD-21) -----------------------------------------------------

  private async startPairing(): Promise<Result> {
    const identity = this.host.identity;
    const environment = identity.environment;
    if (!environment)
      return refusal("not_available", identity.unavailableReason ?? "No identity environment is configured.");
    const binding = this.host.binding;
    if (binding.error !== undefined)
      return refusal(
        "state_unavailable",
        `The device binding cannot be used (${binding.error}). Unpair the device to reset it, then pair it again.`,
      );
    if (binding.paired) return refusal("already_paired", "This device is already paired. Unpair it first.");
    let pending;
    try {
      pending = await identity.startPairing((outcome, deviceId) => void this.pairingFinished(outcome, deviceId));
    } catch (error) {
      return refusal("pairing_failed", `Pairing could not start: ${errorText(error)}`);
    }
    this.lastPairingFailure = undefined;
    this.host.log("control: pairing started; waiting for the user to sign in");
    this.stateChanged();
    return { ok: true, authorizationUrl: pending.authorizationUrl, expiresAt: pending.expiresAt };
  }

  /** The sign-in of a pairing completed (or failed): record the binding, audit first (it widens remote reachability). */
  private pairingFinished(outcome: PairingOutcome, deviceId: string): Promise<void> {
    return this.serial(async () => {
      const environment = this.host.identity.environment;
      const fail = async (reason: string) => {
        this.lastPairingFailure = { reason, at: new Date().toISOString() };
        await this.auditBestEffort("pairing", outcome.ok ? "failed" : "refused", {
          reason,
          device: { deviceId, ...(environment ? { environment: environment.id } : {}) },
        });
        this.host.log(`control: pairing did not complete (${reason})`);
        this.stateChanged();
      };
      if (!outcome.ok) return fail(outcome.detail ? `${outcome.reason}: ${outcome.detail}` : outcome.reason);
      if (!environment) return fail("no_environment");
      if (this.host.binding.error !== undefined || this.host.binding.paired) return fail("not_unpaired");
      const device = { deviceId, accountId: outcome.accountId, environment: environment.id };
      try {
        await this.audit("pairing", "applied", { device });
      } catch (error) {
        return fail(`audit_failed: ${errorText(error)}`);
      }
      try {
        await this.host.binding.pair(
          {
            deviceId,
            accountId: outcome.accountId,
            environment: environment.id,
            issuer: environment.issuer,
            relayHost: environment.relayHost,
          },
          environment,
        );
      } catch (error) {
        return fail(`state_write_failed: ${errorText(error)}`);
      }
      this.lastPairingFailure = undefined;
      this.host.log(`control: device paired (device ${deviceId}, environment ${environment.id})`);
      this.stateChanged();
    });
  }

  /**
   * Unpair (AD-21 point 4 (b)): narrowing, effective at once — no token is
   * accepted, every remote request in flight is ended and the device
   * credential is removed. Also resets an unusable binding.
   */
  private async unpair(): Promise<Result> {
    const binding = this.host.binding;
    const before = binding.paired;
    if (!before && binding.error === undefined) {
      this.host.identity.cancelPairing();
      return { ok: true, unchanged: true };
    }
    this.host.identity.cancelPairing();
    const result = await binding.unpair();
    let ended = { sessions: 0, requests: 0 };
    for (const client of this.host.clients.list()) {
      const r = await this.endRemote(client);
      ended = { sessions: ended.sessions + r.sessions, requests: ended.requests + r.requests };
    }
    const warning = await this.auditBestEffort("unpair", "applied", {
      ...(before
        ? { device: { deviceId: before.deviceId, accountId: before.accountId, environment: before.environment } }
        : {}),
      ...(result.errors.length > 0 ? { reason: "not_persisted" } : {}),
    });
    this.host.log("control: device unpaired");
    this.stateChanged();
    const warnings = [...result.errors, ...(warning ? [warning] : [])];
    return {
      ok: true,
      persisted: result.persisted,
      keyRemoved: result.keyRemoved,
      ended,
      ...(warnings.length > 0 ? { warning: warnings.join("; ") } : {}),
    };
  }

  private pairingView(): PairingView {
    const identity = this.host.identity;
    const environment = identity.environment;
    const binding = this.host.binding;
    const paired = binding.paired;
    const pending = identity.pending;
    const state: PairingView["state"] =
      binding.error !== undefined ? "unavailable" : paired ? "paired" : pending ? "pairing" : "unpaired";
    const here =
      paired && environment && paired.issuer === environment.issuer && paired.relayHost === environment.relayHost;
    const error =
      binding.error ??
      (paired && !here
        ? `Paired in the identity environment '${paired.environment}' (${paired.issuer}), which is not active: no remote token is accepted.`
        : undefined);
    return {
      available: environment !== undefined,
      ...(environment ? {} : { reason: identity.unavailableReason ?? "No identity environment is configured." }),
      state,
      ...(environment
        ? {
            environment: {
              id: environment.id,
              kind: environment.kind,
              issuer: environment.issuer,
              relayHost: environment.relayHost,
              rfc9207: identity.rfc9207,
            },
          }
        : {}),
      ...(paired
        ? {
            device: {
              deviceId: paired.deviceId,
              accountId: paired.accountId,
              environment: paired.environment,
              pairedAt: paired.pairedAt,
              ...(here
                ? { resourceUri: identity.resourceUri()!, protectedResourceMetadata: identity.resourceMetadataUrl()! }
                : {}),
              ...(binding.publicKey ? { publicKey: binding.publicKey.x } : {}),
            },
          }
        : {}),
      ...(pending ? { pending: { authorizationUrl: pending.authorizationUrl, expiresAt: pending.expiresAt } } : {}),
      ...(this.lastPairingFailure ? { lastFailure: this.lastPairingFailure } : {}),
      ...(error ? { error } : {}),
    };
  }

  private async endRemote(client: RemoteClientKey): Promise<{ sessions: number; requests: number }> {
    let sessions = 0;
    let requests = 0;
    for (const entry of this.remoteEntries) {
      const r = await entry.endRemoteClient(client).catch(() => ({ sessions: 0, requests: 0 }));
      sessions += r.sessions;
      requests += r.requests;
    }
    return { sessions, requests };
  }

  // ---- overview (AD-19 point 10) -----------------------------------------------------------------

  overview(): ControlOverview {
    const status = this.host.serviceStatus();
    const core = this.host.holder.instance.status();
    const preset = ControlCenter.effectivePreset(this.host.settings, this.host.configuredPreset);
    const store = this.host.remoteExposure;
    const clients: RemoteClientView[] = this.host.clients.list().map((c) => {
      const key = remoteExposureScope(c.accountId, c.deviceId, c.clientId).remoteKey!;
      const exposure: RemoteClientView["exposure"] =
        !store || store.failedClosed ? "unknown" : store.isExposed(key) ? "exposed" : "clean";
      return { ...c, exposure };
    });
    const errors = [
      ...(this.host.settings.error !== undefined ? [`device settings: ${this.host.settings.error}`] : []),
      ...(this.host.clients.error !== undefined ? [`remote clients: ${this.host.clients.error}`] : []),
      ...(store?.failedClosed
        ? ["remote exposure state cannot be read: every remote client is treated as exposed"]
        : []),
    ];
    const browser = this.host.browserState();
    const blockedBy = this.host.holder.busyReason();
    return {
      service: {
        state: status.state,
        pid: status.pid,
        version: core.version,
        launch: status.launch,
        uptimeMs: status.uptimeMs,
      },
      mode: core.mode,
      workspace: core.workspace.root,
      preset: {
        effective: preset.effective,
        source: preset.source,
        configured: this.host.configuredPreset,
        selectable: SELECTABLE_PRESETS,
        unavailable: UNAVAILABLE_PRESETS,
        ...(blockedBy ? { blockedBy } : {}),
      },
      remote: {
        mode: this.host.settings.settings.remoteMode,
        fullControl: this.host.settings.settings.remoteFullControl,
        fullControlNote: FULL_CONTROL_NOTE,
        tunnel: TUNNEL_NOTE,
        clients,
        errors,
      },
      agents: { ...this.host.agents(), remoteClients: clients.filter((c) => c.revokedAt === undefined).length },
      browser: browserView(browser, core.browser.state),
      approvals: { trays: this.provider.subscriberCount, pending: this.provider.pendingCount },
      confinement: core.confinement,
      cdp: { available: false, reason: CDP_REASON },
      pairing: this.pairingView(),
    };
  }
}

const DECIDE_MESSAGES: Readonly<Record<"not_pending" | "digest_mismatch" | "unknown_request", string>> = {
  not_pending: "The request is no longer pending.",
  digest_mismatch: "The request changed; it was not approved.",
  unknown_request: "No such pending request was shown to this tray.",
};

const REGRANT_MESSAGES: Readonly<
  Record<"unknown_client" | "not_revoked" | "state_unavailable" | "write_failed", string>
> = {
  unknown_client: "This remote client is not known on this device.",
  not_revoked: "This remote client is not revoked.",
  state_unavailable: "The remote client list cannot be read; every remote request is refused.",
  write_failed: "Not re-granted: the remote client list could not be written; the client stays revoked.",
};

const REVOKE_MESSAGES: Readonly<Record<"unknown_client" | "already_revoked" | "state_unavailable", string>> = {
  unknown_client: "This remote client is not known on this device.",
  already_revoked: "This remote client is already revoked.",
  state_unavailable: "The remote client list cannot be read; every remote request is refused.",
};

function browserView(state: BrowserConnectionState | undefined, fallback: string): ControlOverview["browser"] {
  if (state?.kind === "connected") {
    const b = state.browser as { name?: unknown; version?: unknown; extensionVersion?: unknown };
    return {
      state: "connected",
      ...(typeof b.name === "string" ? { name: b.name } : {}),
      ...(typeof b.version === "string" ? { version: b.version } : {}),
      ...(typeof b.extensionVersion === "string" ? { extensionVersion: b.extensionVersion } : {}),
      connectionId: state.connectionId,
    };
  }
  return { state: state?.kind ?? fallback };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
