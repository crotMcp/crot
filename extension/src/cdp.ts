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
 * Target (auto-attach to child frames), event-only Network and one Emulation
 * method: focus emulation, so that keys and focus reach the page while the
 * browser window is not the focused window (it changes nothing else).
 *
 * Not here, therefore never sendable: Runtime.*, Debugger.*, Fetch.*,
 * Storage.*, Browser.*, SystemInfo.*, every other Emulation method, Network.getCookies /
 * getResponseBody / interception, Target.createTarget,
 * Target.createBrowserContext, Page.addScriptToEvaluateOnNewDocument.
 * DOM.setFileInputFiles and the Page dialog / file chooser / download methods
 * belong to WP-25 and WP-26 and are added there.
 */
export const CDP_ALLOWED_METHODS: ReadonlySet<string> = new Set([
  "Accessibility.enable",
  "Accessibility.getFullAXTree",
  "Accessibility.getPartialAXTree",
  "DOM.enable",
  "DOM.getDocument",
  "DOM.describeNode",
  "DOM.resolveNode",
  "DOM.getBoxModel",
  "DOM.getContentQuads",
  "DOM.getFrameOwner",
  "DOM.getNodeForLocation",
  "DOM.focus",
  "DOM.scrollIntoViewIfNeeded",
  "DOM.querySelector",
  "DOM.requestNode",
  "DOMSnapshot.captureSnapshot",
  "Emulation.setFocusEmulationEnabled",
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

/** Methods that still answer while a JavaScript dialog blocks the page (they do not need the page's script). */
const DIALOG_SAFE_METHODS: ReadonlySet<string> = new Set([
  "Page.enable",
  "Page.getNavigationHistory",
  "Target.setAutoAttach",
]);

/**
 * A JavaScript dialog (alert, confirm, prompt, beforeunload) blocks the page
 * until the user answers it. Browser v1 does not answer dialogs, so commands
 * fail at once instead of waiting out their timeout.
 */
export const dialogMessage = (type: string, opened: boolean): string =>
  (opened ? "The action opened a JavaScript " : "A JavaScript ") +
  (["alert", "confirm", "prompt", "beforeunload"].includes(type) ? type : "") +
  " dialog" +
  (opened ? "" : " is open in the tab") +
  ": the page is blocked until it is answered. CROT does not answer dialogs; ask the user to close it in the browser, then continue.";

export type CdpEventListener = (tabId: number, method: string, params: unknown) => void;

/** Bound on auto-attached child sessions (out-of-process frames) per tab, as for snapshot frames. */
export const CDP_MAX_CHILD_SESSIONS = 100;
/** Depth bound of nested out-of-process frames. */
export const CDP_MAX_CHILD_DEPTH = 8;

const AUTO_ATTACH = { autoAttach: true, waitForDebuggerOnStart: false, flatten: true } as const;

/**
 * An out-of-process frame of a tab (AD-16 point 10): a flat child session of
 * the tab's debugger, auto-attached with Target.setAutoAttach. Commands for
 * it go through the same allowlist; it is never a separate debugger target.
 */
export interface ChildSession {
  readonly sessionId: string;
  /** The frame id of the child's root frame (its target id). */
  readonly frameId: string;
  /** The session the child was attached from; undefined for the tab's own session. */
  readonly parentSessionId: string | undefined;
  readonly depth: number;
}

export interface CdpOptions {
  readonly idleDetachMs?: number;
  readonly setTimer?: (callback: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
}

interface Attachment {
  readonly ready: Promise<void>;
  attached: boolean;
  idle?: unknown;
  /** Target.setAutoAttach has been sent on the tab's own session. */
  autoAttach?: Promise<void>;
  readonly children: Map<string, ChildSession>;
}

export class CdpSessions {
  private readonly attachments = new Map<number, Attachment>();
  private readonly generations = new Map<number, number>();
  private readonly listeners = new Set<CdpEventListener>();
  /** Open JavaScript dialogs per tab (type), from Page.javascriptDialogOpening / Closed. */
  private readonly dialogs = new Map<number, string>();
  private readonly dialogWaiters = new Map<number, Set<(type: string) => void>>();
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
      if (source.tabId === undefined) return;
      // A child session ending (its frame went away) is not a detach of the tab.
      if (source.sessionId !== undefined)
        this.onTargetEvent(source.tabId, undefined, "Target.detachedFromTarget", { sessionId: source.sessionId });
      else this.forget(source.tabId);
    });
    api.debugger.onEvent.addListener((source, method, params) => {
      if (source.tabId === undefined || !this.attachments.has(source.tabId)) return;
      if (method === "Page.javascriptDialogOpening") {
        const type = String((params as { type?: unknown } | undefined)?.type ?? "");
        this.dialogs.set(source.tabId, type);
        for (const waiter of this.dialogWaiters.get(source.tabId) ?? []) waiter(type);
      } else if (method === "Page.javascriptDialogClosed") {
        this.dialogs.delete(source.tabId);
      }
      if (method === "Target.attachedToTarget" || method === "Target.detachedFromTarget") {
        this.onTargetEvent(source.tabId, source.sessionId, method, params);
        return;
      }
      // Listeners observe the tab's top-level session only (lifecycle, navigation, network).
      if (source.sessionId !== undefined) return;
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

  /** Fails at once while a JavaScript dialog is known to block the tab (before script injection, which would wait). */
  assertNoDialog(tabId: number): void {
    const dialog = this.dialogs.get(tabId);
    if (dialog !== undefined) throw new ExtensionError("OPERATION_FAILED", dialogMessage(dialog, false));
  }

  onEvent(listener: CdpEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Sends one allowlisted method to a tab, attaching first if needed. With
   * `sessionId` it goes to that auto-attached child session (an
   * out-of-process frame) of the same tab.
   */
  async send<T = unknown>(
    tabId: number,
    method: string,
    params: Readonly<Record<string, unknown>> = {},
    sessionId?: string,
  ): Promise<T> {
    if (!CDP_ALLOWED_METHODS.has(method)) {
      throw new ExtensionError("OPERATION_FAILED", "CDP method '" + method + "' is not allowed.");
    }
    const generation = await this.attach(tabId);
    const dialog = this.dialogs.get(tabId);
    if (dialog !== undefined && !DIALOG_SAFE_METHODS.has(method))
      throw new ExtensionError("OPERATION_FAILED", dialogMessage(dialog, false));
    if (sessionId !== undefined && !this.attachments.get(tabId)?.children.has(sessionId)) {
      throw new ExtensionError("OPERATION_FAILED", FRAME_DETACHED_MESSAGE);
    }
    try {
      const command = this.api.debugger.sendCommand(target(tabId, sessionId), method, params);
      if (DIALOG_SAFE_METHODS.has(method)) return (await command) as T;
      // A dialog the command opens (a click on a button that calls alert()) blocks its answer.
      let stop = (): void => undefined;
      const opened = new Promise<never>((_, reject) => {
        const waiter = (type: string): void =>
          reject(new ExtensionError("OPERATION_FAILED", dialogMessage(type, true)));
        const waiters = this.dialogWaiters.get(tabId) ?? new Set();
        waiters.add(waiter);
        this.dialogWaiters.set(tabId, waiters);
        stop = () => {
          waiters.delete(waiter);
          if (waiters.size === 0) this.dialogWaiters.delete(tabId);
        };
      });
      command.catch(() => undefined);
      try {
        return (await Promise.race([command, opened])) as T;
      } finally {
        stop();
      }
    } catch (error) {
      if (error instanceof ExtensionError) throw error;
      if (sessionId !== undefined && !this.attachments.get(tabId)?.children.has(sessionId)) {
        throw new ExtensionError("OPERATION_FAILED", FRAME_DETACHED_MESSAGE);
      }
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
        children: new Map(),
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

  /**
   * Auto-attach to the tab's out-of-process frames (once per debugger
   * session) and answer the child sessions. Chromium reports the existing
   * frames before it answers Target.setAutoAttach; later ones as they appear.
   */
  async frameSessions(tabId: number): Promise<readonly ChildSession[]> {
    await this.attach(tabId);
    const attachment = this.attachments.get(tabId);
    if (!attachment) throw new ExtensionError("OPERATION_FAILED", DETACHED_MESSAGE);
    attachment.autoAttach ??= this.send(tabId, "Target.setAutoAttach", AUTO_ATTACH).then(() => undefined);
    try {
      await attachment.autoAttach;
    } catch (error) {
      if (this.attachments.get(tabId) === attachment) attachment.autoAttach = undefined;
      throw error;
    }
    return [...attachment.children.values()];
  }

  private onTargetEvent(tabId: number, parentSessionId: string | undefined, method: string, raw: unknown): void {
    const attachment = this.attachments.get(tabId);
    if (!attachment || typeof raw !== "object" || raw === null) return;
    const params = raw as { sessionId?: unknown; targetInfo?: { type?: unknown; targetId?: unknown } };
    if (typeof params.sessionId !== "string") return;
    if (method === "Target.detachedFromTarget") {
      const gone = [params.sessionId];
      while (gone.length > 0) {
        const id = gone.pop() as string;
        attachment.children.delete(id);
        for (const child of attachment.children.values()) if (child.parentSessionId === id) gone.push(child.sessionId);
      }
      return;
    }
    const info = params.targetInfo;
    if (info?.type !== "iframe" || typeof info.targetId !== "string") return;
    const parent = parentSessionId === undefined ? undefined : attachment.children.get(parentSessionId);
    if (parentSessionId !== undefined && parent === undefined) return;
    const depth = (parent?.depth ?? 0) + 1;
    if (depth > CDP_MAX_CHILD_DEPTH || attachment.children.size >= CDP_MAX_CHILD_SESSIONS) return;
    const sessionId = params.sessionId;
    attachment.children.set(sessionId, { sessionId, frameId: info.targetId, parentSessionId, depth });
    // Nested out-of-process frames of this frame.
    void this.send(tabId, "Target.setAutoAttach", AUTO_ATTACH, sessionId).catch(() => undefined);
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
    attachment.children.clear();
    this.attachments.delete(tabId);
    this.dialogs.delete(tabId);
    this.generations.set(tabId, this.generation(tabId) + 1);
  }
}

const target = (tabId: number, sessionId?: string): ChromeDebuggee =>
  sessionId === undefined ? { tabId } : { tabId, sessionId };

const FRAME_DETACHED_MESSAGE = "The frame's debugger session ended (the frame was removed or navigated).";
