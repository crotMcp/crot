/**
 * The subset of the Chromium extension API the CROT Browser Extension uses,
 * declared here because the project has no @types/chrome dependency. The
 * extension's modules receive this object as a parameter (the real `chrome`
 * in background.ts, a fake in the tests).
 *
 * scripting.executeScript is declared with `func` only: the extension runs
 * nothing in pages except the fixed functions of page-functions.ts, never
 * script files, code strings or anything provided by the host.
 */

export interface ChromeEvent<L extends (...args: never[]) => void> {
  addListener(listener: L): void;
  removeListener(listener: L): void;
}

export interface ChromePort {
  postMessage(message: unknown): void;
  disconnect(): void;
  readonly onMessage: ChromeEvent<(message: unknown, port: ChromePort) => void>;
  readonly onDisconnect: ChromeEvent<(port: ChromePort) => void>;
}

export interface ChromeTab {
  readonly id?: number;
  readonly windowId: number;
  readonly url?: string;
  readonly pendingUrl?: string;
  readonly title?: string;
  readonly active: boolean;
  readonly status?: string;
}

export interface ChromeTabChangeInfo {
  readonly status?: string;
}

export interface ChromeTabQuery {
  readonly active?: boolean;
  readonly lastFocusedWindow?: boolean;
  readonly windowId?: number;
}

export interface ChromeCaptureOptions {
  readonly format: "png" | "jpeg";
  readonly quality?: number;
}

export interface ChromeScriptInjection<A extends unknown[], R> {
  readonly target: { readonly tabId: number };
  readonly func: (...args: A) => R;
  readonly args: A;
  readonly world: "ISOLATED";
}

export interface ChromeInjectionResult {
  readonly frameId: number;
  readonly result?: unknown;
}

/** A debugger target: one tab (AD-16 point 3; never anything else). */
export interface ChromeDebuggee {
  readonly tabId?: number;
}

export interface ChromeApi {
  readonly runtime: {
    connectNative(application: string): ChromePort;
    readonly lastError?: { readonly message?: string } | undefined;
    getManifest(): { readonly version: string };
    readonly onStartup: ChromeEvent<() => void>;
    readonly onInstalled: ChromeEvent<() => void>;
  };
  readonly tabs: {
    query(query: ChromeTabQuery): Promise<ChromeTab[]>;
    get(tabId: number): Promise<ChromeTab>;
    create(properties: { readonly url: string; readonly active: boolean }): Promise<ChromeTab>;
    update(
      tabId: number,
      properties: { readonly url?: string; readonly active?: boolean },
    ): Promise<ChromeTab | undefined>;
    remove(tabId: number): Promise<void>;
    captureVisibleTab(windowId: number, options: ChromeCaptureOptions): Promise<string>;
    readonly onUpdated: ChromeEvent<(tabId: number, changeInfo: ChromeTabChangeInfo, tab: ChromeTab) => void>;
    readonly onRemoved: ChromeEvent<(tabId: number) => void>;
  };
  readonly windows: {
    update(windowId: number, properties: { readonly focused: boolean }): Promise<unknown>;
  };
  readonly scripting: {
    executeScript<A extends unknown[], R>(injection: ChromeScriptInjection<A, R>): Promise<ChromeInjectionResult[]>;
  };
  /** Used only through cdp.ts, which enforces the fixed CDP method allowlist. */
  readonly debugger: {
    attach(target: ChromeDebuggee, requiredVersion: string): Promise<void>;
    detach(target: ChromeDebuggee): Promise<void>;
    sendCommand(target: ChromeDebuggee, method: string, commandParams?: object): Promise<unknown>;
    readonly onDetach: ChromeEvent<(source: ChromeDebuggee, reason: string) => void>;
    readonly onEvent: ChromeEvent<(source: ChromeDebuggee, method: string, params?: unknown) => void>;
  };
  readonly alarms: {
    create(name: string, info: { readonly periodInMinutes: number }): Promise<void>;
    readonly onAlarm: ChromeEvent<(alarm: { readonly name: string }) => void>;
  };
}
