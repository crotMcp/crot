import type { BrowserCommand } from "../../src/core/capabilities/browser/connection.js";
import type { ChromeApi, ChromeTab } from "./chrome-api.js";
import { ExtensionError, isExtensionErrorCode } from "./errors.js";
import { clickElement, readPageContent, typeIntoElement, type PageOutcome } from "./page-functions.js";

/**
 * The fixed commands of the CROT Browser Extension (bridge protocol v1).
 *
 * The extension makes no authorization decisions and has no capability of its
 * own: it only executes requests that the CROT Host sent after Core's
 * PermissionEngine authorized them, and Core validates every result. It still
 * checks every request's parameters, because the browser side must not trust
 * the other side of a channel either, and it refuses non-http(s) pages.
 *
 * Results follow Core's result schemas (src/core/capabilities/browser/schemas.ts).
 * Core's limits are repeated below because that module depends on zod; the
 * extension tests check that both agree.
 */

export const URL_MAX_LENGTH = 8192;
export const TITLE_MAX_LENGTH = 10_000;
export const MAX_TABS = 1000;
export const SELECTOR_MAX_LENGTH = 1000;
export const TYPE_TEXT_MAX_LENGTH = 100_000;
export const SCREENSHOT_MAX_BYTES = 16 * 1024 * 1024;

/** How long tab_open and navigate wait for the page to finish loading before answering anyway. */
export const LOAD_WAIT_MS = 20_000;

export type CommandParams = Readonly<Record<string, unknown>>;
export type CommandHandler = (params: CommandParams) => Promise<unknown>;
export type CommandHandlers = Readonly<Record<BrowserCommand, CommandHandler>>;

export interface CommandOptions {
  readonly loadWaitMs?: number;
}

const TAB_STATUSES: ReadonlySet<string> = new Set(["loading", "complete", "unloaded"]);
const PAGE_ERROR_CODES: ReadonlySet<string> = new Set(["NOT_FOUND", "INVALID_INPUT", "OPERATION_FAILED"]);

// ---------------------------------------------------------------- parameters

const invalid = (message: string): ExtensionError => new ExtensionError("INVALID_INPUT", message);

function onlyKeys(params: CommandParams, allowed: readonly string[]): void {
  for (const key of Object.keys(params)) {
    if (!allowed.includes(key)) throw invalid("Unexpected parameter '" + key + "'.");
  }
}

function tabIdParam(params: CommandParams): number {
  const value = params.tabId;
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw invalid("'tabId' must be a non-negative integer.");
  return value as number;
}

const optionalTabIdParam = (params: CommandParams): number | undefined => (params.tabId === undefined ? undefined : tabIdParam(params));

export function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > URL_MAX_LENGTH) return false;
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

function urlParam(params: CommandParams): string {
  if (!isHttpUrl(params.url)) throw invalid("Only absolute http: and https: URLs are allowed.");
  return params.url;
}

function booleanParam(params: CommandParams, key: string): boolean {
  const value = params[key];
  if (typeof value !== "boolean") throw invalid("'" + key + "' must be a boolean.");
  return value;
}

function stringParam(params: CommandParams, key: string, min: number, max: number): string {
  const value = params[key];
  if (typeof value !== "string" || value.length < min || value.length > max) {
    throw invalid("'" + key + "' must be a string of " + min + " to " + max + " characters.");
  }
  return value;
}

function selectorParam(params: CommandParams): string {
  const selector = stringParam(params, "selector", 1, SELECTOR_MAX_LENGTH);
  if (selector.includes("\0")) throw invalid("Selectors must not contain NUL.");
  return selector;
}

function enumParam<T extends string>(params: CommandParams, key: string, values: readonly T[]): T {
  const value = params[key];
  if (typeof value !== "string" || !values.includes(value as T)) throw invalid("'" + key + "' must be one of " + values.join(", ") + ".");
  return value as T;
}

// ---------------------------------------------------------------- results

const bounded = (text: string | undefined, max: number): string => (text ?? "").slice(0, max);

const tabUrl = (tab: ChromeTab): string => bounded(tab.url || tab.pendingUrl, URL_MAX_LENGTH);

function tabInfo(tab: ChromeTab & { readonly id: number }) {
  return {
    tabId: tab.id,
    windowId: tab.windowId,
    url: tabUrl(tab),
    title: bounded(tab.title, TITLE_MAX_LENGTH),
    active: tab.active,
    ...(tab.status !== undefined && TAB_STATUSES.has(tab.status) ? { status: tab.status } : {}),
  };
}

const hasId = (tab: ChromeTab): tab is ChromeTab & { readonly id: number } => Number.isSafeInteger(tab.id) && (tab.id as number) >= 0;

// ---------------------------------------------------------------- browser errors

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const RESTRICTED = /cannot access|cannot be scripted|error page|chrome:\/\/|extensions gallery|permission/i;

/** Map an exception of a chrome.* call. */
function browserError(error: unknown, action: string): ExtensionError {
  if (error instanceof ExtensionError) return error;
  const message = messageOf(error);
  if (/no tab with id/i.test(message)) return new ExtensionError("NOT_FOUND", "The tab does not exist.");
  if (/MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND/.test(message)) return new ExtensionError("RESOURCE_BUSY", "Too many screenshots; retry shortly.");
  if (RESTRICTED.test(message)) return new ExtensionError("BROWSER_PAGE_RESTRICTED", "The browser does not allow extensions to access this page.");
  return new ExtensionError("OPERATION_FAILED", action + " failed: " + message);
}

const restricted = (): ExtensionError =>
  new ExtensionError("BROWSER_PAGE_RESTRICTED", "CROT can only access http: and https: pages.");

// ---------------------------------------------------------------- handlers

export function createCommandHandlers(api: ChromeApi, options: CommandOptions = {}): CommandHandlers {
  const loadWaitMs = options.loadWaitMs ?? LOAD_WAIT_MS;

  async function getTab(tabId: number): Promise<ChromeTab & { readonly id: number }> {
    let tab: ChromeTab;
    try {
      tab = await api.tabs.get(tabId);
    } catch {
      throw new ExtensionError("NOT_FOUND", "No tab with id " + tabId + ".");
    }
    if (!hasId(tab)) throw new ExtensionError("NOT_FOUND", "No tab with id " + tabId + ".");
    return tab;
  }

  /** The requested tab, or the active tab of the last focused window. */
  async function resolveTab(tabId: number | undefined): Promise<ChromeTab & { readonly id: number }> {
    if (tabId !== undefined) return getTab(tabId);
    const [tab] = await api.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab || !hasId(tab)) throw new ExtensionError("NOT_FOUND", "There is no active tab.");
    return tab;
  }

  /** A tab whose page CROT may read or act on: http: or https: only. */
  async function resolvePageTab(tabId: number | undefined): Promise<ChromeTab & { readonly id: number }> {
    const tab = await resolveTab(tabId);
    if (!isHttpUrl(tab.url)) throw restricted();
    return tab;
  }

  async function runInPage<A extends unknown[], T>(tabId: number, func: (...args: A) => PageOutcome<T>, args: A): Promise<T> {
    let results;
    try {
      results = await api.scripting.executeScript({ target: { tabId }, func, args, world: "ISOLATED" });
    } catch (error) {
      throw browserError(error, "Accessing the page");
    }
    const outcome = results[0]?.result as Partial<{ ok: boolean; value: T; code: unknown; message: unknown }> | null | undefined;
    if (typeof outcome !== "object" || outcome === null) throw new ExtensionError("OPERATION_FAILED", "The page did not return a result.");
    if (outcome.ok === true) return outcome.value as T;
    const code = typeof outcome.code === "string" && PAGE_ERROR_CODES.has(outcome.code) && isExtensionErrorCode(outcome.code) ? outcome.code : "OPERATION_FAILED";
    throw new ExtensionError(code, typeof outcome.message === "string" ? outcome.message : "The page operation failed.");
  }

  /** Resolve when the tab has finished loading, has been closed, or after loadWaitMs. Never rejects. */
  function waitForLoad(tabId: number): Promise<void> {
    return new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        api.tabs.onUpdated.removeListener(onUpdated);
        api.tabs.onRemoved.removeListener(onRemoved);
        resolve();
      };
      const onUpdated = (id: number, change: { readonly status?: string }) => {
        if (id === tabId && change.status === "complete") finish();
      };
      const onRemoved = (id: number) => {
        if (id === tabId) finish();
      };
      const timer = setTimeout(finish, loadWaitMs);
      api.tabs.onUpdated.addListener(onUpdated);
      api.tabs.onRemoved.addListener(onRemoved);
      api.tabs.get(tabId).then(
        (tab) => {
          if (tab.status === "complete" && !tab.pendingUrl) finish();
        },
        finish,
      );
    });
  }

  /** Wait for the load, then report the tab's (possibly redirected) URL. */
  async function loaded(tabId: number): Promise<{ tabId: number; url: string }> {
    await waitForLoad(tabId);
    let tab: ChromeTab;
    try {
      tab = await api.tabs.get(tabId);
    } catch {
      throw new ExtensionError("NOT_FOUND", "The tab was closed while loading.");
    }
    // While still loading (load wait elapsed), pendingUrl is where the tab is going.
    return { tabId, url: bounded(tab.pendingUrl || tab.url, URL_MAX_LENGTH) };
  }

  return {
    async "tabs.list"(params) {
      onlyKeys(params, []);
      const tabs = await api.tabs.query({});
      return { tabs: tabs.filter(hasId).slice(0, MAX_TABS).map(tabInfo) };
    },

    async "tabs.open"(params) {
      onlyKeys(params, ["url", "active"]);
      const url = urlParam(params);
      const active = booleanParam(params, "active");
      let tab: ChromeTab;
      try {
        tab = await api.tabs.create({ url, active });
      } catch (error) {
        throw browserError(error, "Opening the tab");
      }
      if (!hasId(tab)) throw new ExtensionError("OPERATION_FAILED", "The browser did not report the new tab.");
      return loaded(tab.id);
    },

    async "tabs.navigate"(params) {
      onlyKeys(params, ["tabId", "url"]);
      const tabId = optionalTabIdParam(params);
      const url = urlParam(params);
      const tab = await resolveTab(tabId);
      try {
        await api.tabs.update(tab.id, { url });
      } catch (error) {
        throw browserError(error, "Navigating");
      }
      return loaded(tab.id);
    },

    async "tabs.activate"(params) {
      onlyKeys(params, ["tabId"]);
      const tab = await getTab(tabIdParam(params));
      try {
        await api.tabs.update(tab.id, { active: true });
        await api.windows.update(tab.windowId, { focused: true });
      } catch (error) {
        throw browserError(error, "Activating the tab");
      }
      return { tabId: tab.id, url: tabUrl(tab) };
    },

    async "tabs.close"(params) {
      onlyKeys(params, ["tabId"]);
      const tab = await getTab(tabIdParam(params));
      try {
        await api.tabs.remove(tab.id);
      } catch (error) {
        throw browserError(error, "Closing the tab");
      }
      return { tabId: tab.id, closed: true };
    },

    async "page.read"(params) {
      onlyKeys(params, ["tabId", "format", "maxBytes"]);
      const tabId = optionalTabIdParam(params);
      const format = enumParam(params, "format", ["text", "html"] as const);
      const maxBytes = params.maxBytes;
      if (!Number.isSafeInteger(maxBytes) || (maxBytes as number) < 1) throw invalid("'maxBytes' must be a positive integer.");
      const tab = await resolvePageTab(tabId);
      const page = await runInPage(tab.id, readPageContent, [format, maxBytes as number]);
      if (typeof page?.content !== "string" || typeof page.truncated !== "boolean") {
        throw new ExtensionError("OPERATION_FAILED", "The page returned an invalid result.");
      }
      return {
        tabId: tab.id,
        url: tabUrl(tab),
        title: bounded(tab.title, TITLE_MAX_LENGTH),
        format,
        content: page.content,
        truncated: page.truncated,
      };
    },

    async "page.screenshot"(params) {
      onlyKeys(params, ["tabId", "format", "quality"]);
      const tabId = optionalTabIdParam(params);
      const format = enumParam(params, "format", ["png", "jpeg"] as const);
      const quality = params.quality;
      if (quality !== undefined) {
        if (format !== "jpeg") throw invalid("'quality' is only valid with format 'jpeg'.");
        if (!Number.isInteger(quality) || (quality as number) < 0 || (quality as number) > 100) throw invalid("'quality' must be an integer from 0 to 100.");
      }
      const tab = await resolvePageTab(tabId);
      // A screenshot is a read: CROT never activates a tab to take one.
      if (!tab.active) {
        throw invalid("Tab " + tab.id + " is not the visible tab of its window. Activate it with browser_tab_activate first.");
      }
      let dataUrl: string;
      try {
        dataUrl = await api.tabs.captureVisibleTab(tab.windowId, quality === undefined ? { format } : { format, quality: quality as number });
      } catch (error) {
        throw browserError(error, "Taking the screenshot");
      }
      // captureVisibleTab captures whatever the window shows: make sure it was still this tab and page.
      const [visible] = await api.tabs.query({ active: true, windowId: tab.windowId });
      if (!visible || visible.id !== tab.id) throw new ExtensionError("OPERATION_FAILED", "The visible tab changed while taking the screenshot.");
      if (!isHttpUrl(visible.url)) throw restricted();
      const prefix = "data:image/" + format + ";base64,";
      if (typeof dataUrl !== "string" || !dataUrl.startsWith(prefix)) throw new ExtensionError("OPERATION_FAILED", "The browser returned an unexpected image.");
      const data = dataUrl.slice(prefix.length);
      const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
      if ((data.length / 4) * 3 - padding > SCREENSHOT_MAX_BYTES) {
        throw new ExtensionError("LIMIT_EXCEEDED", "The screenshot exceeds " + SCREENSHOT_MAX_BYTES + " bytes.");
      }
      return { tabId: tab.id, url: tabUrl(visible), mimeType: "image/" + format, data };
    },

    async "page.click"(params) {
      onlyKeys(params, ["tabId", "selector"]);
      const tabId = optionalTabIdParam(params);
      const selector = selectorParam(params);
      const tab = await resolvePageTab(tabId);
      await runInPage(tab.id, clickElement, [selector]);
      return { tabId: tab.id, url: tabUrl(tab) };
    },

    async "page.type"(params) {
      onlyKeys(params, ["tabId", "selector", "text", "clear"]);
      const tabId = optionalTabIdParam(params);
      const selector = selectorParam(params);
      const text = stringParam(params, "text", 0, TYPE_TEXT_MAX_LENGTH);
      const clear = booleanParam(params, "clear");
      const tab = await resolvePageTab(tabId);
      await runInPage(tab.id, typeIntoElement, [selector, text, clear]);
      return { tabId: tab.id, url: tabUrl(tab) };
    },
  };
}
