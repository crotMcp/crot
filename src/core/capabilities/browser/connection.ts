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
  "files.chooser": { readonly tabId: number } & Expect;
  "files.download_release": { readonly stem: string };
  "files.upload": {
    readonly tabId?: number;
    readonly ref?: string;
    readonly chooserNonce?: string;
    readonly token: string;
    readonly paths: readonly string[];
  } & Expect;
  "files.download": {
    readonly tabId?: number;
    readonly ref?: string;
    readonly selector?: string;
    readonly frameRef?: string;
    readonly url?: string;
    readonly prefix: string;
    readonly stem: string;
    readonly deadline: number;
    readonly timeoutMs: number;
    readonly maxBytes: number;
  } & Expect;
  "dialog.handle": { readonly tabId?: number; readonly accept: boolean; readonly promptText?: string } & Expect;
  "tabs.list": Record<string, never>;
  /**
   * AD-8: the concrete tab a gated, tab-targeting operation would act on (the
   * given tab, or the active tab of the last focused window) and its URL.
   * Reads tab id and URL only; never acts on the page.
   */
  "tabs.resolve": { readonly tabId?: number };
  "tabs.open": { readonly url: string; readonly active: boolean } & Settle & Expect;
  "tabs.navigate": { readonly tabId?: number; readonly url: string } & Settle & Expect;
  "tabs.activate": { readonly tabId: number } & Expect;
  "tabs.close": { readonly tabId: number } & Expect;
  "page.read": { readonly tabId?: number; readonly format: BrowserPageFormat; readonly maxBytes: number } & Expect;
  "page.screenshot": {
    readonly tabId?: number;
    readonly format: BrowserImageFormat;
    readonly quality?: number;
    readonly ref?: string;
    readonly fullPage?: boolean;
  } & Expect;
  /** Legacy form: selector only (page function). Browser v1 form: ref or selector plus options, trusted CDP input. */
  "page.click": Partial<Target> & {
    readonly button?: "left" | "right" | "middle";
    readonly clickCount?: 1 | 2;
    readonly modifiers?: readonly ("Shift" | "Control" | "Alt" | "Meta" | "ControlOrMeta")[];
  } & Settle &
    Expect;
  "page.type": Partial<Target> & {
    readonly text: string;
    readonly clear: boolean;
    readonly submit?: boolean;
  } & Settle &
    Expect;
  /** Browser v1 (AD-16 points 5-7): accessibility snapshot with document-bound element refs. */
  "page.snapshot": {
    readonly tabId?: number;
    readonly frameRef?: string;
    readonly includeText?: boolean;
    readonly maxElements?: number;
  } & Expect;
  "page.hover": Target & Settle & Expect;
  "page.scroll": Partial<Target> & { readonly deltaX?: number; readonly deltaY?: number } & Settle & Expect;
  "page.drag": Target & { readonly to: { readonly ref?: string; readonly selector?: string } } & Settle & Expect;
  "page.press_key": Partial<Target> & { readonly keys: readonly string[] } & Settle & Expect;
  "page.select_option": Target & { readonly values: readonly string[] } & Settle & Expect;
  "page.set_checked": Target & { readonly checked: boolean } & Settle & Expect;
  "page.wait": {
    readonly tabId?: number;
    readonly ref?: string;
    readonly selector?: string;
    readonly state?: "visible" | "hidden" | "enabled" | "detached";
    readonly text?: string;
    readonly textGone?: string;
    readonly urlPrefix?: string;
    readonly loadState?: BrowserWaitUntil;
    readonly newDocument?: true;
    readonly newTab?: true;
    readonly timeoutMs?: number;
  } & Expect;
  "tabs.history": { readonly tabId?: number; readonly action: "back" | "forward" | "reload" } & Settle & Expect;
}

export type BrowserWaitUntil = "commit" | "domcontentloaded" | "load" | "networkidle";

/** The element of a control command: exactly one of ref (from page.snapshot) or selector. */
interface Target {
  readonly tabId?: number;
  readonly ref?: string;
  readonly selector?: string;
}

/** Settle phase of a control command (AD-16 point 7). */
interface Settle {
  readonly waitUntil?: BrowserWaitUntil;
  readonly timeoutMs?: number;
}

export type BrowserCommand = keyof BrowserCommandParams;

export const BROWSER_COMMANDS: readonly BrowserCommand[] = [
  "files.chooser",
  "files.download_release",
  "files.upload",
  "files.download",
  "dialog.handle",
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
  "page.snapshot",
  "page.hover",
  "page.scroll",
  "page.drag",
  "page.press_key",
  "page.select_option",
  "page.set_checked",
  "page.wait",
  "tabs.history",
];

/**
 * - waiting: this instance owns the bridge; no extension is connected.
 * - connected: an extension is connected.
 * - in_use: another live CROT instance owns the bridge (ownership is exclusive).
 */
export type BrowserConnectionState =
  | { readonly kind: "waiting" }
  | { readonly kind: "update_required" }
  | {
      readonly kind: "connected";
      readonly browser: BrowserInfo;
      /** Random id (>= 128 bits) of this accepted connection; new for every hello, never reused (AD-9). Not shown to agents. */
      readonly connectionId: string;
      readonly cdp?: { readonly available: boolean; readonly reason: string | null };
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
  onUploadReleased?(listener: (token: string, connectionId: string) => void): () => void;
  onDialogDismissed?(
    listener: (event: { tabId: number; dialogType: string; connectionId: string }) => void,
  ): () => void;
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
