import type { CdpSessions } from "./cdp.js";
import { ExtensionError } from "./errors.js";
import { type CdpChannel, FrameChannels, tabFrames } from "./frames.js";
import type { RefRegistry } from "./refs.js";

/**
 * browser_snapshot (ARCHITECTURE.md §27, AD-16 points 5 and 10): the frames of
 * one tab and their interactive and landmark elements in document order,
 * each with a ref. Built from the accessibility tree of every frame (which
 * includes open shadow roots), box models in top-level viewport coordinates
 * and, for text fields, the node's type so password values are never read.
 * Every string and the whole result are bounded; `truncated` reports a cut.
 */

export const SNAPSHOT_DEFAULT_ELEMENTS = 500;
export const SNAPSHOT_MAX_ELEMENTS = 5000;
export const SNAPSHOT_MAX_BYTES = 1024 * 1024;
export const SNAPSHOT_NAME_MAX = 500;
export const SNAPSHOT_VALUE_MAX = 1000;
export const SNAPSHOT_TEXT_MAX = 2000;
export const SNAPSHOT_MAX_FRAME_DEPTH = 8;
export const SNAPSHOT_MAX_FRAMES = 100;

export const INTERACTIVE_ROLES: ReadonlySet<string> = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "checkbox",
  "radio",
  "switch",
  "combobox",
  "listbox",
  "option",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "slider",
  "spinbutton",
  "treeitem",
  "textField",
  "PopUpButton",
]);

export const LANDMARK_ROLES: ReadonlySet<string> = new Set([
  "banner",
  "navigation",
  "main",
  "contentinfo",
  "complementary",
  "form",
  "search",
  "region",
  "dialog",
  "alertdialog",
]);

const TEXT_ROLES: ReadonlySet<string> = new Set(["StaticText"]);
const TEXT_FIELD_ROLES: ReadonlySet<string> = new Set(["textbox", "searchbox", "textField"]);

// ------------------------------------------------------------- CDP shapes

interface AxValue {
  readonly value?: unknown;
}

export interface AxNode {
  readonly nodeId: string;
  readonly ignored?: boolean;
  readonly role?: AxValue;
  readonly name?: AxValue;
  readonly value?: AxValue;
  readonly properties?: readonly { readonly name: string; readonly value: AxValue }[];
  readonly childIds?: readonly string[];
  readonly parentId?: string;
  readonly backendDOMNodeId?: number;
}

export interface FrameInfo {
  readonly frameId: string;
  readonly parentFrameId: string | undefined;
  readonly url: string;
  readonly loaderId: string;
}

export interface Bounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export type ElementStates = Partial<
  Record<"disabled" | "selected" | "expanded" | "pressed" | "focused" | "readonly" | "required" | "editable", boolean>
> & { checked?: boolean | "mixed" };

export interface SnapshotElement {
  readonly ref: string;
  readonly frameRef: string;
  readonly role: string;
  readonly name: string;
  readonly value?: string;
  readonly hasValue?: boolean;
  readonly states: ElementStates;
  readonly bounds: Bounds | null;
  readonly inViewport: boolean;
}

export interface SnapshotFrame {
  readonly frameRef: string;
  readonly parentFrameRef: string | null;
  readonly url: string;
  readonly origin: string | null;
  readonly restricted: boolean;
}

export interface SnapshotResult {
  readonly tabId: number;
  readonly url: string;
  readonly title: string;
  readonly frames: SnapshotFrame[];
  readonly elements: SnapshotElement[];
  readonly truncated: boolean;
}

export interface SnapshotOptions {
  readonly frameRef?: string;
  readonly includeText: boolean;
  readonly maxElements: number;
}

// ------------------------------------------------------------- helpers

const clip = (text: string, max: number): { text: string; cut: boolean } =>
  text.length > max ? { text: text.slice(0, max), cut: true } : { text, cut: false };

const str = (v: AxValue | undefined): string =>
  v === undefined || v.value === undefined || v.value === null ? "" : String(v.value);

/** Origin of a frame (AD-16 point 10): http(s) origin, about:blank / srcdoc inherit the parent's, otherwise restricted. */
export function frameOrigin(url: string, parentOrigin: string | null | undefined): string | null {
  if (url === "" || url === "about:blank" || url.startsWith("about:srcdoc") || url.startsWith("about:blank#")) {
    return parentOrigin ?? null;
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") return parsed.origin;
  } catch {
    // not a URL
  }
  return null;
}

export function statesOf(node: AxNode): ElementStates {
  const states: Record<string, boolean | "mixed"> = {};
  for (const property of node.properties ?? []) {
    const v = property.value.value;
    switch (property.name) {
      case "disabled":
      case "selected":
      case "expanded":
      case "pressed":
      case "focused":
      case "readonly":
      case "required":
        if (typeof v === "boolean") states[property.name] = v;
        else if (v === "true" || v === "false") states[property.name] = v === "true";
        else if (property.name === "pressed" && v === "mixed") states.pressed = true;
        break;
      case "checked":
        if (v === "mixed") states.checked = "mixed";
        else if (typeof v === "boolean") states.checked = v;
        else if (v === "true" || v === "false") states.checked = v === "true";
        break;
      case "editable":
        if (typeof v === "string") states.editable = v === "plaintext" || v === "richtext";
        break;
    }
  }
  return states;
}

export function intersectsViewport(bounds: Bounds | null, viewport: { width: number; height: number }): boolean {
  if (bounds === null || bounds.width <= 0 || bounds.height <= 0) return false;
  return (
    bounds.x < viewport.width &&
    bounds.y < viewport.height &&
    bounds.x + bounds.width > 0 &&
    bounds.y + bounds.height > 0
  );
}

/** The bounding box of a CDP quad list (x1,y1,...,x4,y4). */
export function quadBounds(quad: readonly number[] | undefined): Bounds | null {
  if (!quad || quad.length < 8) return null;
  const xs = [quad[0], quad[2], quad[4], quad[6]] as number[];
  const ys = [quad[1], quad[3], quad[5], quad[7]] as number[];
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  const round = (n: number): number => Math.round(n * 100) / 100;
  return { x: round(x), y: round(y), width: round(Math.max(...xs) - x), height: round(Math.max(...ys) - y) };
}

/** The AX nodes of one frame in document (tree) order, starting at the root. */
export function inTreeOrder(nodes: readonly AxNode[]): AxNode[] {
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const root = nodes.find((n) => n.parentId === undefined || !byId.has(n.parentId));
  if (!root) return [];
  const out: AxNode[] = [];
  const seen = new Set<string>();
  const stack: AxNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop() as AxNode;
    if (seen.has(node.nodeId)) continue;
    seen.add(node.nodeId);
    out.push(node);
    const children = (node.childIds ?? []).map((id) => byId.get(id)).filter((n): n is AxNode => n !== undefined);
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i] as AxNode);
  }
  return out;
}

// ------------------------------------------------------------- collection

export interface SnapshotTab {
  readonly id: number;
  readonly url: string;
  readonly title: string;
}

/** Collects one snapshot through the allowlisted CDP methods. */
export async function takeSnapshot(
  cdp: CdpSessions,
  registry: RefRegistry,
  tab: SnapshotTab,
  options: SnapshotOptions,
): Promise<SnapshotResult> {
  const tabId = tab.id;
  await cdp.send(tabId, "DOM.enable");
  await cdp.send(tabId, "Accessibility.enable");
  const generation = cdp.generation(tabId);

  // Frames in tree order with depth and count bounds, out-of-process frames included (AD-16 point 10).
  const listed = await tabFrames(cdp, tabId, { maxDepth: SNAPSHOT_MAX_FRAME_DEPTH, maxFrames: SNAPSHOT_MAX_FRAMES });
  const frames = listed.frames;
  const channels = new FrameChannels(cdp, tabId, frames);
  const channelOf = (frame: FrameInfo): CdpChannel => channels.forSession(sessionOf(frame));
  const sessionOf = (frame: FrameInfo): string | undefined =>
    frames.find((f) => f.frameId === frame.frameId)?.sessionId;
  for (const sessionId of new Set(frames.map((f) => f.sessionId))) {
    if (sessionId === undefined) continue;
    try {
      await cdp.send(tabId, "DOM.enable", {}, sessionId);
      await cdp.send(tabId, "Accessibility.enable", {}, sessionId);
    } catch {
      // the frame went away meanwhile; its elements are missing from this snapshot
    }
  }

  let truncated = listed.truncated || frames.length >= SNAPSHOT_MAX_FRAMES;
  const frameRefs = new Map<string, string>();
  const origins = new Map<string, string | null>();
  const snapshotFrames: SnapshotFrame[] = [];
  for (const frame of frames) {
    const frameRef = registry.frameRefFor({ tabId, frameId: frame.frameId, loaderId: frame.loaderId, generation });
    frameRefs.set(frame.frameId, frameRef);
    const parentOrigin = frame.parentFrameId === undefined ? undefined : origins.get(frame.parentFrameId);
    const origin = frameOrigin(frame.url, parentOrigin);
    origins.set(frame.frameId, origin);
    snapshotFrames.push({
      frameRef,
      parentFrameRef: frame.parentFrameId === undefined ? null : (frameRefs.get(frame.parentFrameId) ?? null),
      url: clip(frame.url, 8192).text,
      origin,
      restricted: origin === null,
    });
  }

  let only: string | undefined;
  if (options.frameRef !== undefined) {
    const target = registry.lookupFrame(options.frameRef);
    const frame = target && frames.find((f) => f.frameId === target.frameId);
    if (
      !target ||
      target.tabId !== tabId ||
      target.generation !== generation ||
      !frame ||
      frame.loaderId !== target.loaderId
    ) {
      throw new ExtensionError("BROWSER_STALE_REF", "The frame reference is stale. Take a new browser_snapshot.");
    }
    only = target.frameId;
  }

  // Owner element of each child frame (in its parent's session), to splice child frames in document order.
  const ownerKey = (sessionId: string | undefined, backendNodeId: number): string =>
    (sessionId ?? "") + "|" + backendNodeId;
  const ownerOf = new Map<string, string>();
  for (const frame of frames) {
    if (frame.parentFrameId === undefined) continue;
    const parent = frames.find((f) => f.frameId === frame.parentFrameId);
    if (!parent) continue;
    try {
      const owner = await channelOf(parent).send<{ backendNodeId: number }>(tabId, "DOM.getFrameOwner", {
        frameId: frame.frameId,
      });
      ownerOf.set(ownerKey(parent.sessionId, owner.backendNodeId), frame.frameId);
    } catch {
      // owner not reachable; the frame is listed after its parent's elements
    }
  }

  const metrics = await cdp.send<{ cssVisualViewport?: { clientWidth: number; clientHeight: number } }>(
    tabId,
    "Page.getLayoutMetrics",
  );
  const viewport = {
    width: metrics.cssVisualViewport?.clientWidth ?? 0,
    height: metrics.cssVisualViewport?.clientHeight ?? 0,
  };

  const elements: SnapshotElement[] = [];
  let bytes = 0;
  const done = new Set<string>();

  const addFrame = async (frame: FrameInfo): Promise<void> => {
    if (done.has(frame.frameId)) return;
    done.add(frame.frameId);
    const frameRef = frameRefs.get(frame.frameId) as string;
    const restricted = origins.get(frame.frameId) === null;
    const childrenLater = frames.filter((f) => f.parentFrameId === frame.frameId);
    if (!restricted && (only === undefined || only === frame.frameId)) {
      let nodes: AxNode[] = [];
      try {
        const tree = await channelOf(frame).send<{ nodes: AxNode[] }>(tabId, "Accessibility.getFullAXTree", {
          frameId: frame.frameId,
        });
        nodes = inTreeOrder(tree.nodes);
      } catch {
        nodes = [];
      }
      for (const node of nodes) {
        if (truncated) return;
        const owned =
          node.backendDOMNodeId === undefined
            ? undefined
            : ownerOf.get(ownerKey(sessionOf(frame), node.backendDOMNodeId));
        const role = str(node.role);
        const isText = TEXT_ROLES.has(role);
        const wanted =
          !node.ignored && (INTERACTIVE_ROLES.has(role) || LANDMARK_ROLES.has(role) || (isText && options.includeText));
        if (wanted && node.backendDOMNodeId !== undefined) {
          const element = await describe(node, frame, frameRef, role, isText);
          if (element) {
            const size = JSON.stringify(element).length;
            if (elements.length >= options.maxElements || bytes + size > SNAPSHOT_MAX_BYTES) {
              truncated = true;
              return;
            }
            bytes += size;
            elements.push(element);
          }
        }
        if (owned !== undefined) {
          const child = frames.find((f) => f.frameId === owned);
          if (child) await addFrame(child);
        }
      }
    }
    for (const child of childrenLater) {
      if (truncated) return;
      await addFrame(child);
    }
  };

  const describe = async (
    node: AxNode,
    frame: FrameInfo,
    frameRef: string,
    role: string,
    isText: boolean,
  ): Promise<SnapshotElement | undefined> => {
    const backendNodeId = node.backendDOMNodeId as number;
    let bounds: Bounds | null = null;
    try {
      const box = await channelOf(frame).send<{ model: { border: number[] } }>(tabId, "DOM.getBoxModel", {
        backendNodeId,
      });
      bounds = quadBounds(box.model.border);
    } catch {
      bounds = null;
    }
    if (isText && !intersectsViewport(bounds, { width: Number.MAX_SAFE_INTEGER, height: Number.MAX_SAFE_INTEGER })) {
      return undefined; // text nodes: visible ones only
    }
    let password = false;
    if (TEXT_FIELD_ROLES.has(role)) {
      try {
        const { node: dom } = await channelOf(frame).send<{ node: { localName?: string; attributes?: string[] } }>(
          tabId,
          "DOM.describeNode",
          { backendNodeId },
        );
        const attributes = dom.attributes ?? [];
        for (let i = 0; i + 1 < attributes.length; i += 2) {
          if (attributes[i] === "type" && (attributes[i + 1] ?? "").toLowerCase() === "password") password = true;
        }
      } catch {
        password = true; // unknown: treat as secret
      }
    }
    const ref = registry.refFor({ tabId, frameId: frame.frameId, loaderId: frame.loaderId, backendNodeId, generation });
    const name = clip(str(node.name), isText ? SNAPSHOT_TEXT_MAX : SNAPSHOT_NAME_MAX);
    if (name.cut) truncated = true;
    const rawValue = str(node.value);
    const element: {
      ref: string;
      frameRef: string;
      role: string;
      name: string;
      value?: string;
      hasValue?: boolean;
      states: ElementStates;
      bounds: Bounds | null;
      inViewport: boolean;
    } = {
      ref,
      frameRef,
      role: isText ? "text" : role,
      name: name.text,
      states: statesOf(node),
      bounds,
      inViewport: intersectsViewport(bounds, viewport),
    };
    if (password) {
      element.hasValue = rawValue.length > 0;
    } else if (rawValue.length > 0 && !isText) {
      const value = clip(rawValue, SNAPSHOT_VALUE_MAX);
      if (value.cut) truncated = true;
      element.value = value.text;
    }
    return element;
  };

  const main = frames[0];
  if (main) await addFrame(main);
  // A cut caused by the frame bound or by a frame whose owner was not found is still reported.
  if (cdp.generation(tabId) !== generation) {
    throw new ExtensionError("OPERATION_FAILED", "The browser debugger was detached from the tab.");
  }
  return {
    tabId,
    url: tab.url,
    title: clip(tab.title, 10_000).text,
    frames: snapshotFrames,
    elements,
    truncated,
  };
}
