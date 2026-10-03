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
    quality: z.number().int().min(0).max(100).optional().describe("JPEG quality (0-100). Only valid with format jpeg."),
  })
  .strict()
  .refine((v) => v.quality === undefined || v.format === "jpeg", {
    message: "'quality' is only valid with format 'jpeg'.",
  });

export const BrowserTabOpenInputSchema = z
  .object({
    url: BrowserUrl,
    active: z.boolean().default(true).describe("Make the new tab the active tab."),
  })
  .strict();

export const BrowserNavigateInputSchema = z.object({ tabId: OptionalTabId, url: BrowserUrl }).strict();

export const BrowserTabActivateInputSchema = z.object({ tabId: TabId }).strict();

export const BrowserTabCloseInputSchema = z.object({ tabId: TabId }).strict();

export const BrowserClickInputSchema = z.object({ tabId: OptionalTabId, selector: Selector }).strict();

export const BrowserTypeInputSchema = z
  .object({
    tabId: OptionalTabId,
    selector: Selector,
    text: z.string().max(BROWSER_TYPE_TEXT_MAX_LENGTH).describe("Text to type into the element."),
    clear: z.boolean().default(false).describe("Clear the element's current value first."),
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
  status: z.enum(["loading", "complete", "unloaded"]).optional(),
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
  /** Base64-encoded image. */
  data: Base64,
});

export const BrowserTabActionResultSchema = z.object({ tabId: TabId, url: ResultUrl });

export const BrowserTabCloseResultSchema = z.object({ tabId: TabId, closed: z.literal(true) });

export type BrowserInfo = z.output<typeof BrowserInfoSchema>;
export type BrowserTabInfo = z.output<typeof BrowserTabInfoSchema>;
export type BrowserTabsListResult = z.output<typeof BrowserTabsListResultSchema>;
export type BrowserPageReadResult = z.output<typeof BrowserPageReadResultSchema>;
export type BrowserScreenshotResult = z.output<typeof BrowserScreenshotResultSchema>;
export type BrowserTabActionResult = z.output<typeof BrowserTabActionResultSchema>;
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
  readonly browser?: BrowserInfo;
  readonly detail: string;
}
