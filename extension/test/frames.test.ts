import { describe, expect, it } from "vitest";
import { CdpSessions } from "../src/cdp.js";
import { ExtensionError } from "../src/errors.js";
import { FrameChannels, tabFrames } from "../src/frames.js";
import { hitTest } from "../src/input.js";
import { RefRegistry, verifyRef } from "../src/refs.js";
import { takeSnapshot } from "../src/snapshot.js";
import { FakeChrome } from "./fake-chrome.js";

/**
 * Out-of-process frames (AD-16 point 10): child sessions auto-attached with
 * Target.setAutoAttach, one frame list across sessions, routing and
 * coordinate translation of the frame channel.
 */

const TAB = 1;
const MAIN = "MAIN";
const SAME = "SAME"; // same-process child frame
const OOPIF = "OOPIF"; // cross-site frame in session S1
const NESTED = "NESTED"; // out-of-process frame inside OOPIF, session S2

interface World {
  /** Answers of the tab's own session and of each child session. */
  answer: (method: string, params: Record<string, unknown>, sessionId: string | undefined) => unknown;
}

function setup(world: Partial<World> = {}) {
  const chrome = new FakeChrome();
  chrome.addTab({ id: TAB, url: "https://top.example/" });
  const cdp = new CdpSessions(chrome.api, { setTimer: () => 0, clearTimer: () => undefined });
  chrome.debugger.respond = (tabId, method, params, sessionId) => {
    if (method === "Target.setAutoAttach") {
      // Chromium reports existing frames before answering.
      if (sessionId === undefined) chrome.debugger.attachFrame(tabId, "S1", OOPIF);
      if (sessionId === "S1") chrome.debugger.attachFrame(tabId, "S2", NESTED, "S1");
      return {};
    }
    if (method === "Page.getFrameTree") {
      if (sessionId === undefined)
        return {
          frameTree: {
            frame: { id: MAIN, url: "https://top.example/", loaderId: "L0" },
            childFrames: [{ frame: { id: SAME, parentId: MAIN, url: "about:srcdoc", loaderId: "L1" } }],
          },
        };
      if (sessionId === "S1")
        return { frameTree: { frame: { id: OOPIF, parentId: MAIN, url: "https://pay.example/", loaderId: "L2" } } };
      return { frameTree: { frame: { id: NESTED, parentId: OOPIF, url: "https://ads.example/", loaderId: "L3" } } };
    }
    return world.answer?.(method, params as Record<string, unknown>, sessionId) ?? {};
  };
  return { chrome, cdp };
}

describe("child sessions of out-of-process frames", () => {
  it("auto-attaches once per debugger session, recursively, and lists frames across sessions in tree order", async () => {
    const { chrome, cdp } = setup();
    const { frames, truncated } = await tabFrames(cdp, TAB);
    expect(truncated).toBe(false);
    expect(frames.map((f) => [f.frameId, f.parentFrameId, f.sessionId, f.depth])).toEqual([
      [MAIN, undefined, undefined, 0],
      [SAME, MAIN, undefined, 1],
      [OOPIF, MAIN, "S1", 1],
      [NESTED, OOPIF, "S2", 2],
    ]);
    await tabFrames(cdp, TAB);
    const autoAttach = chrome.debugger.sent.filter((s) => s.method === "Target.setAutoAttach");
    expect(autoAttach.map((s) => s.sessionId)).toEqual([undefined, "S1", "S2"]);
    expect(autoAttach[0]?.params).toEqual({ autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  });

  it("forgets a detached child (and its children); commands for it fail without being sent", async () => {
    const { chrome, cdp } = setup();
    await tabFrames(cdp, TAB);
    chrome.debugger.event(TAB, "Target.detachedFromTarget", { sessionId: "S1" });
    expect((await cdp.frameSessions(TAB)).map((c) => c.sessionId)).toEqual([]);
    const before = chrome.debugger.sent.length;
    await expect(cdp.send(TAB, "DOM.getDocument", {}, "S2")).rejects.toBeInstanceOf(ExtensionError);
    expect(chrome.debugger.sent.length).toBe(before);
  });

  it("a child session's onDetach is not a detach of the tab", async () => {
    const { chrome, cdp } = setup();
    await tabFrames(cdp, TAB);
    const generation = cdp.generation(TAB);
    chrome.debugger.onDetach.emit({ tabId: TAB, sessionId: "S2" }, "target_closed");
    expect(cdp.isAttached(TAB)).toBe(true);
    expect(cdp.generation(TAB)).toBe(generation);
    expect((await cdp.frameSessions(TAB)).map((c) => c.sessionId)).toEqual(["S1"]);
  });

  it("does not forward child-session events to tab listeners, and keeps the allowlist for child sessions", async () => {
    const { chrome, cdp } = setup();
    await tabFrames(cdp, TAB);
    const seen: string[] = [];
    cdp.onEvent((_tab, method) => seen.push(method));
    chrome.debugger.sessionEvent(TAB, "S1", "Page.lifecycleEvent", { name: "load" });
    chrome.debugger.event(TAB, "Page.lifecycleEvent", { name: "load" });
    expect(seen).toEqual(["Page.lifecycleEvent"]);
    await expect(cdp.send(TAB, "Runtime.evaluate", { expression: "1" }, "S1")).rejects.toMatchObject({
      message: "CDP method 'Runtime.evaluate' is not allowed.",
    });
    expect(chrome.debugger.sent.some((s) => s.method.startsWith("Runtime."))).toBe(false);
  });

  it("ignores non-frame targets and attachments from unknown sessions", async () => {
    const { chrome, cdp } = setup();
    await tabFrames(cdp, TAB);
    chrome.debugger.onEvent.emit({ tabId: TAB }, "Target.attachedToTarget", {
      sessionId: "W1",
      targetInfo: { targetId: "W", type: "worker" },
    });
    chrome.debugger.attachFrame(TAB, "X1", "X", "nope");
    expect((await cdp.frameSessions(TAB)).map((c) => c.sessionId)).toEqual(["S1", "S2"]);
  });
});

describe("frame channels", () => {
  /** The OOPIF's owner iframe has its content box at (100, 200); the nested frame's owner at (10, 20) inside it. */
  const answer: World["answer"] = (method, params, sessionId) => {
    if (method === "DOM.getFrameOwner") return { backendNodeId: params.frameId === OOPIF ? 50 : 60 };
    if (method === "DOM.getBoxModel" && sessionId === undefined && params.backendNodeId === 50)
      return {
        model: { content: [100, 200, 300, 200, 300, 400, 100, 400], border: [98, 198, 302, 198, 302, 402, 98, 402] },
      };
    if (method === "DOM.getBoxModel" && sessionId === "S1" && params.backendNodeId === 60)
      return { model: { content: [10, 20, 110, 20, 110, 70, 10, 70], border: [] } };
    if (method === "DOM.getBoxModel")
      return { model: { border: [1, 2, 11, 2, 11, 12, 1, 12], content: [1, 2, 11, 2, 11, 12, 1, 12] } };
    if (method === "DOM.getContentQuads") return { quads: [[1, 2, 11, 2, 11, 12, 1, 12]] };
    // The top-level document is scrolled by 500 px, the OOPIF's document by 30 px: hit tests take document coordinates.
    if (method === "Page.getLayoutMetrics")
      return { cssLayoutViewport: { pageX: 0, pageY: sessionId === undefined ? 500 : sessionId === "S1" ? 30 : 0 } };
    if (method === "DOM.getNodeForLocation") {
      if (sessionId === undefined)
        return { backendNodeId: Number(params.x) > 1000 ? 999 : Number(params.y) >= 500 ? 50 : 998 };
      if (sessionId === "S1") return { backendNodeId: Number(params.y) === 57 ? 60 : 997 };
      return { backendNodeId: 7, at: [params.x, params.y] };
    }
    if (method === "DOM.describeNode") return { node: { localName: "div", attributes: ["id", "banner"] } };
    return {};
  };

  it("translates box models and quads into top-level coordinates through nested frames", async () => {
    const { cdp } = setup({ answer });
    const { frames } = await tabFrames(cdp, TAB);
    const channels = new FrameChannels(cdp, TAB, frames);
    expect(channels.forFrame(MAIN)).toBe(cdp);
    expect(channels.forFrame(SAME)).toBe(cdp);
    const oopif = channels.forFrame(OOPIF);
    const nested = channels.forFrame(NESTED);
    const box = await oopif.send<{ model: { border: number[] } }>(TAB, "DOM.getBoxModel", { backendNodeId: 7 });
    expect(box.model.border).toEqual([101, 202, 111, 202, 111, 212, 101, 212]);
    const quads = await nested.send<{ quads: number[][] }>(TAB, "DOM.getContentQuads", { backendNodeId: 7 });
    expect(quads.quads[0]).toEqual([111, 222, 121, 222, 121, 232, 111, 232]);
  });

  it("routes Input and Page to the tab's own session, DOM and Accessibility to the frame's session", async () => {
    const { chrome, cdp } = setup({ answer });
    const { frames } = await tabFrames(cdp, TAB);
    const oopif = new FrameChannels(cdp, TAB, frames).forFrame(OOPIF);
    chrome.debugger.sent.length = 0;
    await oopif.send(TAB, "Input.insertText", { text: "x" });
    await oopif.send(TAB, "Page.getLayoutMetrics");
    await oopif.send(TAB, "DOM.focus", { backendNodeId: 7 });
    await oopif.send(TAB, "Accessibility.getPartialAXTree", { backendNodeId: 7 });
    expect(chrome.debugger.sent.map((s) => [s.method, s.sessionId])).toEqual([
      ["Input.insertText", undefined],
      ["Page.getLayoutMetrics", undefined],
      ["DOM.focus", "S1"],
      ["Accessibility.getPartialAXTree", "S1"],
    ]);
  });

  it("hit-tests the owner in the parent first, then the frame in its own document coordinates (scroll offsets added)", async () => {
    const { cdp } = setup({ answer });
    const { frames } = await tabFrames(cdp, TAB);
    const nested = new FrameChannels(cdp, TAB, frames).forFrame(NESTED);
    // Top-level (116, 227) + scroll 500 hits the OOPIF's owner; in the OOPIF (16, 27) + scroll 30 hits the
    // nested frame's owner; in the nested frame (6, 7).
    const hit = await hitTest(nested, TAB, { x: 116, y: 227 });
    expect(hit).toEqual({ backendNodeId: 7, at: [6, 7] });
    // Something else in the top-level document covers the point: obscured, and what covers it is named.
    const covered = await hitTest(nested, TAB, { x: 2000, y: 227 });
    expect(covered).toEqual({ backendNodeId: -1, coveredBy: "covered by div#banner" });
  });

  it("scrolls the element into the frame's view, then exactly its part of the frame into the parent's", async () => {
    const { chrome, cdp } = setup({ answer });
    const { frames } = await tabFrames(cdp, TAB);
    const oopif = new FrameChannels(cdp, TAB, frames).forFrame(OOPIF);
    chrome.debugger.sent.length = 0;
    await oopif.send(TAB, "DOM.scrollIntoViewIfNeeded", { backendNodeId: 7 });
    expect(
      chrome.debugger.sent.filter((s) => s.method === "DOM.scrollIntoViewIfNeeded").map((s) => [s.sessionId, s.params]),
    ).toEqual([
      ["S1", { backendNodeId: 7 }],
      // The element's rect (1,2 10x10 in the frame) relative to the iframe's border box (2 px border).
      [undefined, { backendNodeId: 50, rect: { x: 3, y: 4, width: 10, height: 10 } }],
    ]);
  });
});

describe("refs and snapshots across processes", () => {
  const ax = (frame: string) => ({
    nodes: [
      { nodeId: "1", role: { value: "RootWebArea" }, childIds: ["2"], backendDOMNodeId: 1 },
      {
        nodeId: "2",
        parentId: "1",
        role: { value: "button" },
        name: { value: "Pay in " + frame },
        backendDOMNodeId: 7,
      },
    ],
  });
  const answer: World["answer"] = (method, params, sessionId) => {
    if (method === "Accessibility.getFullAXTree")
      return params.frameId === SAME ? { nodes: [] } : ax(String(params.frameId));
    if (method === "DOM.getFrameOwner")
      return { backendNodeId: params.frameId === OOPIF ? 50 : params.frameId === NESTED ? 60 : 40 };
    if (method === "DOM.getBoxModel" && sessionId === undefined && params.backendNodeId === 50)
      return { model: { content: [100, 200, 300, 200, 300, 400, 100, 400], border: [] } };
    if (method === "DOM.getBoxModel" && sessionId === "S1" && params.backendNodeId === 60)
      return { model: { content: [10, 20, 110, 20, 110, 70, 10, 70], border: [] } };
    if (method === "DOM.getBoxModel")
      return { model: { border: [1, 2, 11, 2, 11, 12, 1, 12], content: [1, 2, 11, 2, 11, 12, 1, 12] } };
    if (method === "Page.getLayoutMetrics") return { cssVisualViewport: { clientWidth: 1000, clientHeight: 800 } };
    if (method === "DOM.getDocument") {
      const frameId = sessionId === undefined ? MAIN : sessionId === "S1" ? OOPIF : NESTED;
      return { root: { backendNodeId: 1, frameId, children: [{ backendNodeId: 7 }] } };
    }
    return {};
  };

  it("lists every frame with its origin and gives elements of out-of-process frames refs and top-level bounds", async () => {
    const { cdp } = setup({ answer });
    const registry = new RefRegistry();
    const snap = await takeSnapshot(
      cdp,
      registry,
      { id: TAB, url: "https://top.example/", title: "Top" },
      { includeText: false, maxElements: 100 },
    );
    expect(snap.frames.map((f) => [f.parentFrameRef, f.origin, f.restricted])).toEqual([
      [null, "https://top.example", false],
      ["f1", "https://top.example", false],
      ["f1", "https://pay.example", false],
      ["f3", "https://ads.example", false],
    ]);
    expect(snap.elements.map((e) => [e.ref, e.frameRef, e.name, e.bounds])).toEqual([
      ["e1", "f1", "Pay in MAIN", { x: 1, y: 2, width: 10, height: 10 }],
      ["e2", "f3", "Pay in OOPIF", { x: 101, y: 202, width: 10, height: 10 }],
      ["e3", "f4", "Pay in NESTED", { x: 111, y: 222, width: 10, height: 10 }],
    ]);
    // A ref of the nested frame resolves to that frame's channel; after the frame's session ends it is stale.
    const target = await verifyRef(registry, cdp, "e3", TAB);
    expect(target.frameId).toBe(NESTED);
    expect(target.channel).not.toBe(cdp);
  });

  it("a ref of an out-of-process frame becomes stale when its session ends or its document changes", async () => {
    const { chrome, cdp } = setup({ answer });
    const registry = new RefRegistry();
    await takeSnapshot(
      cdp,
      registry,
      { id: TAB, url: "https://top.example/", title: "Top" },
      { includeText: false, maxElements: 100 },
    );
    chrome.debugger.event(TAB, "Target.detachedFromTarget", { sessionId: "S2" });
    await expect(verifyRef(registry, cdp, "e3", TAB)).rejects.toMatchObject({ code: "BROWSER_STALE_REF" });
    // The OOPIF navigated: new loader id.
    const original = chrome.debugger.respond;
    chrome.debugger.respond = (tabId, method, params, sessionId) =>
      method === "Page.getFrameTree" && sessionId === "S1"
        ? { frameTree: { frame: { id: OOPIF, parentId: MAIN, url: "https://pay.example/next", loaderId: "L9" } } }
        : original(tabId, method, params, sessionId);
    await expect(verifyRef(registry, cdp, "e2", TAB)).rejects.toMatchObject({ code: "BROWSER_STALE_REF" });
    await expect(verifyRef(registry, cdp, "e1", TAB)).resolves.toMatchObject({ frameId: MAIN });
  });
});
