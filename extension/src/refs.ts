import type { CdpSessions } from "./cdp.js";
import { ExtensionError } from "./errors.js";

/**
 * Element references (ARCHITECTURE.md §27, AD-16 point 5).
 *
 * A ref names one element of one document: it is bound to (connection, tab,
 * frame, document). One registry exists per host connection, so a ref of an
 * earlier connection is unknown to the next one. The same element of the same
 * document keeps its ref across snapshots. A ref is not a secret and grants
 * nothing: commands with a ref are authorized and approved like any other.
 *
 * Before acting on a ref the extension checks, inside the same command, that
 * the ref belongs to the named tab, that the tab's debugger session is the one
 * the ref was made in, that the frame still shows the same document (its
 * loader id; node ids alone can resolve into a new document) and that the
 * element is still connected. Otherwise BROWSER_STALE_REF; nothing is done
 * and the ref is never re-resolved by role, name, text, position or selector.
 */

export const REF_PATTERN = /^e[1-9][0-9]{0,8}$/;
export const FRAME_REF_PATTERN = /^f[1-9][0-9]{0,8}$/;

/** Bound on remembered refs per connection; the oldest are forgotten (and then stale). */
export const MAX_REFS = 50_000;

export interface RefTarget {
  readonly tabId: number;
  /** CDP frame id of the element's frame. */
  readonly frameId: string;
  /** CDP loader id of the frame's document when the ref was made. */
  readonly loaderId: string;
  readonly backendNodeId: number;
  /** CdpSessions generation of the tab when the ref was made. */
  readonly generation: number;
}

export const STALE_MESSAGE =
  "The element reference is stale (the page, frame or element changed). Take a new browser_snapshot.";

const stale = (): ExtensionError => new ExtensionError("BROWSER_STALE_REF", STALE_MESSAGE);

const key = (t: RefTarget): string =>
  t.tabId + "|" + t.generation + "|" + t.frameId + "|" + t.loaderId + "|" + t.backendNodeId;

export interface FrameTarget {
  readonly tabId: number;
  readonly frameId: string;
  readonly loaderId: string;
  readonly generation: number;
}

const frameKey = (t: FrameTarget): string => t.tabId + "|" + t.generation + "|" + t.frameId + "|" + t.loaderId;

export class RefRegistry {
  private readonly byKey = new Map<string, string>();
  private readonly byRef = new Map<string, RefTarget>();
  private readonly frameByKey = new Map<string, string>();
  private readonly frameByRef = new Map<string, FrameTarget>();
  private next = 1;
  private nextFrame = 1;

  constructor(private readonly max = MAX_REFS) {}

  /** The ref of an element, the existing one when the same element of the same document already has one. */
  refFor(target: RefTarget): string {
    const k = key(target);
    const existing = this.byKey.get(k);
    if (existing !== undefined) return existing;
    const ref = "e" + this.next++;
    this.byKey.set(k, ref);
    this.byRef.set(ref, target);
    while (this.byRef.size > this.max) {
      const [oldest, oldTarget] = this.byRef.entries().next().value as [string, RefTarget];
      this.byRef.delete(oldest);
      this.byKey.delete(key(oldTarget));
    }
    return ref;
  }

  /** The ref of a frame document (bound like element refs, AD-16 point 10). */
  frameRefFor(target: FrameTarget): string {
    const k = frameKey(target);
    const existing = this.frameByKey.get(k);
    if (existing !== undefined) return existing;
    const ref = "f" + this.nextFrame++;
    this.frameByKey.set(k, ref);
    this.frameByRef.set(ref, target);
    while (this.frameByRef.size > this.max) {
      const [oldest, oldTarget] = this.frameByRef.entries().next().value as [string, FrameTarget];
      this.frameByRef.delete(oldest);
      this.frameByKey.delete(frameKey(oldTarget));
    }
    return ref;
  }

  lookupFrame(frameRef: string): FrameTarget | undefined {
    return this.frameByRef.get(frameRef);
  }

  lookup(ref: string): RefTarget | undefined {
    return this.byRef.get(ref);
  }

  /** Forget every ref of a closed tab (they are stale anyway). */
  forgetTab(tabId: number): void {
    for (const [ref, target] of this.byRef) {
      if (target.tabId !== tabId) continue;
      this.byRef.delete(ref);
      this.byKey.delete(key(target));
    }
    for (const [ref, target] of this.frameByRef) {
      if (target.tabId !== tabId) continue;
      this.frameByRef.delete(ref);
      this.frameByKey.delete(frameKey(target));
    }
  }

  get size(): number {
    return this.byRef.size;
  }
}

export function refParam(value: unknown): string {
  if (typeof value !== "string" || !REF_PATTERN.test(value)) {
    throw new ExtensionError("INVALID_INPUT", "'ref' must be an element reference from browser_snapshot.");
  }
  return value;
}

export function frameRefParam(value: unknown): string {
  if (typeof value !== "string" || !FRAME_REF_PATTERN.test(value)) {
    throw new ExtensionError("INVALID_INPUT", "'frameRef' must be a frame reference from browser_snapshot.");
  }
  return value;
}

/** Check before acting for a frame ref: the frame still shows the same document, or BROWSER_STALE_REF. */
export async function verifyFrameRef(
  registry: RefRegistry,
  cdp: CdpSessions,
  frameRef: string,
  tabId: number,
): Promise<FrameTarget> {
  const target = registry.lookupFrame(frameRef);
  if (target === undefined || target.tabId !== tabId) throw stale();
  if (cdp.generation(tabId) !== target.generation || !cdp.isAttached(tabId)) throw stale();
  const loaders = await frameLoaders(cdp, tabId);
  if (loaders.get(target.frameId) !== target.loaderId || cdp.generation(tabId) !== target.generation) throw stale();
  return target;
}

interface FrameTreeNode {
  readonly frame: { readonly id: string; readonly loaderId: string };
  readonly childFrames?: readonly FrameTreeNode[];
}

interface DomNode {
  readonly backendNodeId: number;
  readonly frameId?: string;
  readonly children?: readonly DomNode[];
  readonly shadowRoots?: readonly DomNode[];
  readonly contentDocument?: DomNode;
}

/** The current loader id of every frame of the tab's main target. */
export async function frameLoaders(cdp: CdpSessions, tabId: number): Promise<Map<string, string>> {
  const { frameTree } = await cdp.send<{ frameTree: FrameTreeNode }>(tabId, "Page.getFrameTree");
  const loaders = new Map<string, string>();
  const walk = (node: FrameTreeNode): void => {
    loaders.set(node.frame.id, node.frame.loaderId);
    for (const child of node.childFrames ?? []) walk(child);
  };
  walk(frameTree);
  return loaders;
}

/** Whether a node is connected to the document of the given frame (shadow roots and frames pierced). */
export async function isConnected(
  cdp: CdpSessions,
  tabId: number,
  frameId: string,
  backendNodeId: number,
): Promise<boolean> {
  const { root } = await cdp.send<{ root: DomNode }>(tabId, "DOM.getDocument", { depth: -1, pierce: true });
  // The document of the frame: the root for the main frame, otherwise a contentDocument with that frameId.
  const findDocument = (node: DomNode): DomNode | undefined => {
    if (node.frameId === frameId) return node;
    for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) {
      const found = findDocument(child);
      if (found) return found;
    }
    return node.contentDocument ? findDocument(node.contentDocument) : undefined;
  };
  const contains = (node: DomNode): boolean => {
    if (node.backendNodeId === backendNodeId) return true;
    for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) if (contains(child)) return true;
    // A node of a child frame's document is not part of this frame's document.
    return false;
  };
  const document = root.frameId === frameId ? root : findDocument(root);
  return document !== undefined && contains(document);
}

/**
 * Check before acting (AD-16 point 5): the ref's target, or BROWSER_STALE_REF.
 * Runs inside the command that acts, immediately before the action.
 */
export async function verifyRef(
  registry: RefRegistry,
  cdp: CdpSessions,
  ref: string,
  tabId: number,
): Promise<RefTarget> {
  const target = registry.lookup(ref);
  if (target === undefined || target.tabId !== tabId) throw stale();
  if (cdp.generation(tabId) !== target.generation || !cdp.isAttached(tabId)) throw stale();
  const loaders = await frameLoaders(cdp, tabId);
  if (loaders.get(target.frameId) !== target.loaderId) throw stale();
  if (cdp.generation(tabId) !== target.generation) throw stale();
  if (!(await isConnected(cdp, tabId, target.frameId, target.backendNodeId))) throw stale();
  return target;
}
