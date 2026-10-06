/**
 * Device-side controls of the service on the authenticated control channel
 * (ARCHITECTURE.md §27, AD-19): the tray approval provider, the preset,
 * remote mode, the remote full-control opt-in, exposure reset, client
 * revocation, the overview and the admission of remote requests.
 *
 * This is the only code that changes these settings, and it runs only for
 * requests on the control channel (AD-17 point 7). It makes no permission
 * decision: approvals are decided by the user through the broker's tickets,
 * and the preset becomes policy only by building a new Core (AD-19 point 5).
 */
import type { RemoteAdmission, RemoteAdmissionDecision, RemoteClientKey } from "../adapters/http/server.js";
import type { UntrustedContentSetting } from "../core/approvals/exposure.js";
import type { RemoteExposureResettable, RemoteExposureStore } from "../core/approvals/remote-exposure.js";
import type { PresentedApproval, TerminalApprovalStatus } from "../core/approvals/types.js";
import { newAuditEventId, type ControlAuditAction, type ControlAuditRecord } from "../core/audit/audit.js";
import { remoteExposureScope } from "../core/auth/principal.js";
import type { CoreCompositionHandle, CrotCore } from "../core/crot-core.js";
import type { BrowserConnectionState } from "../core/capabilities/browser/connection.js";
import type { ServiceStatus } from "../core/service-status.js";
import type { CoreHolder } from "./core-holder.js";
import type { DeviceSettingsStore } from "./device-settings.js";
import type {
  ControlEvent,
  ControlOverview,
  ControlRefusal,
  ControlRequest,
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
export const CONFINEMENT_REASON = "Command confinement L1 is implemented by WP-23; commands run unconfined.";
export const CDP_REASON = "The CDP browser backend is implemented by WP-24.";
export const PAIRING_REASON = "Device pairing requires identity and device binding (WP-28).";

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

  admit(client: RemoteClientKey): RemoteAdmissionDecision {
    if (this.host.settings.error !== undefined) return { admitted: false, reason: "state_unavailable" };
    if (!this.host.settings.settings.remoteMode) return { admitted: false, reason: "remote_mode_off" };
    if (this.host.clients.failedClosed) return { admitted: false, reason: "state_unavailable" };
    if (!isValidRemoteId(client.accountId) || !isValidRemoteId(client.deviceId) || !isValidRemoteId(client.clientId))
      return { admitted: false, reason: "invalid_client" };
    if (this.host.clients.isRevoked(client)) return { admitted: false, reason: "client_revoked" };
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
      case "pairing.start":
        return Promise.resolve(refusal("not_available", PAIRING_REASON));
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
    fields: Partial<Pick<ControlAuditRecord, "reason" | "previous" | "value" | "client">> = {},
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
    this.host.log("control: a remote client was revoked");
    this.stateChanged();
    return {
      ok: true,
      persisted: revoked.persisted,
      exposure,
      ended,
      ...(warning ? { warning } : {}),
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
      confinement: { available: false, reason: CONFINEMENT_REASON },
      cdp: { available: false, reason: CDP_REASON },
      pairing: { available: false, reason: PAIRING_REASON },
    };
  }
}

const DECIDE_MESSAGES: Readonly<Record<"not_pending" | "digest_mismatch" | "unknown_request", string>> = {
  not_pending: "The request is no longer pending.",
  digest_mismatch: "The request changed; it was not approved.",
  unknown_request: "No such pending request was shown to this tray.",
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
