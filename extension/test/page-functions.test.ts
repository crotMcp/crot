import { afterEach, describe, expect, it } from "vitest";
import { clickElement, readPageContent, typeIntoElement } from "../src/page-functions.js";

/**
 * chrome.scripting.executeScript serializes `func` and runs its source in the
 * page. Each test runs a copy rebuilt from the function's source, so a
 * function that referred to anything outside its own body would fail here.
 * (`__name` covers a helper some test transformers add; tsc does not.)
 */
function serialized<T>(fn: T): T {
  return new Function("const __name = (f) => f; return (" + String(fn) + ");")() as T;
}

// ---------------------------------------------------------------- minimal DOM

class FakeElement extends EventTarget {
  scrolled = false;
  disabled?: boolean;
  scrollIntoView(): void {
    this.scrolled = true;
  }
}

class FakeHTMLElement extends FakeElement {
  isContentEditable = false;
  textContent = "";
  focused = false;
  clicks = 0;
  focus(): void {
    this.focused = true;
  }
  click(): void {
    this.clicks++;
  }
  append(text: string): void {
    this.textContent += text;
  }
}

class FakeField extends FakeHTMLElement {
  readOnly = false;
  override disabled = false;
  readonly events: string[] = [];
  override dispatchEvent(event: Event): boolean {
    this.events.push(event.type);
    return super.dispatchEvent(event);
  }
}

/** Like HTMLInputElement: `value` is an accessor of the prototype (the page function uses its setter). */
class FakeInput extends FakeField {
  type = "text";
  private current = "";
  get value(): string {
    return this.current;
  }
  set value(v: string) {
    this.current = v;
  }
}

/** Without a prototype accessor: exercises the plain assignment fallback. */
class FakeTextArea extends FakeField {
  value = "";
}

class FakeMouseEvent extends Event {}

interface FakeDocument {
  title: string;
  doctype: { name: string } | null;
  documentElement: { outerHTML: string; textContent: string } | null;
  body: { innerText: string } | null;
  elements: Record<string, FakeElement>;
  commands: string[];
  execCommandResult: boolean;
}

const GLOBALS = ["document", "window", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "MouseEvent"] as const;
const saved = new Map<string, PropertyDescriptor | undefined>();

function installDom(doc: Partial<FakeDocument> = {}): FakeDocument {
  const state: FakeDocument = {
    title: "T",
    doctype: { name: "html" },
    documentElement: { outerHTML: "<html><body>Hi</body></html>", textContent: "Hi" },
    body: { innerText: "Hi" },
    elements: {},
    commands: [],
    execCommandResult: true,
    ...doc,
  };
  const document = {
    get title() {
      return state.title;
    },
    get doctype() {
      return state.doctype;
    },
    get documentElement() {
      return state.documentElement;
    },
    get body() {
      return state.body;
    },
    querySelector(selector: string) {
      if (selector.startsWith("!")) throw new SyntaxError("not a valid selector");
      return state.elements[selector] ?? null;
    },
    execCommand(command: string, _ui?: boolean, value?: string) {
      state.commands.push(value === undefined ? command : command + ":" + value);
      return state.execCommandResult;
    },
    createRange() {
      return { selectNodeContents: () => undefined, collapse: () => undefined };
    },
  };
  const window = { getSelection: () => ({ removeAllRanges: () => undefined, addRange: () => undefined }) };
  const values: Record<(typeof GLOBALS)[number], unknown> = {
    document,
    window,
    HTMLElement: FakeHTMLElement,
    HTMLInputElement: FakeInput,
    HTMLTextAreaElement: FakeTextArea,
    MouseEvent: FakeMouseEvent,
  };
  for (const name of GLOBALS) {
    if (!saved.has(name)) saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value: values[name], configurable: true, writable: true });
  }
  return state;
}

afterEach(() => {
  for (const [name, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  saved.clear();
});

// ---------------------------------------------------------------- tests

describe("page functions", () => {
  it("read visible text or HTML", () => {
    installDom({ body: { innerText: "Visible text" } });
    const read = serialized(readPageContent);
    expect(read("text", 1000)).toEqual({ ok: true, value: { content: "Visible text", truncated: false } });
    expect(read("html", 1000)).toEqual({ ok: true, value: { content: "<!DOCTYPE html>\n<html><body>Hi</body></html>", truncated: false } });
  });

  it("fall back to textContent without a body", () => {
    installDom({ body: null, doctype: null, documentElement: { outerHTML: "<svg/>", textContent: "svg text" } });
    const read = serialized(readPageContent);
    expect(read("text", 100)).toEqual({ ok: true, value: { content: "svg text", truncated: false } });
    expect(read("html", 100)).toEqual({ ok: true, value: { content: "<svg/>", truncated: false } });
  });

  it("truncate to maxBytes UTF-8 bytes without splitting characters", () => {
    installDom({ body: { innerText: "aé€😀b" } }); // 1 + 2 + 3 + 4 + 1 bytes
    const read = serialized(readPageContent);
    expect(read("text", 11)).toEqual({ ok: true, value: { content: "aé€😀b", truncated: false } });
    expect(read("text", 10)).toEqual({ ok: true, value: { content: "aé€😀", truncated: true } });
    expect(read("text", 9)).toEqual({ ok: true, value: { content: "aé€", truncated: true } });
    expect(read("text", 2)).toEqual({ ok: true, value: { content: "a", truncated: true } });
    expect(read("text", 1)).toEqual({ ok: true, value: { content: "a", truncated: true } });
  });

  it("click the matching element", () => {
    const button = new FakeHTMLElement();
    const svg = new FakeElement();
    const clicked: string[] = [];
    svg.addEventListener("click", () => clicked.push("svg"));
    installDom({ elements: { "#go": button, "#svg": svg } });
    const click = serialized(clickElement);
    expect(click("#go")).toEqual({ ok: true, value: null });
    expect(button.clicks).toBe(1);
    expect(button.scrolled).toBe(true);
    expect(click("#svg")).toEqual({ ok: true, value: null });
    expect(clicked).toEqual(["svg"]);
  });

  it("report missing, disabled and invalid click targets", () => {
    const disabled = new FakeInput();
    disabled.disabled = true;
    installDom({ elements: { "#off": disabled } });
    const click = serialized(clickElement);
    expect(click("#missing")).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(click("!bad")).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(click("#off")).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(disabled.clicks).toBe(0);
  });

  it("type into inputs and textareas, appending or replacing", () => {
    const input = new FakeInput();
    input.value = "abc";
    const area = new FakeTextArea();
    area.value = "old";
    installDom({ elements: { "#in": input, "#area": area } });
    const type = serialized(typeIntoElement);
    expect(type("#in", "def", false)).toEqual({ ok: true, value: null });
    expect(input.value).toBe("abcdef");
    expect(input.focused).toBe(true);
    expect(input.events).toEqual(["input", "change"]);
    expect(type("#area", "new", true)).toEqual({ ok: true, value: null });
    expect(area.value).toBe("new");
  });

  it("refuse elements that cannot take text", () => {
    const checkbox = new FakeInput();
    checkbox.type = "checkbox";
    const readOnly = new FakeInput();
    readOnly.readOnly = true;
    const div = new FakeHTMLElement();
    installDom({ elements: { "#cb": checkbox, "#ro": readOnly, "#div": div } });
    const type = serialized(typeIntoElement);
    expect(type("#cb", "x", false)).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(type("#ro", "x", false)).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(type("#div", "x", false)).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(type("#none", "x", false)).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(type("!bad", "x", false)).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(readOnly.value).toBe("");
  });

  it("type into editable elements with insertText", () => {
    const editor = new FakeHTMLElement();
    editor.isContentEditable = true;
    const dom = installDom({ elements: { "#ed": editor } });
    const type = serialized(typeIntoElement);
    expect(type("#ed", "hello", false)).toEqual({ ok: true, value: null });
    expect(dom.commands).toEqual(["insertText:hello"]);
    expect(editor.focused).toBe(true);
  });

  it("set the text directly when execCommand is unavailable", () => {
    const editor = new FakeHTMLElement();
    editor.isContentEditable = true;
    editor.textContent = "old";
    installDom({ elements: { "#ed": editor }, execCommandResult: false });
    const type = serialized(typeIntoElement);
    expect(type("#ed", "+1", false)).toEqual({ ok: true, value: null });
    expect(editor.textContent).toBe("old+1");
    expect(type("#ed", "new", true)).toEqual({ ok: true, value: null });
    expect(editor.textContent).toBe("new");
  });
});
