import type { ChromeApi, ChromeDebuggee } from "./chrome-api.js";
import { ExtensionError } from "./errors.js";

/**
 * The extension's only path to the Chrome DevTools Protocol (ARCHITECTURE.md
 * §27, AD-16 point 3).
 *
 * - Fixed surface: only the methods in CDP_ALLOWED_METHODS can be sent. The
 *   list is compiled into the extension; nothing the host or a page sends can
 *   extend it. Every other method is refused before anything reaches the
 *   browser, including every Runtime method (the extension's page-world code
 *   uses chrome.scripting with built-in functions only).
 * - Attach lifecycle: a tab is attached on the first command that needs CDP,
 *   never otherwise; it is detached when the tab closes, when the host
 *   connection ends (detachAll) or after an idle period. The browser's own
 *   "debugging this browser" notice is never suppressed.
 * - Detach by the user or the browser: commands in flight fail with
 *   OPERATION_FAILED, the tab's generation advances (element references of
 *   the tab become stale, AD-16 point 5) and the next command re-attaches.
 * - No fallback: if attaching fails (for example blocked by policy), the
 *   command fails with OPERATION_FAILED and a fixed message.
 */

export const CDP_PROTOCOL_VERSION = "1.3";

/** Detach a tab no command used for this long. */
export const CDP_IDLE_DETACH_MS = 5 * 60_000;

/**
 * Every CDP method the extension may send (AD-16 point 3). Domains:
 * Accessibility, DOM (read, box model, focus, scroll into view, resolve and
 * describe), DOMSnapshot, Input, Page (lifecycle, history, frame tree),
 * Target (auto-attach to child frames) and event-only Network.
 *
 * Not here, therefore never sendable: Runtime.*, Debugger.*, Fetch.*,
 * Storage.*, Browser.*, SystemInfo.*, Emulation.*, Network.getCookies /
 * getResponseBody / interception, Target.createTarget,
 * Target.createBrowserContext, Page.addScriptToEvaluateOnNewDocument.
 * DOM.setFileInputFiles and the Page dialog / file chooser / download methods
 * belong to WP-25 and WP-26 and are added there.
 */
export const CDP_ALLOWED_METHODS: ReadonlySet<string> = new Set([
  "Accessibility.enable",
  "Accessibility.getFullAXTree",
  "DOM.enable",
  "DOM.getDocument",
  "DOM.describeNode",
  "DOM.resolveNode",
  "DOM.getBoxModel",
  "DOM.getContentQuads",
  "DOM.getNodeForLocation",
  "DOM.focus",
  "DOM.scrollIntoViewIfNeeded",
  "DOM.querySelector",
  "DOM.requestNode",
  "DOMSnapshot.captureSnapshot",
  "Input.dispatchMouseEvent",
  "Input.dispatchKeyEvent",
  "Input.insertText",
  "Page.enable",
  "Page.getFrameTree",
  "Page.getLayoutMetrics",
  "Page.getNavigationHistory",
  "Page.navigateToHistoryEntry",
  "Page.reload",
  "Page.setLifecycleEventsEnabled",
  "Target.setAutoAttach",
  "Network.enable",
]);

export const CDP_UNAVAILABLE_MESSAGE =
  "The browser debugger interface is not available to CROT (it may be blocked by browser policy).";

const DETACHED_MESSAGE = "The browser debugger was detached from the tab.";

export type CdpEventListener = (tabId: number, method: string, params: unknown) => void;

export interface CdpOptions {
  readonly idleDetachMs?: number;
  readonly setTimer?: (callback: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
}

interface Attachment {
  readonly ready: Promise<void>;
  attached: boolean;
  idle?: unknown;
}

export class CdpSessions {
  private readonly attachments = new Map<number, Attachment>();
  private readonly generations = new Map<number, number>();
  private readonly listeners = new Set<CdpEventListener>();
  private readonly idleMs: number;
  private readonly setTimer: (callback: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(
    private readonly api: ChromeApi,
    options: CdpOptions = {},
  ) {
    this.idleMs = options.idleDetachMs ?? CDP_IDLE_DETACH_MS;
    this.setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    api.debugger.onDetach.addListener((source) => {
      if (source.tabId !== undefined) this.forget(source.tabId);
    });
    api.debugger.onEvent.addListener((source, method, params) => {
      if (source.tabId === undefined || !this.attachments.has(source.tabId)) return;
      for (const listener of this.listeners) listener(source.tabId, method, params);
    });
    api.tabs.onRemoved.addListener((tabId) => this.forget(tabId));
  }

  /** Increases whenever the tab's debugger session ends; references carry it to detect detach. */
  generation(tabId: number): number {
    return this.generations.get(tabId) ?? 0;
  }

  isAttached(tabId: number): boolean {
    return this.attachments.get(tabId)?.attached === true;
  }

  onEvent(listener: CdpEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Sends one allowlisted method to a tab, attaching first if needed. */
  async send<T = unknown>(tabId: number, method: string, params: Readonly<Record<string, unknown>> = {}): Promise<T> {
    if (!CDP_ALLOWED_METHODS.has(method)) {
      throw new ExtensionError("OPERATION_FAILED", "CDP method '" + method + "' is not allowed.");
    }
    const generation = await this.attach(tabId);
    try {
      return (await this.api.debugger.sendCommand(target(tabId), method, params)) as T;
    } catch (error) {
      if (this.generation(tabId) !== generation || !this.isAttached(tabId)) {
        throw new ExtensionError("OPERATION_FAILED", DETACHED_MESSAGE);
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new ExtensionError("OPERATION_FAILED", "Browser operation failed: " + message);
    } finally {
      this.touch(tabId);
    }
  }

  /** Attaches to a tab if needed and answers the tab's generation. */
  async attach(tabId: number): Promise<number> {
    let attachment = this.attachments.get(tabId);
    if (!attachment) {
      const created: Attachment = {
        attached: false,
        ready: this.api.debugger.attach(target(tabId), CDP_PROTOCOL_VERSION).then(() => {
          created.attached = true;
        }),
      };
      attachment = created;
      this.attachments.set(tabId, created);
      try {
        await created.ready;
      } catch {
        if (this.attachments.get(tabId) === created) this.attachments.delete(tabId);
        throw new ExtensionError("OPERATION_FAILED", CDP_UNAVAILABLE_MESSAGE);
      }
    } else {
      try {
        await attachment.ready;
      } catch {
        throw new ExtensionError("OPERATION_FAILED", CDP_UNAVAILABLE_MESSAGE);
      }
    }
    if (!attachment.attached) throw new ExtensionError("OPERATION_FAILED", DETACHED_MESSAGE);
    this.touch(tabId);
    return this.generation(tabId);
  }

  /** Detaches one tab (idle, tab no longer needed). */
  async detach(tabId: number): Promise<void> {
    const attachment = this.attachments.get(tabId);
    if (!attachment) return;
    const wasAttached = attachment.attached;
    this.forget(tabId);
    if (wasAttached) await this.api.debugger.detach(target(tabId)).catch(() => undefined);
  }

  /** Detaches every tab, for example when the host connection ends. */
  async detachAll(): Promise<void> {
    await Promise.all([...this.attachments.keys()].map((tabId) => this.detach(tabId)));
  }

  private touch(tabId: number): void {
    const attachment = this.attachments.get(tabId);
    if (!attachment) return;
    if (attachment.idle !== undefined) this.clearTimer(attachment.idle);
    attachment.idle = this.setTimer(() => void this.detach(tabId), this.idleMs);
  }

  private forget(tabId: number): void {
    const attachment = this.attachments.get(tabId);
    if (!attachment) return;
    if (attachment.idle !== undefined) this.clearTimer(attachment.idle);
    attachment.attached = false;
    this.attachments.delete(tabId);
    this.generations.set(tabId, this.generation(tabId) + 1);
  }
}

const target = (tabId: number): ChromeDebuggee => ({ tabId });
