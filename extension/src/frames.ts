import type { CdpSessions } from "./cdp.js";
import { ExtensionError } from "./errors.js";

/**
 * Frames of a tab across processes (ARCHITECTURE.md §27, AD-16 point 10).
 *
 * Same-process frames are part of the tab's own debugger session.
 * Out-of-process frames (typically cross-site iframes) live in flat child
 * sessions that cdp.ts auto-attaches. This module joins both into one frame
 * list and gives every frame a CDP channel:
 *
 * - DOM, Accessibility and DOMSnapshot commands go to the frame's session;
 * - Input and Page commands go to the tab's own session (input is dispatched
 *   at top-level viewport coordinates, which Chromium routes to the frame);
 * - box models and quads of a child session are translated into top-level
 *   viewport coordinates (the owner iframe's content box), and a hit test
 *   first checks that the point hits the owner iframe in the parent.
 *
 * Nothing here evaluates script; every command still passes the allowlist.
 */

/** What element and snapshot code needs from CDP; CdpSessions itself is the tab's top-level channel. */
export interface CdpChannel {
  send<T = unknown>(tabId: number, method: string, params?: Readonly<Record<string, unknown>>): Promise<T>;
  generation(tabId: number): number;
  isAttached(tabId: number): boolean;
}

export interface FrameLocation {
  readonly frameId: string;
  readonly parentFrameId: string | undefined;
  readonly url: string;
  readonly loaderId: string;
  readonly depth: number;
  /** The child session of an out-of-process frame; undefined for the tab's own session. */
  readonly sessionId: string | undefined;
}

interface FrameTreeNode {
  readonly frame: {
    readonly id: string;
    readonly parentId?: string;
    readonly url: string;
    readonly loaderId: string;
    readonly urlFragment?: string;
  };
  readonly childFrames?: readonly FrameTreeNode[];
}

/** Frames of the tab in tree order (children after their parent), bounded in depth and count. */
export async function tabFrames(
  cdp: CdpSessions,
  tabId: number,
  bounds: { readonly maxDepth: number; readonly maxFrames: number } = { maxDepth: 8, maxFrames: 100 },
): Promise<{ frames: FrameLocation[]; truncated: boolean }> {
  const children = await cdp.frameSessions(tabId);
  const trees: { sessionId: string | undefined; tree: FrameTreeNode }[] = [];
  const { frameTree } = await cdp.send<{ frameTree: FrameTreeNode }>(tabId, "Page.getFrameTree");
  trees.push({ sessionId: undefined, tree: frameTree });
  for (const child of children) {
    try {
      const { frameTree: tree } = await cdp.send<{ frameTree: FrameTreeNode }>(
        tabId,
        "Page.getFrameTree",
        {},
        child.sessionId,
      );
      trees.push({ sessionId: child.sessionId, tree });
    } catch {
      // the frame went away meanwhile: it is not listed
    }
  }
  // Roots of child sessions hang below the frame that owns them.
  const childRoots = new Map<string, { sessionId: string; tree: FrameTreeNode }[]>();
  for (const t of trees.slice(1)) {
    const parent = t.tree.frame.parentId;
    if (parent === undefined || t.sessionId === undefined) continue;
    const list = childRoots.get(parent) ?? [];
    list.push({ sessionId: t.sessionId, tree: t.tree });
    childRoots.set(parent, list);
  }
  const frames: FrameLocation[] = [];
  const seen = new Set<string>();
  let truncated = false;
  const walk = (node: FrameTreeNode, depth: number, sessionId: string | undefined): void => {
    if (seen.has(node.frame.id)) return;
    if (frames.length >= bounds.maxFrames || depth > bounds.maxDepth) {
      truncated = true;
      return;
    }
    seen.add(node.frame.id);
    frames.push({
      frameId: node.frame.id,
      parentFrameId: node.frame.parentId,
      url: node.frame.url + (node.frame.urlFragment ?? ""),
      loaderId: node.frame.loaderId,
      depth,
      sessionId,
    });
    for (const child of node.childFrames ?? []) {
      // A frame that moved to its own process is listed from its own session.
      if (
        childRoots.has(node.frame.id) &&
        childRoots.get(node.frame.id)?.some((r) => r.tree.frame.id === child.frame.id)
      )
        continue;
      walk(child, depth + 1, sessionId);
    }
    for (const root of childRoots.get(node.frame.id) ?? []) walk(root.tree, depth + 1, root.sessionId);
  };
  walk(frameTree, 0, undefined);
  return { frames, truncated };
}

/** The channel of each session of the tab: the tab itself, or a FrameScope per child session. */
export class FrameChannels {
  private readonly scopes = new Map<string, FrameScope>();

  constructor(
    private readonly cdp: CdpSessions,
    private readonly tabId: number,
    private readonly frames: readonly FrameLocation[],
  ) {}

  /** The channel of the session a frame lives in. */
  forFrame(frameId: string): CdpChannel {
    const frame = this.frames.find((f) => f.frameId === frameId);
    if (!frame) throw new ExtensionError("OPERATION_FAILED", "The frame is no longer in the tab.");
    return this.forSession(frame.sessionId);
  }

  forSession(sessionId: string | undefined): CdpChannel {
    if (sessionId === undefined) return this.cdp;
    let scope = this.scopes.get(sessionId);
    if (!scope) {
      // The child session's root frame and the session of the frame that owns it.
      const root = this.frames.find((f) => f.sessionId === sessionId && f.depth >= 0 && this.isRoot(f));
      if (!root || root.parentFrameId === undefined)
        throw new ExtensionError("OPERATION_FAILED", "The frame is no longer in the tab.");
      const parentSession = this.frames.find((f) => f.frameId === root.parentFrameId)?.sessionId;
      scope = new FrameScope(this.cdp, sessionId, root.frameId, this.forSession(parentSession));
      this.scopes.set(sessionId, scope);
    }
    return scope;
  }

  private isRoot(frame: FrameLocation): boolean {
    const parent = this.frames.find((f) => f.frameId === frame.parentFrameId);
    return parent === undefined || parent.sessionId !== frame.sessionId;
  }
}

type Quad = readonly number[];

/**
 * The channel of one out-of-process frame's session: routes commands and
 * translates coordinates between the frame's viewport and the top-level
 * viewport (see the module comment).
 */
export class FrameScope implements CdpChannel {
  constructor(
    private readonly cdp: CdpSessions,
    private readonly sessionId: string,
    /** Root frame of the session; its owner element lives in the parent. */
    private readonly rootFrameId: string,
    private readonly parent: CdpChannel,
  ) {}

  generation(tabId: number): number {
    return this.cdp.generation(tabId);
  }

  isAttached(tabId: number): boolean {
    return this.cdp.isAttached(tabId);
  }

  async send<T = unknown>(tabId: number, method: string, params: Readonly<Record<string, unknown>> = {}): Promise<T> {
    if (method.startsWith("Input.") || method.startsWith("Page.")) return this.cdp.send<T>(tabId, method, params);
    switch (method) {
      case "DOM.scrollIntoViewIfNeeded": {
        // The element into the frame's view, then exactly that part of the frame into the parent's
        // (a partly visible frame is not enough: the element may sit in its hidden part).
        const result = await this.own<T>(tabId, method, params);
        const owner = await this.owner(tabId);
        let rect: { x: number; y: number; width: number; height: number } | undefined;
        try {
          const { quads } = await this.own<{ quads?: Quad[] }>(tabId, "DOM.getContentQuads", params);
          const { model } = await this.parent.send<{ model: { content: number[]; border: number[] } }>(
            tabId,
            "DOM.getBoxModel",
            { backendNodeId: owner },
          );
          const quad = (quads ?? [])[0];
          if (quad) {
            const xs = [quad[0], quad[2], quad[4], quad[6]] as number[];
            const ys = [quad[1], quad[3], quad[5], quad[7]] as number[];
            const inset = {
              x:
                Math.min(...[0, 2, 4, 6].map((i) => model.content[i] ?? 0)) -
                Math.min(...[0, 2, 4, 6].map((i) => model.border[i] ?? 0)),
              y:
                Math.min(...[1, 3, 5, 7].map((i) => model.content[i] ?? 0)) -
                Math.min(...[1, 3, 5, 7].map((i) => model.border[i] ?? 0)),
            };
            rect = {
              x: Math.min(...xs) + inset.x,
              y: Math.min(...ys) + inset.y,
              width: Math.max(1, Math.max(...xs) - Math.min(...xs)),
              height: Math.max(1, Math.max(...ys) - Math.min(...ys)),
            };
          }
        } catch {
          rect = undefined;
        }
        await this.parent.send(tabId, method, rect ? { backendNodeId: owner, rect } : { backendNodeId: owner });
        return result;
      }
      case "DOM.getContentQuads": {
        const result = await this.own<{ quads?: Quad[] }>(tabId, method, params);
        const offset = await this.offset(tabId);
        return { ...result, quads: (result.quads ?? []).map((q) => shift(q, offset)) } as T;
      }
      case "DOM.getBoxModel": {
        const result = await this.own<{ model: Record<string, unknown> }>(tabId, method, params);
        const offset = await this.offset(tabId);
        const model: Record<string, unknown> = { ...result.model };
        for (const key of ["content", "padding", "border", "margin"]) {
          const quad = model[key];
          if (Array.isArray(quad)) model[key] = shift(quad as number[], offset);
        }
        return { ...result, model } as T;
      }
      case "DOM.getNodeForLocation": {
        // Something in the parent above the frame obscures every point of it.
        const owner = await this.owner(tabId);
        const outer = await this.parent.send<{ backendNodeId?: number }>(tabId, method, params);
        if (outer.backendNodeId !== owner) return { backendNodeId: -1 } as T;
        const offset = await this.offset(tabId);
        const x = Number(params.x) - offset.x;
        const y = Number(params.y) - offset.y;
        return this.own<T>(tabId, method, { ...params, x: Math.round(x), y: Math.round(y) });
      }
      default:
        return this.own<T>(tabId, method, params);
    }
  }

  private own<T>(tabId: number, method: string, params: Readonly<Record<string, unknown>>): Promise<T> {
    return this.cdp.send<T>(tabId, method, params, this.sessionId);
  }

  /** The iframe element of this frame in the parent document. */
  private async owner(tabId: number): Promise<number> {
    const { backendNodeId } = await this.parent.send<{ backendNodeId: number }>(tabId, "DOM.getFrameOwner", {
      frameId: this.rootFrameId,
    });
    return backendNodeId;
  }

  /** Top-left of the owner's content box in top-level viewport coordinates (measured at each use). */
  private async offset(tabId: number): Promise<{ x: number; y: number }> {
    const { model } = await this.parent.send<{ model: { content: number[] } }>(tabId, "DOM.getBoxModel", {
      backendNodeId: await this.owner(tabId),
    });
    const q = model.content;
    return {
      x: Math.min(q[0] ?? 0, q[2] ?? 0, q[4] ?? 0, q[6] ?? 0),
      y: Math.min(q[1] ?? 0, q[3] ?? 0, q[5] ?? 0, q[7] ?? 0),
    };
  }
}

function shift(quad: Quad, offset: { x: number; y: number }): number[] {
  return quad.map((v, i) => (i % 2 === 0 ? v + offset.x : v + offset.y));
}
