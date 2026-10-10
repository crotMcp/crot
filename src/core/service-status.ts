/**
 * State of the supervised CROT service (WP-20, AD-17), reported by crot_status.
 *
 * Supplied by the host that runs Core (the service); Core only reports it.
 * It contains no credentials, no client data and no endpoint secrets.
 */
export interface ServiceStatus {
  /** Lifecycle state of the service process. */
  readonly state: "starting" | "running" | "stopping";
  readonly pid: number;
  /** ISO timestamp of the service start. */
  readonly startedAt: string;
  readonly uptimeMs: number;
  /**
   * on-demand: started by a stdio shim, stops when the last client has gone;
   * managed: started explicitly or by an OS supervisor (systemd user unit,
   * launchd agent, Task Scheduler), keeps running.
   */
  readonly launch: "on-demand" | "managed";
  /** Connected local clients: stdio shims (one MCP connection each) and control-channel peers. */
  readonly clients: { readonly stdio: number; readonly control: number };
  readonly endpoints: { readonly kind: "unix-socket" | "named-pipe" };
  readonly http: {
    readonly enabled: boolean;
    readonly url?: string;
    /** Sessionless (2026-07-28) requests in flight and their limit (http.maxConcurrentRequests). */
    readonly sessionless?: { readonly inFlight: number; readonly limit: number; readonly rejected: number };
  };
  /** Detected system suspend/resume (or clock jumps) and the last endpoint re-check. */
  readonly power: { readonly resumes: number; readonly lastResumeAt?: string };
  /**
   * Secret store of the service (WP-21, AD-18): backend and location, never a
   * value. store: keychain | dpapi | libsecret | file. httpToken: where the
   * HTTP token is kept when HTTP is enabled ("token-file" is the plaintext
   * compatibility mode).
   */
  readonly secrets: {
    readonly store: string;
    readonly location: string;
    readonly fallbackReason?: string;
    readonly httpToken?: "secret-store" | "token-file";
  };
  /**
   * Device controls of the tray (WP-22, AD-19): where the preset comes from,
   * remote mode, the remote full-control opt-in as recorded and whether the
   * running Core applies it (WP-31), and the number of trays subscribed to
   * approvals. Changed only through the control channel.
   */
  readonly controls?: {
    readonly preset: { readonly value: string; readonly source: "device" | "configuration" | "fail-closed" };
    readonly remoteMode: boolean;
    readonly remoteFullControl: boolean;
    /** The running Core applies the opt-in (recorded, readable and the device paired here). */
    readonly remoteFullControlEffective?: boolean;
    readonly approvalUis: number;
  };
}
