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

/** Parameters of each command Core sends to the extension. */
export interface BrowserCommandParams {
  "tabs.list": Record<string, never>;
  "tabs.open": { readonly url: string; readonly active: boolean };
  "tabs.navigate": { readonly tabId?: number; readonly url: string };
  "tabs.activate": { readonly tabId: number };
  "tabs.close": { readonly tabId: number };
  "page.read": { readonly tabId?: number; readonly format: BrowserPageFormat; readonly maxBytes: number };
  "page.screenshot": { readonly tabId?: number; readonly format: BrowserImageFormat; readonly quality?: number };
  "page.click": { readonly tabId?: number; readonly selector: string };
  "page.type": { readonly tabId?: number; readonly selector: string; readonly text: string; readonly clear: boolean };
}

export type BrowserCommand = keyof BrowserCommandParams;

export const BROWSER_COMMANDS: readonly BrowserCommand[] = [
  "tabs.list",
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
  | { readonly kind: "connected"; readonly browser: BrowserInfo }
  | { readonly kind: "in_use" };

export interface BrowserRequestOptions {
  /** How long Core waits for the answer. Core enforces it independently. */
  readonly timeoutMs: number;
  /** Aborted when Core gives up on the request (timeout, shutdown). */
  readonly signal: AbortSignal;
}

export interface BrowserConnection {
  state(): BrowserConnectionState;
  /**
   * Send one command and resolve with the extension's raw (unvalidated)
   * result, or reject with a CrotError reported by the extension.
   */
  request<C extends BrowserCommand>(command: C, params: BrowserCommandParams[C], options: BrowserRequestOptions): Promise<unknown>;
}
