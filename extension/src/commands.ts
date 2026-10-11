import type { BrowserCommand } from "../../src/core/capabilities/browser/connection.js";
import type { ChromeApi, ChromeTab } from "./chrome-api.js";
import { ExtensionError, isExtensionErrorCode } from "./errors.js";
import { CdpSessions } from "./cdp.js";
import {
  DEFAULT_TIMING,
  HISTORY_ACTIONS,
  TabObserver,
  enableEvents,
  historyTarget,
  resolveTarget,
  settle,
  timeoutParam,
  waitConditionParam,
  waitFor,
  waitForLoadState,
  waitUntilParam,
  type Timing,
  type WaitUntil,
} from "./control.js";
import {
  MAX_SCROLL_DELTA,
  MODIFIERS,
  actionablePoint,
  clickAt,
  dragBetween,
  hoverAt,
  keySequenceParam,
  pressCombination,
  selectInto,
  setChecked,
  typeInto,
  viewportCenter,
  wheelAt,
  type Modifier,
  type MouseButton,
} from "./input.js";
import { clickElement, readPageContent, typeIntoElement, type PageOutcome } from "./page-functions.js";
import { RefRegistry, frameRefParam } from "./refs.js";
import { SNAPSHOT_DEFAULT_ELEMENTS, SNAPSHOT_MAX_ELEMENTS, takeSnapshot } from "./snapshot.js";

/**
 * The fixed commands of the CROT Browser Extension (bridge protocol v1).
 *
 * The extension makes no authorization decisions and has no capability of its
 * own: it only executes requests that the CROT Host sent after Core's
 * PermissionEngine authorized them, and Core validates every result. It still
 * checks every request's parameters, because the browser side must not trust
 * the other side of a channel either, and it refuses non-http(s) pages.
 *
 * Commands of approved (gated) operations carry an expected browser subject
 * `expect: { tabId?, origin, connectionId }` (ARCHITECTURE.md §27, AD-11).
 * Immediately before acting, the handler checks the connection id the host
 * assigned in `welcome`, the tab id, and the origin of the tab's committed URL
 * (a pending navigation to another origin is a mismatch). Any mismatch, or a
 * value that cannot be determined, refuses with PERMISSION_DENIED and nothing
 * is done. The check only narrows; it grants nothing.
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
/** Facts of the connection a command arrived on. */
export interface CommandContext {
  /** Connection id from the host's `welcome` (AD-9); undefined when unknown or the connection is gone. */
  readonly connectionId: () => string | undefined;
}

export type CommandHandler = (params: CommandParams, context?: CommandContext) => Promise<unknown>;
export type CommandHandlers = Readonly<Record<BrowserCommand, CommandHandler>>;

export interface CommandOptions {
  readonly loadWaitMs?: number;
  /** CDP sessions (AD-16 point 3); created over `api.debugger` when absent. */
  readonly cdp?: CdpSessions;
  /** ControlOrMeta is Meta on macOS. */
  readonly mac?: boolean;
  /** Settle/wait timing (tests shorten it). */
  readonly timing?: Timing;
}

/** Bound of each tab's command queue (AD-16 point 8). */
export const TAB_QUEUE_MAX = 16;
export const SELECT_VALUES_MAX = 100;

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

const optionalTabIdParam = (params: CommandParams): number | undefined =>
  params.tabId === undefined ? undefined : tabIdParam(params);

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
  if (selector.includes("\\0")) throw invalid("Selectors must not contain NUL.");
  return selector;
}

function enumParam<T extends string>(params: CommandParams, key: string, values: readonly T[]): T {
  const value = params[key];
  if (typeof value !== "string" || !values.includes(value as T))
    throw invalid("'" + key + "' must be one of " + values.join(", ") + ".");
  return value as T;
}

/** Expected browser subject of an approved operation (AD-11). */
interface ExpectedSubject {
  readonly tabId?: number;
  readonly origin: string;
  readonly connectionId: string;
}

const CONNECTION_ID_MAX_LENGTH = 128;

function expectParam(params: CommandParams): ExpectedSubject | undefined {
  const value = params.expect;
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid("'expect' must be an object.");
  const expected = value as Readonly<Record<string, unknown>>;
  onlyKeys(expected, ["tabId", "origin", "connectionId"]);
  const tabId = expected.tabId === undefined ? undefined : tabIdParam(expected);
  const { origin, connectionId } = expected;
  if (typeof origin !== "string" || origin.length === 0 || origin.length > URL_MAX_LENGTH)
    throw invalid("'expect.origin' must be an origin.");
  if (typeof connectionId !== "string" || connectionId.length === 0 || connectionId.length > CONNECTION_ID_MAX_LENGTH)
    throw invalid("'expect.connectionId' must be a connection id.");
  return tabId === undefined ? { origin, connectionId } : { tabId, origin, connectionId };
}

/**
 * WHATWG origin of an http: or https: URL (lowercase scheme and host, punycode
 * host, default port omitted); undefined for anything else, so opaque origins
 * and other schemes never match. Same rule as Core's normalizedHttpOrigin.
 */
export function httpOrigin(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return url.origin === "null" ? undefined : url.origin;
  } catch {
    return undefined;
  }
}

const mismatch = (what: string): ExtensionError =>
  new ExtensionError(
    "PERMISSION_DENIED",
    "The approved browser target no longer matches (" + what + "); the action was not performed.",
  );

function checkConnection(expected: ExpectedSubject, context: CommandContext | undefined): void {
  const current = context?.connectionId();
  if (current === undefined || current !== expected.connectionId) throw mismatch("connection");
}

/** The whole expected subject against the tab as it is right now. */
function checkTab(expected: ExpectedSubject, tab: ChromeTab, context: CommandContext | undefined): void {
  checkConnection(expected, context);
  if (expected.tabId === undefined || tab.id !== expected.tabId) throw mismatch("tab");
  const origin = httpOrigin(tab.url);
  if (origin === undefined || origin !== expected.origin) throw mismatch("origin");
  if (tab.pendingUrl && httpOrigin(tab.pendingUrl) !== expected.origin) throw mismatch("navigation to another origin");
}

/** The legacy selector form (page functions, unchanged): only legacy keys and a selector. */
function legacyForm(params: CommandParams, keys: readonly string[]): boolean {
  return params.selector !== undefined && Object.keys(params).every((k) => keys.includes(k));
}

function modifiersParam(value: unknown): Modifier[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MODIFIERS.length || value.some((m) => !MODIFIERS.includes(m as Modifier)))
    throw invalid("'modifiers' must be a list of " + MODIFIERS.join(", ") + ".");
  return [...new Set(value as Modifier[])];
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
    ...(typeof tab.openerTabId === "number" && Number.isInteger(tab.openerTabId) && tab.openerTabId >= 0
      ? { openerTabId: tab.openerTabId }
      : {}),
  };
}

const hasId = (tab: ChromeTab): tab is ChromeTab & { readonly id: number } =>
  Number.isSafeInteger(tab.id) && (tab.id as number) >= 0;

// ---------------------------------------------------------------- browser errors

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const RESTRICTED = /cannot access|cannot be scripted|error page|chrome:\/\/|extensions gallery|permission/i;

/** Map an exception of a chrome.* call. */
function browserError(error: unknown, action: string): ExtensionError {
  if (error instanceof ExtensionError) return error;
  const message = messageOf(error);
  if (/no tab with id/i.test(message)) return new ExtensionError("NOT_FOUND", "The tab does not exist.");
  if (/MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND/.test(message))
    return new ExtensionError("RESOURCE_BUSY", "Too many screenshots; retry shortly.");
  if (RESTRICTED.test(message))
    return new ExtensionError("BROWSER_PAGE_RESTRICTED", "The browser does not allow extensions to access this page.");
  return new ExtensionError("OPERATION_FAILED", action + " failed: " + message);
}

const restricted = (): ExtensionError =>
  new ExtensionError("BROWSER_PAGE_RESTRICTED", "CROT can only access http: and https: pages.");

// ---------------------------------------------------------------- handlers

export function createCommandHandlers(api: ChromeApi, options: CommandOptions = {}): CommandHandlers {
  const loadWaitMs = options.loadWaitMs ?? LOAD_WAIT_MS;
  // CDP sessions and the ref registry's tab listener exist only once a Browser v1 command runs.
  let sessions: CdpSessions | undefined = options.cdp;
  let watchingTabs = false;
  const cdpSessions = (): CdpSessions => {
    sessions ??= new CdpSessions(api);
    if (!watchingTabs) {
      watchingTabs = true;
      api.tabs.onRemoved.addListener((tabId) => registry.forgetTab(tabId));
    }
    return sessions;
  };
  const cdp: CdpSessions = new Proxy({} as CdpSessions, {
    get(_target, property) {
      const real = cdpSessions();
      const value = Reflect.get(real, property, real) as unknown;
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(real) : value;
    },
  });
  const timing = options.timing ?? DEFAULT_TIMING;
  const inputOptions = { mac: options.mac === true };
  const limits = { urlMax: URL_MAX_LENGTH, selectorMax: SELECTOR_MAX_LENGTH };
  const resolveModifiers = (modifiers: readonly Modifier[]): Exclude<Modifier, "ControlOrMeta">[] => [
    ...new Set(
      modifiers.map((m): Exclude<Modifier, "ControlOrMeta"> =>
        m === "ControlOrMeta" ? (inputOptions.mac ? "Meta" : "Control") : m,
      ),
    ),
  ];

  // One ref registry per host connection (AD-16 point 5): refs of an earlier connection are unknown.
  let registry = new RefRegistry();
  let registryConnection: string | undefined;
  function refsFor(context: CommandContext | undefined): RefRegistry {
    const id = context?.connectionId();
    if (id !== registryConnection) {
      registry = new RefRegistry();
      registryConnection = id;
    }
    return registry;
  }
  // Per-tab FIFO (AD-16 point 8): commands on one tab run one at a time, bound TAB_QUEUE_MAX.
  const queues = new Map<number, { tail: Promise<unknown>; size: number }>();
  async function serialized<T>(tabId: number, run: () => Promise<T>): Promise<T> {
    const queue = queues.get(tabId) ?? { tail: Promise.resolve(), size: 0 };
    if (queue.size >= TAB_QUEUE_MAX)
      throw new ExtensionError("RESOURCE_BUSY", "Too many browser commands are queued for this tab.");
    queue.size++;
    queues.set(tabId, queue);
    const result = queue.tail.then(run, run);
    queue.tail = result.then(
      () => undefined,
      () => undefined,
    );
    try {
      return await result;
    } finally {
      queue.size--;
      if (queue.size === 0 && queues.get(tabId) === queue) queues.delete(tabId);
    }
  }

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

  async function runInPage<A extends unknown[], T>(
    tabId: number,
    func: (...args: A) => PageOutcome<T>,
    args: A,
  ): Promise<T> {
    let results;
    try {
      results = await api.scripting.executeScript({ target: { tabId }, func, args, world: "ISOLATED" });
    } catch (error) {
      throw browserError(error, "Accessing the page");
    }
    const outcome = results[0]?.result as
      Partial<{ ok: boolean; value: T; code: unknown; message: unknown }> | null | undefined;
    if (typeof outcome !== "object" || outcome === null)
      throw new ExtensionError("OPERATION_FAILED", "The page did not return a result.");
    if (outcome.ok === true) return outcome.value as T;
    const code =
      typeof outcome.code === "string" && PAGE_ERROR_CODES.has(outcome.code) && isExtensionErrorCode(outcome.code)
        ? outcome.code
        : "OPERATION_FAILED";
    throw new ExtensionError(
      code,
      typeof outcome.message === "string" ? outcome.message : "The page operation failed.",
    );
  }

  /**
   * The tab a command acts on. With an expected subject: exactly the approved
   * tab, checked (connection, tab, origin) right before the action; without
   * one: the requested tab or the active tab (page commands: http(s) only).
   */
  async function targetTab(
    tabId: number | undefined,
    expected: ExpectedSubject | undefined,
    context: CommandContext | undefined,
    page: boolean,
  ): Promise<ChromeTab & { readonly id: number }> {
    if (!expected) return page ? resolvePageTab(tabId) : resolveTab(tabId);
    if (tabId === undefined || tabId !== expected.tabId) throw mismatch("tab");
    let tab: ChromeTab;
    try {
      tab = await api.tabs.get(tabId);
    } catch {
      throw mismatch("tab closed");
    }
    if (!hasId(tab)) throw mismatch("tab closed");
    checkTab(expected, tab, context);
    return tab;
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
      api.tabs.get(tabId).then((tab) => {
        if (tab.status === "complete" && !tab.pendingUrl) finish();
      }, finish);
    });
  }

  /** Wait for the load, then report the tab's (possibly redirected) URL. */
  async function loaded(
    tabId: number,
    waitUntil?: WaitUntil,
    timeoutMs?: number,
    observer?: TabObserver,
  ): Promise<{ tabId: number; url: string }> {
    if (waitUntil === undefined || timeoutMs === undefined) await waitForLoad(tabId);
    else {
      try {
        await waitForLoadState(api, tabId, waitUntil, Date.now() + timeoutMs, observer, timing);
      } finally {
        observer?.dispose();
      }
    }
    let tab: ChromeTab;
    try {
      tab = await api.tabs.get(tabId);
    } catch {
      throw new ExtensionError("NOT_FOUND", "The tab was closed while loading.");
    }
    // While still loading (load wait elapsed), pendingUrl is where the tab is going.
    return { tabId, url: bounded(tab.pendingUrl || tab.url, URL_MAX_LENGTH) };
  }

  const handlers: CommandHandlers = {
    async "tabs.list"(params) {
      onlyKeys(params, []);
      const tabs = await api.tabs.query({});
      return { tabs: tabs.filter(hasId).slice(0, MAX_TABS).map(tabInfo) };
    },

    async "tabs.resolve"(params) {
      onlyKeys(params, ["tabId"]);
      const tab = await resolveTab(optionalTabIdParam(params));
      // The committed URL: what the tab shows now, not where it may be going.
      return { tabId: tab.id, url: bounded(tab.url, URL_MAX_LENGTH) };
    },

    async "tabs.open"(params, context) {
      onlyKeys(params, ["url", "active", "waitUntil", "timeoutMs", "expect"]);
      const url = urlParam(params);
      const active = booleanParam(params, "active");
      const waitUntil = params.waitUntil === undefined ? undefined : waitUntilParam(params.waitUntil);
      const timeoutMs = params.timeoutMs === undefined ? undefined : timeoutParam(params.timeoutMs);
      const expected = expectParam(params);
      if (expected) {
        checkConnection(expected, context);
        if (expected.tabId !== undefined || httpOrigin(url) !== expected.origin) throw mismatch("origin");
      }
      let tab: ChromeTab;
      try {
        tab = await api.tabs.create({ url, active });
      } catch (error) {
        throw browserError(error, "Opening the tab");
      }
      if (!hasId(tab)) throw new ExtensionError("OPERATION_FAILED", "The browser did not report the new tab.");
      if (waitUntil === undefined && timeoutMs === undefined) return loaded(tab.id);
      return loaded(tab.id, waitUntil ?? "load", timeoutMs ?? loadWaitMs);
    },

    async "tabs.navigate"(params, context) {
      onlyKeys(params, ["tabId", "url", "waitUntil", "timeoutMs", "expect"]);
      const tabId = optionalTabIdParam(params);
      const url = urlParam(params);
      const legacy = params.waitUntil === undefined && params.timeoutMs === undefined;
      const waitUntil = waitUntilParam(params.waitUntil);
      const timeoutMs = params.timeoutMs === undefined ? loadWaitMs : timeoutParam(params.timeoutMs);
      const tab = await targetTab(tabId, expectParam(params), context, false);
      // Lifecycle events are only needed for the states the tab status cannot tell.
      const events = !legacy && (waitUntil === "domcontentloaded" || waitUntil === "networkidle");
      const observer = events
        ? new TabObserver(api, cdp, tab.id, isHttpUrl(tab.url) ? await enableEvents(cdp, tab.id) : undefined)
        : undefined;
      try {
        await api.tabs.update(tab.id, { url });
      } catch (error) {
        observer?.dispose();
        throw browserError(error, "Navigating");
      }
      if (legacy) return loaded(tab.id);
      return loaded(tab.id, waitUntil, timeoutMs, observer);
    },

    async "tabs.activate"(params, context) {
      onlyKeys(params, ["tabId", "expect"]);
      const tabId = tabIdParam(params);
      const expected = expectParam(params);
      const tab = expected ? await targetTab(tabId, expected, context, false) : await getTab(tabId);
      try {
        await api.tabs.update(tab.id, { active: true });
        await api.windows.update(tab.windowId, { focused: true });
      } catch (error) {
        throw browserError(error, "Activating the tab");
      }
      return { tabId: tab.id, url: tabUrl(tab) };
    },

    async "tabs.close"(params, context) {
      onlyKeys(params, ["tabId", "expect"]);
      const tabId = tabIdParam(params);
      const expected = expectParam(params);
      const tab = expected ? await targetTab(tabId, expected, context, false) : await getTab(tabId);
      try {
        await api.tabs.remove(tab.id);
      } catch (error) {
        throw browserError(error, "Closing the tab");
      }
      return { tabId: tab.id, closed: true };
    },

    async "page.read"(params, context) {
      onlyKeys(params, ["tabId", "format", "maxBytes", "expect"]);
      const tabId = optionalTabIdParam(params);
      const format = enumParam(params, "format", ["text", "html"] as const);
      const maxBytes = params.maxBytes;
      if (!Number.isSafeInteger(maxBytes) || (maxBytes as number) < 1)
        throw invalid("'maxBytes' must be a positive integer.");
      const tab = await targetTab(tabId, expectParam(params), context, true);
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

    async "page.screenshot"(params, context) {
      onlyKeys(params, ["tabId", "format", "quality", "expect"]);
      const tabId = optionalTabIdParam(params);
      const format = enumParam(params, "format", ["png", "jpeg"] as const);
      const quality = params.quality;
      if (quality !== undefined) {
        if (format !== "jpeg") throw invalid("'quality' is only valid with format 'jpeg'.");
        if (!Number.isInteger(quality) || (quality as number) < 0 || (quality as number) > 100)
          throw invalid("'quality' must be an integer from 0 to 100.");
      }
      const expected = expectParam(params);
      const tab = await targetTab(tabId, expected, context, true);
      // A screenshot is a read: CROT never activates a tab to take one.
      if (!tab.active) {
        throw invalid(
          "Tab " + tab.id + " is not the visible tab of its window. Activate it with browser_tab_activate first.",
        );
      }
      let dataUrl: string;
      try {
        dataUrl = await api.tabs.captureVisibleTab(
          tab.windowId,
          quality === undefined ? { format } : { format, quality: quality as number },
        );
      } catch (error) {
        throw browserError(error, "Taking the screenshot");
      }
      // captureVisibleTab captures whatever the window shows: make sure it was still this tab and page.
      const [visible] = await api.tabs.query({ active: true, windowId: tab.windowId });
      if (!visible || visible.id !== tab.id)
        throw new ExtensionError("OPERATION_FAILED", "The visible tab changed while taking the screenshot.");
      if (!isHttpUrl(visible.url)) throw restricted();
      if (expected) checkTab(expected, visible, context);
      const prefix = "data:image/" + format + ";base64,";
      if (typeof dataUrl !== "string" || !dataUrl.startsWith(prefix))
        throw new ExtensionError("OPERATION_FAILED", "The browser returned an unexpected image.");
      const data = dataUrl.slice(prefix.length);
      const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
      if ((data.length / 4) * 3 - padding > SCREENSHOT_MAX_BYTES) {
        throw new ExtensionError("LIMIT_EXCEEDED", "The screenshot exceeds " + SCREENSHOT_MAX_BYTES + " bytes.");
      }
      return { tabId: tab.id, url: tabUrl(visible), mimeType: "image/" + format, data };
    },

    async "page.click"(params, context) {
      if (!legacyForm(params, ["tabId", "selector", "expect"])) {
        const button =
          params.button === undefined ? "left" : enumParam(params, "button", ["left", "right", "middle"] as const);
        const clickCount = params.clickCount ?? 1;
        if (clickCount !== 1 && clickCount !== 2) throw invalid("'clickCount' must be 1 or 2.");
        const modifiers = modifiersParam(params.modifiers);
        return control(params, context, ["button", "clickCount", "modifiers"], async (tabId, node) => {
          const point = await actionablePoint(cdp, tabId, node.backendNodeId);
          await clickAt(cdp, tabId, point, {
            button: button as MouseButton,
            clickCount,
            modifiers: resolveModifiers(modifiers),
          });
        });
      }
      onlyKeys(params, ["tabId", "selector", "expect"]);
      const tabId = optionalTabIdParam(params);
      const selector = selectorParam(params);
      const tab = await targetTab(tabId, expectParam(params), context, true);
      await runInPage(tab.id, clickElement, [selector]);
      return { tabId: tab.id, url: tabUrl(tab) };
    },

    async "page.type"(params, context) {
      if (!legacyForm(params, ["tabId", "selector", "text", "clear", "expect"])) {
        const text = stringParam(params, "text", 0, TYPE_TEXT_MAX_LENGTH);
        const clear = booleanParam(params, "clear");
        const submit = params.submit === undefined ? false : booleanParam(params, "submit");
        return control(params, context, ["text", "clear", "submit"], async (tabId, node) => {
          await typeInto(cdp, tabId, node.backendNodeId, text, { ...inputOptions, clear, submit });
        });
      }
      onlyKeys(params, ["tabId", "selector", "text", "clear", "expect"]);
      const tabId = optionalTabIdParam(params);
      const selector = selectorParam(params);
      const text = stringParam(params, "text", 0, TYPE_TEXT_MAX_LENGTH);
      const clear = booleanParam(params, "clear");
      const tab = await targetTab(tabId, expectParam(params), context, true);
      await runInPage(tab.id, typeIntoElement, [selector, text, clear]);
      return { tabId: tab.id, url: tabUrl(tab) };
    },

    // ------------------------------------------------------------ Browser v1 (AD-16)

    async "page.snapshot"(params, context) {
      onlyKeys(params, ["tabId", "frameRef", "includeText", "maxElements", "expect"]);
      const tabId = optionalTabIdParam(params);
      const frameRef = params.frameRef === undefined ? undefined : frameRefParam(params.frameRef);
      const includeText = params.includeText === undefined ? false : booleanParam(params, "includeText");
      const maxElements = params.maxElements === undefined ? SNAPSHOT_DEFAULT_ELEMENTS : params.maxElements;
      if (
        !Number.isSafeInteger(maxElements) ||
        (maxElements as number) < 1 ||
        (maxElements as number) > SNAPSHOT_MAX_ELEMENTS
      )
        throw invalid("'maxElements' must be an integer from 1 to " + SNAPSHOT_MAX_ELEMENTS + ".");
      const expected = expectParam(params);
      const refs = refsFor(context);
      const first = await targetTab(tabId, expected, context, true);
      return serialized(first.id, async () => {
        const tab = await targetTab(first.id, expected, context, true);
        return takeSnapshot(
          cdp,
          refs,
          { id: tab.id, url: tabUrl(tab), title: bounded(tab.title, TITLE_MAX_LENGTH) },
          { ...(frameRef === undefined ? {} : { frameRef }), includeText, maxElements: maxElements as number },
        );
      });
    },

    async "page.hover"(params, context) {
      return control(params, context, [], async (tabId, node) => {
        await hoverAt(cdp, tabId, await actionablePoint(cdp, tabId, node.backendNodeId));
      });
    },

    async "page.scroll"(params, context) {
      const deltaX = params.deltaX ?? 0;
      const deltaY = params.deltaY ?? 0;
      for (const [name, value] of [
        ["deltaX", deltaX],
        ["deltaY", deltaY],
      ] as const) {
        if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > MAX_SCROLL_DELTA)
          throw invalid("'" + name + "' must be a number from -" + MAX_SCROLL_DELTA + " to " + MAX_SCROLL_DELTA + ".");
      }
      const element = params.ref !== undefined || params.selector !== undefined;
      return control(
        params,
        context,
        ["deltaX", "deltaY"],
        async (tabId, node) => {
          const point = node
            ? await actionablePoint(cdp, tabId, node.backendNodeId, { requireEnabled: false })
            : await viewportCenter(cdp, tabId);
          await wheelAt(cdp, tabId, point, deltaX as number, deltaY as number);
        },
        { element },
      );
    },

    async "page.drag"(params, context) {
      const to = params.to;
      if (typeof to !== "object" || to === null || Array.isArray(to))
        throw invalid("'to' must be an object with 'ref' or 'selector'.");
      onlyKeys(to as CommandParams, ["ref", "selector"]);
      return control(params, context, ["to"], async (tabId, node, refs) => {
        const from = await actionablePoint(cdp, tabId, node.backendNodeId);
        const target = await resolveTarget(cdp, refs, tabId, to as CommandParams, SELECTOR_MAX_LENGTH);
        const point = await actionablePoint(cdp, tabId, target.backendNodeId, { requireEnabled: false });
        await dragBetween(cdp, tabId, from, point);
      });
    },

    async "page.press_key"(params, context) {
      const keys = keySequenceParam(params.keys, inputOptions);
      const element = params.ref !== undefined || params.selector !== undefined;
      return control(
        params,
        context,
        ["keys"],
        async (tabId, node) => {
          if (node) {
            await actionablePoint(cdp, tabId, node.backendNodeId);
            await cdp.send(tabId, "DOM.focus", { backendNodeId: node.backendNodeId });
          }
          for (const combo of keys) await pressCombination(cdp, tabId, combo);
        },
        { element },
      );
    },

    async "page.select_option"(params, context) {
      const values = params.values;
      if (
        !Array.isArray(values) ||
        values.length < 1 ||
        values.length > SELECT_VALUES_MAX ||
        values.some((v) => typeof v !== "string" || v.length > TITLE_MAX_LENGTH)
      )
        throw invalid("'values' must be 1 to " + SELECT_VALUES_MAX + " option values or labels.");
      let selected: string[] = [];
      const result = await control(params, context, ["values"], async (tabId, node) => {
        await actionablePoint(cdp, tabId, node.backendNodeId);
        ({ selected } = await selectInto(cdp, tabId, node.backendNodeId, values as string[], inputOptions));
      });
      return { ...result, selected };
    },

    async "page.set_checked"(params, context) {
      const checked = booleanParam(params, "checked");
      let outcome: { checked: boolean | "mixed"; changed: boolean } = { checked, changed: false };
      const result = await control(params, context, ["checked"], async (tabId, node) => {
        outcome = await setChecked(cdp, tabId, node.backendNodeId, checked);
      });
      return { ...result, ...outcome };
    },

    async "page.wait"(params, context) {
      onlyKeys(params, [
        "tabId",
        "ref",
        "selector",
        "state",
        "text",
        "textGone",
        "urlPrefix",
        "loadState",
        "newDocument",
        "newTab",
        "timeoutMs",
        "expect",
      ]);
      const tabId = optionalTabIdParam(params);
      const condition = waitConditionParam(params, URL_MAX_LENGTH);
      const timeoutMs = timeoutParam(params.timeoutMs);
      const expected = expectParam(params);
      const refs = refsFor(context);
      const tab = await targetTab(tabId, expected, context, true);
      // A wait observes; it does not take the tab's command queue (a wait for a new tab may follow a click).
      return waitFor(api, cdp, refs, tab.id, condition, timeoutMs, timing, limits);
    },

    async "tabs.history"(params, context) {
      onlyKeys(params, ["tabId", "action", "waitUntil", "timeoutMs", "expect"]);
      const tabId = optionalTabIdParam(params);
      const action = enumParam(params, "action", HISTORY_ACTIONS);
      const waitUntil = waitUntilParam(params.waitUntil);
      const timeoutMs = timeoutParam(params.timeoutMs);
      const expected = expectParam(params);
      const first = await targetTab(tabId, expected, context, true);
      return serialized(first.id, async () => {
        const tab = await targetTab(first.id, expected, context, true);
        const mainFrameId = await enableEvents(cdp, tab.id);
        if (action !== "reload") {
          const entry = await historyTarget(cdp, tab.id, action);
          if (expected && httpOrigin(entry.url) !== expected.origin) throw mismatch("navigation to another origin");
          const observer = new TabObserver(api, cdp, tab.id, mainFrameId);
          await cdp.send(tab.id, "Page.navigateToHistoryEntry", { entryId: entry.id });
          // A history navigation always navigates (same-document entries included).
          const result = await settle(api, observer, waitUntil, timeoutMs, timing, URL_MAX_LENGTH);
          return { ...result, navigated: true };
        }
        const observer = new TabObserver(api, cdp, tab.id, mainFrameId);
        await cdp.send(tab.id, "Page.reload", {});
        return settle(api, observer, waitUntil, timeoutMs, timing, URL_MAX_LENGTH);
      });
    },
  };

  /**
   * A control command (AD-16 point 7): check the subject, resolve the target
   * (ref or selector) and act once inside the tab's queue, then settle.
   */
  async function control(
    params: CommandParams,
    context: CommandContext | undefined,
    extraKeys: readonly string[],
    act: (tabId: number, node: { backendNodeId: number }, refs: RefRegistry) => Promise<void>,
    options: { element?: boolean } = {},
  ): Promise<{ tabId: number; url: string; navigated: boolean; newTabs: number[] }> {
    onlyKeys(params, ["tabId", "ref", "selector", "waitUntil", "timeoutMs", "expect", ...extraKeys]);
    const tabId = optionalTabIdParam(params);
    const waitUntil = waitUntilParam(params.waitUntil);
    const timeoutMs = timeoutParam(params.timeoutMs);
    const expected = expectParam(params);
    const refs = refsFor(context);
    const element = options.element ?? true;
    const first = await targetTab(tabId, expected, context, true);
    return serialized(first.id, async () => {
      // The binding is checked when the command reaches the front of the queue.
      const tab = await targetTab(first.id, expected, context, true);
      const mainFrameId = await enableEvents(cdp, tab.id);
      const node = element
        ? await resolveTarget(cdp, refs, tab.id, params, SELECTOR_MAX_LENGTH)
        : (undefined as unknown as { backendNodeId: number });
      const observer = new TabObserver(api, cdp, tab.id, mainFrameId);
      try {
        if (expected) checkTab(expected, await api.tabs.get(tab.id), context);
        await act(tab.id, node, refs);
      } catch (error) {
        observer.dispose();
        throw error;
      }
      return settle(api, observer, waitUntil, timeoutMs, timing, URL_MAX_LENGTH);
    });
  }

  return handlers;
}
