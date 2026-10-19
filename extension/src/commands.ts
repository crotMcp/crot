import { DownloadCapture } from "./download-capture.js";
import type { BrowserCommand } from "../../src/core/capabilities/browser/connection.js";
import type { ChromeApi, ChromeTab } from "./chrome-api.js";
import { ExtensionError, isExtensionErrorCode } from "./errors.js";
import { CdpSessions } from "./cdp.js";
import type { CdpChannel } from "./frames.js";
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
  focusForKeys,
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
import { NOT_DELIVERED_MESSAGE, VISIBLE_WAIT_MS, ensureVisible, injector, startInputProbe } from "./delivery.js";
import { RefRegistry, frameRefParam, refParam, verifyRef } from "./refs.js";
import { SNAPSHOT_DEFAULT_ELEMENTS, SNAPSHOT_MAX_ELEMENTS, takeSnapshot, quadBounds } from "./snapshot.js";

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
  /** How long a control command waits for the tab's page to become visible (tests shorten it). */
  readonly visibleWaitMs?: number;
  /** Bound of one screenshot capture (tests shorten it). */
  readonly screenshotTimeoutMs?: number;
}

/** A capture the browser does not answer in this time fails (a hidden window produces no image). */
export const SCREENSHOT_TIMEOUT_MS = 10_000;
const SCREENSHOT_HIDDEN_MESSAGE = "The browser did not capture the requested tab within the screenshot timeout.";

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
  if (selector.includes("\0")) throw invalid("Selectors must not contain NUL.");
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
  const inject = injector(api);
  const visibleWaitMs = options.visibleWaitMs ?? VISIBLE_WAIT_MS;
  const screenshotTimeoutMs = options.screenshotTimeoutMs ?? SCREENSHOT_TIMEOUT_MS;
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

  // Input needs a visible page, and activating one tab hides the others of its window: control
  // commands of different tabs run one at a time (waits, reads and snapshots are not affected).
  let inputTail: Promise<unknown> = Promise.resolve();
  function exclusiveInput<T>(run: () => Promise<T>): Promise<T> {
    const result = inputTail.then(run, run);
    inputTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
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

  /** True when the load finishes; false on close or loadWaitMs expiry. Never rejects. */
  function waitForLoad(tabId: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let done = false;
      const finish = (loaded: boolean) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        api.tabs.onUpdated.removeListener(onUpdated);
        api.tabs.onRemoved.removeListener(onRemoved);
        resolve(loaded);
      };
      const onUpdated = (id: number, change: { readonly status?: string }) => {
        if (id === tabId && change.status === "complete") finish(true);
      };
      const onRemoved = (id: number) => {
        if (id === tabId) finish(false);
      };
      const timer = setTimeout(() => finish(false), loadWaitMs);
      api.tabs.onUpdated.addListener(onUpdated);
      api.tabs.onRemoved.addListener(onRemoved);
      api.tabs.get(tabId).then(
        (tab) => {
          if (tab.status === "complete" && !tab.pendingUrl) finish(true);
        },
        () => finish(false),
      );
    });
  }

  /** Wait for the load, then report the tab's (possibly redirected) URL. */
  async function loaded(
    tabId: number,
    waitUntil?: WaitUntil,
    timeoutMs?: number,
    observer?: TabObserver,
  ): Promise<{ tabId: number; url: string; loadTimedOut?: true }> {
    let timedOut = false;
    if (waitUntil === undefined || timeoutMs === undefined) timedOut = !(await waitForLoad(tabId));
    else {
      let reachedState: boolean | "closed";
      try {
        reachedState = await waitForLoadState(api, tabId, waitUntil, Date.now() + timeoutMs, observer, timing);
      } finally {
        observer?.dispose();
      }
      timedOut = reachedState === false;
    }
    let tab: ChromeTab;
    try {
      tab = await api.tabs.get(tabId);
    } catch {
      throw new ExtensionError("NOT_FOUND", "The tab was closed while loading.");
    }
    // While still loading (load wait elapsed), pendingUrl is where the tab is going.
    const url = bounded(tab.pendingUrl || tab.url, URL_MAX_LENGTH);
    // The page has not reached waitUntil in time: said so, never silently (the tab keeps loading).
    return timedOut ? { tabId, url, loadTimedOut: true } : { tabId, url };
  }

  const groupQueues = new Map<number, Promise<unknown>>();
  async function groupTab(tab: ChromeTab & { id: number }): Promise<void> {
    const previous = groupQueues.get(tab.windowId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        const [group] = await api.tabGroups.query({ title: "CROT", windowId: tab.windowId });
        const id = await api.tabs.group({
          tabIds: [tab.id],
          ...(group ? { groupId: group.id } : { createProperties: { windowId: tab.windowId } }),
        });
        await api.tabGroups.update(id, { title: "CROT" });
      });
    groupQueues.set(tab.windowId, next);
    try {
      await next;
    } finally {
      if (groupQueues.get(tab.windowId) === next) groupQueues.delete(tab.windowId);
    }
  }
  api.tabs.onCreated.addListener((tab) => {
    if (!hasId(tab) || tab.openerTabId === undefined) return;
    void getTab(tab.openerTabId)
      .then(async (opener) => {
        const groups = await api.tabGroups.query({ title: "CROT", windowId: opener.windowId });
        if (groups.some((g) => g.id === opener.groupId)) await groupTab(tab);
      })
      .catch(() => undefined); // Browser may refuse grouping popups or a closed tab.
  });
  const dialogSnapshot = (tab: ChromeTab & { id: number }) => ({
    tabId: tab.id,
    url: tabUrl(tab),
    title: bounded(tab.title, TITLE_MAX_LENGTH),
    frames: [],
    elements: [],
    truncated: false,
    dialog: cdp.dialog(tab.id),
  });

  const capture = new DownloadCapture(api, cdp);
  const handlers: CommandHandlers = {
    async "files.download_release"(params) {
      onlyKeys(params, ["stem"]);
      const stem = stringParam(params, "stem", 48, 48);
      if (!/^[a-f0-9]{48}$/.test(stem)) throw invalid("Invalid download lease.");
      await capture.release(stem);
      return {};
    },
    async "files.upload"(params, context) {
      onlyKeys(params, ["tabId", "ref", "token", "paths", "expect"]);
      const token = stringParam(params, "token", 48, 48);
      if (
        !/^[a-f0-9]{48}$/.test(token) ||
        !Array.isArray(params.paths) ||
        params.paths.length < 1 ||
        params.paths.length > 16 ||
        !params.paths.every((p) => typeof p === "string" && p.length > 0 && p.length < 8192 && !p.includes("\0"))
      )
        throw invalid("Invalid upload staging parameters.");
      const paths = params.paths as string[];
      const expected = expectParam(params),
        first = await targetTab(optionalTabIdParam(params), expected, context, true);
      return serialized(first.id, async () => {
        const tab = await targetTab(first.id, expected, context, true);
        let frameId: string;
        const chooser = cdp.fileChooser(tab.id);
        if (params.ref === undefined) {
          if (!chooser || cdp.dialog(tab.id)?.type !== "file_chooser")
            throw invalid("Give a file input ref or open a file chooser first.");
          frameId = chooser.frameId;
          cdp.retainUpload(tab.id, token, frameId);
          await cdp.send(
            tab.id,
            "DOM.setFileInputFiles",
            { files: paths, backendNodeId: chooser.backendNodeId },
            chooser.sessionId,
          );
          cdp.completeFileChooser(tab.id);
        } else {
          cdp.assertNoDialog(tab.id);
          const node = await resolveTarget(cdp, refsFor(context), tab.id, params, SELECTOR_MAX_LENGTH);
          const info = await node.channel.send<{ node: { nodeName: string; attributes?: string[] } }>(
            tab.id,
            "DOM.describeNode",
            { backendNodeId: node.backendNodeId },
          );
          const attrs = info.node.attributes ?? [];
          const attributes = new Map<string, string>();
          for (let i = 0; i + 1 < attrs.length; i += 2) attributes.set(attrs[i]!.toLowerCase(), attrs[i + 1]!);
          const type = attributes.get("type");
          if (info.node.nodeName.toLowerCase() !== "input" || type?.toLowerCase() !== "file")
            throw invalid("ref is not a file input.");
          if (paths.length > 1 && !attributes.has("multiple"))
            throw invalid("File input does not accept multiple files.");
          const tree = await cdp.send<{ frameTree: { frame: { id: string } } }>(tab.id, "Page.getFrameTree");
          frameId = node.frameId ?? tree.frameTree.frame.id;
          cdp.retainUpload(tab.id, token, frameId);
          await node.channel.send(tab.id, "DOM.setFileInputFiles", { files: paths, backendNodeId: node.backendNodeId });
        }
        return { tabId: tab.id };
      });
    },
    async "files.download"(params, context) {
      onlyKeys(params, [
        "tabId",
        "ref",
        "selector",
        "frameRef",
        "url",
        "prefix",
        "stem",
        "timeoutMs",
        "deadline",
        "maxBytes",
        "expect",
      ]);
      if ([params.ref, params.selector, params.url].filter((x) => x !== undefined).length !== 1)
        throw invalid("Give exactly one download trigger.");
      const expected = expectParam(params),
        first = await targetTab(optionalTabIdParam(params), expected, context, true);
      const prefix = stringParam(params, "prefix", 1, 200),
        stem = stringParam(params, "stem", 48, 48);
      const deadline = params.deadline as number,
        maxBytes = params.maxBytes as number;
      return serialized(first.id, () =>
        exclusiveInput(async () => {
          const tab = await targetTab(first.id, expected, context, true);
          cdp.assertNoDialog(tab.id);
          await ensureVisible(api, inject, tab, visibleWaitMs);
          const node =
            params.url === undefined
              ? await resolveTarget(cdp, refsFor(context), tab.id, params, SELECTOR_MAX_LENGTH)
              : undefined;
          return capture.run(tab.id, prefix, stem, deadline, maxBytes, async () => {
            await targetTab(tab.id, expected, context, true);
            if (params.url !== undefined) {
              await api.tabs.update(tab.id, { url: urlParam(params) });
            } else {
              const point = await actionablePoint(node!.channel, tab.id, node!.backendNodeId);
              await clickAt(cdp, tab.id, point, { button: "left", clickCount: 1, modifiers: [] });
            }
          });
        }),
      );
    },
    async "tabs.list"(params) {
      onlyKeys(params, []);
      const tabs = await api.tabs.query({});
      return {
        tabs: await Promise.all(
          tabs
            .filter(hasId)
            .slice(0, MAX_TABS)
            .map(async (tab) => {
              const groups = await api.tabGroups.query({ title: "CROT", windowId: tab.windowId });
              const dialog = cdp.dialog(tab.id);
              return {
                ...tabInfo(tab),
                discarded: tab.discarded === true,
                groupedByCrot: groups.some((g) => g.id === tab.groupId),
                ...(dialog ? { dialog } : {}),
              };
            }),
        ),
      };
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
      await groupTab(tab);
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
      // Closing is explicit; dismiss a pending page dialog safely, never confirm it.
      const pending = cdp.dialog(tab.id);
      if (pending?.type === "beforeunload") return { tabId: tab.id, closed: false, dialog: { type: pending.type } };
      if (pending) await cdp.handleDialog(tab.id, false);
      try {
        // Closing can itself open beforeunload; do not leave the command hanging.
        await cdp.guardDialog(tab.id, () => api.tabs.remove(tab.id));
      } catch (error) {
        const dialog = cdp.dialog(tab.id);
        if (error instanceof ExtensionError && error.code === "BROWSER_DIALOG_OPEN" && dialog)
          return { tabId: tab.id, closed: false, dialog: { type: dialog.type } };
        // A successful removal emits onRemoved, which also cancels in-flight work.
        try {
          await api.tabs.get(tab.id);
        } catch {
          return { tabId: tab.id, closed: true };
        }
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

    async "dialog.handle"(params, context) {
      onlyKeys(params, ["tabId", "accept", "promptText", "expect"]);
      const accept = booleanParam(params, "accept");
      const promptText = params.promptText === undefined ? undefined : stringParam(params, "promptText", 0, 10_000);
      const tab = await targetTab(optionalTabIdParam(params), expectParam(params), context, true);
      await cdp.handleDialog(tab.id, accept, promptText);
      const dialog = cdp.dialog(tab.id);
      return { tabId: tab.id, url: tabUrl(tab), ...(dialog ? { dialog: { type: dialog.type } } : {}) };
    },

    async "page.screenshot"(params, context) {
      onlyKeys(params, ["tabId", "format", "quality", "ref", "fullPage", "expect"]);
      const format = enumParam(params, "format", ["png", "jpeg"] as const);
      const quality = params.quality;
      if (
        quality !== undefined &&
        (format !== "jpeg" || !Number.isInteger(quality) || (quality as number) < 0 || (quality as number) > 100)
      )
        throw invalid("'quality' requires jpeg and an integer from 0 to 100.");
      const ref = params.ref === undefined ? undefined : refParam(params.ref);
      const fullPage = params.fullPage === undefined ? false : booleanParam(params, "fullPage");
      if (ref && fullPage) throw invalid("'ref' and 'fullPage' are mutually exclusive.");
      const expected = expectParam(params);
      const first = await targetTab(optionalTabIdParam(params), expected, context, true);
      return serialized(first.id, async () => {
        const tab = await targetTab(first.id, expected, context, true);
        if (tab.discarded) throw invalid("Discarded tabs cannot be captured; explicitly reload the tab first.");
        cdp.assertNoDialog(tab.id);
        const node = ref ? await verifyRef(refsFor(context), cdp, ref, tab.id) : undefined;
        type View = { pageX: number; pageY: number; clientWidth: number; clientHeight: number };
        const metrics = await cdp.send<{
          cssLayoutViewport: View;
          cssContentSize: { x: number; y: number; width: number; height: number };
        }>(tab.id, "Page.getLayoutMetrics");
        const view = metrics.cssLayoutViewport;
        const viewport = { width: view.clientWidth, height: view.clientHeight };
        let clip = { x: view.pageX, y: view.pageY, width: viewport.width, height: viewport.height, scale: 1 };
        if (fullPage) clip = { ...metrics.cssContentSize, scale: 1 };
        if (node) {
          const box = await node.channel.send<{ model: { border: number[] } }>(tab.id, "DOM.getBoxModel", {
            backendNodeId: node.backendNodeId,
          });
          const bounds = quadBounds(box.model.border);
          if (!bounds || bounds.width <= 0 || bounds.height <= 0)
            throw invalid("The referenced element has no screenshot area.");
          clip = { ...bounds, x: bounds.x + view.pageX, y: bounds.y + view.pageY, scale: 1 };
          await verifyRef(refsFor(context), cdp, ref as string, tab.id);
        }
        if (
          ![clip.x, clip.y, clip.width, clip.height].every(Number.isFinite) ||
          clip.width <= 0 ||
          clip.height <= 0 ||
          clip.width * clip.height > 64_000_000
        )
          throw new ExtensionError("LIMIT_EXCEEDED", "Screenshot area exceeds the capture bound.");
        let timer: ReturnType<typeof setTimeout> | undefined;
        let image: { data: string };
        try {
          image = await Promise.race([
            cdp.send<{ data: string }>(tab.id, "Page.captureScreenshot", {
              format,
              ...(quality === undefined ? {} : { quality }),
              fromSurface: true,
              captureBeyondViewport: true,
              clip,
            }),
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(
                () => reject(new ExtensionError("TIMEOUT", SCREENSHOT_HIDDEN_MESSAGE)),
                screenshotTimeoutMs,
              );
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
        const after = await getTab(tab.id);
        if (expected) checkTab(expected, after, context);
        if (after.url !== tab.url) throw new ExtensionError("OPERATION_FAILED", "The document changed during capture.");
        if (node) await verifyRef(refsFor(context), cdp, ref as string, tab.id);
        const data = image.data;
        if (typeof data !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(data))
          throw new ExtensionError("OPERATION_FAILED", "The browser returned an invalid image.");
        const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
        if ((data.length / 4) * 3 - padding > SCREENSHOT_MAX_BYTES)
          throw new ExtensionError("LIMIT_EXCEEDED", "The screenshot exceeds 16 MiB.");
        // Decode image metadata only; no page-world script or global emulation override.
        const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
        const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/" + format }));
        const devicePixelRatio = bitmap.width / clip.width;
        bitmap.close();
        return { tabId: tab.id, url: tabUrl(after), mimeType: "image/" + format, data, viewport, devicePixelRatio };
      });
    },

    async "page.click"(params, context) {
      if (!legacyForm(params, ["tabId", "selector", "expect"])) {
        const button =
          params.button === undefined ? "left" : enumParam(params, "button", ["left", "right", "middle"] as const);
        const clickCount = params.clickCount ?? 1;
        if (clickCount !== 1 && clickCount !== 2) throw invalid("'clickCount' must be 1 or 2.");
        const modifiers = modifiersParam(params.modifiers);
        return control(params, context, ["button", "clickCount", "modifiers"], async (tabId, node) => {
          const point = await actionablePoint(node.channel, tabId, node.backendNodeId);
          const probe = await startInputProbe(inject, tabId);
          await clickAt(cdp, tabId, point, {
            button: button as MouseButton,
            clickCount,
            modifiers: resolveModifiers(modifiers),
          });
          if (!(await probe.delivered())) throw new ExtensionError("OPERATION_FAILED", NOT_DELIVERED_MESSAGE);
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
          await typeInto(node.channel, tabId, node.backendNodeId, text, { ...inputOptions, clear, submit });
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
      if (cdp.dialog(first.id)) return dialogSnapshot(first);
      return serialized(first.id, async () => {
        const tab = await targetTab(first.id, expected, context, true);
        if (cdp.dialog(tab.id)) return dialogSnapshot(tab);
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
        await hoverAt(cdp, tabId, await actionablePoint(node.channel, tabId, node.backendNodeId));
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
            ? await actionablePoint(node.channel, tabId, node.backendNodeId, { requireEnabled: false })
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
      onlyKeys(to as CommandParams, ["ref", "selector", "frameRef"]);
      return control(params, context, ["to"], async (tabId, node, refs) => {
        const from = await actionablePoint(node.channel, tabId, node.backendNodeId);
        const target = await resolveTarget(cdp, refs, tabId, to as CommandParams, SELECTOR_MAX_LENGTH);
        const point = await actionablePoint(target.channel, tabId, target.backendNodeId, { requireEnabled: false });
        const probe = await startInputProbe(inject, tabId);
        await dragBetween(cdp, tabId, from, point);
        if (!(await probe.delivered())) throw new ExtensionError("OPERATION_FAILED", NOT_DELIVERED_MESSAGE);
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
            await actionablePoint(node.channel, tabId, node.backendNodeId, { requireEnabled: false });
            await focusForKeys(node.channel, tabId, node.backendNodeId);
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
        await actionablePoint(node.channel, tabId, node.backendNodeId);
        ({ selected } = await selectInto(node.channel, tabId, node.backendNodeId, values as string[], inputOptions));
      });
      return { ...result, selected };
    },

    async "page.set_checked"(params, context) {
      const checked = booleanParam(params, "checked");
      let outcome: { checked: boolean | "mixed"; changed: boolean } = { checked, changed: false };
      const result = await control(params, context, ["checked"], async (tabId, node) => {
        outcome = await setChecked(node.channel, tabId, node.backendNodeId, checked);
      });
      return { ...result, ...outcome };
    },

    async "page.wait"(params, context) {
      onlyKeys(params, [
        "tabId",
        "ref",
        "selector",
        "frameRef",
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
    act: (tabId: number, node: { backendNodeId: number; channel: CdpChannel }, refs: RefRegistry) => Promise<void>,
    options: { element?: boolean } = {},
  ): Promise<{
    tabId: number;
    url: string;
    navigated: boolean;
    newTabs: number[];
    activated?: true;
    loadTimedOut?: true;
  }> {
    onlyKeys(params, ["tabId", "ref", "selector", "frameRef", "waitUntil", "timeoutMs", "expect", ...extraKeys]);
    const tabId = optionalTabIdParam(params);
    const waitUntil = waitUntilParam(params.waitUntil);
    const timeoutMs = timeoutParam(params.timeoutMs);
    const expected = expectParam(params);
    const refs = refsFor(context);
    const element = options.element ?? true;
    const first = await targetTab(tabId, expected, context, true);
    return serialized(first.id, () =>
      exclusiveInput(async () => {
        // The binding is checked when the command reaches the front of the queue.
        const tab = await targetTab(first.id, expected, context, true);
        cdp.assertNoDialog(tab.id);
        // Input reaches visible pages only: activate the tab (restore its window) first.
        const activated = await ensureVisible(api, inject, tab, visibleWaitMs);
        const mainFrameId = await enableEvents(cdp, tab.id);
        // Keys and focus work as for a focused window while the user works in another application.
        await cdp.send(tab.id, "Emulation.setFocusEmulationEnabled", { enabled: true });
        const node = element
          ? await resolveTarget(cdp, refs, tab.id, params, SELECTOR_MAX_LENGTH)
          : (undefined as unknown as { backendNodeId: number; channel: CdpChannel });
        const observer = new TabObserver(api, cdp, tab.id, mainFrameId);
        try {
          if (expected) checkTab(expected, await api.tabs.get(tab.id), context);
          await act(tab.id, node, refs);
        } catch (error) {
          observer.dispose();
          const dialog = cdp.dialog(tab.id);
          if (error instanceof ExtensionError && error.code === "BROWSER_DIALOG_OPEN" && dialog)
            return { tabId: tab.id, url: tabUrl(tab), navigated: false, newTabs: [], dialog: { type: dialog.type } };
          throw error;
        }
        if (cdp.dialog(tab.id)) {
          observer.dispose();
          return {
            tabId: tab.id,
            url: tabUrl(tab),
            navigated: false,
            newTabs: [],
            dialog: { type: cdp.dialog(tab.id)!.type },
          };
        }
        const result = await settle(api, observer, waitUntil, timeoutMs, timing, URL_MAX_LENGTH);
        return activated ? { ...result, activated: true } : result;
      }),
    );
  }

  const exempt = new Set<BrowserCommand>([
    "tabs.list",
    "tabs.resolve",
    "tabs.open",
    "tabs.close",
    "page.snapshot",
    "dialog.handle",
    "files.upload",
    "files.download_release",
  ]);
  const reads = new Set<BrowserCommand>(["page.read", "page.screenshot", "page.wait"]);
  return Object.fromEntries(
    Object.entries(handlers).map(([name, handler]) => [
      name,
      async (params: CommandParams, context?: CommandContext) => {
        if (exempt.has(name as BrowserCommand)) return handler(params, context);
        const tab = await targetTab(optionalTabIdParam(params), expectParam(params), context, true);
        cdp.assertNoDialog(tab.id);
        try {
          return await cdp.guardDialog(tab.id, () => handler(params, context));
        } catch (error) {
          const dialog = cdp.dialog(tab.id);
          if (
            !reads.has(name as BrowserCommand) &&
            error instanceof ExtensionError &&
            error.code === "BROWSER_DIALOG_OPEN" &&
            dialog
          )
            return { tabId: tab.id, url: tabUrl(await getTab(tab.id)), dialog: { type: dialog.type } };
          if (error instanceof ExtensionError && error.code === "OPERATION_FAILED") {
            await getTab(tab.id); // NOT_FOUND for a tab close; external detach remains OPERATION_FAILED.
          }
          throw error;
        }
      },
    ]),
  ) as CommandHandlers;
}
