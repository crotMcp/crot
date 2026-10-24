import { describe, expect, it } from "vitest";
import { CdpSessions } from "../src/cdp.js";
import { ExtensionError } from "../src/errors.js";
import {
  actionablePoint,
  chooseOptions,
  clickAt,
  keySequenceParam,
  parseCombination,
  pressCombination,
  selectInto,
  setChecked,
  typeInto,
} from "../src/input.js";
import { FakeChrome } from "./fake-chrome.js";

const linux = { mac: false };
const mac = { mac: true };

async function failure(promise: Promise<unknown>): Promise<ExtensionError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ExtensionError);
  return error as ExtensionError;
}

/** Node 1 = document, 2 = button (child 3 = span), 4 = overlay, 5 = input, 6 = iframe, 7 = node in the frame. */
class Page {
  quads: Record<number, number[][]> = {
    2: [[10, 10, 30, 10, 30, 30, 10, 30]],
    5: [[100, 10, 200, 10, 200, 30, 100, 30]],
    7: [[300, 300, 320, 300, 320, 320, 300, 320]],
  };
  hit: (x: number, y: number) => number = (x) => (x < 50 ? 3 : x < 250 ? 5 : 6);
  ax: Record<number, { role: string; value?: string; properties?: { name: string; value: { value: unknown } }[] }> = {
    2: { role: "button" },
    5: { role: "textbox", properties: [{ name: "editable", value: { value: "plaintext" } }] },
    7: { role: "checkbox", properties: [{ name: "checked", value: { value: "false" } }] },
  };
  readonly chrome = new FakeChrome();

  constructor() {
    this.chrome.addTab({ id: 1, url: "https://a.test/", title: "A" });
    this.chrome.debugger.respond = (_t, method, p) => this.answer(method, (p ?? {}) as Record<string, unknown>);
  }

  answer(method: string, p: Record<string, unknown>): unknown {
    switch (method) {
      case "DOM.getContentQuads":
        return { quads: this.quads[p.backendNodeId as number] ?? [] };
      case "Page.getLayoutMetrics":
        return {
          cssVisualViewport: { clientWidth: 800, clientHeight: 600 },
          cssLayoutViewport: { pageX: this.scroll.x, pageY: this.scroll.y },
        };
      case "DOM.getNodeForLocation":
        return { backendNodeId: this.hit(p.x as number, p.y as number) };
      case "Accessibility.getPartialAXTree": {
        const id = p.backendNodeId as number;
        const node = this.ax[id];
        return {
          nodes: node
            ? [
                {
                  backendDOMNodeId: id,
                  role: { value: node.role },
                  ...(node.value === undefined ? {} : { value: { value: node.value } }),
                  properties: node.properties ?? [],
                },
              ]
            : [],
        };
      }
      case "DOM.describeNode":
        if (p.backendNodeId === 6) return { node: { backendNodeId: 6, localName: "iframe" } };
        if (p.backendNodeId === 9)
          return {
            node: {
              backendNodeId: 9,
              localName: "select",
              attributes: this.multiple ? ["multiple", ""] : [],
              children: [
                {
                  backendNodeId: 10,
                  localName: "option",
                  attributes: ["value", "a"],
                  children: [{ nodeName: "#text", nodeValue: " Apple " }],
                },
                { backendNodeId: 11, localName: "option", attributes: ["value", "b", "disabled", ""], children: [] },
                {
                  backendNodeId: 12,
                  localName: "optgroup",
                  attributes: [],
                  children: [
                    {
                      backendNodeId: 13,
                      localName: "option",
                      attributes: ["value", "c"],
                      children: [{ nodeName: "#text", nodeValue: "Cherry" }],
                    },
                  ],
                },
              ],
            },
          };
        if (p.backendNodeId === 3) return { node: { backendNodeId: 3, nodeType: 3, nodeName: "#text" } };
        if (p.backendNodeId === 4)
          return { node: { backendNodeId: 4, nodeType: 1, localName: "div", attributes: ["id", "overlay"] } };
        return { node: { backendNodeId: p.backendNodeId, localName: "div" } };
      case "DOM.getDocument":
        return {
          root: {
            backendNodeId: 1,
            children: [
              {
                backendNodeId: 2,
                pseudoElements: [{ backendNodeId: 20 }],
                children: [{ backendNodeId: 3, pseudoElements: [{ backendNodeId: 30 }] }],
              },
              { backendNodeId: 4, pseudoElements: [{ backendNodeId: 40 }] },
              { backendNodeId: 5 },
              {
                backendNodeId: 9,
                children: [
                  { backendNodeId: 10 },
                  { backendNodeId: 11 },
                  { backendNodeId: 12, children: [{ backendNodeId: 13 }] },
                ],
              },
              { backendNodeId: 6, contentDocument: { backendNodeId: 60, children: [{ backendNodeId: 7 }] } },
            ],
          },
        };
      default:
        return {};
    }
  }

  multiple = false;
  scroll = { x: 0, y: 0 };

  get sent() {
    return this.chrome.debugger.sent;
  }

  input() {
    return this.sent.filter((s) => s.method.startsWith("Input."));
  }
}

const setup = () => {
  const page = new Page();
  const cdp = new CdpSessions(page.chrome.api, { setTimer: () => 0, clearTimer: () => undefined });
  return { page, cdp };
};

describe("actionability (AD-16 point 6)", () => {
  it("scrolls into view and returns the centre when the element or a descendant is hit", async () => {
    const { page, cdp } = setup();
    expect(await actionablePoint(cdp, 1, 2)).toEqual({ x: 20, y: 20 });
    expect(page.sent.map((s) => s.method)).toContain("DOM.scrollIntoViewIfNeeded");
  });

  it("accepts own and descendant pseudo-elements, never an unrelated overlay's pseudo-element", async () => {
    const { page, cdp } = setup();
    for (const id of [20, 30]) {
      page.hit = () => id;
      expect(await actionablePoint(cdp, 1, 2)).toEqual({ x: 20, y: 20 });
    }
    page.hit = () => 40;
    expect((await failure(actionablePoint(cdp, 1, 2))).code).toBe("INVALID_INPUT");
  });

  it("accepts a hit on the owner of the element's frame", async () => {
    const { cdp } = setup();
    expect(await actionablePoint(cdp, 1, 7)).toEqual({ x: 310, y: 310 });
  });

  it("refuses obscured, invisible, off-viewport and disabled elements and dispatches nothing", async () => {
    const { page, cdp } = setup();
    page.hit = () => 4;
    expect((await failure(actionablePoint(cdp, 1, 2))).message).toContain("obscured");
    page.hit = () => 1; // an ancestor that is not a frame owner
    expect((await failure(actionablePoint(cdp, 1, 2))).message).toContain("obscured");
    page.hit = () => 3;
    page.quads[2] = [[10, 10, 10, 10, 10, 10, 10, 10]];
    expect((await failure(actionablePoint(cdp, 1, 2))).message).toContain("not visible");
    page.quads[2] = [[900, 10, 920, 10, 920, 30, 900, 30]];
    expect((await failure(actionablePoint(cdp, 1, 2))).message).toContain("not visible");
    page.quads[2] = [[10, 10, 30, 10, 30, 30, 10, 30]];
    page.ax[2] = { role: "button", properties: [{ name: "disabled", value: { value: true } }] };
    const error = await failure(actionablePoint(cdp, 1, 2));
    expect(error.code).toBe("INVALID_INPUT");
    expect(error.message).toContain("disabled");
    // At most a wheel step that tried to scroll the covered element clear: never a press or a move.
    expect(page.input().filter((s) => (s.params as { type?: string }).type !== "mouseWheel")).toHaveLength(0);
  });

  it("scrolls a covered element towards the viewport centre once, then acts; names what keeps covering it", async () => {
    const { page, cdp } = setup();
    const wheeled = () => page.input().some((s) => (s.params as { type?: string }).type === "mouseWheel");
    page.hit = () => (wheeled() ? 3 : 4);
    expect(await actionablePoint(cdp, 1, 2)).toEqual({ x: 20, y: 20 });
    const wheels = page
      .input()
      .map((s) => s.params as Record<string, unknown>)
      .filter((p) => p.type === "mouseWheel");
    expect(wheels).toEqual([{ type: "mouseWheel", x: 20, y: 20, deltaX: 0, deltaY: -280 }]);
    page.hit = () => 4;
    const error = await failure(actionablePoint(cdp, 1, 2));
    expect(error.message).toBe("The element is not actionable: obscured (covered by div#overlay).");
  });

  it("rechecks coverage, position and disabled state after hover and never presses a changed target", async () => {
    for (const change of ["position", "covered", "disabled"] as const) {
      const { page, cdp } = setup();
      const answer = page.answer.bind(page);
      page.chrome.debugger.respond = (_tab, method, params) => {
        if (method === "Input.dispatchMouseEvent" && (params as { type?: string })?.type === "mouseMoved") {
          if (change === "position") page.quads[2] = [[50, 10, 70, 10, 70, 30, 50, 30]];
          if (change === "covered") page.hit = () => 4;
          if (change === "disabled")
            page.ax[2] = { role: "button", properties: [{ name: "disabled", value: { value: true } }] };
        }
        return answer(method, params as Record<string, unknown>);
      };
      const error = await failure(actionablePoint(cdp, 1, 2));
      expect(error.code).toBe("INVALID_INPUT");
      expect(page.input().every((s) => (s.params as { type: string }).type !== "mousePressed")).toBe(true);
    }
  });

  it("hit-tests in document coordinates: the scroll offset is added to the viewport point", async () => {
    const { page, cdp } = setup();
    page.scroll = { x: 0, y: 1000 };
    page.hit = (_x, y) => (y >= 1000 ? 3 : 4);
    expect(await actionablePoint(cdp, 1, 2)).toEqual({ x: 20, y: 20 });
    expect(page.sent.find((s) => s.method === "DOM.getNodeForLocation")?.params).toMatchObject({ x: 20, y: 1020 });
  });

  it("accepts the parent element as the hit of a text node (hit tests never return text nodes)", async () => {
    const { page, cdp } = setup();
    page.quads[3] = [[12, 12, 28, 12, 28, 28, 12, 28]];
    page.hit = () => 2;
    expect(await actionablePoint(cdp, 1, 3, { requireEnabled: false })).toEqual({ x: 20, y: 20 });
  });
});

describe("pointer input", () => {
  it("clicks with button, click count and modifiers as trusted mouse events", async () => {
    const { page, cdp } = setup();
    await clickAt(cdp, 1, { x: 5, y: 6 }, { button: "right", clickCount: 2, modifiers: ["Shift", "Control"] });
    const events = page.input().map((s) => s.params as Record<string, unknown>);
    expect(events.map((e) => [e.type, e.clickCount])).toEqual([
      ["mouseMoved", undefined],
      ["mousePressed", 1],
      ["mouseReleased", 1],
      ["mousePressed", 2],
      ["mouseReleased", 2],
    ]);
    expect(events[1]).toMatchObject({ button: "right", buttons: 2, modifiers: 10, x: 5, y: 6 });
  });
});

describe("keys", () => {
  it("parses the fixed notation", () => {
    expect(parseCombination("Enter", linux)).toMatchObject({ modifiers: [], key: { key: "Enter", keyCode: 13 } });
    expect(parseCombination("Control+Shift+a", linux)).toMatchObject({
      modifiers: ["Control", "Shift"],
      key: { key: "a", code: "KeyA", keyCode: 65 },
    });
    expect(parseCombination("ControlOrMeta+c", mac).modifiers).toEqual(["Meta"]);
    expect(parseCombination("ControlOrMeta+c", linux).modifiers).toEqual(["Control"]);
    expect(parseCombination("+", linux).key?.key).toBe("+");
    expect(parseCombination("Shift++", linux)).toMatchObject({ modifiers: ["Shift"], key: { key: "+" } });
    expect(parseCombination("F12", linux).key?.keyCode).toBe(123);
    expect(parseCombination("Shift", linux)).toEqual({ modifiers: ["Shift"], key: undefined });
    for (const bad of ["", "Ctrl+a", "a+b", "Enterr", "Shift+Shift+a", "Control+", "x".repeat(65)]) {
      expect(() => parseCombination(bad, linux)).toThrow(ExtensionError);
    }
  });

  it("bounds sequences to 32 combinations", () => {
    expect(keySequenceParam("Tab", linux)).toHaveLength(1);
    expect(keySequenceParam(Array(32).fill("Tab"), linux)).toHaveLength(32);
    expect(() => keySequenceParam(Array(33).fill("Tab"), linux)).toThrow(ExtensionError);
    expect(() => keySequenceParam([], linux)).toThrow(ExtensionError);
  });

  it("presses modifiers around the key; shortcuts produce no text", async () => {
    const { page, cdp } = setup();
    await cdp.attach(1);
    await pressCombination(cdp, 1, parseCombination("Control+a", linux));
    const events = page.input().map((s) => s.params as Record<string, unknown>);
    expect(events.map((e) => [e.type, e.key, e.modifiers])).toEqual([
      ["rawKeyDown", "Control", 2],
      ["rawKeyDown", "a", 2],
      ["keyUp", "a", 2],
      ["keyUp", "Control", 0],
    ]);
    expect(events.some((e) => "text" in e)).toBe(false);
    page.sent.length = 0;
    await pressCombination(cdp, 1, parseCombination("Shift+a", linux));
    expect(page.input()[1]?.params).toMatchObject({ type: "keyDown", text: "A", modifiers: 8 });
  });
});

describe("typing", () => {
  it("clicks, focuses, clears and inserts text, then submits", async () => {
    const { page, cdp } = setup();
    await typeInto(cdp, 1, 5, "hello", { ...linux, clear: true, submit: true });
    const methods = page.sent.map((s) => s.method);
    expect(methods).toContain("DOM.focus");
    const inserted = page.sent.filter((s) => s.method === "Input.insertText");
    expect(inserted.map((s) => s.params)).toEqual([{ text: "hello" }]);
    const keys = page
      .input()
      .filter((s) => s.method === "Input.dispatchKeyEvent")
      .map((s) => (s.params as { key: string }).key);
    expect(keys).toEqual(["Control", "a", "a", "Control", "Delete", "Delete", "Enter", "Enter"]);
    expect(methods.indexOf("Input.insertText")).toBeLessThan(methods.lastIndexOf("Input.dispatchKeyEvent"));
  });

  it("refuses non-editable and read-only elements without input", async () => {
    const { page, cdp } = setup();
    expect((await failure(typeInto(cdp, 1, 2, "x", { ...linux, clear: false, submit: false }))).message).toContain(
      "not editable",
    );
    page.ax[5] = { role: "textbox", properties: [{ name: "readonly", value: { value: true } }] };
    expect((await failure(typeInto(cdp, 1, 5, "x", { ...linux, clear: false, submit: false }))).code).toBe(
      "INVALID_INPUT",
    );
    expect(page.input()).toHaveLength(0);
  });
});

describe("select and check", () => {
  const options = [
    { backendNodeId: 1, value: "a", label: "Apple", disabled: false },
    { backendNodeId: 2, value: "b", label: "Banana", disabled: true },
    { backendNodeId: 3, value: "Cherry", label: "c", disabled: false },
  ];

  it("chooses options by value, then by label", () => {
    expect(chooseOptions(options, ["a"], false)).toEqual([0]);
    expect(chooseOptions(options, ["Apple"], false)).toEqual([0]);
    expect(chooseOptions(options, ["Cherry"], false)).toEqual([2]); // value wins over label
    expect(chooseOptions(options, ["a", "Cherry"], true)).toEqual([0, 2]);
    expect(() => chooseOptions(options, ["b"], false)).toThrow(/disabled/);
    expect(() => chooseOptions(options, ["zzz"], false)).toThrow(ExtensionError);
    expect(() => chooseOptions(options, ["a", "Cherry"], false)).toThrow(ExtensionError);
  });

  it("moves a single select with keys, skipping disabled options", async () => {
    const { page, cdp } = setup();
    page.quads[9] = [[400, 10, 500, 10, 500, 30, 400, 30]];
    page.hit = () => 9;
    page.ax[9] = { role: "combobox", value: "Apple" };
    const answer = page.answer.bind(page);
    page.chrome.debugger.respond = (_t, method, p) => {
      const params = (p ?? {}) as { type?: string; key?: string };
      // The page moves the selection with ArrowDown (Home is already on the first enabled option).
      if (method === "Input.dispatchKeyEvent" && params.type === "keyUp" && params.key === "ArrowDown")
        page.ax[9] = { role: "combobox", value: "Cherry" };
      return answer(method, params as Record<string, unknown>);
    };
    expect(await selectInto(cdp, 1, 9, ["Cherry"], linux)).toEqual({ selected: ["c"] });
    const keys = page
      .input()
      .filter((s) => s.method === "Input.dispatchKeyEvent" && (s.params as { type: string }).type !== "keyUp")
      .map((s) => (s.params as { key: string }).key);
    expect(keys).toEqual(["Home", "ArrowDown"]);
  });

  it("fails when the page does not show the requested option (no false success)", async () => {
    const { page, cdp } = setup();
    page.quads[9] = [[400, 10, 500, 10, 500, 30, 400, 30]];
    page.hit = () => 9;
    page.ax[9] = { role: "combobox", value: "Apple" };
    const error = await failure(selectInto(cdp, 1, 9, ["Cherry"], linux));
    expect(error.code).toBe("OPERATION_FAILED");
    expect(error.message).toContain("did not change");
  });

  it("clicks options of a multiple select with the platform modifier", async () => {
    const { page, cdp } = setup();
    page.multiple = true;
    page.quads[9] = [[400, 10, 500, 10, 500, 90, 400, 90]];
    page.quads[10] = [[400, 10, 500, 10, 500, 30, 400, 30]];
    page.quads[13] = [[400, 50, 500, 50, 500, 70, 400, 70]];
    page.hit = (_x, y) => (y < 40 ? 10 : 13);
    page.ax[9] = { role: "listbox" };
    const selected = [{ name: "selected", value: { value: true } }];
    page.ax[10] = { role: "option", properties: selected };
    page.ax[13] = { role: "option", properties: selected };
    expect(await selectInto(cdp, 1, 9, ["a", "c"], mac)).toEqual({ selected: ["a", "c"] });
    const presses = page.input().filter((s) => (s.params as { type: string }).type === "mousePressed");
    expect(presses.map((s) => (s.params as { modifiers: number }).modifiers)).toEqual([0, 4]);
  });

  it("sets a checkbox only when its state differs and reports the result", async () => {
    const { page, cdp } = setup();
    page.hit = () => 7;
    let clicks = 0;
    const answer = page.answer.bind(page);
    page.chrome.debugger.respond = (_t, method, p) => {
      if (method === "Input.dispatchMouseEvent" && (p as { type: string }).type === "mouseReleased") {
        clicks++;
        page.ax[7] = { role: "checkbox", properties: [{ name: "checked", value: { value: "true" } }] };
      }
      return answer(method, (p ?? {}) as Record<string, unknown>);
    };
    expect(await setChecked(cdp, 1, 7, true)).toEqual({ checked: true, changed: true });
    expect(await setChecked(cdp, 1, 7, true)).toEqual({ checked: true, changed: false });
    expect(clicks).toBe(1);
    expect((await failure(setChecked(cdp, 1, 2, true))).message).toContain("not checkable");
  });

  it("fails when the click does not change the state (no false success)", async () => {
    const { page, cdp } = setup();
    page.hit = () => 7;
    const error = await failure(setChecked(cdp, 1, 7, true));
    expect(error.code).toBe("OPERATION_FAILED");
    expect(error.message).toBe("The element did not become checked (its state is unchecked).");
  });

  it("waits briefly for a state the page updates asynchronously", async () => {
    const { page, cdp } = setup();
    page.hit = () => 7;
    const answer = page.answer.bind(page);
    page.chrome.debugger.respond = (_t, method, p) => {
      if (method === "Input.dispatchMouseEvent" && (p as { type: string }).type === "mouseReleased") {
        setTimeout(() => {
          page.ax[7] = { role: "checkbox", properties: [{ name: "checked", value: { value: true } }] };
        }, 120);
      }
      return answer(method, (p ?? {}) as Record<string, unknown>);
    };
    expect(await setChecked(cdp, 1, 7, true)).toEqual({ checked: true, changed: true });
  });
});
