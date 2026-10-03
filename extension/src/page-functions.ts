/**
 * The only code the CROT Browser Extension runs inside web pages.
 *
 * Each function is injected with chrome.scripting.executeScript({ func, args })
 * into the extension's isolated world (never the page's main world), so the
 * page's own scripts can neither see nor alter it. Chrome serializes the
 * function's source: every function here must be self-contained and must not
 * refer to anything outside its own body, including other declarations of
 * this module.
 *
 * There is no way to run other code: no eval, no Function, no script files,
 * no code from the host. Selectors and text are data, used only as arguments
 * of querySelector and of the value or insertText operations below.
 */

export type PageErrorCode = "NOT_FOUND" | "INVALID_INPUT" | "OPERATION_FAILED";

/** What a page function returns (structured-cloned back to the extension). */
export type PageOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: PageErrorCode; readonly message: string };

export interface PageContent {
  readonly content: string;
  readonly truncated: boolean;
}

/** Visible text (format text) or the HTML of the page, cut to at most `maxBytes` UTF-8 bytes without splitting a character. */
export function readPageContent(format: "text" | "html", maxBytes: number): PageOutcome<PageContent> {
  const root = document.documentElement;
  let text: string;
  if (format === "html") {
    const doctype = document.doctype ? "<!DOCTYPE " + document.doctype.name + ">\n" : "";
    text = root ? doctype + root.outerHTML : "";
  } else {
    text = document.body ? document.body.innerText : root ? (root.textContent ?? "") : "";
  }
  // A UTF-16 code unit never takes more than 3 UTF-8 bytes.
  if (text.length * 3 <= maxBytes) return { ok: true, value: { content: text, truncated: false } };
  const { read } = new TextEncoder().encodeInto(text, new Uint8Array(maxBytes));
  if (read >= text.length) return { ok: true, value: { content: text, truncated: false } };
  return { ok: true, value: { content: text.slice(0, read), truncated: true } };
}

/** Click the first element matching `selector`. */
export function clickElement(selector: string): PageOutcome<null> {
  let element: Element | null;
  try {
    element = document.querySelector(selector);
  } catch {
    return { ok: false, code: "INVALID_INPUT", message: "Invalid CSS selector." };
  }
  if (element === null) return { ok: false, code: "NOT_FOUND", message: "No element matches the selector." };
  if ("disabled" in element && element.disabled === true) {
    return { ok: false, code: "INVALID_INPUT", message: "The element is disabled." };
  }
  element.scrollIntoView({ block: "center", inline: "center" });
  if (element instanceof HTMLElement) element.click();
  else element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
  return { ok: true, value: null };
}

/**
 * Type `text` into the first element matching `selector`: a text-like input,
 * a textarea or an editable (contenteditable) element. With `clear`, the
 * current value is replaced; otherwise `text` is appended.
 */
export function typeIntoElement(selector: string, text: string, clear: boolean): PageOutcome<null> {
  const TEXT_INPUT_TYPES = ["text", "search", "email", "url", "tel", "password", "number"];
  let element: Element | null;
  try {
    element = document.querySelector(selector);
  } catch {
    return { ok: false, code: "INVALID_INPUT", message: "Invalid CSS selector." };
  }
  if (element === null) return { ok: false, code: "NOT_FOUND", message: "No element matches the selector." };

  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    if (element instanceof HTMLInputElement && !TEXT_INPUT_TYPES.includes(element.type)) {
      return { ok: false, code: "INVALID_INPUT", message: "Cannot type into an input of type " + element.type + "." };
    }
    if (element.disabled || element.readOnly) {
      return { ok: false, code: "INVALID_INPUT", message: "The element is disabled or read-only." };
    }
    element.focus();
    const prototype = element instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    const setValue = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    const value = (clear ? "" : element.value) + text;
    if (setValue) setValue.call(element, value);
    else element.value = value;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true, value: null };
  }

  if (element instanceof HTMLElement && element.isContentEditable) {
    element.focus();
    const selection = window.getSelection();
    if (selection) {
      const range = document.createRange();
      range.selectNodeContents(element);
      if (!clear) range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    if (
      text.length === 0 ? !clear || document.execCommand("delete") : document.execCommand("insertText", false, text)
    ) {
      return { ok: true, value: null };
    }
    // execCommand unavailable: set the text directly.
    if (clear) element.textContent = text;
    else element.append(text);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    return { ok: true, value: null };
  }

  return { ok: false, code: "INVALID_INPUT", message: "The element is not a text field or an editable element." };
}
