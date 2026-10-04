import type { BrowserImageFormat, BrowserInfo, BrowserPageFormat } from "./schemas.js";

/**
 * Core's view of the browser: one request/response channel to the CROT
 * Browser Extension, implemented outside Core by the browser bridge, which only
 * transports messages.
 *
 * The connection has no way to call into Core: the browser answers requests and
 * never initiates operations. Every request is issued by BrowserService after
 * the PermissionEngine has authorized it, and every response is validated by
 * BrowserService before it reaches an adapter.
 */

/**
 * Expected browser subject of a gated operation (ARCHITECTURE.md §27, AD-6,
 * AD-11): the values of the approved subject. The extension checks them
 * immediately before acting and refuses with PERMISSION_DENIED on any
 * mismatch. Carried only by commands of gated operations.
 */
export interface ExpectedBrowserSubject {
  /** Absent only for tabs.open (bound to the origin of the URL it opens). */
  readonly tabId?: number;
  /** Normalized WHATWG origin, http(s) only, compared by exact equality. */
  readonly origin: string;
  /** Connection id of the approved subject (AD-9). */
  readonly connectionId: string;
}

interface Expect {
  readonly expect?: ExpectedBrowserSubject;
}

/** Parameters of each command Core sends to the extension. */
export interface BrowserCommandParams {
  "tabs.list": Record<string, never>;
  /**
   * AD-8: the concrete tab a gated, tab-targeting operation would act on (the
   * given tab, or the active tab of the last focused window) and its URL.
   * Reads tab id and URL only; never acts on the page.
   */
  "tabs.resolve": { readonly tabId?: number };
  "tabs.open": { readonly url: string; readonly active: boolean } & Expect;
  "tabs.navigate": { readonly tabId?: number; readonly url: string } & Expect;
  "tabs.activate": { readonly tabId: number } & Expect;
  "tabs.close": { readonly tabId: number } & Expect;
  "page.read": { readonly tabId?: number; readonly format: BrowserPageFormat; readonly maxBytes: number } & Expect;
  "page.screenshot": {
    readonly tabId?: number;
    readonly format: BrowserImageFormat;
    readonly quality?: number;
  } & Expect;
  "page.click": { readonly tabId?: number; readonly selector: string } & Expect;
  "page.type": {
    readonly tabId?: number;
    readonly selector: string;
    readonly text: string;
    readonly clear: boolean;
  } & Expect;
}

export type BrowserCommand = keyof BrowserCommandParams;

export const BROWSER_COMMANDS: readonly BrowserCommand[] = [
  "tabs.list",
  "tabs.resolve",
  "tabs.open",
  "tabs.navigate",
  "tabs.activate",
  "tabs.close",
  "page.read",
  "page.screenshot",
  "page.click",
  "page.type",
];

/**
 * - waiting: this instance owns the bridge; no extension is connected.
 * - connected: an extension is connected.
 * - in_use: another live CROT instance owns the bridge (ownership is exclusive).
 */
export type BrowserConnectionState =
  | { readonly kind: "waiting" }
  | {
      readonly kind: "connected";
      readonly browser: BrowserInfo;
      /** Random id (>= 128 bits) of this accepted connection; new for every hello, never reused (AD-9). Not shown to agents. */
      readonly connectionId: string;
    }
  | { readonly kind: "in_use" };

export interface BrowserRequestOptions {
  /** How long Core waits for the answer. Core enforces it independently. */
  readonly timeoutMs: number;
  /** Aborted when Core gives up on the request (timeout, shutdown). */
  readonly signal: AbortSignal;
  /**
   * When set, the request is sent only on this connection; otherwise it is
   * rejected with PERMISSION_DENIED without being sent (AD-9, AD-11).
   */
  readonly connectionId?: string;
}

export interface BrowserConnection {
  state(): BrowserConnectionState;
  /**
   * Send one command and resolve with the extension's raw (unvalidated)
   * result, or reject with a CrotError reported by the extension.
   */
  request<C extends BrowserCommand>(
    command: C,
    params: BrowserCommandParams[C],
    options: BrowserRequestOptions,
  ): Promise<unknown>;
}
