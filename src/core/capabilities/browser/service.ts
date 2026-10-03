import { StringDecoder } from "node:string_decoder";
import type { z } from "zod";
import type { AuthContext } from "../../auth/principal.js";
import type { Limits } from "../../config/schema.js";
import { CrotError, parseInput, type CrotErrorCode } from "../../errors.js";
import type { ExecutionGuard } from "../../execution/guard.js";
import type { Capability } from "../../permissions/capabilities.js";
import type { BrowserCommand, BrowserCommandParams, BrowserConnection, BrowserConnectionState } from "./connection.js";
import {
  BROWSER_SCREENSHOT_MAX_BYTES,
  BrowserClickInputSchema,
  BrowserNavigateInputSchema,
  BrowserPageReadInputSchema,
  BrowserPageReadResultSchema,
  BrowserScreenshotInputSchema,
  BrowserScreenshotResultSchema,
  BrowserStatusInputSchema,
  BrowserTabActionResultSchema,
  BrowserTabActivateInputSchema,
  BrowserTabCloseInputSchema,
  BrowserTabCloseResultSchema,
  BrowserTabOpenInputSchema,
  BrowserTabsListInputSchema,
  BrowserTabsListResultSchema,
  BrowserTypeInputSchema,
  urlOrigin,
  type BrowserBridgeState,
  type BrowserClickInput,
  type BrowserNavigateInput,
  type BrowserPageReadInput,
  type BrowserPageReadResult,
  type BrowserScreenshotInput,
  type BrowserScreenshotResult,
  type BrowserStatus,
  type BrowserStatusInput,
  type BrowserTabActionResult,
  type BrowserTabActivateInput,
  type BrowserTabCloseInput,
  type BrowserTabCloseResult,
  type BrowserTabOpenInput,
  type BrowserTabsListInput,
  type BrowserTabsListResult,
  type BrowserTypeInput,
} from "./schemas.js";

/** Default time Core waits for the browser to answer one request. */
export const BROWSER_DEFAULT_TIMEOUT_MS = 30_000;

const MAX_BROWSER_ERROR_MESSAGE = 500;
const MAX_AUDIT_SELECTOR = 200;

/** Error codes a browser error may carry through to the agent. Anything else becomes OPERATION_FAILED. */
const PASS_THROUGH_CODES: ReadonlySet<CrotErrorCode> = new Set<CrotErrorCode>([
  "NOT_FOUND",
  "INVALID_INPUT",
  "TIMEOUT",
  "LIMIT_EXCEEDED",
  "RESOURCE_BUSY",
  "OPERATION_FAILED",
  "BROWSER_NOT_CONNECTED",
  "BROWSER_BRIDGE_IN_USE",
  "BROWSER_PAGE_RESTRICTED",
]);

const DISABLED_DETAIL =
  "Browser support is disabled. Set browser.enabled to true in the CROT configuration and connect the CROT Browser Extension.";
const WAITING_DETAIL = "Waiting for the CROT Browser Extension to connect.";
const IN_USE_DETAIL =
  "Another CROT instance owns the browser bridge. Browser operations are unavailable in this instance; all other capabilities work normally.";

export interface BrowserServiceDeps {
  readonly guard: ExecutionGuard;
  readonly limits: Pick<Limits, "maxReadBytes">;
  /** Absent when browser support is disabled. */
  readonly connection?: BrowserConnection;
  /** Per-request timeout (default BROWSER_DEFAULT_TIMEOUT_MS). */
  readonly timeoutMs?: number;
}

/**
 * Browser capability of CROT Core.
 *
 * Every method validates its input, runs through the ExecutionGuard (the
 * PermissionEngine authorizes browser.read or browser.control) and only then
 * checks the bridge and talks to the browser. Responses are validated against
 * Core's result schemas, and errors reported by the browser are mapped to an
 * allowlist of codes. Audit records hold tab ids, URL origins, truncated
 * selectors and text lengths: never page content, typed text or full URLs.
 */
export class BrowserService {
  private readonly timeoutMs: number;
  private readonly pending = new Set<AbortController>();
  private closed = false;

  constructor(private readonly deps: BrowserServiceDeps) {
    this.timeoutMs = deps.timeoutMs ?? BROWSER_DEFAULT_TIMEOUT_MS;
  }

  /** Bridge state for crot_status. Contains no browser data, so it needs no authorization. */
  state(): BrowserBridgeState {
    return this.deps.connection ? this.deps.connection.state().kind : "disabled";
  }

  /** Bridge state and connected browser (browser.read). Reports, rather than fails, when not connected. */
  async status(context: AuthContext, input: BrowserStatusInput = {}): Promise<BrowserStatus> {
    parseInput(BrowserStatusInputSchema, input);
    return this.run(context, "browser.status", "browser.read", {}, async () => {
      this.assertOpen();
      return describeState(this.deps.connection?.state());
    });
  }

  async listTabs(context: AuthContext, input: BrowserTabsListInput = {}): Promise<BrowserTabsListResult> {
    parseInput(BrowserTabsListInputSchema, input);
    return this.run(context, "browser.tabs_list", "browser.read", {}, async () => {
      const raw = await this.send("tabs.list", {});
      return validate(BrowserTabsListResultSchema, raw, "tabs.list");
    });
  }

  async readPage(context: AuthContext, input: BrowserPageReadInput = {}): Promise<BrowserPageReadResult> {
    const args = parseInput(BrowserPageReadInputSchema, input);
    const maxBytes = Math.min(args.maxBytes ?? this.deps.limits.maxReadBytes, this.deps.limits.maxReadBytes);
    return this.run(
      context,
      "browser.page_read",
      "browser.read",
      { tabId: tabRef(args.tabId), format: args.format, maxBytes },
      async () => {
        const raw = await this.send("page.read", { ...tab(args.tabId), format: args.format, maxBytes });
        const result = validate(BrowserPageReadResultSchema, raw, "page.read");
        expectTab("page.read", args.tabId, result.tabId);
        if (result.format !== args.format) throw invalidResponse("page.read");
        // The browser is asked to respect maxBytes; Core enforces it regardless.
        const content = truncateUtf8(result.content, maxBytes);
        return { ...result, content: content.text, truncated: result.truncated || content.truncated };
      },
    );
  }

  async screenshot(context: AuthContext, input: BrowserScreenshotInput = {}): Promise<BrowserScreenshotResult> {
    const args = parseInput(BrowserScreenshotInputSchema, input);
    return this.run(
      context,
      "browser.screenshot",
      "browser.read",
      { tabId: tabRef(args.tabId), format: args.format },
      async () => {
        const raw = await this.send("page.screenshot", {
          ...tab(args.tabId),
          format: args.format,
          ...(args.quality !== undefined ? { quality: args.quality } : {}),
        });
        const result = validate(BrowserScreenshotResultSchema, raw, "page.screenshot");
        expectTab("page.screenshot", args.tabId, result.tabId);
        if (result.mimeType !== `image/${args.format}`) throw invalidResponse("page.screenshot");
        if (Buffer.byteLength(result.data, "base64") > BROWSER_SCREENSHOT_MAX_BYTES) {
          throw new CrotError("LIMIT_EXCEEDED", `Screenshot exceeds ${BROWSER_SCREENSHOT_MAX_BYTES} bytes.`);
        }
        return result;
      },
    );
  }

  async openTab(context: AuthContext, input: BrowserTabOpenInput): Promise<BrowserTabActionResult> {
    const args = parseInput(BrowserTabOpenInputSchema, input);
    return this.run(
      context,
      "browser.tab_open",
      "browser.control",
      { origin: urlOrigin(args.url), active: args.active },
      async () => {
        const raw = await this.send("tabs.open", { url: args.url, active: args.active });
        return validate(BrowserTabActionResultSchema, raw, "tabs.open");
      },
    );
  }

  async navigate(context: AuthContext, input: BrowserNavigateInput): Promise<BrowserTabActionResult> {
    const args = parseInput(BrowserNavigateInputSchema, input);
    return this.run(
      context,
      "browser.navigate",
      "browser.control",
      { tabId: tabRef(args.tabId), origin: urlOrigin(args.url) },
      async () => {
        const raw = await this.send("tabs.navigate", { ...tab(args.tabId), url: args.url });
        const result = validate(BrowserTabActionResultSchema, raw, "tabs.navigate");
        expectTab("tabs.navigate", args.tabId, result.tabId);
        return result;
      },
    );
  }

  async activateTab(context: AuthContext, input: BrowserTabActivateInput): Promise<BrowserTabActionResult> {
    const args = parseInput(BrowserTabActivateInputSchema, input);
    return this.run(context, "browser.tab_activate", "browser.control", { tabId: args.tabId }, async () => {
      const raw = await this.send("tabs.activate", { tabId: args.tabId });
      const result = validate(BrowserTabActionResultSchema, raw, "tabs.activate");
      expectTab("tabs.activate", args.tabId, result.tabId);
      return result;
    });
  }

  async closeTab(context: AuthContext, input: BrowserTabCloseInput): Promise<BrowserTabCloseResult> {
    const args = parseInput(BrowserTabCloseInputSchema, input);
    return this.run(context, "browser.tab_close", "browser.control", { tabId: args.tabId }, async () => {
      const raw = await this.send("tabs.close", { tabId: args.tabId });
      const result = validate(BrowserTabCloseResultSchema, raw, "tabs.close");
      expectTab("tabs.close", args.tabId, result.tabId);
      return result;
    });
  }

  async click(context: AuthContext, input: BrowserClickInput): Promise<BrowserTabActionResult> {
    const args = parseInput(BrowserClickInputSchema, input);
    return this.run(
      context,
      "browser.click",
      "browser.control",
      { tabId: tabRef(args.tabId), selector: auditSelector(args.selector) },
      async () => {
        const raw = await this.send("page.click", { ...tab(args.tabId), selector: args.selector });
        const result = validate(BrowserTabActionResultSchema, raw, "page.click");
        expectTab("page.click", args.tabId, result.tabId);
        return result;
      },
    );
  }

  async type(context: AuthContext, input: BrowserTypeInput): Promise<BrowserTabActionResult> {
    const args = parseInput(BrowserTypeInputSchema, input);
    const details = {
      tabId: tabRef(args.tabId),
      selector: auditSelector(args.selector),
      textLength: args.text.length,
      clear: args.clear,
    };
    return this.run(context, "browser.type", "browser.control", details, async () => {
      const raw = await this.send("page.type", {
        ...tab(args.tabId),
        selector: args.selector,
        text: args.text,
        clear: args.clear,
      });
      const result = validate(BrowserTabActionResultSchema, raw, "page.type");
      expectTab("page.type", args.tabId, result.tabId);
      return result;
    });
  }

  /** Refuse new browser operations and cancel the ones waiting for the browser. Idempotent. */
  shutdown(): void {
    this.closed = true;
    for (const controller of this.pending) controller.abort();
    this.pending.clear();
  }

  private run<T>(
    context: AuthContext,
    operation: string,
    capability: Capability,
    details: Record<string, unknown>,
    execute: () => Promise<T>,
  ): Promise<T> {
    return this.deps.guard.run(context, { operation, capability, details }, execute);
  }

  private assertOpen(): void {
    if (this.closed)
      throw new CrotError("OPERATION_FAILED", "CROT is shutting down; browser operations are not accepted.");
  }

  /** Called only inside an authorized operation. */
  private requireConnection(): BrowserConnection {
    this.assertOpen();
    const connection = this.deps.connection;
    if (!connection) throw new CrotError("BROWSER_NOT_CONNECTED", DISABLED_DETAIL);
    const state = connection.state();
    if (state.kind === "in_use") throw new CrotError("BROWSER_BRIDGE_IN_USE", IN_USE_DETAIL);
    if (state.kind === "waiting") throw new CrotError("BROWSER_NOT_CONNECTED", WAITING_DETAIL);
    return connection;
  }

  private async send<C extends BrowserCommand>(command: C, params: BrowserCommandParams[C]): Promise<unknown> {
    const connection = this.requireConnection();
    const controller = new AbortController();
    this.pending.add(controller);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const interrupted = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener(
        "abort",
        () => reject(new CrotError("OPERATION_FAILED", "Browser request cancelled: CROT is shutting down.")),
        { once: true },
      );
      timer = setTimeout(() => {
        reject(new CrotError("TIMEOUT", `The browser did not answer ${command} within ${this.timeoutMs} ms.`));
        controller.abort();
      }, this.timeoutMs);
    });
    try {
      return await Promise.race([
        connection.request(command, params, { timeoutMs: this.timeoutMs, signal: controller.signal }),
        interrupted,
      ]);
    } catch (error) {
      throw sanitizeBrowserError(error);
    } finally {
      clearTimeout(timer);
      this.pending.delete(controller);
    }
  }
}

function describeState(state: BrowserConnectionState | undefined): BrowserStatus {
  if (!state) return { state: "disabled", detail: DISABLED_DETAIL };
  switch (state.kind) {
    case "connected":
      return {
        state: "connected",
        browser: state.browser,
        detail: `Connected to ${state.browser.name} ${state.browser.version} (CROT Browser Extension ${state.browser.extensionVersion}).`,
      };
    case "waiting":
      return { state: "waiting", detail: WAITING_DETAIL };
    case "in_use":
      return { state: "in_use", detail: IN_USE_DETAIL };
  }
}

const tab = (tabId: number | undefined): { tabId?: number } => (tabId === undefined ? {} : { tabId });

const tabRef = (tabId: number | undefined): number | "active" => tabId ?? "active";

const auditSelector = (selector: string): string =>
  selector.length > MAX_AUDIT_SELECTOR ? `${selector.slice(0, MAX_AUDIT_SELECTOR)}…` : selector;

const invalidResponse = (command: BrowserCommand): CrotError =>
  new CrotError("OPERATION_FAILED", `The browser returned an invalid response to ${command}.`);

function validate<S extends z.ZodType>(schema: S, raw: unknown, command: BrowserCommand): z.output<S> {
  const result = schema.safeParse(raw);
  if (!result.success) throw invalidResponse(command);
  return result.data;
}

function expectTab(command: BrowserCommand, requested: number | undefined, actual: number): void {
  if (requested !== undefined && requested !== actual) {
    throw new CrotError("OPERATION_FAILED", `The browser answered ${command} for a different tab.`);
  }
}

/** Truncate to at most `maxBytes` UTF-8 bytes without splitting a character. */
function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return { text, truncated: false };
  return { text: new StringDecoder("utf8").write(bytes.subarray(0, maxBytes)), truncated: true };
}

function cleanMessage(message: string): string {
  const cleaned = message
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .trim()
    .slice(0, MAX_BROWSER_ERROR_MESSAGE);
  return cleaned.length > 0 ? cleaned : "unknown error";
}

/** Map an error from the browser side to an allowlisted code with a bounded message and no details. */
function sanitizeBrowserError(error: unknown): CrotError {
  if (error instanceof CrotError && PASS_THROUGH_CODES.has(error.code))
    return new CrotError(error.code, cleanMessage(error.message));
  const message = error instanceof Error ? error.message : String(error);
  return new CrotError("OPERATION_FAILED", `Browser operation failed: ${cleanMessage(message)}`);
}
