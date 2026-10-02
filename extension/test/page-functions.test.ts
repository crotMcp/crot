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
  const window = { getSelection: () => ({ removeAllRanges: () => undefined, addRange: