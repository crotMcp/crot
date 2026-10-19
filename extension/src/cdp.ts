import { ownershipToken } from "./download-ownership.js";
import type { BrowserNotice } from "../../src/browser-bridge/protocol.js";
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
 * Not here, therefore never sendable: Runtime.*, Debugger.*, all Fetch methods except the four AD-33 continuations,
 * Storage.*, Browser.*, SystemInfo.*, every other Emulation method, Network.getCookies /
 * getResponseBody / interception, Target.createTarget,
 * Target.createBrowserContext, Page.addScriptToEvaluateOnNewDocument.
 * Dialog, chooser interception and screenshot methods are included by WP-25.
 * WP-26 adds DOM.setFileInputFiles and the four AD-33 Fetch methods; there is no generic interception tool.
 */
export const CDP_ALLOWED_METHODS: ReadonlySet<string> = new Set([
  "Accessibility.enable",
  "Accessibility.getFullAXTree",
  "Accessibility.getPartialAXTree",
  "DOM.setFileInputFiles",
  "Fetch.enable",
  "Fetch.continueResponse",
  "Fetch.continueRequest",
  "Fetch.disable",
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
  "Page.captureScreenshot",
  "Page.handleJavaScriptDialog",
  "Page.setInterceptFileChooserDialog",
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
  "DOM.setFileInputFiles",
  "Page.getFrameTree",
  "Page.enable",
  "Page.getNavigationHistory",
  "Target.setAutoAttach",
  "Page.handleJavaScriptDialog",
]);

export const dialogMessage = (_type: string, _opened: boolean): string =>
  "A dialog is open in the tab; use browser_snapshot or browser_dialog_handle.";

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

export type DialogType = "alert" | "confirm" | "prompt" | "beforeunload" | "file_chooser";
export interface PendingDialog {
  readonly type: DialogType;
  readonly message: string;
  readonly defaultPrompt?: string;
}
export interface CdpOptions {
  readonly dialogTimeoutMs?: number;
  readonly onNotice?: (notice: BrowserNotice) => void;
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
  readonly childReady: Map<string, Promise<void>>;
}

export class CdpSessions {
  private readonly sessionListeners = new Set<
    (tabId: number, method: string, params: unknown, sessionId?: string) => void
  >();
  private readonly uploads = new Map<number, Map<string, string>>();
  private readonly choosers = new Map<
    number,
    { backendNodeId: number; frameId: string; nonce: string; sessionId?: string }
  >();
  private readonly attachments = new Map<number, Attachment>();
  private readonly generations = new Map<number, number>();
  private readonly listeners = new Set<CdpEventListener>();
  /** Open JavaScript dialogs per tab (type), from Page.javascriptDialogOpening / Closed. */
  private readonly dialogs = new Map<number, PendingDialog>();
  private readonly dialogSessions = new Map<number, string | undefined>();
  private readonly dialogTimers = new Map<number, unknown>();
  private readonly pending = new Map<number, Set<(e: Error) => void>>();
  private readonly dialogTimeoutMs: number;
  private readonly notice: (notice: BrowserNotice) => void;
  private readonly dialogWaiters = new Map<number, Set<(type: string) => void>>();
  private readonly idleMs: number;
  private readonly setTimer: (callback: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(
    private readonly api: ChromeApi,
    options: CdpOptions = {},
  ) {
    this.dialogTimeoutMs = options.dialogTimeoutMs ?? 60_000;
    this.notice = options.onNotice ?? (() => undefined);
    this.idleMs = options.idleDetachMs ?? CDP_IDLE_DETACH_MS;
    this.setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    if (!api.debugger) return;
    api.debugger.onDetach.addListener((source) => {
      if (source.tabId === undefined) return;
      // A child session ending (its frame went away) is not a detach of the tab.
      if (source.sessionId !== undefined)
        this.onTargetEvent(source.tabId, undefined, "Target.detachedFromTarget", { sessionId: source.sessionId });
      else this.forget(source.tabId);
    });
    api.debugger.onEvent.addListener((source, method, params) => {
      if (source.tabId === undefined || !this.attachments.has(source.tabId)) return;
      for (const listener of this.sessionListeners) listener(source.tabId, method, params, source.sessionId);
      const frame = params as { frame?: { id?: string; parentId?: string }; frameId?: string } | undefined;
      if (method === "Page.frameNavigated" && frame?.frame?.id) {
        const top = frame.frame.parentId === undefined && source.sessionId === undefined;
        if (top) this.releaseUploads(source.tabId);
        // A parent page may retain a File from a removed/navigated child.
        // Only replacing the tab's top-level document releases lazy-read copies.
        if (top || this.choosers.get(source.tabId)?.frameId === frame.frame.id) this.clearDialog(source.tabId);
      } else if (
        method === "Page.frameDetached" &&
        frame?.frameId &&
        frame.frameId === this.choosers.get(source.tabId)?.frameId
      ) {
        this.clearDialog(source.tabId);
      }
      if (method === "Page.fileChooserOpened") {
        const p = params as { backendNodeId?: number; frameId?: string };
        if (Number.isSafeInteger(p.backendNodeId) && typeof p.frameId === "string")
          this.choosers.set(source.tabId, {
            backendNodeId: p.backendNodeId!,
            nonce: ownershipToken(),
            frameId: p.frameId,
            ...(source.sessionId === undefined ? {} : { sessionId: source.sessionId }),
          });
      }
      if (method === "Page.javascriptDialogOpening" || method === "Page.fileChooserOpened") {
        const p = (params ?? {}) as { type?: string; message?: string; defaultPrompt?: string };
        const type = method === "Page.fileChooserOpened" ? "file_chooser" : p.type;
        if (["alert", "confirm", "prompt", "beforeunload", "file_chooser"].includes(type ?? "")) {
          const dialog: PendingDialog = {
            type: type as DialogType,
            message: String(p.message ?? "").slice(0, 10_000),
            ...(typeof p.defaultPrompt === "string" ? { defaultPrompt: p.defaultPrompt.slice(0, 10_000) } : {}),
          };
          const chooser = this.choosers.get(source.tabId);
          this.clearDialog(source.tabId);
          if (type === "file_chooser" && chooser) this.choosers.set(source.tabId, chooser);
          this.dialogs.set(source.tabId, dialog);
          this.dialogSessions.set(source.tabId, source.sessionId);
          const id = source.tabId;
          this.dialogTimers.set(
            id,
            this.setTimer(() => {
              if (this.dialogs.get(id) !== dialog) return;
              void this.handleDialog(id, false)
                .then(() =>
                  this.notice({
                    type: "browser_notice",
                    event: "dialog_auto_dismissed",
                    tabId: id,
                    dialogType: dialog.type,
                  }),
                )
                .catch(() => undefined);
            }, this.dialogTimeoutMs),
          );
          for (const waiter of this.dialogWaiters.get(id) ?? []) waiter(dialog.type);
        }
      } else if (method === "Page.javascriptDialogClosed") this.clearDialog(source.tabId);
      if (method === "Target.attachedToTarget" || method === "Target.detachedFromTarget") {
        this.onTargetEvent(source.tabId, source.sessionId, method, params);
        return;
      }
      // Listeners observe the tab's top-level session only (lifecycle, navigation, network).
      if (source.sessionId !== undefined) return;
      for (const listener of this.listeners) listener(source.tabId, method, params);
    });
    api.tabs.onRemoved.addListener((tabId) => {
      this.releaseUploads(tabId);
      this.forget(tabId);
    });
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
    if (dialog !== undefined)
      throw new ExtensionError(
        "BROWSER_DIALOG_OPEN",
        "A dialog is open in the tab; use browser_snapshot or browser_dialog_handle.",
      );
  }

  onSessionEvent(listener: (tabId: number, method: string, params: unknown, sessionId?: string) => void): () => void {
    this.sessionListeners.add(listener);
    return () => this.sessionListeners.delete(listener);
  }
  retainUpload(tabId: number, token: string, frameId: string): void {
    const leases = this.uploads.get(tabId) ?? new Map<string, string>();
    leases.set(token, frameId);
    this.uploads.set(tabId, leases);
  }
  private releaseUploads(tabId: number, frameId?: string): void {
    const leases = this.uploads.get(tabId);
    if (!leases) return;
    for (const [token, frame] of leases)
      if (frameId === undefined || frame === frameId) {
        leases.delete(token);
        this.notice({ type: "browser_notice", event: "upload_released", token });
      }
    if (!leases.size) this.uploads.delete(tabId);
  }
  fileChooser(
    tabId: number,
  ): { backendNodeId: number; frameId: string; nonce: string; sessionId?: string } | undefined {
    return this.choosers.get(tabId);
  }
  completeFileChooser(tabId: number, nonce: string): void {
    if (this.choosers.get(tabId)?.nonce === nonce && this.dialogs.get(tabId)?.type === "file_chooser")
      this.clearDialog(tabId);
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
      throw new ExtensionError(
        "BROWSER_DIALOG_OPEN",
        "A dialog is open in the tab; use browser_snapshot or browser_dialog_handle.",
      );
    if (sessionId !== undefined && !this.attachments.get(tabId)?.children.has(sessionId)) {
      throw new ExtensionError("OPERATION_FAILED", FRAME_DETACHED_MESSAGE);
    }
    try {
      const command = this.api.debugger.sendCommand(target(tabId, sessionId), method, params);
      if (DIALOG_SAFE_METHODS.has(method)) return (await this.cancellable(tabId, command)) as T;
      // A dialog the command opens (a click on a button that calls alert()) blocks its answer.
      let stop = (): void => undefined;
      const opened = new Promise<never>((_, reject) => {
        const waiter = (type: string): void =>
          reject(new ExtensionError("BROWSER_DIALOG_OPEN", "The action opened a dialog: " + type));
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
        return (await this.cancellable(tabId, Promise.race([command, opened]))) as T;
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
      if (/Debugger is not attached/i.test(message)) {
        this.forget(tabId, false); // No retry: next command may attach afresh.
        throw new ExtensionError("OPERATION_FAILED", DETACHED_MESSAGE);
      }
      throw new ExtensionError("OPERATION_FAILED", "Browser operation failed: " + message);
    } finally {
      this.touch(tabId);
    }
  }

  /** Attaches to a tab if needed and answers the tab's generation. */
  async attach(tabId: number): Promise<number> {
    if (!this.api.debugger) {
      this.notice({ type: "browser_notice", event: "cdp_status", available: false });
      throw new ExtensionError("OPERATION_FAILED", CDP_UNAVAILABLE_MESSAGE);
    }
    let attachment = this.attachments.get(tabId);
    if (!attachment) {
      const created: Attachment = {
        attached: false,
        children: new Map(),
        childReady: new Map(),
        ready: this.api.debugger.attach(target(tabId), CDP_PROTOCOL_VERSION).then(() => {
          if (this.attachments.get(tabId) !== created) throw new ExtensionError("OPERATION_FAILED", DETACHED_MESSAGE);
          created.attached = true;
          return this.api.debugger
            .sendCommand(target(tabId), "Page.enable")
            .then(() =>
              this.api.debugger.sendCommand(target(tabId), "Page.setInterceptFileChooserDialog", { enabled: true }),
            )
            .then(() => {
              this.notice({ type: "browser_notice", event: "cdp_status", available: true });
            });
        }),
      };
      attachment = created;
      this.attachments.set(tabId, created);
      try {
        await created.ready;
      } catch {
        if (this.attachments.get(tabId) === created) {
          this.forget(tabId);
          void this.api.debugger.detach(target(tabId)).catch(() => undefined);
        }
        this.notice({ type: "browser_notice", event: "cdp_status", available: false });
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
    await Promise.all(attachment.childReady.values());
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
        attachment.childReady.delete(id);
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
    // Every OOP frame gets the same interception, before frame commands proceed.
    const ready = (async () => {
      await this.send(tabId, "Page.enable", {}, sessionId);
      await this.send(tabId, "Page.setInterceptFileChooserDialog", { enabled: true }, sessionId);
      await this.send(tabId, "Target.setAutoAttach", AUTO_ATTACH, sessionId);
    })();
    attachment.childReady.set(sessionId, ready);
    void ready.catch(() => undefined); // frameSessions propagates failures; avoid unhandled event promises.
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

  dialog(tabId: number): PendingDialog | undefined {
    return this.dialogs.get(tabId);
  }

  private clearDialog(tabId: number): void {
    const timer = this.dialogTimers.get(tabId);
    if (timer !== undefined) this.clearTimer(timer);
    this.dialogTimers.delete(tabId);
    this.dialogs.delete(tabId);
    this.choosers.delete(tabId);
    this.dialogSessions.delete(tabId);
  }

  async handleDialog(tabId: number, accept: boolean, promptText?: string): Promise<void> {
    const dialog = this.dialogs.get(tabId);
    if (!dialog) throw new ExtensionError("NOT_FOUND", "There is no pending dialog in the tab.");
    if (promptText !== undefined && dialog.type !== "prompt")
      throw new ExtensionError("INVALID_INPUT", "promptText is only valid for prompt.");
    if (dialog.type === "file_chooser") {
      if (accept)
        throw new ExtensionError(
          "INVALID_INPUT",
          "Use browser_file_upload to answer this chooser, or accept=false to dismiss it.",
        );
    } else
      await this.send(
        tabId,
        "Page.handleJavaScriptDialog",
        {
          accept,
          ...(promptText === undefined ? {} : { promptText }),
        },
        this.dialogSessions.get(tabId),
      );
    if (this.dialogs.get(tabId) === dialog) this.clearDialog(tabId);
  }

  async guardDialog<T>(tabId: number, run: () => Promise<T>): Promise<T> {
    this.assertNoDialog(tabId);
    let waiter: (type: string) => void = () => undefined;
    const waiters = this.dialogWaiters.get(tabId) ?? new Set();
    this.dialogWaiters.set(tabId, waiters);
    const opened = new Promise<never>((_, reject) => {
      waiter = () => reject(new ExtensionError("BROWSER_DIALOG_OPEN", dialogMessage("", true)));
      waiters.add(waiter);
    });
    try {
      return await this.cancellable(tabId, Promise.race([run(), opened]));
    } finally {
      waiters.delete(waiter);
      if (!waiters.size) this.dialogWaiters.delete(tabId);
    }
  }

  async cancellable<T>(tabId: number, command: Promise<T>): Promise<T> {
    let rejecter: (e: Error) => void = () => undefined;
    const waiters = this.pending.get(tabId) ?? new Set();
    this.pending.set(tabId, waiters);
    const detached = new Promise<never>((_, reject) => {
      rejecter = reject;
      waiters.add(rejecter);
    });
    try {
      return await Promise.race([command, detached]);
    } finally {
      waiters.delete(rejecter);
      if (!waiters.size) this.pending.delete(tabId);
    }
  }

  private touch(tabId: number): void {
    const attachment = this.attachments.get(tabId);
    if (!attachment) return;
    if (attachment.idle !== undefined) this.clearTimer(attachment.idle);
    attachment.idle = this.setTimer(() => {
      if (this.uploads.has(tabId)) this.touch(tabId);
      else void this.detach(tabId);
    }, this.idleMs);
  }

  private forget(tabId: number, cancel = true): void {
    const attachment = this.attachments.get(tabId);
    if (!attachment) return;
    if (attachment.idle !== undefined) this.clearTimer(attachment.idle);
    attachment.attached = false;
    attachment.children.clear();
    attachment.childReady.clear();
    this.attachments.delete(tabId);
    this.clearDialog(tabId);
    if (cancel)
      for (const reject of this.pending.get(tabId) ?? [])
        reject(new ExtensionError("OPERATION_FAILED", DETACHED_MESSAGE));
    this.generations.set(tabId, this.generation(tabId) + 1);
  }
}

const target = (tabId: number, sessionId?: string): ChromeDebuggee =>
  sessionId === undefined ? { tabId } : { tabId, sessionId };

const FRAME_DETACHED_MESSAGE = "The frame's debugger session ended (the frame was removed or navigated).";
