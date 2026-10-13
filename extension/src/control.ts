import type { ChromeApi, ChromeTab } from "./chrome-api.js";
import type { CdpSessions } from "./cdp.js";
import { ExtensionError } from "./errors.js";
import { type CdpChannel, FrameChannels, tabFrames } from "./frames.js";
import { axOf } from "./input.js";
import { STALE_MESSAGE, type RefRegistry, frameRefParam, refParam, verifyFrameRef, verifyRef } from "./refs.js";

/**
 * Settle phase, waits and history of Browser v1 (ARCHITECTURE.md §27,
 * AD-16 point 7).
 *
 * After every control command the extension observes the tab for a short,
 * fixed quiet period. When the action started a top-level navigation it waits
 * for that navigation to reach `waitUntil` (bounded by `timeoutMs`). The
 * control result reports facts only: `{tabId, url, navigated, newTabs}`;
 * it never contains page text. Nothing is retried: a wait either sees its
 * condition or ends with TIMEOUT.
 */

export const WAIT_UNTIL = ["commit", "domcontentloaded", "load", "networkidle"] as const;
export type WaitUntil = (typeof WAIT_UNTIL)[number];

export const WAIT_TIMEOUT_DEFAULT_MS = 20_000;
export const WAIT_TIMEOUT_MAX_MS = 60_000;
/** Quiet period after an action in which a navigation or a new tab is noticed. */
export const SETTLE_QUIET_MS = 300;
/** Network idle: no request in flight for this long (after load). */
export const NETWORK_IDLE_MS = 500;
/** Poll interval of browser_wait conditions. */
export const WAIT_POLL_MS = 100;
export const WAIT_TEXT_MAX_LENGTH = 1000;
export const MAX_NEW_TABS = 100;

export interface Timing {
  readonly quietMs: number;
  readonly networkIdleMs: number;
  readonly pollMs: number;
}

export const DEFAULT_TIMING: Timing = {
  quietMs: SETTLE_QUIET_MS,
  networkIdleMs: NETWORK_IDLE_MS,
  pollMs: WAIT_POLL_MS,
};

const invalid = (message: string): ExtensionError => new ExtensionError("INVALID_INPUT", message);
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function waitUntilParam(value: unknown, fallback: WaitUntil = "load"): WaitUntil {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !(WAIT_UNTIL as readonly string[]).includes(value))
    throw invalid("'waitUntil' must be one of " + WAIT_UNTIL.join(", ") + ".");
  return value as WaitUntil;
}

export function timeoutParam(value: unknown): number {
  if (value === undefined) return WAIT_TIMEOUT_DEFAULT_MS;
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > WAIT_TIMEOUT_MAX_MS)
    throw invalid("'timeoutMs' must be an integer from 1 to " + WAIT_TIMEOUT_MAX_MS + ".");
  return value as number;
}

const isHttp = (url: string | undefined): boolean => {
  if (!url) return false;
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
};

// ---------------------------------------------------------------- tab observer

interface LifecycleParams {
  readonly frameId?: string;
  readonly loaderId?: string;
  readonly name?: string;
}

/**
 * Observes one tab from just before an action: top-level navigations (the
 * tab starts loading or the main frame commits a new document), tabs opened
 * by it (openerTabId), lifecycle events of the main frame and the number of
 * network requests in flight. Events only; it sends nothing to the page.
 */
export class TabObserver {
  private started = false;
  private committed = false;
  private readonly opened: number[] = [];
  private readonly lifecycle = new Set<string>();
  private inflight = new Set<string>();
  private lastNetwork = Date.now();
  private readonly disposers: (() => void)[] = [];
  private mainFrameId: string | undefined;

  constructor(
    private readonly api: ChromeApi,
    cdp: CdpSessions | undefined,
    readonly tabId: number,
    mainFrameId?: string,
  ) {
    this.mainFrameId = mainFrameId;
    const onUpdated = (id: number, change: { readonly status?: string }) => {
      if (id === tabId && change.status === "loading") this.started = true;
    };
    const onCreated = (tab: ChromeTab) => {
      if (tab.openerTabId === tabId && tab.id !== undefined && this.opened.length < MAX_NEW_TABS)
        this.opened.push(tab.id);
    };
    api.tabs.onUpdated.addListener(onUpdated);
    api.tabs.onCreated.addListener(onCreated);
    this.disposers.push(() => api.tabs.onUpdated.removeListener(onUpdated));
    this.disposers.push(() => api.tabs.onCreated.removeListener(onCreated));
    if (cdp) {
      this.disposers.push(
        cdp.onEvent((source, method, params) => {
          if (source !== tabId) return;
          this.onCdpEvent(method, (params ?? {}) as Record<string, unknown>);
        }),
      );
    }
  }

  private onCdpEvent(method: string, params: Record<string, unknown>): void {
    if (method === "Page.frameNavigated") {
      const frame = params.frame as { id?: string; parentId?: string } | undefined;
      if (frame && frame.parentId === undefined && (this.mainFrameId === undefined || frame.id === this.mainFrameId)) {
        this.started = true;
        this.committed = true;
        this.lifecycle.clear();
        this.inflight.clear();
      }
    } else if (method === "Page.frameStartedLoading") {
      if (params.frameId !== undefined && params.frameId === this.mainFrameId) this.started = true;
    } else if (method === "Page.lifecycleEvent") {
      const p = params as LifecycleParams;
      if (p.name && (this.mainFrameId === undefined || p.frameId === this.mainFrameId)) {
        if (p.name === "init") this.lifecycle.clear();
        else this.lifecycle.add(p.name);
      }
    } else if (method === "Network.requestWillBeSent") {
      if (typeof params.requestId === "string") this.inflight.add(params.requestId);
      this.lastNetwork = Date.now();
    } else if (method === "Network.loadingFinished" || method === "Network.loadingFailed") {
      if (typeof params.requestId === "string") this.inflight.delete(params.requestId);
      this.lastNetwork = Date.now();
    }
  }

  /** A top-level navigation started (or committed) since the observer was created. */
  get navigationStarted(): boolean {
    return this.started;
  }

  /** The main frame committed a new document since the observer was created. */
  get documentCommitted(): boolean {
    return this.committed;
  }

  get newTabs(): number[] {
    return [...this.opened];
  }

  sawLifecycle(name: string): boolean {
    return this.lifecycle.has(name);
  }

  networkQuietFor(ms: number): boolean {
    return this.inflight.size === 0 && Date.now() - this.lastNetwork >= ms;
  }

  dispose(): void {
    for (const dispose of this.disposers.splice(0)) dispose();
  }
}

/** Prepares CDP event delivery for an observer (Page/Network events only) and answers the main frame id. */
export async function enableEvents(cdp: CdpSessions, tabId: number): Promise<string | undefined> {
  await cdp.send(tabId, "Page.enable");
  await cdp.send(tabId, "Page.setLifecycleEventsEnabled", { enabled: true });
  await cdp.send(tabId, "Network.enable");
  const { frameTree } = await cdp.send<{ frameTree: { frame: { id: string } } }>(tabId, "Page.getFrameTree");
  return frameTree?.frame?.id;
}

// ---------------------------------------------------------------- load states

async function tabNow(api: ChromeApi, tabId: number): Promise<ChromeTab | undefined> {
  try {
    return await api.tabs.get(tabId);
  } catch {
    return undefined;
  }
}

/**
 * Whether the tab's current document reached a load state. Without CDP
 * events (no observer), domcontentloaded and networkidle are judged by the
 * tab's load status (and, for networkidle, an additional quiet period).
 */
async function reached(
  api: ChromeApi,
  tabId: number,
  state: WaitUntil,
  observer: TabObserver | undefined,
  timing: Timing,
): Promise<boolean | "closed"> {
  const tab = await tabNow(api, tabId);
  if (!tab) return "closed";
  const committed = !tab.pendingUrl;
  const complete = committed && tab.status === "complete";
  switch (state) {
    case "commit":
      return committed || observer?.documentCommitted === true;
    case "domcontentloaded":
      return complete || observer?.sawLifecycle("DOMContentLoaded") === true;
    case "load":
      return complete || observer?.sawLifecycle("load") === true;
    case "networkidle":
      if (observer?.sawLifecycle("networkIdle")) return true;
      return complete && (observer ? observer.networkQuietFor(timing.networkIdleMs) : true);
  }
}

/** Waits until the load state is reached; false on timeout. Never rejects for a closed tab (answers "closed"). */
export async function waitForLoadState(
  api: ChromeApi,
  tabId: number,
  state: WaitUntil,
  deadline: number,
  observer: TabObserver | undefined,
  timing: Timing,
): Promise<boolean | "closed"> {
  for (;;) {
    const result = await reached(api, tabId, state, observer, timing);
    if (result !== false) return result;
    if (Date.now() >= deadline) return false;
    await sleep(Math.min(timing.pollMs, Math.max(1, deadline - Date.now())));
  }
}

export interface ControlResult {
  readonly tabId: number;
  readonly url: string;
  readonly navigated: boolean;
  readonly newTabs: number[];
  /** The navigation the action started did not reach waitUntil within timeoutMs (it goes on loading). */
  readonly loadTimedOut?: true;
}

/**
 * The settle phase after an action: a fixed quiet period; when the action
 * started a top-level navigation, wait for it to reach `waitUntil` (bounded).
 * A navigation that does not finish in time is still reported as navigated,
 * with loadTimedOut; the action has happened and is never repeated.
 */
export async function settle(
  api: ChromeApi,
  observer: TabObserver,
  waitUntil: WaitUntil,
  timeoutMs: number,
  timing: Timing,
  urlMax: number,
): Promise<ControlResult> {
  const deadline = Date.now() + timeoutMs;
  try {
    await sleep(Math.min(timing.quietMs, timeoutMs));
    let timedOut = false;
    if (observer.navigationStarted) {
      timedOut = (await waitForLoadState(api, observer.tabId, waitUntil, deadline, observer, timing)) === false;
    }
    const tab = await tabNow(api, observer.tabId);
    const result: ControlResult = {
      tabId: observer.tabId,
      url: (tab ? tab.url || tab.pendingUrl || "" : "").slice(0, urlMax),
      navigated: observer.navigationStarted,
      newTabs: observer.newTabs,
    };
    return timedOut ? { ...result, loadTimedOut: true } : result;
  } finally {
    observer.dispose();
  }
}

// ---------------------------------------------------------------- history

export const HISTORY_ACTIONS = ["back", "forward", "reload"] as const;
export type HistoryAction = (typeof HISTORY_ACTIONS)[number];

interface NavigationHistory {
  readonly currentIndex: number;
  readonly entries: readonly { readonly id: number; readonly url: string }[];
}

/**
 * The history entry back/forward would show, or a refusal: no such entry
 * (INVALID_INPUT) or a non-http(s) entry (BROWSER_PAGE_RESTRICTED).
 */
export async function historyTarget(
  cdp: CdpSessions,
  tabId: number,
  action: Exclude<HistoryAction, "reload">,
): Promise<{ id: number; url: string }> {
  const history = await cdp.send<NavigationHistory>(tabId, "Page.getNavigationHistory");
  const index = history.currentIndex + (action === "back" ? -1 : 1);
  const entry = history.entries?.[index];
  if (!entry) throw invalid("There is no history entry to go " + action + " to.");
  if (!isHttp(entry.url))
    throw new ExtensionError("BROWSER_PAGE_RESTRICTED", "CROT can only access http: and https: pages.");
  return entry;
}

// ---------------------------------------------------------------- targets

interface QueryNode {
  readonly nodeId: number;
  readonly backendNodeId?: number;
  readonly frameId?: string;
  readonly children?: readonly QueryNode[];
  readonly shadowRoots?: readonly QueryNode[];
  readonly contentDocument?: QueryNode;
}

/**
 * The document node of a frame in a DOM tree (CDP marks a frame's document
 * element and its owner element with the frame id): the owner's
 * contentDocument, or the document above the marked document element.
 */
export function frameDocumentNode(root: QueryNode, frameId: string): QueryNode | undefined {
  const visit = (node: QueryNode, parent: QueryNode | undefined): QueryNode | undefined => {
    if (node.frameId === frameId) return node.contentDocument ?? parent ?? node;
    for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) {
      const found = visit(child, node);
      if (found) return found;
    }
    return node.contentDocument ? visit(node.contentDocument, undefined) : undefined;
  };
  return visit(root, undefined);
}

/**
 * The element a command names: a ref (checked before acting, AD-16 point 5)
 * or a CSS selector (first match in the light DOM of one document: the
 * frame named by frameRef, checked like a ref, or the top-level document;
 * resolved once, right before the action, never re-resolved). With a ref,
 * frameRef must name the ref's own frame.
 */
export async function resolveTarget(
  cdp: CdpSessions,
  registry: RefRegistry,
  tabId: number,
  params: Readonly<Record<string, unknown>>,
  selectorMax: number,
): Promise<{ backendNodeId: number; frameId?: string; channel: CdpChannel }> {
  const hasRef = params.ref !== undefined;
  const hasSelector = params.selector !== undefined;
  if (hasRef === hasSelector) throw invalid("Give exactly one of 'ref' or 'selector'.");
  await cdp.send(tabId, "DOM.enable");
  const frame =
    params.frameRef === undefined
      ? undefined
      : await verifyFrameRef(registry, cdp, frameRefParam(params.frameRef), tabId);
  if (hasRef) {
    const target = await verifyRef(registry, cdp, refParam(params.ref), tabId);
    if (frame !== undefined && frame.frameId !== target.frameId)
      throw invalid("The ref is not in the frame named by 'frameRef'.");
    return { backendNodeId: target.backendNodeId, frameId: target.frameId, channel: target.channel };
  }
  const selector = params.selector;
  if (typeof selector !== "string" || selector.length < 1 || selector.length > selectorMax || selector.includes("\0"))
    throw invalid("'selector' must be a CSS selector of 1 to " + selectorMax + " characters.");
  let channel: CdpChannel = cdp;
  let documentId: number;
  if (frame === undefined) {
    documentId = (await cdp.send<{ root: QueryNode }>(tabId, "DOM.getDocument", { depth: 0 })).root.nodeId;
  } else {
    const { frames } = await tabFrames(cdp, tabId);
    channel = new FrameChannels(cdp, tabId, frames).forFrame(frame.frameId);
    const { root } = await channel.send<{ root: QueryNode }>(tabId, "DOM.getDocument", { depth: -1, pierce: true });
    const document = frameDocumentNode(root, frame.frameId);
    if (document === undefined) throw new ExtensionError("OPERATION_FAILED", "The frame is no longer in the tab.");
    documentId = document.nodeId;
  }
  let nodeId: number;
  try {
    ({ nodeId } = await channel.send<{ nodeId: number }>(tabId, "DOM.querySelector", { nodeId: documentId, selector }));
  } catch (error) {
    if (error instanceof ExtensionError && /selector|syntax/i.test(error.message))
      throw invalid("Invalid CSS selector.");
    throw error;
  }
  if (!nodeId) throw new ExtensionError("NOT_FOUND", "No element matches the selector.");
  const { node } = await channel.send<{ node: QueryNode }>(tabId, "DOM.describeNode", { nodeId });
  if (!Number.isSafeInteger(node.backendNodeId))
    throw new ExtensionError("NOT_FOUND", "No element matches the selector.");
  return {
    backendNodeId: node.backendNodeId as number,
    ...(frame !== undefined ? { frameId: frame.frameId } : {}),
    channel,
  };
}

// ---------------------------------------------------------------- browser_wait

export const ELEMENT_STATES = ["visible", "hidden", "enabled", "detached"] as const;
export type ElementState = (typeof ELEMENT_STATES)[number];

export type WaitCondition =
  | {
      readonly kind: "element";
      readonly ref?: string;
      readonly selector?: string;
      readonly frameRef?: string;
      readonly state: ElementState;
    }
  | { readonly kind: "text"; readonly text: string; readonly present: boolean }
  | { readonly kind: "url"; readonly urlPrefix: string }
  | { readonly kind: "load"; readonly state: WaitUntil }
  | { readonly kind: "newDocument" }
  | { readonly kind: "newTab" };

const CONDITION_KEYS = ["ref", "selector", "text", "textGone", "urlPrefix", "loadState", "newDocument", "newTab"];

/** Exactly one condition (AD-16 point 7). */
export function waitConditionParam(params: Readonly<Record<string, unknown>>, urlMax: number): WaitCondition {
  const given = CONDITION_KEYS.filter((k) => params[k] !== undefined);
  const elementForm = given.length === 1 && (given[0] === "ref" || given[0] === "selector");
  if (given.length !== 1) throw invalid("Give exactly one wait condition.");
  if (!elementForm && params.state !== undefined) throw invalid("'state' is only valid with 'ref' or 'selector'.");
  if (!elementForm && params.frameRef !== undefined)
    throw invalid("'frameRef' is only valid with 'ref' or 'selector'.");
  const frame = params.frameRef === undefined ? {} : { frameRef: frameRefParam(params.frameRef) };
  const key = given[0] as string;
  switch (key) {
    case "ref":
    case "selector": {
      const state = params.state ?? "visible";
      if (typeof state !== "string" || !(ELEMENT_STATES as readonly string[]).includes(state))
        throw invalid("'state' must be one of " + ELEMENT_STATES.join(", ") + ".");
      if (key === "ref") return { kind: "element", ref: refParam(params.ref), ...frame, state: state as ElementState };
      return { kind: "element", selector: params.selector as string, ...frame, state: state as ElementState };
    }
    case "text":
    case "textGone": {
      const text = params[key];
      if (typeof text !== "string" || text.length < 1 || text.length > WAIT_TEXT_MAX_LENGTH)
        throw invalid("'" + key + "' must be a string of 1 to " + WAIT_TEXT_MAX_LENGTH + " characters.");
      return { kind: "text", text, present: key === "text" };
    }
    case "urlPrefix": {
      const prefix = params.urlPrefix;
      if (typeof prefix !== "string" || prefix.length < 1 || prefix.length > urlMax)
        throw invalid("'urlPrefix' must be a string of 1 to " + urlMax + " characters.");
      return { kind: "url", urlPrefix: prefix };
    }
    case "loadState":
      return { kind: "load", state: waitUntilParam(params.loadState) };
    case "newDocument":
      if (params.newDocument !== true) throw invalid("'newDocument' must be true.");
      return { kind: "newDocument" };
    default:
      if (params.newTab !== true) throw invalid("'newTab' must be true.");
      return { kind: "newTab" };
  }
}

interface LayoutSnapshot {
  readonly documents?: readonly {
    readonly nodes?: { readonly nodeType?: readonly number[]; readonly nodeValue?: readonly number[] };
    readonly layout?: {
      readonly nodeIndex?: readonly number[];
      readonly styles?: readonly (readonly number[])[];
      readonly text?: readonly number[];
    };
  }[];
  readonly strings?: readonly string[];
}

/** The rendered text of one session's documents: text with a layout box whose visibility is not hidden. */
function renderedText(snapshot: LayoutSnapshot): string[] {
  const strings = snapshot.strings ?? [];
  const at = (index: number | undefined): string =>
    index !== undefined && index >= 0 && index < strings.length ? (strings[index] as string) : "";
  const parts: string[] = [];
  for (const doc of snapshot.documents ?? []) {
    const nodeType = doc.nodes?.nodeType ?? [];
    const nodeValue = doc.nodes?.nodeValue ?? [];
    const layout = doc.layout;
    const nodeIndex = layout?.nodeIndex ?? [];
    for (let i = 0; i < nodeIndex.length; i++) {
      const node = nodeIndex[i] as number;
      if (nodeType[node] !== 3) continue;
      const visibility = at(layout?.styles?.[i]?.[0]);
      if (visibility === "hidden" || visibility === "collapse") continue;
      const text = layout?.text?.[i];
      parts.push(text !== undefined && text >= 0 ? at(text) : at(nodeValue[node]));
    }
  }
  return parts;
}

/**
 * Whether the tab shows the text: rendered text only (AD-16 point 7), so text
 * in display:none or visibility:hidden elements, scripts and templates does
 * not count. Shadow roots and frames (out-of-process frames through their
 * sessions) are included. The text is never returned.
 */
async function pageHasText(cdp: CdpSessions, tabId: number, text: string): Promise<boolean> {
  const params = { computedStyles: ["visibility"] };
  const parts = renderedText(await cdp.send<LayoutSnapshot>(tabId, "DOMSnapshot.captureSnapshot", params));
  for (const child of await cdp.frameSessions(tabId)) {
    try {
      parts.push(
        ...renderedText(await cdp.send<LayoutSnapshot>(tabId, "DOMSnapshot.captureSnapshot", params, child.sessionId)),
      );
    } catch {
      // the frame went away meanwhile
    }
  }
  const normalize = (s: string) => s.replace(/\s+/g, " ");
  const wanted = normalize(text).trim();
  return normalize(parts.join(" ")).includes(wanted) || normalize(parts.join("")).includes(wanted);
}

async function elementState(
  cdp: CdpSessions,
  registry: RefRegistry,
  tabId: number,
  condition: Extract<WaitCondition, { kind: "element" }>,
  selectorMax: number,
): Promise<boolean> {
  let target: { backendNodeId: number; channel: CdpChannel };
  try {
    target = await resolveTarget(
      cdp,
      registry,
      tabId,
      {
        ...(condition.ref !== undefined ? { ref: condition.ref } : { selector: condition.selector }),
        ...(condition.frameRef !== undefined ? { frameRef: condition.frameRef } : {}),
      },
      selectorMax,
    );
  } catch (error) {
    const gone =
      error instanceof ExtensionError &&
      (error.code === "NOT_FOUND" || (error.code === "BROWSER_STALE_REF" && error.message === STALE_MESSAGE));
    if (!gone) throw error;
    if (condition.state === "detached" || condition.state === "hidden") return true;
    // A stale ref never becomes valid again: waiting for it to appear cannot succeed.
    if (condition.ref !== undefined) throw error;
    return false;
  }
  if (condition.state === "detached") return false;
  let visible: boolean;
  try {
    const { quads } = await target.channel.send<{ quads: number[][] }>(tabId, "DOM.getContentQuads", {
      backendNodeId: target.backendNodeId,
    });
    visible = (quads ?? []).some((q) => {
      const xs = [q[0], q[2], q[4], q[6]] as number[];
      const ys = [q[1], q[3], q[5], q[7]] as number[];
      return Math.max(...xs) - Math.min(...xs) > 0 && Math.max(...ys) - Math.min(...ys) > 0;
    });
  } catch {
    visible = false;
  }
  if (condition.state === "visible") return visible;
  if (condition.state === "hidden") return !visible;
  const ax = await axOf(target.channel, tabId, target.backendNodeId);
  const disabled = (ax?.properties ?? []).some((p) => p.name === "disabled" && p.value?.value === true);
  return visible && !disabled;
}

export const timeout = (what: string): ExtensionError =>
  new ExtensionError("TIMEOUT", "The wait for " + what + " timed out.");

const describeCondition = (c: WaitCondition): string =>
  c.kind === "element"
    ? "the element to be " + c.state
    : c.kind === "text"
      ? c.present
        ? "the text to appear"
        : "the text to disappear"
      : c.kind === "url"
        ? "the URL"
        : c.kind === "load"
          ? "the load state " + c.state
          : c.kind === "newDocument"
            ? "a new document"
            : "a new tab";

/** browser_wait: polls one condition until it holds (satisfied) or the deadline passes (TIMEOUT). */
export async function waitFor(
  api: ChromeApi,
  cdp: CdpSessions,
  registry: RefRegistry,
  tabId: number,
  condition: WaitCondition,
  timeoutMs: number,
  timing: Timing,
  limits: { readonly urlMax: number; readonly selectorMax: number },
): Promise<{ satisfied: true; url: string; newTabs?: number[] }> {
  // A CDP query may stop answering (renderer navigation/teardown). Checking tabs.get only
  // between polls cannot observe a close in that case. Race the whole wait, including
  // event setup and in-flight CDP, against native tab removal and its absolute deadline.
  let stopped = false;
  let interrupt!: (error: ExtensionError) => void;
  const interrupted = new Promise<never>((_, reject) => {
    interrupt = reject;
  });
  const onRemoved = (id: number): void => {
    if (id === tabId) interrupt(new ExtensionError("NOT_FOUND", "The tab was closed while waiting."));
  };
  api.tabs.onRemoved.addListener(onRemoved);
  const timer = setTimeout(() => interrupt(timeout(describeCondition(condition))), timeoutMs);
  let observer: TabObserver | undefined;
  const poll = async (): Promise<{ satisfied: true; url: string; newTabs?: number[] }> => {
    const deadline = Date.now() + timeoutMs;
    const needsEvents = condition.kind === "load" || condition.kind === "newDocument";
    const mainFrameId = needsEvents ? await enableEvents(cdp, tabId) : undefined;
    if (stopped) throw timeout(describeCondition(condition));
    observer = new TabObserver(api, needsEvents ? cdp : undefined, tabId, mainFrameId);
    try {
      for (;;) {
        if (stopped) throw timeout(describeCondition(condition));
        const tab = await tabNow(api, tabId);
        if (!tab) throw new ExtensionError("NOT_FOUND", "The tab was closed while waiting.");
        const url = (tab.url || "").slice(0, limits.urlMax);
        let ok: boolean;
        switch (condition.kind) {
          case "element":
            ok = await elementState(cdp, registry, tabId, condition, limits.selectorMax);
            break;
          case "text":
            ok = (await pageHasText(cdp, tabId, condition.text)) === condition.present;
            break;
          case "url":
            ok = !tab.pendingUrl && (tab.url ?? "").startsWith(condition.urlPrefix);
            break;
          case "load":
            ok = (await reached(api, tabId, condition.state, observer, timing)) === true;
            break;
          case "newDocument":
            ok = observer.documentCommitted;
            break;
          case "newTab":
            ok = observer.newTabs.length > 0;
            break;
        }
        if (stopped) throw timeout(describeCondition(condition));
        if (ok) {
          return condition.kind === "newTab"
            ? { satisfied: true, url, newTabs: observer.newTabs }
            : { satisfied: true, url };
        }
        if (Date.now() >= deadline) throw timeout(describeCondition(condition));
        await sleep(Math.min(timing.pollMs, Math.max(1, deadline - Date.now())));
      }
    } finally {
      observer.dispose();
    }
  };
  try {
    return await Promise.race([poll(), interrupted]);
  } finally {
    stopped = true;
    clearTimeout(timer);
    api.tabs.onRemoved.removeListener(onRemoved);
    observer?.dispose();
  }
}
