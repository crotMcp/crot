import { z } from "zod";

/**
 * Browser capability schemas, owned by Core (ARCHITECTURE.md §16).
 *
 * Input schemas validate agent requests before authorization. Result schemas
 * validate what the CROT Browser Extension returns: the extension and the
 * browser are outside CROT's trust boundary, so every response is untrusted
 * data until it has passed these schemas.
 */

export const BROWSER_URL_MAX_LENGTH = 8192;
export const BROWSER_SELECTOR_MAX_LENGTH = 1000;
export const BROWSER_TYPE_TEXT_MAX_LENGTH = 100_000;
export const BROWSER_TITLE_MAX_LENGTH = 10_000;
export const BROWSER_MAX_TABS = 1000;
/** Largest decoded screenshot Core accepts from the browser. */
export const BROWSER_SCREENSHOT_MAX_BYTES = 16 * 1024 * 1024;

const ALLOWED_URL_PROTOCOLS: ReadonlySet<string> = new Set(["http:", "https:"]);

/**
 * Whether `value` is a URL CROT may open or navigate to: absolute http: or
 * https: only. javascript:, data:, file:, blob:, browser-internal (chrome:,
 * edge:, brave:, about:) and extension URLs are rejected.
 */
export function isAllowedBrowserUrl(value: string): boolean {
  if (value.length === 0 || value.length > BROWSER_URL_MAX_LENGTH) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return ALLOWED_URL_PROTOCOLS.has(url.protocol);
}

/** Audit-safe form of a URL: its origin (never path, query, fragment or credentials). */
export function urlOrigin(value: string): string {
  try {
    const url = new URL(value);
    return ALLOWED_URL_PROTOCOLS.has(url.protocol) ? url.origin : url.protocol;
  } catch {
    return "invalid-url";
  }
}

export const BROWSER_PAGE_FORMATS = ["text", "html"] as const;
export type BrowserPageFormat = (typeof BROWSER_PAGE_FORMATS)[number];

export const BROWSER_IMAGE_FORMATS = ["png", "jpeg"] as const;
export type BrowserImageFormat = (typeof BROWSER_IMAGE_FORMATS)[number];

const TabId = z.number().int().nonnegative().describe("Browser tab id, as returned by browser_tabs_list.");
const OptionalTabId = TabId.optional().describe("Tab id. Defaults to the active tab of the last focused window.");
const BrowserUrl = z
  .string()
  .min(1)
  .max(BROWSER_URL_MAX_LENGTH)
  .refine(isAllowedBrowserUrl, { message: "Only absolute http: and https: URLs are allowed." })
  .describe("Absolute http: or https: URL.");
const Selector = z
  .string()
  .min(1)
  .max(BROWSER_SELECTOR_MAX_LENGTH)
  .regex(/^[^\0]*$/, "Selectors must not contain NUL.")
  .describe("CSS selector of the target element.");

export const BrowserDialogTypeSchema = z.enum(["alert", "confirm", "prompt", "beforeunload", "file_chooser"]);
export const BrowserDialogSchema = z.object({
  type: BrowserDialogTypeSchema,
  message: z.string().max(10_000),
  defaultPrompt: z.string().max(10_000).optional(),
});
export const BrowserDialogHandleInputSchema = z
  .object({ tabId: OptionalTabId, accept: z.boolean(), promptText: z.string().max(10_000).optional() })
  .strict();
export type BrowserDialogHandleInput = z.input<typeof BrowserDialogHandleInputSchema>;
// ---------------------------------------------------------------- inputs

export const BrowserStatusInputSchema = z.object({}).strict();

export const BrowserTabsListInputSchema = z.object({}).strict();

export const BrowserPageReadInputSchema = z
  .object({
    tabId: OptionalTabId,
    format: z
      .enum(BROWSER_PAGE_FORMATS)
      .default("text")
      .describe("text: visible text (default); html: the page's HTML."),
    maxBytes: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Maximum UTF-8 bytes of content to return (bounded by the configured maxReadBytes)."),
  })
  .strict();

export const BrowserScreenshotInputSchema = z
  .object({
    tabId: OptionalTabId,
    format: z.enum(BROWSER_IMAGE_FORMATS).default("png"),
    ref: z
      .string()
      .regex(/^e[1-9][0-9]{0,8}$/)
      .optional(),
    fullPage: z.boolean().optional(),
    quality: z.number().int().min(0).max(100).optional().describe("JPEG quality (0-100). Only valid with format jpeg."),
  })
  .strict()
  .refine((v) => v.quality === undefined || v.format === "jpeg", {
    message: "'quality' is only valid with format 'jpeg'.",
  })
  .refine((v) => !(v.ref && v.fullPage), { message: "ref and fullPage are mutually exclusive." });

export const BROWSER_WAIT_UNTIL = ["commit", "domcontentloaded", "load", "networkidle"] as const;
export const BROWSER_WAIT_TIMEOUT_MAX_MS = 60_000;
export const BROWSER_SNAPSHOT_MAX_ELEMENTS = 5000;
export const BROWSER_KEY_COMBINATIONS_MAX = 32;
export const BROWSER_SELECT_VALUES_MAX = 100;
export const BROWSER_SCROLL_DELTA_MAX = 100_000;
export const BROWSER_WAIT_TEXT_MAX_LENGTH = 1000;
export const BROWSER_NEW_TABS_MAX = 100;

const Ref = z
  .string()
  .regex(/^e[1-9][0-9]{0,8}$/, "Expected an element ref from browser_snapshot (e1, e2, ...).")
  .describe("Element ref from the latest browser_snapshot of this tab. Refs become stale when the document changes.");
const FrameRef = z
  .string()
  .regex(/^f[1-9][0-9]{0,8}$/, "Expected a frame ref from browser_snapshot (f1, f2, ...).")
  .describe("Frame ref from browser_snapshot.");
const WaitUntil = z
  .enum(BROWSER_WAIT_UNTIL)
  .optional()
  .describe("Load state to wait for when the action starts a navigation (default: load).");
const TimeoutMs = z
  .number()
  .int()
  .min(1)
  .max(BROWSER_WAIT_TIMEOUT_MAX_MS)
  .optional()
  .describe("Maximum wait in milliseconds (default 20000, at most 60000). The action is never repeated.");
const Settle = { waitUntil: WaitUntil, timeoutMs: TimeoutMs };
const OptionalRef = Ref.optional();
const OptionalSelector = Selector.optional();
const oneTarget = (v: { ref?: string; selector?: string }): boolean =>
  (v.ref === undefined) !== (v.selector === undefined);
const atMostOneTarget = (v: { ref?: string; selector?: string }): boolean =>
  v.ref === undefined || v.selector === undefined;
const ONE_TARGET = { message: "Give exactly one of 'ref' or 'selector'." };
const AT_MOST_ONE_TARGET = { message: "Give at most one of 'ref' or 'selector'." };
const TargetFrameRef = FrameRef.optional().describe(
  "Frame document the selector is resolved in (frame ref from browser_snapshot; default: the top-level document). With a ref it must be the ref's frame.",
);
const frameNeedsTarget = (v: { ref?: string; selector?: string; frameRef?: string }): boolean =>
  v.frameRef === undefined || v.ref !== undefined || v.selector !== undefined;
const FRAME_NEEDS_TARGET = { message: "'frameRef' is only valid with 'ref' or 'selector'." };
const ElementTarget = z
  .object({ ref: OptionalRef, selector: OptionalSelector, frameRef: TargetFrameRef })
  .strict()
  .refine(oneTarget, ONE_TARGET);

export const BrowserTabOpenInputSchema = z
  .object({
    url: BrowserUrl,
    active: z.boolean().default(true).describe("Make the new tab the active tab."),
    ...Settle,
  })
  .strict();

export const BrowserNavigateInputSchema = z.object({ tabId: OptionalTabId, url: BrowserUrl, ...Settle }).strict();

export const BrowserTabActivateInputSchema = z.object({ tabId: TabId }).strict();

export const BrowserTabCloseInputSchema = z.object({ tabId: TabId }).strict();

export const BrowserClickInputSchema = z
  .object({
    tabId: OptionalTabId,
    ref: OptionalRef,
    selector: OptionalSelector,
    frameRef: TargetFrameRef,
    button: z.enum(["left", "right", "middle"]).optional().describe("Mouse button (default left)."),
    clickCount: z
      .union([z.literal(1), z.literal(2)])
      .optional()
      .describe("1 (default) or 2 for a double click."),
    modifiers: z
      .array(z.enum(["Shift", "Control", "Alt", "Meta", "ControlOrMeta"]))
      .max(5)
      .optional()
      .describe("Modifier keys held during the click."),
    ...Settle,
  })
  .strict()
  .refine(frameNeedsTarget, FRAME_NEEDS_TARGET)
  .refine(oneTarget, ONE_TARGET);

export const BrowserTypeInputSchema = z
  .object({
    tabId: OptionalTabId,
    ref: OptionalRef,
    selector: OptionalSelector,
    frameRef: TargetFrameRef,
    text: z.string().max(BROWSER_TYPE_TEXT_MAX_LENGTH).describe("Text to type into the element."),
    clear: z.boolean().default(false).describe("Clear the element's current value first."),
    submit: z.boolean().optional().describe("Press Enter after typing (ref or Browser v1 form only)."),
    ...Settle,
  })
  .strict()
  .refine(frameNeedsTarget, FRAME_NEEDS_TARGET)
  .refine(oneTarget, ONE_TARGET);

export const BrowserSnapshotInputSchema = z
  .object({
    tabId: OptionalTabId,
    frameRef: FrameRef.optional().describe("Limit the snapshot to one frame (and its descendants)."),
    includeText: z.boolean().default(false).describe("Include static text nodes, not only interactive elements."),
    maxElements: z
      .number()
      .int()
      .min(1)
      .max(BROWSER_SNAPSHOT_MAX_ELEMENTS)
      .optional()
      .describe("Maximum number of elements (default 500); check 'truncated'."),
  })
  .strict();

export const BrowserHoverInputSchema = z
  .object({ tabId: OptionalTabId, ref: OptionalRef, selector: OptionalSelector, frameRef: TargetFrameRef, ...Settle })
  .strict()
  .refine(frameNeedsTarget, FRAME_NEEDS_TARGET)
  .refine(oneTarget, ONE_TARGET);

const ScrollDelta = z.number().int().min(-BROWSER_SCROLL_DELTA_MAX).max(BROWSER_SCROLL_DELTA_MAX).optional();
export const BrowserScrollInputSchema = z
  .object({
    tabId: OptionalTabId,
    ref: OptionalRef.describe("Element to scroll over (default: the centre of the viewport)."),
    selector: OptionalSelector,
    frameRef: TargetFrameRef,
    deltaX: ScrollDelta.describe("Horizontal wheel delta in CSS pixels."),
    deltaY: ScrollDelta.describe("Vertical wheel delta in CSS pixels (positive scrolls down)."),
    ...Settle,
  })
  .strict()
  .refine(frameNeedsTarget, FRAME_NEEDS_TARGET)
  .refine(atMostOneTarget, AT_MOST_ONE_TARGET)
  .refine((v) => (v.deltaX ?? 0) !== 0 || (v.deltaY ?? 0) !== 0, { message: "Give a non-zero deltaX or deltaY." });

export const BrowserDragInputSchema = z
  .object({
    tabId: OptionalTabId,
    ref: OptionalRef,
    selector: OptionalSelector,
    frameRef: TargetFrameRef,
    to: ElementTarget.describe("Drop target: exactly one of ref or selector."),
    ...Settle,
  })
  .strict()
  .refine(frameNeedsTarget, FRAME_NEEDS_TARGET)
  .refine(oneTarget, ONE_TARGET);

export const BrowserPressKeyInputSchema = z
  .object({
    tabId: OptionalTabId,
    ref: OptionalRef.describe("Element to focus first (default: the focused element)."),
    selector: OptionalSelector,
    frameRef: TargetFrameRef,
    keys: z
      .array(z.string().min(1).max(100))
      .min(1)
      .max(BROWSER_KEY_COMBINATIONS_MAX)
      .describe("Key combinations pressed in order, e.g. ['Tab', 'ControlOrMeta+A', 'Enter']."),
    ...Settle,
  })
  .strict()
  .refine(frameNeedsTarget, FRAME_NEEDS_TARGET)
  .refine(atMostOneTarget, AT_MOST_ONE_TARGET);

export const BrowserSelectOptionInputSchema = z
  .object({
    tabId: OptionalTabId,
    ref: OptionalRef,
    selector: OptionalSelector,
    frameRef: TargetFrameRef,
    values: z
      .array(z.string().max(BROWSER_WAIT_TEXT_MAX_LENGTH))
      .min(1)
      .max(BROWSER_SELECT_VALUES_MAX)
      .describe("Option values or visible labels to select."),
    ...Settle,
  })
  .strict()
  .refine(frameNeedsTarget, FRAME_NEEDS_TARGET)
  .refine(oneTarget, ONE_TARGET);

export const BrowserSetCheckedInputSchema = z
  .object({
    tabId: OptionalTabId,
    ref: OptionalRef,
    selector: OptionalSelector,
    frameRef: TargetFrameRef,
    checked: z.boolean().describe("The wanted state; nothing is clicked when it already holds."),
    ...Settle,
  })
  .strict()
  .refine(frameNeedsTarget, FRAME_NEEDS_TARGET)
  .refine(oneTarget, ONE_TARGET);

const WaitText = z.string().min(1).max(BROWSER_WAIT_TEXT_MAX_LENGTH);
const WAIT_CONDITIONS = [
  "ref",
  "selector",
  "text",
  "textGone",
  "urlPrefix",
  "loadState",
  "newDocument",
  "newTab",
] as const;
export const BrowserWaitInputSchema = z
  .object({
    tabId: OptionalTabId,
    ref: OptionalRef,
    selector: OptionalSelector,
    frameRef: TargetFrameRef,
    state: z
      .enum(["visible", "hidden", "enabled", "detached"])
      .optional()
      .describe("Element state to wait for (with ref or selector; default visible)."),
    text: WaitText.optional().describe("Wait until this text appears in the page."),
    textGone: WaitText.optional().describe("Wait until this text is no longer in the page."),
    urlPrefix: z
      .string()
      .min(1)
      .max(BROWSER_URL_MAX_LENGTH)
      .optional()
      .describe("Wait until the tab URL starts with this."),
    loadState: z.enum(BROWSER_WAIT_UNTIL).optional().describe("Wait until the page reaches this load state."),
    newDocument: z.literal(true).optional().describe("Wait until a new document commits in the tab."),
    newTab: z.literal(true).optional().describe("Wait until this tab opens a new tab."),
    timeoutMs: TimeoutMs,
  })
  .strict()
  .refine(frameNeedsTarget, FRAME_NEEDS_TARGET)
  .refine((v) => WAIT_CONDITIONS.filter((k) => v[k] !== undefined).length === 1, {
    message: `Give exactly one condition: ${WAIT_CONDITIONS.join(", ")}.`,
  })
  .refine((v) => v.state === undefined || v.ref !== undefined || v.selector !== undefined, {
    message: "'state' is only valid with 'ref' or 'selector'.",
  });

export const BrowserHistoryInputSchema = z
  .object({
    tabId: OptionalTabId,
    action: z.enum(["back", "forward", "reload"]).describe("back, forward or reload."),
    ...Settle,
  })
  .strict();

export type BrowserStatusInput = z.input<typeof BrowserStatusInputSchema>;
export type BrowserTabsListInput = z.input<typeof BrowserTabsListInputSchema>;
export type BrowserPageReadInput = z.input<typeof BrowserPageReadInputSchema>;
export type BrowserScreenshotInput = z.input<typeof BrowserScreenshotInputSchema>;
export type BrowserTabOpenInput = z.input<typeof BrowserTabOpenInputSchema>;
export type BrowserNavigateInput = z.input<typeof BrowserNavigateInputSchema>;
export type BrowserTabActivateInput = z.input<typeof BrowserTabActivateInputSchema>;
export type BrowserTabCloseInput = z.input<typeof BrowserTabCloseInputSchema>;
export type BrowserClickInput = z.input<typeof BrowserClickInputSchema>;
export type BrowserTypeInput = z.input<typeof BrowserTypeInputSchema>;
export type BrowserSnapshotInput = z.input<typeof BrowserSnapshotInputSchema>;
export type BrowserHoverInput = z.input<typeof BrowserHoverInputSchema>;
export type BrowserScrollInput = z.input<typeof BrowserScrollInputSchema>;
export type BrowserDragInput = z.input<typeof BrowserDragInputSchema>;
export type BrowserPressKeyInput = z.input<typeof BrowserPressKeyInputSchema>;
export type BrowserSelectOptionInput = z.input<typeof BrowserSelectOptionInputSchema>;
export type BrowserSetCheckedInput = z.input<typeof BrowserSetCheckedInputSchema>;
export type BrowserWaitInput = z.input<typeof BrowserWaitInputSchema>;
export type BrowserHistoryInput = z.input<typeof BrowserHistoryInputSchema>;

export const BrowserFileUploadInputSchema = z
  .object({
    tabId: OptionalTabId,
    ref: OptionalRef.describe("File input from browser_snapshot; omit only to answer a pending file chooser."),
    paths: z.array(z.string().min(1).max(4096)).min(1).max(16),
  })
  .strict();
export const BrowserDownloadInputSchema = z
  .object({
    tabId: OptionalTabId,
    ref: OptionalRef,
    selector: OptionalSelector,
    frameRef: TargetFrameRef,
    url: z.string().refine(isAllowedBrowserUrl).optional(),
    savePath: z.string().min(1).max(4096),
    overwrite: z.boolean().default(false),
    timeoutMs: z.number().int().min(1).max(60_000).default(20_000),
  })
  .strict()
  .refine((v) => [v.ref, v.selector, v.url].filter((x) => x !== undefined).length === 1, {
    message: "Give exactly one ref, selector or HTTP(S) URL trigger.",
  })
  .refine(frameNeedsTarget, FRAME_NEEDS_TARGET);
export type BrowserFileUploadInput = z.input<typeof BrowserFileUploadInputSchema>;
export type BrowserDownloadInput = z.input<typeof BrowserDownloadInputSchema>;

// ---------------------------------------------------------------- results (untrusted, from the browser)

const ResultUrl = z.string().max(BROWSER_URL_MAX_LENGTH);
const Title = z.string().max(BROWSER_TITLE_MAX_LENGTH);
const Base64 = z
  .string()
  .min(1)
  .max(Math.ceil(BROWSER_SCREENSHOT_MAX_BYTES / 3) * 4)
  .regex(/^[A-Za-z0-9+/]*={0,2}$/, "Expected base64 data.");

export const BrowserInfoSchema = z.object({
  name: z.string().min(1).max(200),
  version: z.string().min(1).max(200),
  extensionVersion: z.string().min(1).max(200),
});

export const BrowserTabInfoSchema = z.object({
  tabId: TabId,
  windowId: z.number().int(),
  url: ResultUrl,
  title: Title,
  active: z.boolean(),
  discarded: z.boolean().optional(),
  groupedByCrot: z.boolean().optional(),
  dialog: BrowserDialogSchema.optional(),
  status: z.enum(["loading", "complete", "unloaded"]).optional(),
  /** The tab that opened this one (popups, target=_blank). */
  openerTabId: TabId.optional(),
});

export const BrowserTabsListResultSchema = z.object({ tabs: z.array(BrowserTabInfoSchema).max(BROWSER_MAX_TABS) });

export const BrowserPageReadResultSchema = z.object({
  tabId: TabId,
  url: ResultUrl,
  title: Title,
  format: z.enum(BROWSER_PAGE_FORMATS),
  content: z.string(),
  truncated: z.boolean(),
});

export const BrowserScreenshotResultSchema = z.object({
  tabId: TabId,
  url: ResultUrl,
  mimeType: z.enum(["image/png", "image/jpeg"]),
  viewport: z.object({ width: z.number().positive(), height: z.number().positive() }).optional(),
  devicePixelRatio: z.number().positive().optional(),
  /** Base64-encoded image. */
  data: Base64,
});

export const BrowserTabActionResultSchema = z.object({ tabId: TabId, url: ResultUrl });

/** Result of a control action (AD-16 point 7): navigation started by it and tabs it opened. */
export const BrowserControlResultSchema = BrowserTabActionResultSchema.extend({
  dialog: z.object({ type: BrowserDialogTypeSchema }).optional(),
  navigated: z.boolean().optional(),
  newTabs: z.array(TabId).max(BROWSER_NEW_TABS_MAX).optional(),
  /** The page did not reach waitUntil within timeoutMs; it goes on loading (nothing is retried). */
  loadTimedOut: z.literal(true).optional(),
  /** The extension made the tab visible first (activated it, restored or focused its window): input reaches visible pages only. */
  activated: z.literal(true).optional(),
});

const InterruptedControlResult = BrowserControlResultSchema.extend({
  dialog: z.object({ type: BrowserDialogTypeSchema }),
});
export const BrowserSelectOptionResultSchema = z.union([
  BrowserControlResultSchema.extend({
    selected: z.array(z.string().max(BROWSER_WAIT_TEXT_MAX_LENGTH)).max(BROWSER_SELECT_VALUES_MAX),
  }),
  InterruptedControlResult,
]);
export const BrowserSetCheckedResultSchema = z.union([
  BrowserControlResultSchema.extend({ checked: z.boolean(), changed: z.boolean() }),
  InterruptedControlResult,
]);

export const BrowserWaitResultSchema = z.object({
  satisfied: z.literal(true),
  url: ResultUrl,
  newTabs: z.array(TabId).max(BROWSER_NEW_TABS_MAX).optional(),
});

const Bounds = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() });
export const BrowserSnapshotResultSchema = z.object({
  dialog: BrowserDialogSchema.optional(),
  tabId: TabId,
  url: ResultUrl,
  title: Title,
  frames: z
    .array(
      z.object({
        frameRef: z.string().regex(/^f[1-9][0-9]{0,8}$/),
        parentFrameRef: z
          .string()
          .regex(/^f[1-9][0-9]{0,8}$/)
          .nullable(),
        url: ResultUrl,
        origin: z.string().max(BROWSER_URL_MAX_LENGTH).nullable(),
        restricted: z.boolean(),
      }),
    )
    .max(1000),
  elements: z
    .array(
      z.object({
        ref: z.string().regex(/^e[1-9][0-9]{0,8}$/),
        frameRef: z.string().regex(/^f[1-9][0-9]{0,8}$/),
        role: z.string().max(200),
        name: z.string().max(BROWSER_TITLE_MAX_LENGTH),
        value: z.string().max(BROWSER_TITLE_MAX_LENGTH).optional(),
        hasValue: z.boolean().optional(),
        states: z.record(z.string(), z.union([z.boolean(), z.literal("mixed")])),
        bounds: Bounds.nullable(),
        inViewport: z.boolean(),
      }),
    )
    .max(BROWSER_SNAPSHOT_MAX_ELEMENTS),
  truncated: z.boolean(),
});

export const BrowserTabCloseResultSchema = z
  .object({ tabId: TabId, closed: z.boolean(), dialog: z.object({ type: BrowserDialogTypeSchema }).optional() })
  .refine((value) => value.closed || value.dialog !== undefined, "An unclosed tab must report the pending dialog.");

export type BrowserInfo = z.output<typeof BrowserInfoSchema>;
export type BrowserTabInfo = z.output<typeof BrowserTabInfoSchema>;
export type BrowserTabsListResult = z.output<typeof BrowserTabsListResultSchema>;
export type BrowserPageReadResult = z.output<typeof BrowserPageReadResultSchema>;
export type BrowserScreenshotResult = z.output<typeof BrowserScreenshotResultSchema>;
export type BrowserTabActionResult = z.output<typeof BrowserTabActionResultSchema>;
export type BrowserControlResult = z.output<typeof BrowserControlResultSchema>;
export type BrowserSelectOptionResult = z.output<typeof BrowserSelectOptionResultSchema>;
export type BrowserSetCheckedResult = z.output<typeof BrowserSetCheckedResultSchema>;
export type BrowserWaitResult = z.output<typeof BrowserWaitResultSchema>;
export type BrowserSnapshotResult = z.output<typeof BrowserSnapshotResultSchema>;
export type BrowserTabCloseResult = z.output<typeof BrowserTabCloseResultSchema>;

// ---------------------------------------------------------------- bridge status

/**
 * State of the browser bridge in this CROT instance.
 * - disabled: browser support is off (browser.enabled is false).
 * - waiting: this instance owns the bridge; no extension is connected yet.
 * - connected: an extension is connected.
 * - in_use: another live CROT instance owns the bridge; only browser
 *   operations are unavailable here.
 */
export type BrowserBridgeState = "disabled" | "waiting" | "connected" | "in_use";

export interface BrowserStatus {
  readonly state: BrowserBridgeState;
  readonly cdp?: { readonly available: boolean; readonly reason: string | null };
  readonly browser?: BrowserInfo;
  readonly detail: string;
}
