import type { CdpChannel } from "./frames.js";
import { ExtensionError } from "./errors.js";

/**
 * Trusted browser input (ARCHITECTURE.md §27, AD-16 point 6).
 *
 * All input is CDP Input of the browser (trusted DOM events), dispatched at
 * the element's top-level viewport coordinates, so it also reaches frames and
 * shadow roots. Before pointer input the element is scrolled into view and
 * must have a non-empty box, be enabled and be hit at the click point by
 * itself or a descendant; otherwise INVALID_INPUT with a fixed reason and
 * nothing is dispatched. There is no "force" option and no retry.
 *
 * Callers pass a node that has just passed the ref check (refs.ts verifyRef)
 * or was just resolved from a selector in the same command.
 */

export type MouseButton = "left" | "right" | "middle";
export type Modifier = "Shift" | "Control" | "Alt" | "Meta" | "ControlOrMeta";

export const MODIFIERS: readonly Modifier[] = ["Shift", "Control", "Alt", "Meta", "ControlOrMeta"];
export const MAX_KEY_COMBINATIONS = 32;
export const MAX_DRAG_STEPS = 10;
export const MAX_SCROLL_DELTA = 100_000;
/** How long a select / check action waits for the page to show the requested state. */
export const STATE_SETTLE_MS = 1_000;
const STATE_POLL_MS = 50;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export type NotActionableReason =
  "not visible" | "disabled" | "obscured" | "not editable" | "not a select" | "not checkable" | "not focusable";

export const notActionable = (reason: NotActionableReason, detail = ""): ExtensionError =>
  new ExtensionError(
    "INVALID_INPUT",
    "The element is not actionable: " + reason + (detail ? " (" + detail + ")" : "") + ".",
  );

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface InputOptions {
  /** ControlOrMeta is Meta on macOS, Control elsewhere. */
  readonly mac: boolean;
}

// ------------------------------------------------------------- DOM helpers

interface DomNode {
  readonly backendNodeId: number;
  readonly nodeType?: number;
  readonly attributes?: readonly string[];
  readonly nodeName?: string;
  readonly localName?: string;
  readonly children?: readonly DomNode[];
  readonly shadowRoots?: readonly DomNode[];
  readonly contentDocument?: DomNode;
}

/** Parent of every node of the tab (shadow roots and same-process frame documents pierced). */
async function parents(cdp: CdpChannel, tabId: number): Promise<Map<number, number>> {
  const { root } = await cdp.send<{ root: DomNode }>(tabId, "DOM.getDocument", { depth: -1, pierce: true });
  const map = new Map<number, number>();
  const stack: DomNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop() as DomNode;
    const kids = [...(node.children ?? []), ...(node.shadowRoots ?? [])];
    if (node.contentDocument) kids.push(node.contentDocument);
    for (const kid of kids) {
      map.set(kid.backendNodeId, node.backendNodeId);
      stack.push(kid);
    }
  }
  return map;
}

function isSelfOrAncestor(parentOf: ReadonlyMap<number, number>, ancestor: number, node: number): boolean {
  let current: number | undefined = node;
  for (let i = 0; current !== undefined && i < 10_000; i++) {
    if (current === ancestor) return true;
    current = parentOf.get(current);
  }
  return false;
}

interface AxProperty {
  readonly name: string;
  readonly value: { readonly value?: unknown };
}

interface AxNode {
  readonly backendDOMNodeId?: number;
  readonly role?: { readonly value?: unknown };
  readonly value?: { readonly value?: unknown };
  readonly properties?: readonly AxProperty[];
}

/** The computed accessibility node of an element (disabled, checked, role). */
export async function axOf(cdp: CdpChannel, tabId: number, backendNodeId: number): Promise<AxNode | undefined> {
  const { nodes } = await cdp.send<{ nodes: AxNode[] }>(tabId, "Accessibility.getPartialAXTree", {
    backendNodeId,
    fetchRelatives: false,
  });
  return nodes.find((n) => n.backendDOMNodeId === backendNodeId) ?? nodes[0];
}

const property = (node: AxNode | undefined, name: string): unknown =>
  node?.properties?.find((p) => p.name === name)?.value.value;

const truthy = (v: unknown): boolean => v === true || v === "true";

export type CheckedState = boolean | "mixed";

export function checkedOf(node: AxNode | undefined): CheckedState | undefined {
  const v = property(node, "checked") ?? property(node, "pressed");
  if (v === "mixed") return "mixed";
  if (v === undefined) return undefined;
  return truthy(v);
}

function quadCenter(quad: readonly number[]): { point: Point; area: number } {
  const xs = [quad[0], quad[2], quad[4], quad[6]] as number[];
  const ys = [quad[1], quad[3], quad[5], quad[7]] as number[];
  const width = Math.max(...xs) - Math.min(...xs);
  const height = Math.max(...ys) - Math.min(...ys);
  return {
    point: { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 },
    area: width * height,
  };
}

/** Attempts after a covered hit test: first the element is scrolled towards the viewport centre, then re-checked. */
export const OBSCURED_ATTEMPTS = 4;
export const OBSCURED_RETRY_MS = 150;
const SCROLL_SETTLE_MS = 1_000;
const TEXT_NODE = 3;

/**
 * The actionability check before pointer input. Returns the point to
 * dispatch at (the centre of the first visible box, top-level viewport
 * coordinates).
 *
 * A covered element (a fixed header over an element scrolled to the top, a
 * fading overlay) is scrolled towards the centre of the viewport once and
 * re-checked a few times; an element that stays covered fails with the
 * element that covers it named (tag and id only).
 */
export async function actionablePoint(
  cdp: CdpChannel,
  tabId: number,
  backendNodeId: number,
  options: { requireEnabled?: boolean } = {},
): Promise<Point> {
  try {
    await cdp.send(tabId, "DOM.scrollIntoViewIfNeeded", { backendNodeId });
  } catch {
    throw notActionable("not visible");
  }
  let point = await visiblePoint(cdp, tabId, backendNodeId);
  if (options.requireEnabled !== false && truthy(property(await axOf(cdp, tabId, backendNodeId), "disabled"))) {
    throw notActionable("disabled");
  }
  let covered = await coveredBy(cdp, tabId, backendNodeId, point);
  for (let attempt = 1; covered !== undefined && attempt < OBSCURED_ATTEMPTS; attempt++) {
    if (attempt === 1) await scrollTowardsCentre(cdp, tabId, backendNodeId, point);
    else await sleep(OBSCURED_RETRY_MS);
    point = await visiblePoint(cdp, tabId, backendNodeId);
    covered = await coveredBy(cdp, tabId, backendNodeId, point);
  }
  if (covered !== undefined) throw notActionable("obscured", covered);
  return point;
}

/** The centre of the element's first visible box, inside the viewport, or "not visible". */
async function visiblePoint(cdp: CdpChannel, tabId: number, backendNodeId: number): Promise<Point> {
  let quads: number[][] = [];
  try {
    quads = (await cdp.send<{ quads: number[][] }>(tabId, "DOM.getContentQuads", { backendNodeId })).quads;
  } catch {
    quads = [];
  }
  const box = quads.map(quadCenter).find((q) => q.area > 0);
  if (!box) throw notActionable("not visible");
  const { width: vw, height: vh } = await viewportSize(cdp, tabId);
  const point = { x: Math.round(box.point.x * 100) / 100, y: Math.round(box.point.y * 100) / 100 };
  if (point.x < 0 || point.y < 0 || point.x >= vw || point.y >= vh)
    throw notActionable("not visible", "outside the viewport");
  return point;
}

/**
 * What a top-level viewport point hits: DOM.getNodeForLocation takes
 * document coordinates (the viewport point plus the document's scroll
 * offset), so the scroll offset is added here. A frame channel translates
 * into its own document (see FrameScope.hitTest).
 */
export async function hitTest(cdp: CdpChannel, tabId: number, point: Point): Promise<HitResult> {
  if (cdp.hitTest) return cdp.hitTest(tabId, point);
  return documentHit((method, params) => cdp.send(tabId, method, params), point);
}

export interface HitResult {
  /** The hit node; undefined or negative when nothing of this document is hit there. */
  readonly backendNodeId?: number;
  /** What covers the point instead ("covered by div#overlay"), when known. */
  readonly coveredBy?: string;
}

/** Hit test in one document's session at a point of that document's viewport. */
export async function documentHit(
  send: <T>(method: string, params?: Readonly<Record<string, unknown>>) => Promise<T>,
  point: Point,
): Promise<HitResult> {
  let scrollX = 0;
  let scrollY = 0;
  try {
    const metrics = await send<{ cssLayoutViewport?: { pageX?: number; pageY?: number } }>("Page.getLayoutMetrics");
    scrollX = metrics.cssLayoutViewport?.pageX ?? 0;
    scrollY = metrics.cssLayoutViewport?.pageY ?? 0;
  } catch {
    // no metrics: an unscrolled document
  }
  try {
    return await send<{ backendNodeId?: number }>("DOM.getNodeForLocation", {
      x: Math.round(point.x + scrollX),
      y: Math.round(point.y + scrollY),
      includeUserAgentShadowDOM: true,
      ignorePointerEventsNone: false,
    });
  } catch {
    return {};
  }
}

async function viewportSize(cdp: CdpChannel, tabId: number): Promise<{ width: number; height: number }> {
  const metrics = await cdp.send<{ cssVisualViewport?: { clientWidth: number; clientHeight: number } }>(
    tabId,
    "Page.getLayoutMetrics",
  );
  return {
    width: metrics.cssVisualViewport?.clientWidth ?? Number.MAX_SAFE_INTEGER,
    height: metrics.cssVisualViewport?.clientHeight ?? Number.MAX_SAFE_INTEGER,
  };
}

/**
 * Whether the point hits the element: undefined when it does, otherwise what
 * covers it ("covered by div#overlay"). The hit may be the element, a
 * descendant, the parent element of a text node (hit tests never return text
 * nodes), or the owner of the frame the element is in (a hit test may stop
 * at an out-of-process frame's owner).
 */
async function coveredBy(
  cdp: CdpChannel,
  tabId: number,
  backendNodeId: number,
  point: Point,
): Promise<string | undefined> {
  const hit = await hitTest(cdp, tabId, point);
  const hitId = hit?.backendNodeId;
  if (hitId === undefined || hitId < 0) return hit?.coveredBy ?? "covered";
  if (hitId === backendNodeId) return undefined;
  const parentOf = await parents(cdp, tabId);
  let target = backendNodeId;
  const parent = parentOf.get(backendNodeId);
  if (parent !== undefined && (await nodeType(cdp, tabId, backendNodeId)) === TEXT_NODE) target = parent;
  if (isSelfOrAncestor(parentOf, target, hitId)) return undefined;
  if (isSelfOrAncestor(parentOf, hitId, target)) {
    // The hit node contains the element: accept only frame owners (IFRAME / FRAME).
    const name = await nodeName(cdp, tabId, hitId);
    if (name === "iframe" || name === "frame") return undefined;
  }
  return "covered by " + (await describeNode(cdp, tabId, hitId));
}

/** One wheel step that brings the element's centre towards the viewport centre, then a short settle. */
async function scrollTowardsCentre(cdp: CdpChannel, tabId: number, backendNodeId: number, point: Point): Promise<void> {
  const { width, height } = await viewportSize(cdp, tabId);
  const deltaY = Math.round(point.y - height / 2);
  const deltaX = point.x >= 0 && point.x < width ? 0 : Math.round(point.x - width / 2);
  if (Math.abs(deltaY) < 2 && deltaX === 0) return;
  const quadsOf = async (): Promise<string | undefined> => {
    try {
      return JSON.stringify(
        (await cdp.send<{ quads: number[][] }>(tabId, "DOM.getContentQuads", { backendNodeId })).quads,
      );
    } catch {
      return undefined;
    }
  };
  const before = await quadsOf();
  // Only a wheel event (no mouse move or press): the page scrolls as for the user's wheel.
  await cdp.send(tabId, "Input.dispatchMouseEvent", { type: "mouseWheel", x: point.x, y: point.y, deltaX, deltaY });
  // Wheel scrolling is applied asynchronously and may be animated: wait until the element has moved
  // and stopped moving (or give up: the re-check decides).
  let last = before;
  let moved = false;
  const deadline = Date.now() + SCROLL_SETTLE_MS;
  while (Date.now() < deadline) {
    await sleep(50);
    const now = await quadsOf();
    if (now === undefined) return;
    if (moved && now === last) return;
    if (now !== before) moved = true;
    last = now;
  }
}

async function describedNode(cdp: CdpChannel, tabId: number, backendNodeId: number): Promise<DomNode | undefined> {
  try {
    return (await cdp.send<{ node: DomNode }>(tabId, "DOM.describeNode", { backendNodeId })).node;
  } catch {
    return undefined;
  }
}

async function nodeType(cdp: CdpChannel, tabId: number, backendNodeId: number): Promise<number | undefined> {
  return (await describedNode(cdp, tabId, backendNodeId))?.nodeType;
}

async function nodeName(cdp: CdpChannel, tabId: number, backendNodeId: number): Promise<string> {
  const node = await describedNode(cdp, tabId, backendNodeId);
  return (node?.localName || node?.nodeName || "").toLowerCase();
}

/** Tag and id of a node, for error messages ("div#overlay"); never its text. */
export async function describeNode(cdp: CdpChannel, tabId: number, backendNodeId: number): Promise<string> {
  const node = await describedNode(cdp, tabId, backendNodeId);
  if (!node) return "another element";
  return nodeLabel(node);
}

export function nodeLabel(node: { localName?: string; nodeName?: string; attributes?: readonly string[] }): string {
  const name = (node.localName || node.nodeName || "element").toLowerCase();
  const attrs = node.attributes ?? [];
  let id: string | undefined;
  for (let i = 0; i + 1 < attrs.length; i += 2) if (attrs[i] === "id") id = attrs[i + 1];
  const label = name + (id ? "#" + id : "");
  return label.length > 80 ? label.slice(0, 79) + "\u2026" : label;
}

/**
 * Focuses the element keys go to. The document's body and root element take
 * keys without focus (they are where key events go when nothing is focused).
 */
export async function focusForKeys(cdp: CdpChannel, tabId: number, backendNodeId: number): Promise<void> {
  try {
    await cdp.send(tabId, "DOM.focus", { backendNodeId });
    return;
  } catch {
    // not focusable: see below
  }
  const { node } = await cdp.send<{ node: DomNode }>(tabId, "DOM.describeNode", { backendNodeId });
  const name = (node.localName ?? node.nodeName ?? "").toLowerCase();
  if (name !== "body" && name !== "html") throw notActionable("not focusable");
}

// ------------------------------------------------------------- keys

export interface KeyDefinition {
  readonly key: string;
  readonly code: string;
  readonly keyCode: number;
  readonly text?: string;
}

const NAMED_KEYS: Readonly<Record<string, KeyDefinition>> = {
  Enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  Tab: { key: "Tab", code: "Tab", keyCode: 9 },
  Escape: { key: "Escape", code: "Escape", keyCode: 27 },
  Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  Delete: { key: "Delete", code: "Delete", keyCode: 46 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  Home: { key: "Home", code: "Home", keyCode: 36 },
  End: { key: "End", code: "End", keyCode: 35 },
  PageUp: { key: "PageUp", code: "PageUp", keyCode: 33 },
  PageDown: { key: "PageDown", code: "PageDown", keyCode: 34 },
  Space: { key: " ", code: "Space", keyCode: 32, text: " " },
  ...Object.fromEntries(
    Array.from({ length: 12 }, (_, i) => [
      "F" + (i + 1),
      { key: "F" + (i + 1), code: "F" + (i + 1), keyCode: 112 + i },
    ]),
  ),
};

const MODIFIER_KEYS: Readonly<Record<Exclude<Modifier, "ControlOrMeta">, KeyDefinition & { bit: number }>> = {
  Alt: { key: "Alt", code: "AltLeft", keyCode: 18, bit: 1 },
  Control: { key: "Control", code: "ControlLeft", keyCode: 17, bit: 2 },
  Meta: { key: "Meta", code: "MetaLeft", keyCode: 91, bit: 4 },
  Shift: { key: "Shift", code: "ShiftLeft", keyCode: 16, bit: 8 },
};

const PUNCTUATION_CODES: Readonly<Record<string, [string, number]>> = {
  " ": ["Space", 32],
  "-": ["Minus", 189],
  "=": ["Equal", 187],
  "[": ["BracketLeft", 219],
  "]": ["BracketRight", 221],
  "\\": ["Backslash", 220],
  ";": ["Semicolon", 186],
  "'": ["Quote", 222],
  ",": ["Comma", 188],
  ".": ["Period", 190],
  "/": ["Slash", 191],
  "`": ["Backquote", 192],
};

/** A printable character as a key (layout-independent code where one exists). */
export function printableKey(char: string): KeyDefinition {
  const upper = char.toUpperCase();
  if (/^[a-zA-Z]$/.test(char)) return { key: char, code: "Key" + upper, keyCode: upper.charCodeAt(0), text: char };
  if (/^[0-9]$/.test(char)) return { key: char, code: "Digit" + char, keyCode: char.charCodeAt(0), text: char };
  const punctuation = PUNCTUATION_CODES[char];
  if (punctuation) return { key: char, code: punctuation[0], keyCode: punctuation[1], text: char };
  return { key: char, code: "", keyCode: 0, text: char };
}

export interface KeyCombination {
  readonly modifiers: readonly Exclude<Modifier, "ControlOrMeta">[];
  readonly key: KeyDefinition | undefined;
}

const invalidKeys = (detail: string): ExtensionError =>
  new ExtensionError("INVALID_INPUT", "Invalid key combination " + JSON.stringify(detail).slice(0, 80) + ".");

/** Parses "Control+Shift+A", "Enter", "+", "Shift++" (AD-16 point 6 notation). */
export function parseCombination(text: string, options: InputOptions): KeyCombination {
  if (typeof text !== "string" || text.length === 0 || text.length > 64) throw invalidKeys(String(text));
  const parts: string[] = [];
  let rest = text;
  while (rest.length > 0) {
    const at = rest.indexOf("+", 1);
    if (at === -1) {
      parts.push(rest);
      break;
    }
    parts.push(rest.slice(0, at));
    rest = rest.slice(at + 1);
    if (rest.length === 0) throw invalidKeys(text);
  }
  const modifiers: Exclude<Modifier, "ControlOrMeta">[] = [];
  let key: KeyDefinition | undefined;
  parts.forEach((part, index) => {
    const last = index === parts.length - 1;
    if ((MODIFIERS as readonly string[]).includes(part)) {
      const m =
        part === "ControlOrMeta" ? (options.mac ? "Meta" : "Control") : (part as Exclude<Modifier, "ControlOrMeta">);
      if (modifiers.includes(m)) throw invalidKeys(text);
      modifiers.push(m);
      return;
    }
    if (!last) throw invalidKeys(text);
    const named = NAMED_KEYS[part];
    if (named) key = named;
    else if ([...part].length === 1) key = printableKey(part);
    else throw invalidKeys(text);
  });
  return { modifiers, key };
}

export function keySequenceParam(value: unknown, options: InputOptions): KeyCombination[] {
  const list = typeof value === "string" ? [value] : value;
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_KEY_COMBINATIONS) {
    throw new ExtensionError(
      "INVALID_INPUT",
      "'keys' must be a key combination or a list of 1 to " + MAX_KEY_COMBINATIONS + " combinations.",
    );
  }
  return list.map((item: unknown) => parseCombination(item as string, options));
}

export function modifierBits(modifiers: readonly Exclude<Modifier, "ControlOrMeta">[]): number {
  return modifiers.reduce((bits, m) => bits | MODIFIER_KEYS[m].bit, 0);
}

/** Presses one combination: modifiers down, key down/up, modifiers up (reverse). */
export async function pressCombination(cdp: CdpChannel, tabId: number, combo: KeyCombination): Promise<void> {
  const down: Exclude<Modifier, "ControlOrMeta">[] = [];
  for (const m of combo.modifiers) {
    down.push(m);
    const def = MODIFIER_KEYS[m];
    await cdp.send(tabId, "Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      key: def.key,
      code: def.code,
      windowsVirtualKeyCode: def.keyCode,
      modifiers: modifierBits(down),
    });
  }
  const bits = modifierBits(combo.modifiers);
  if (combo.key) {
    const k = combo.key;
    // Text is produced only without Control / Alt / Meta (those make shortcuts, not characters).
    const producesText = k.text !== undefined && (bits & ~MODIFIER_KEYS.Shift.bit) === 0;
    const text = producesText ? (bits & MODIFIER_KEYS.Shift.bit && k.text ? k.text.toUpperCase() : k.text) : undefined;
    await cdp.send(tabId, "Input.dispatchKeyEvent", {
      type: producesText ? "keyDown" : "rawKeyDown",
      key: k.key,
      code: k.code,
      windowsVirtualKeyCode: k.keyCode,
      modifiers: bits,
      ...(text !== undefined ? { text, unmodifiedText: k.text } : {}),
    });
    await cdp.send(tabId, "Input.dispatchKeyEvent", {
      type: "keyUp",
      key: k.key,
      code: k.code,
      windowsVirtualKeyCode: k.keyCode,
      modifiers: bits,
    });
  }
  for (const m of [...combo.modifiers].reverse()) {
    down.pop();
    const def = MODIFIER_KEYS[m];
    await cdp.send(tabId, "Input.dispatchKeyEvent", {
      type: "keyUp",
      key: def.key,
      code: def.code,
      windowsVirtualKeyCode: def.keyCode,
      modifiers: modifierBits(down),
    });
  }
}

// ------------------------------------------------------------- pointer

const BUTTON_BITS: Readonly<Record<MouseButton, number>> = { left: 1, right: 2, middle: 4 };

export interface ClickOptions {
  readonly button: MouseButton;
  readonly clickCount: 1 | 2;
  readonly modifiers: readonly Exclude<Modifier, "ControlOrMeta">[];
}

export async function clickAt(cdp: CdpChannel, tabId: number, point: Point, options: ClickOptions): Promise<void> {
  const modifiers = modifierBits(options.modifiers);
  await cdp.send(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, modifiers });
  for (let count = 1; count <= options.clickCount; count++) {
    const common = { x: point.x, y: point.y, button: options.button, clickCount: count, modifiers };
    await cdp.send(tabId, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      ...common,
      buttons: BUTTON_BITS[options.button],
    });
    await cdp.send(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", ...common, buttons: 0 });
  }
}

export async function hoverAt(cdp: CdpChannel, tabId: number, point: Point): Promise<void> {
  await cdp.send(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
}

export async function wheelAt(
  cdp: CdpChannel,
  tabId: number,
  point: Point,
  deltaX: number,
  deltaY: number,
): Promise<void> {
  await cdp.send(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
  await cdp.send(tabId, "Input.dispatchMouseEvent", { type: "mouseWheel", x: point.x, y: point.y, deltaX, deltaY });
}

export async function dragBetween(cdp: CdpChannel, tabId: number, from: Point, to: Point): Promise<void> {
  await cdp.send(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: from.x, y: from.y });
  await cdp.send(tabId, "Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: from.x,
    y: from.y,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  for (let step = 1; step <= MAX_DRAG_STEPS; step++) {
    const x = from.x + ((to.x - from.x) * step) / MAX_DRAG_STEPS;
    const y = from.y + ((to.y - from.y) * step) / MAX_DRAG_STEPS;
    await cdp.send(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "left", buttons: 1 });
  }
  await cdp.send(tabId, "Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: to.x,
    y: to.y,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
}

/** Centre of the visual viewport (page scrolling without a target). */
export async function viewportCenter(cdp: CdpChannel, tabId: number): Promise<Point> {
  const metrics = await cdp.send<{ cssVisualViewport?: { clientWidth: number; clientHeight: number } }>(
    tabId,
    "Page.getLayoutMetrics",
  );
  return {
    x: Math.floor((metrics.cssVisualViewport?.clientWidth ?? 2) / 2),
    y: Math.floor((metrics.cssVisualViewport?.clientHeight ?? 2) / 2),
  };
}

// ------------------------------------------------------------- typing

/**
 * Types text into an editable element: focuses it by a trusted click (after
 * the actionability check), optionally clears it (select all + Delete) and
 * inserts the text as browser input. `submit` presses Enter afterwards.
 */
export async function typeInto(
  cdp: CdpChannel,
  tabId: number,
  backendNodeId: number,
  text: string,
  options: InputOptions & { clear: boolean; submit: boolean },
): Promise<void> {
  const ax = await axOf(cdp, tabId, backendNodeId);
  const editable = property(ax, "editable");
  const role = String(ax?.role?.value ?? "");
  const textRoles = ["textbox", "searchbox", "combobox", "textField", "spinbutton"];
  if (editable === undefined && !textRoles.includes(role)) throw notActionable("not editable");
  if (truthy(property(ax, "readonly"))) throw notActionable("not editable", "read-only");
  const point = await actionablePoint(cdp, tabId, backendNodeId);
  await clickAt(cdp, tabId, point, { button: "left", clickCount: 1, modifiers: [] });
  await cdp.send(tabId, "DOM.focus", { backendNodeId });
  if (options.clear) {
    await pressCombination(cdp, tabId, parseCombination("ControlOrMeta+a", options));
    await pressCombination(cdp, tabId, parseCombination("Delete", options));
  }
  if (text.length > 0) await cdp.send(tabId, "Input.insertText", { text });
  if (options.submit) await pressCombination(cdp, tabId, parseCombination("Enter", options));
}

// ------------------------------------------------------------- select and check

interface OptionNode extends DomNode {
  readonly attributes?: readonly string[];
  readonly nodeValue?: string;
}

const attr = (node: OptionNode, name: string): string | undefined => {
  const list = node.attributes ?? [];
  for (let i = 0; i + 1 < list.length; i += 2) if (list[i] === name) return list[i + 1];
  return undefined;
};

const textOf = (node: OptionNode): string =>
  node.nodeValue !== undefined && node.nodeName === "#text"
    ? node.nodeValue
    : (node.children ?? []).map((c) => textOf(c as OptionNode)).join("");

export interface SelectOption {
  readonly backendNodeId: number;
  readonly value: string;
  readonly label: string;
  readonly disabled: boolean;
}

/** The options of a native select (inside optgroups too), in order. */
export async function selectOptions(
  cdp: CdpChannel,
  tabId: number,
  backendNodeId: number,
): Promise<{ multiple: boolean; options: SelectOption[] }> {
  const { node } = await cdp.send<{ node: OptionNode }>(tabId, "DOM.describeNode", { backendNodeId, depth: 3 });
  if ((node.localName ?? "").toLowerCase() !== "select") throw notActionable("not a select");
  const options: SelectOption[] = [];
  const visit = (n: OptionNode, groupDisabled: boolean): void => {
    for (const child of (n.children ?? []) as OptionNode[]) {
      const name = (child.localName ?? "").toLowerCase();
      if (name === "optgroup") visit(child, groupDisabled || attr(child, "disabled") !== undefined);
      else if (name === "option") {
        const label = (attr(child, "label") ?? textOf(child)).replace(/\s+/g, " ").trim();
        options.push({
          backendNodeId: child.backendNodeId,
          value: attr(child, "value") ?? label,
          label,
          disabled: groupDisabled || attr(child, "disabled") !== undefined,
        });
      }
    }
  };
  visit(node, false);
  return { multiple: attr(node, "multiple") !== undefined, options };
}

/** Indices of the wanted options: by value first, then by label; each must exist and be enabled. */
export function chooseOptions(
  options: readonly SelectOption[],
  wanted: readonly string[],
  multiple: boolean,
): number[] {
  if (!multiple && wanted.length !== 1) {
    throw new ExtensionError("INVALID_INPUT", "A single-choice select takes exactly one option.");
  }
  const indices: number[] = [];
  for (const w of wanted) {
    let index = options.findIndex((o) => o.value === w);
    if (index === -1) index = options.findIndex((o) => o.label === w);
    if (index === -1) throw new ExtensionError("INVALID_INPUT", "The select has no option with this value or label.");
    if ((options[index] as SelectOption).disabled) throw notActionable("disabled", "option");
    if (!indices.includes(index)) indices.push(index);
  }
  return indices;
}

/**
 * Selects options of a native select with trusted input: a single-choice
 * select is focused and moved with Home / ArrowDown (each step skips no
 * enabled option and fires the browser's own input / change events); a
 * multiple select gets a click on the first option and ControlOrMeta-clicks
 * on the others.
 */
export async function selectInto(
  cdp: CdpChannel,
  tabId: number,
  backendNodeId: number,
  wanted: readonly string[],
  options: InputOptions,
): Promise<{ selected: string[] }> {
  const { multiple, options: list } = await selectOptions(cdp, tabId, backendNodeId);
  const indices = chooseOptions(list, wanted, multiple);
  await actionablePoint(cdp, tabId, backendNodeId);
  if (!multiple) {
    await cdp.send(tabId, "DOM.focus", { backendNodeId });
    const target = indices[0] as number;
    const enabled = list.map((o, i) => [o, i] as const).filter(([o]) => !o.disabled);
    const steps = enabled.findIndex(([, i]) => i === target);
    await pressCombination(cdp, tabId, parseCombination("Home", options));
    for (let i = 0; i < steps; i++) await pressCombination(cdp, tabId, parseCombination("ArrowDown", options));
  } else {
    const modifier = options.mac ? "Meta" : "Control";
    let first = true;
    for (const index of indices) {
      const point = await actionablePoint(cdp, tabId, (list[index] as SelectOption).backendNodeId);
      await clickAt(cdp, tabId, point, { button: "left", clickCount: 1, modifiers: first ? [] : [modifier] });
      first = false;
    }
  }
  // Report only what the page shows: the requested options must be selected.
  const wantedIds = new Set(indices.map((i) => (list[i] as SelectOption).backendNodeId));
  const deadline = Date.now() + STATE_SETTLE_MS;
  for (;;) {
    const selected = await selectedOptions(cdp, tabId, backendNodeId, list, multiple);
    if (selected !== undefined && [...wantedIds].every((id) => selected.has(id))) break;
    if (Date.now() >= deadline) {
      throw new ExtensionError(
        "OPERATION_FAILED",
        "The select did not change to the requested option" + (indices.length > 1 ? "s" : "") + ".",
      );
    }
    await sleep(STATE_POLL_MS);
  }
  return { selected: indices.map((i) => (list[i] as SelectOption).value) };
}

/**
 * The selected options as the page shows them: for a single-choice select the
 * accessibility value (the label of the selected option, which is what a
 * closed select exposes), for a multiple select the options' selected state.
 * Undefined when it cannot be read.
 */
async function selectedOptions(
  cdp: CdpChannel,
  tabId: number,
  backendNodeId: number,
  list: readonly SelectOption[],
  multiple: boolean,
): Promise<Set<number> | undefined> {
  try {
    if (!multiple) {
      const ax = await axOf(cdp, tabId, backendNodeId);
      const value = ax?.value?.value;
      if (typeof value === "string" && value.length > 0) {
        const label = value.replace(/\s+/g, " ").trim();
        return new Set(list.filter((o) => o.label === label).map((o) => o.backendNodeId));
      }
    }
    const ids = new Set<number>();
    for (const option of list) {
      if (truthy(property(await axOf(cdp, tabId, option.backendNodeId), "selected"))) ids.add(option.backendNodeId);
    }
    return ids;
  } catch {
    return undefined;
  }
}

const CHECKABLE_ROLES = ["checkbox", "radio", "switch", "menuitemcheckbox", "menuitemradio"];

/** Sets a checkbox, radio button or switch: acts only when the state differs, reports the resulting state. */
export async function setChecked(
  cdp: CdpChannel,
  tabId: number,
  backendNodeId: number,
  checked: boolean,
): Promise<{ checked: CheckedState; changed: boolean }> {
  const before = await axOf(cdp, tabId, backendNodeId);
  const role = String(before?.role?.value ?? "");
  const state = checkedOf(before);
  if (!CHECKABLE_ROLES.includes(role) || state === undefined) throw notActionable("not checkable");
  if (state === checked) return { checked: state, changed: false };
  if (role.endsWith("radio") && !checked) {
    throw new ExtensionError("INVALID_INPUT", "A radio button is unchecked by checking another one.");
  }
  const point = await actionablePoint(cdp, tabId, backendNodeId);
  await clickAt(cdp, tabId, point, { button: "left", clickCount: 1, modifiers: [] });
  // The page may update the state asynchronously (frameworks): wait briefly for the requested state.
  let after = checkedOf(await axOf(cdp, tabId, backendNodeId));
  const deadline = Date.now() + STATE_SETTLE_MS;
  while (after !== checked && Date.now() < deadline) {
    await sleep(STATE_POLL_MS);
    after = checkedOf(await axOf(cdp, tabId, backendNodeId));
  }
  if (after !== checked) {
    throw new ExtensionError(
      "OPERATION_FAILED",
      "The element did not become " +
        (checked ? "checked" : "unchecked") +
        " (its state is " +
        (after === undefined ? "unknown" : after === "mixed" ? "mixed" : after ? "checked" : "unchecked") +
        ").",
    );
  }
  return { checked: after, changed: true };
}
