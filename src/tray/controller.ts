/**
 * The tray's connection to the CROT service (WP-22, AD-19 points 1 and 2).
 * No Electron here: the controller is a control-channel client that keeps
 * the pending approvals and the overview, and turns user actions into
 * control requests. The tray process holds no approval authority of its
 * own — the service checks every decision against the request and the
 * subject digest the tray was shown.
 */
import type { PresentedApproval } from "../core/approvals/types.js";
import type { PrivateFileProtection } from "../core/platform/types.js";
import { ControlClient } from "../service/control-client.js";
import type { ControlEvent, ControlOverview, PresetValue, RemoteClientParams } from "../service/protocol.js";
import type { TrayState } from "./view-model.js";

export interface TrayControllerOptions {
  readonly stateDir: string;
  readonly privateFiles: PrivateFileProtection;
  readonly onUpdate: (state: TrayState) => void;
  /** Called once for each approval request that was not known before (show the window). */
  readonly onNewApproval?: (approval: PresentedApproval) => void;
  /** Delay between connection attempts while the service is not reachable. */
  readonly retryMs?: number;
  /** Interval of `overview` polling while connected (state.changed covers most changes). */
  readonly pollMs?: number;
  /** Test seam: how to reach the service. */
  readonly connect?: () => Promise<ControlClient | undefined>;
  /**
   * Open the identity provider's sign-in page of a pairing (WP-28) in the
   * user's browser. Only HTTPS URLs reach it.
   */
  readonly openSignIn?: (url: string) => void;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Message of a refused control request, or undefined when the result is ok. */
function refusalMessage(result: unknown): string | undefined {
  if (!isRecord(result)) return "The CROT service sent an unexpected answer.";
  if (result.ok === true) return undefined;
  return typeof result.message === "string" ? result.message : "The CROT service refused the request.";
}

const warningOf = (result: unknown): string =>
  isRecord(result) && typeof result.warning === "string" ? ` ${result.warning}` : "";

export class TrayController {
  private client: ControlClient | undefined;
  private connection: TrayState["connection"] = "connecting";
  private error: string | undefined;
  private overview: ControlOverview | undefined;
  private readonly pending = new Map<string, PresentedApproval>();
  private notice: string | undefined;
  private stopped = false;
  private retryTimer: NodeJS.Timeout | undefined;
  private pollTimer: NodeJS.Timeout | undefined;
  private connecting: Promise<void> | undefined;

  constructor(private readonly options: TrayControllerOptions) {}

  get state(): TrayState {
    return {
      connection: this.connection,
      ...(this.error !== undefined ? { error: this.error } : {}),
      ...(this.overview ? { overview: this.overview } : {}),
      pending: [...this.pending.values()],
      ...(this.notice !== undefined ? { notice: this.notice } : {}),
    };
  }

  /** Connect now and keep reconnecting until stop(). */
  start(): Promise<void> {
    this.stopped = false;
    return this.attempt();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    clearInterval(this.pollTimer);
    const client = this.client;
    this.client = undefined;
    client?.close();
  }

  /** Approve or reject a request with the subject digest this tray presented. */
  async decide(requestId: string, decision: "approve" | "reject"): Promise<boolean> {
    const approval = this.pending.get(requestId);
    if (!approval) return this.done("This request is no longer waiting for a decision.", false);
    const result = await this.call("approvals.decide", {
      requestId,
      decision,
      subjectDigest: approval.subjectDigest,
    });
    if (result === undefined) return false;
    const refused = refusalMessage(result);
    if (refused !== undefined) {
      // The request ended or changed: forget it; the service sends the current list on reconnect.
      this.pending.delete(requestId);
      return this.done(refused, false);
    }
    this.pending.delete(requestId);
    return this.done(decision === "approve" ? "Approved." : "Rejected.", true);
  }

  refreshL1(): Promise<boolean> {
    return this.action("confinement.refresh", {}, () => "L1 availability checked.");
  }

  setPreset(value: PresetValue): Promise<boolean> {
    return this.action("preset.set", { value }, (r) =>
      isRecord(r) && r.unchanged === true ? "The preset is already selected." : `Preset set to '${value}'.`,
    );
  }

  setRemoteMode(enabled: boolean): Promise<boolean> {
    return this.action("remote.setMode", { enabled }, () => (enabled ? "Remote mode is on." : "Remote mode is off."));
  }

  setFullControl(enabled: boolean): Promise<boolean> {
    return this.action("remote.setFullControl", { enabled }, () =>
      enabled
        ? "Remote full control opt-in recorded (not enforced yet, see WP-31)."
        : "Remote full control opt-in withdrawn.",
    );
  }

  resetExposure(client: RemoteClientParams): Promise<boolean> {
    return this.action("remote.resetExposure", { ...client }, (r) =>
      isRecord(r) && r.result === "already_clean"
        ? "This client has no recorded exposure."
        : "The exposure of this client was reset.",
    );
  }

  revokeClient(client: RemoteClientParams): Promise<boolean> {
    return this.action("remote.revokeClient", { ...client }, () => "The remote client was revoked.");
  }

  /** Start pairing (WP-28): the service returns the sign-in URL, which opens in the user's browser. */
  startPairing(params: import("../identity/pairing.js").SignInOptions = {}): Promise<boolean> {
    return this.action("pairing.start", { ...params }, (r) => {
      const url = isRecord(r) && typeof r.authorizationUrl === "string" ? r.authorizationUrl : undefined;
      if (url !== undefined && isHttpsUrl(url) && this.options.openSignIn) {
        this.options.openSignIn(url);
        return "Pairing started: sign in to your CROT account in the browser window that opened.";
      }
      return "Pairing started: open the sign-in page shown in the pairing section.";
    });
  }

  /** Validated owner product RPC; the service owns schemas and authorization. */
  async product(
    method: import("../service/product-protocol.js").ProductMethod,
    params: Readonly<Record<string, unknown>>,
  ): Promise<unknown> {
    if (!this.client) throw new Error("Service disconnected");
    return this.client.request(method, params);
  }

  /** Cancel a running pairing; the service refuses (`not_pairing`) when none is in progress. */
  cancelPairing(): Promise<boolean> {
    return this.action("pairing.cancel", undefined, () => "Pairing cancelled.");
  }

  /** Unpair this device (AD-21 point 4 (b)): every remote request ends at once. */
  unpair(): Promise<boolean> {
    return this.action("device.unpair", undefined, (r) =>
      isRecord(r) && r.unchanged === true ? "This device is not paired." : "This device was unpaired.",
    );
  }

  /** Re-grant a revoked remote client (WP-28); tokens issued before now are not accepted for it. */
  regrantClient(client: RemoteClientParams): Promise<boolean> {
    return this.action(
      "remote.regrantClient",
      { ...client },
      () => "The remote client was re-granted; it must sign in again to get a new token.",
    );
  }

  /** Clear the last notice (the user dismissed it). */
  dismissNotice(): void {
    this.notice = undefined;
    this.update();
  }

  private async action(
    method: Parameters<ControlClient["request"]>[0],
    params: Readonly<Record<string, unknown>> | undefined,
    success: (result: unknown) => string,
  ): Promise<boolean> {
    const result = await this.call(method, params);
    if (result === undefined) return false;
    const refused = refusalMessage(result);
    if (refused !== undefined) return this.done(refused, false);
    await this.refresh();
    return this.done(`${success(result)}${warningOf(result)}`, true);
  }

  private done(notice: string, value: boolean): boolean {
    this.notice = notice;
    this.update();
    return value;
  }

  /** A control request; undefined (with a notice) when the service could not be asked. */
  private async call(
    method: Parameters<ControlClient["request"]>[0],
    params?: Readonly<Record<string, unknown>>,
  ): Promise<unknown> {
    const client = this.client;
    if (!client || client.closed) {
      this.done("The CROT service is not connected.", false);
      return undefined;
    }
    try {
      return await client.request(method, params);
    } catch (error) {
      this.done(errorMessage(error), false);
      return undefined;
    }
  }

  private attempt(): Promise<void> {
    if (this.connecting) return this.connecting;
    this.connecting = this.connectOnce().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  private async connectOnce(): Promise<void> {
    if (this.stopped || this.client) return;
    let client: ControlClient | undefined;
    try {
      client = await (this.options.connect
        ? this.options.connect()
        : ControlClient.connect({ stateDir: this.options.stateDir, privateFiles: this.options.privateFiles }));
    } catch (error) {
      this.setOffline("error", errorMessage(error));
      return this.scheduleRetry();
    }
    if (!client) {
      this.setOffline("not_running");
      return this.scheduleRetry();
    }
    if (this.stopped) return client.close();
    this.client = client;
    client.onevent = (event) => this.onEvent(event);
    client.onclose = () => this.onClosed(client);
    try {
      const subscribed = await client.request("approvals.subscribe");
      const overview = await client.request("overview");
      if (this.client !== client) return;
      this.pending.clear();
      const list = isRecord(subscribed) && Array.isArray(subscribed.pending) ? subscribed.pending : [];
      for (const approval of list as PresentedApproval[]) this.addPending(approval);
      this.overview = overview as ControlOverview;
      this.connection = "connected";
      this.error = undefined;
      this.pollTimer = setInterval(() => void this.refresh(), this.options.pollMs ?? 5_000);
      this.pollTimer.unref?.();
      this.update();
    } catch (error) {
      if (this.client === client) {
        this.client = undefined;
        client.close();
        this.setOffline("error", errorMessage(error));
        this.scheduleRetry();
      }
    }
  }

  /** Ask for a fresh overview (polling and after actions). */
  async refresh(): Promise<void> {
    const client = this.client;
    if (!client || client.closed || this.connection !== "connected") return;
    try {
      const overview = await client.request("overview");
      if (this.client !== client) return;
      this.overview = overview as ControlOverview;
      this.update();
    } catch {
      // A lost connection is handled by onclose; a slow answer is retried by the next poll.
    }
  }

  private onEvent(event: ControlEvent): void {
    switch (event.event) {
      case "approval.requested":
        this.addPending(event.approval);
        break;
      case "approval.resolved":
        this.pending.delete(event.requestId);
        break;
      case "state.changed":
        this.overview = event.overview;
        break;
    }
    this.update();
  }

  private addPending(approval: PresentedApproval): void {
    if (this.pending.has(approval.requestId)) return;
    this.pending.set(approval.requestId, approval);
    this.options.onNewApproval?.(approval);
  }

  private onClosed(client: ControlClient): void {
    if (this.client !== client) return;
    this.client = undefined;
    clearInterval(this.pollTimer);
    // A disconnected tray cannot decide anything: pending requests are shown again after reconnecting.
    this.setOffline("connecting");
    this.scheduleRetry();
  }

  private setOffline(connection: TrayState["connection"], error?: string): void {
    this.connection = connection;
    this.error = error;
    this.overview = undefined;
    this.pending.clear();
    this.update();
  }

  private scheduleRetry(): void {
    if (this.stopped) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => void this.attempt(), this.options.retryMs ?? 2_000);
    this.retryTimer.unref?.();
  }

  private update(): void {
    this.options.onUpdate(this.state);
  }
}
