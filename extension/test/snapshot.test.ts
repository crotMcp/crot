import { describe, expect, it } from "vitest";
import { CdpSessions } from "../src/cdp.js";
import { ExtensionError } from "../src/errors.js";
import { RefRegistry, STALE_MESSAGE, isConnected, refParam, verifyFrameRef, verifyRef } from "../src/refs.js";
import {
  dialogsFirst,
  frameOrigin,
  inTreeOrder,
  intersectsViewport,
  quadBounds,
  statesOf,
  takeSnapshot,
  type AxNode,
} from "../src/snapshot.js";
import { FakeChrome } from "./fake-chrome.js";

async function failure(promise: Promise<unknown>): Promise<ExtensionError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ExtensionError);
  return error as ExtensionError;
}

const ax = (
  nodeId: string,
  role: string,
  name: string,
  extra: Partial<AxNode> & { childIds?: string[] } = {},
): AxNode => ({ nodeId, role: { value: role }, name: { value: name }, ...extra });

/**
 * A page: main frame (https://a.test) with heading text, a link, a password
 * field, a text field with a value, an iframe (child frame, https://b.test)
 * holding a button, then a checkbox after the iframe; plus a restricted frame.
 */
class Page {
  loader = { main: "L1", child: "C1" };
  removed = new Set<number>();
  readonly chrome = new FakeChrome();

  constructor() {
    this.chrome.addTab({ id: 7, url: "https://a.test/", title: "A" });
    this.chrome.debugger.respond = (_tab, method, params) => this.answer(method, params as Record<string, unknown>);
  }

  answer(method: string, params: Record<string, unknown>): unknown {
    switch (method) {
      case "Page.getFrameTree":
        return {
          frameTree: {
            frame: { id: "M", url: "https://a.test/", loaderId: this.loader.main },
            childFrames: [
              { frame: { id: "C", parentId: "M", url: "https://b.test/inner", loaderId: this.loader.child } },
              { frame: { id: "R", parentId: "M", url: "chrome-extension://x/y", loaderId: "R1" } },
              { frame: { id: "S", parentId: "M", url: "about:srcdoc", loaderId: "S1" } },
            ],
          },
        };
      case "DOM.getFrameOwner":
        return params.frameId === "C" ? { backendNodeId: 50 } : Promise.reject(new Error("no owner"));
      case "Page.getLayoutMetrics":
        return { cssVisualViewport: { clientWidth: 800, clientHeight: 600 } };
      case "Accessibility.getFullAXTree":
        if (params.frameId === "M")
          return {
            nodes: [
              ax("1", "RootWebArea", "A", { childIds: ["2", "3", "4", "5", "6", "7", "8"], backendDOMNodeId: 1 }),
              ax("2", "StaticText", "Hello", { parentId: "1", backendDOMNodeId: 10 }),
              ax("3", "link", "Home", { parentId: "1", backendDOMNodeId: 11 }),
              ax("4", "textbox", "Password", { parentId: "1", backendDOMNodeId: 12, value: { value: "hunter2" } }),
              ax("5", "textbox", "Name", {
                parentId: "1",
                backendDOMNodeId: 13,
                value: { value: "Ann" },
                properties: [
                  { name: "required", value: { value: true } },
                  { name: "editable", value: { value: "plaintext" } },
                ],
              }),
              ax("6", "Iframe", "", { parentId: "1", backendDOMNodeId: 50 }),
              ax("7", "checkbox", "Agree", {
                parentId: "1",
                backendDOMNodeId: 14,
                properties: [{ name: "checked", value: { value: "false" } }],
              }),
              ax("8", "button", "Hidden", { parentId: "1", backendDOMNodeId: 15, ignored: true }),
            ],
          };
        if (params.frameId === "C")
          return {
            nodes: [
              ax("1", "RootWebArea", "B", { childIds: ["2"], backendDOMNodeId: 100 }),
              ax("2", "button", "Inner", { parentId: "1", backendDOMNodeId: 101 }),
            ],
          };
        return { nodes: [] };
      case "DOM.getBoxModel": {
        const id = params.backendNodeId as number;
        if (id === 14) return { model: { border: [10, 900, 30, 900, 30, 920, 10, 920] } }; // below the fold
        return { model: { border: [id, 10, id + 20, 10, id + 20, 30, id, 30] } };
      }
      case "DOM.describeNode":
        return params.backendNodeId === 12
          ? { node: { localName: "input", attributes: ["type", "password", "name", "pw"] } }
          : { node: { localName: "input", attributes: ["type", "text"] } };
      case "DOM.getDocument":
        return {
          root: {
            backendNodeId: 0,
            frameId: "M",
            children: [
              ...[1, 10, 11, 12, 13, 14, 15].filter((id) => !this.removed.has(id)).map((id) => ({ backendNodeId: id })),
              {
                backendNodeId: 50,
                contentDocument: { backendNodeId: 99, frameId: "C", children: [{ backendNodeId: 101 }] },
              },
            ],
          },
        };
      default:
        return {};
    }
  }
}

const setup = () => {
  const page = new Page();
  const cdp = new CdpSessions(page.chrome.api, { setTimer: () => 0, clearTimer: () => undefined });
  const registry = new RefRegistry();
  const snap = (options: Partial<{ frameRef: string; includeText: boolean; maxElements: number }> = {}) =>
    takeSnapshot(
      cdp,
      registry,
      { id: 7, url: "https://a.test/", title: "A" },
      {
        includeText: false,
        maxElements: 500,
        ...options,
      },
    );
  return { page, cdp, registry, snap };
};

describe("snapshot helpers", () => {
  it("normalizes frame origins (AD-16 point 10)", () => {
    expect(frameOrigin("https://a.test:443/x?q", undefined)).toBe("https://a.test");
    expect(frameOrigin("about:blank", "https://a.test")).toBe("https://a.test");
    expect(frameOrigin("about:srcdoc", "https://a.test")).toBe("https://a.test");
    expect(frameOrigin("chrome://settings", "https://a.test")).toBeNull();
    expect(frameOrigin("data:text/html,x", "https://a.test")).toBeNull();
  });

  it("reads states, bounds and viewport intersection", () => {
    expect(
      statesOf(
        ax("1", "checkbox", "x", {
          properties: [
            { name: "checked", value: { value: "mixed" } },
            { name: "disabled", value: { value: true } },
            { name: "editable", value: { value: "richtext" } },
            { name: "level", value: { value: 2 } },
          ],
        }),
      ),
    ).toEqual({ checked: "mixed", disabled: true, editable: true });
    expect(quadBounds([1, 2, 11, 2, 11, 7, 1, 7])).toEqual({ x: 1, y: 2, width: 10, height: 5 });
    expect(quadBounds([1, 2])).toBeNull();
    expect(intersectsViewport({ x: 790, y: 0, width: 20, height: 5 }, { width: 800, height: 600 })).toBe(true);
    expect(intersectsViewport({ x: 0, y: 600, width: 20, height: 5 }, { width: 800, height: 600 })).toBe(false);
    expect(intersectsViewport({ x: 0, y: 0, width: 0, height: 5 }, { width: 800, height: 600 })).toBe(false);
  });

  it("orders the accessibility tree depth-first from the root", () => {
    const nodes = [
      ax("3", "b", "", { parentId: "1" }),
      ax("1", "root", "", { childIds: ["2", "3"] }),
      ax("2", "a", "", { parentId: "1", childIds: ["4"] }),
      ax("4", "c", "", { parentId: "2" }),
    ];
    expect(inTreeOrder(nodes).map((n) => n.nodeId)).toEqual(["1", "2", "4", "3"]);
  });
});

describe("browser_snapshot (AD-16 point 5)", () => {
  it("lists frames and interactive elements of all frames in document order", async () => {
    const { snap } = setup();
    const result = await snap();
    expect(result.frames.map((f) => [f.parentFrameRef, f.url, f.origin, f.restricted])).toEqual([
      [null, "https://a.test/", "https://a.test", false],
      ["f1", "https://b.test/inner", "https://b.test", false],
      ["f1", "chrome-extension://x/y", null, true],
      ["f1", "about:srcdoc", "https://a.test", false],
    ]);
    // The child frame's button sits where its iframe is, before the checkbox.
    expect(result.elements.map((e) => [e.role, e.name, e.frameRef])).toEqual([
      ["link", "Home", "f1"],
      ["textbox", "Password", "f1"],
      ["textbox", "Name", "f1"],
      ["button", "Inner", "f2"],
      ["checkbox", "Agree", "f1"],
    ]);
    expect(result.truncated).toBe(false);
    const checkbox = result.elements[4];
    expect(checkbox?.states).toEqual({ checked: false });
    expect(checkbox?.inViewport).toBe(false);
    expect(result.elements[0]?.bounds).toEqual({ x: 11, y: 10, width: 20, height: 20 });
    expect(result.elements[0]?.inViewport).toBe(true);
  });

  it("never returns password values, only hasValue", async () => {
    const { snap } = setup();
    const result = await snap();
    const password = result.elements[1];
    expect(password).toMatchObject({ name: "Password", hasValue: true });
    expect(password && "value" in password).toBe(false);
    expect(JSON.stringify(result)).not.toContain("hunter2");
    expect(result.elements[2]).toMatchObject({ value: "Ann", states: { required: true, editable: true } });
  });

  it("keeps the same refs for the same document and makes new ones for a new document", async () => {
    const { snap, page } = setup();
    const first = await snap();
    const second = await snap();
    expect(second.elements.map((e) => e.ref)).toEqual(first.elements.map((e) => e.ref));
    expect(new Set(first.elements.map((e) => e.ref)).size).toBe(first.elements.length);
    page.loader.main = "L2";
    const third = await snap();
    expect(third.elements[0]?.ref).not.toBe(first.elements[0]?.ref);
  });

  it("adds visible text with includeText and bounds the element count", async () => {
    const { snap } = setup();
    const withText = await snap({ includeText: true });
    expect(withText.elements[0]).toMatchObject({ role: "text", name: "Hello" });
    const cut = await snap({ maxElements: 2 });
    expect(cut.elements).toHaveLength(2);
    expect(cut.truncated).toBe(true);
  });

  it("limits the snapshot to one frame with frameRef", async () => {
    const { snap } = setup();
    const all = await snap();
    const inner = all.frames[1]?.frameRef as string;
    const one = await snap({ frameRef: inner });
    expect(one.elements.map((e) => e.name)).toEqual(["Inner"]);
  });
});

describe("element references: check before acting", () => {
  it("accepts a current ref and validates its format", async () => {
    const { snap, cdp, registry } = setup();
    const { elements } = await snap();
    const target = await verifyRef(registry, cdp, elements[0]?.ref as string, 7);
    expect(target).toMatchObject({ tabId: 7, frameId: "M", backendNodeId: 11 });
    expect(() => refParam("x1")).toThrow(ExtensionError);
    expect(() => refParam("e0")).toThrow(ExtensionError);
    expect(refParam("e12")).toBe("e12");
  });

  it("is stale for another tab, an unknown ref and another connection's registry", async () => {
    const { snap, cdp, registry } = setup();
    const ref = (await snap()).elements[0]?.ref as string;
    expect((await failure(verifyRef(registry, cdp, ref, 8))).code).toBe("BROWSER_STALE_REF");
    expect((await failure(verifyRef(registry, cdp, "e999", 7))).code).toBe("BROWSER_STALE_REF");
    expect((await failure(verifyRef(new RefRegistry(), cdp, ref, 7))).code).toBe("BROWSER_STALE_REF");
  });

  it("is stale after navigation or reload (new document of the frame)", async () => {
    const { snap, cdp, registry, page } = setup();
    const { elements } = await snap();
    const inMain = elements[0]?.ref as string;
    const inChild = elements[3]?.ref as string;
    page.loader.child = "C2";
    const error = await failure(verifyRef(registry, cdp, inChild, 7));
    expect(error.code).toBe("BROWSER_STALE_REF");
    expect(error.message).toBe(STALE_MESSAGE);
    await verifyRef(registry, cdp, inMain, 7);
    page.loader.main = "L2";
    expect((await failure(verifyRef(registry, cdp, inMain, 7))).code).toBe("BROWSER_STALE_REF");
  });

  it("is stale when the element was removed", async () => {
    const { snap, cdp, registry, page } = setup();
    const ref = (await snap()).elements[0]?.ref as string;
    page.removed.add(11);
    expect((await failure(verifyRef(registry, cdp, ref, 7))).code).toBe("BROWSER_STALE_REF");
  });

  it("is stale after the debugger was detached and stays stale after re-attach", async () => {
    const { snap, cdp, registry, page } = setup();
    const ref = (await snap()).elements[0]?.ref as string;
    page.chrome.debugger.userDetach(7);
    expect((await failure(verifyRef(registry, cdp, ref, 7))).code).toBe("BROWSER_STALE_REF");
    await cdp.attach(7);
    expect((await failure(verifyRef(registry, cdp, ref, 7))).code).toBe("BROWSER_STALE_REF");
  });

  it("is stale when the tab closed, also for frame refs", async () => {
    const { snap, cdp, registry, page } = setup();
    const result = await snap();
    const ref = result.elements[0]?.ref as string;
    const frameRef = result.frames[1]?.frameRef as string;
    await verifyFrameRef(registry, cdp, frameRef, 7);
    await page.chrome.api.tabs.remove(7);
    registry.forgetTab(7);
    expect((await failure(verifyRef(registry, cdp, ref, 7))).code).toBe("BROWSER_STALE_REF");
    expect((await failure(verifyFrameRef(registry, cdp, frameRef, 7))).code).toBe("BROWSER_STALE_REF");
  });

  it("refuses a stale frameRef in a snapshot", async () => {
    const { snap, page } = setup();
    const frameRef = (await snap()).frames[1]?.frameRef as string;
    page.loader.child = "C2";
    expect((await failure(snap({ frameRef }))).code).toBe("BROWSER_STALE_REF");
  });

  it("forgets the oldest refs beyond its bound", () => {
    const registry = new RefRegistry(2);
    const t = (n: number) => ({ tabId: 1, frameId: "M", loaderId: "L", backendNodeId: n, generation: 0 });
    const a = registry.refFor(t(1));
    registry.refFor(t(2));
    registry.refFor(t(3));
    expect(registry.size).toBe(2);
    expect(registry.lookup(a)).toBeUndefined();
  });
});

describe("dialogs first and same-process frame documents", () => {
  it("orders the subtree of an open dialog before the rest; ignored dialogs change nothing", () => {
    const node = (nodeId: string, role: string, childIds: string[] = [], ignored = false): AxNode => ({
      nodeId,
      role: { value: role },
      childIds,
      ...(ignored ? { ignored: true } : {}),
    });
    const ordered = [
      node("1", "RootWebArea", ["2", "3", "5"]),
      node("2", "button"),
      node("3", "dialog", ["4"]),
      node("4", "button"),
      node("5", "dialog", ["6"], true),
      node("6", "button"),
    ];
    expect(dialogsFirst(ordered).map((n) => n.nodeId)).toEqual(["3", "4", "1", "2", "5", "6"]);
    expect(dialogsFirst(ordered.filter((n) => n.nodeId !== "3")).map((n) => n.nodeId)).toEqual([
      "1",
      "2",
      "4",
      "5",
      "6",
    ]);
  });

  it("finds a same-process frame's nodes below its owner's contentDocument (the owner carries the frame id too)", async () => {
    const chrome = new FakeChrome();
    chrome.addTab({ id: 1, url: "https://a.test/" });
    chrome.debugger.respond = () => ({
      root: {
        backendNodeId: 1,
        children: [
          {
            backendNodeId: 2,
            frameId: "MAIN",
            children: [
              {
                backendNodeId: 3,
                frameId: "CHILD",
                contentDocument: { backendNodeId: 4, children: [{ backendNodeId: 5, frameId: "CHILD" }] },
              },
            ],
          },
        ],
      },
    });
    const cdp = new CdpSessions(chrome.api, { setTimer: () => 0, clearTimer: () => undefined });
    expect(await isConnected(cdp, 1, "CHILD", 5)).toBe(true);
    expect(await isConnected(cdp, 1, "MAIN", 3)).toBe(true);
    // A node of the child frame is not part of the main frame's document.
    expect(await isConnected(cdp, 1, "MAIN", 5)).toBe(false);
  });
});
