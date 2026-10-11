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
  ax: Record<number, { role: string; properties?: { name: string; value: { value: unknown } }[] }> = {
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
        return { cssVisualViewport: { clientWidth: 800, clientHeight: 600 } };
      case "DOM.getNodeForLocation":
        return { backendNodeId: this.hit(p.x as number, p.y as number) };
      case "Accessibility.getPartialAXTree": {
        const id = p.backendNodeId as number;
        const node = this.ax[id];
        return {
          nodes: node ? [{ backendDOMNodeId: id, role: { value: node.role }, properties: node.properties ?? [] }] : [],
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
        return { node: { backendNodeId: p.backendNodeId, localName: "div" } };
      case "DOM.getDocument":
        return {
          root: {
            backendNodeId: 1,
            children: [
              { backendNodeId: 2, children: [{ backendNodeId: 3 }] },
              { backendNodeId: 4 },
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
    expect(page.input()).toHaveLength(0);
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
    page.ax[9] = { role: "combobox" };
    expect(await selectInto(cdp, 1, 9, ["Cherry"], linux)).toEqual({ selected: ["c"] });
    const keys = page
      .input()
      .filter((s) => (s.params as { type: string }).type !== "keyUp")
      .map((s) => (s.params as { key: string }).key);
    expect(keys).toEqual(["Home", "ArrowDown"]);
  });

  it("clicks options of a multiple select with the platform modifier", async () => {
    const { page, cdp } = setup();
    page.multiple = true;
    page.quads[9] = [[400, 10, 500, 10, 500, 90, 400, 90]];
    page.quads[10] = [[400, 10, 500, 10, 500, 30, 400, 30]];
    page.quads[13] = [[400, 50, 500, 50, 500, 70, 400, 70]];
    page.hit = (_x, y) => (y < 40 ? 10 : 13);
    page.ax[9] = { role: "listbox" };
    page.ax[10] = { role: "option" };
    page.ax[13] = { role: "option" };
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
});
