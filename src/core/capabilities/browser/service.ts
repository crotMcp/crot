import { StringDecoder } from "node:string_decoder";
import type { z } from "zod";
import { normalizedHttpOrigin } from "../../approvals/subject.js";
import type { ApprovalBinding, ApprovalBrowserSubject, ApprovalEffect } from "../../approvals/types.js";
import type { AuthContext } from "../../auth/principal.js";
import type { Limits } from "../../config/schema.js";
import { CrotError, parseInput, type CrotErrorCode } from "../../errors.js";
import { ApprovalBindingError, type ExecutionGuard } from "../../execution/guard.js";
import type { Capability } from "../../permissions/capabilities.js";
import type {
  BrowserCommand,
  BrowserCommandParams,
  BrowserConnection,
  BrowserConnectionState,
  BrowserWaitUntil,
} from "./connection.js";
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
  type BrowserHistoryInput,
  type BrowserWaitResult,
  type BrowserWaitInput,
  type BrowserSetCheckedResult,
  type BrowserSetCheckedInput,
  type BrowserSelectOptionResult,
  type BrowserSelectOptionInput,
  type BrowserPressKeyInput,
  type BrowserDragInput,
  type BrowserScrollInput,
  type BrowserHoverInput,
  type BrowserSnapshotResult,
  type BrowserSnapshotInput,
  type BrowserControlResult,
  BrowserHistoryInputSchema,
  BrowserWaitResultSchema,
  BrowserWaitInputSchema,
  BrowserSetCheckedResultSchema,
  BrowserSetCheckedInputSchema,
  BrowserSelectOptionResultSchema,
  BrowserSelectOptionInputSchema,
  BrowserPressKeyInputSchema,
  BrowserDragInputSchema,
  BrowserScrollInputSchema,
  BrowserHoverInputSchema,
  BrowserSnapshotResultSchema,
  BrowserSnapshotInputSchema,
  BrowserControlResultSchema,
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
/** Default settle/wait time of the extension (its WAIT_TIMEOUT_DEFAULT_MS). */
export const BROWSER_WAIT_DEFAULT_MS = 20_000;
/** Added to a settle/wait time for the request timeout: action, transport and the quiet period. */
export const BROWSER_WAIT_MARGIN_MS = 10_000;
/** Commands in flight per tab (the extension's TAB_QUEUE_MAX). */
export const BROWSER_TAB_QUEUE_MAX = 16;

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
  "BROWSER_STALE_REF",
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
 *
 * Approval gates (AD-6, AD-8, AD-9, AD-11): when a gate rule matches a
 * tab-targeting operation, the guard asks this service to bind it first. The
 * concrete tab and its URL are resolved with `tabs.resolve` (the given tab or
 * the active tab of the last focused window) and recorded together with the
 * normalized origin and the bridge's connectionId in the approval subject.
 * `browser.tab_open` is bound to the origin of the URL it opens. After the
 * approval, every command of the operation names the concrete tab and carries
 * the expected subject; the bridge sends it only on the approved connection
 * and the extension checks tab, origin and connection immediately before it
 * acts. Any mismatch denies the operation (PERMISSION_DENIED) without acting.
 */
export class BrowserService {
  private readonly timeoutMs: number;
  private readonly pending = new Set<AbortController>();
  private readonly inFlight = new Map<number | "active", number>();
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
    return this.run(
      context,
      "browser.status",
      "browser.read",
      {},
      NO_TARGET("Report the browser connection status"),
      async () => {
        this.assertOpen();
        return describeState(this.deps.connection?.state());
      },
    );
  }

  async listTabs(context: AuthContext, input: BrowserTabsListInput = {}): Promise<BrowserTabsListResult> {
    parseInput(BrowserTabsListInputSchema, input);
    return this.run(
      context,
      "browser.tabs_list",
      "browser.read",
      {},
      NO_TARGET("List the open browser tabs"),
      async () => {
        const raw = await this.send("tabs.list", {});
        return validate(BrowserTabsListResultSchema, raw, "tabs.list");
      },
    );
  }

  async readPage(context: AuthContext, input: BrowserPageReadInput = {}): Promise<BrowserPageReadResult> {
    const args = parseInput(BrowserPageReadInputSchema, input);
    const maxBytes = Math.min(args.maxBytes ?? this.deps.limits.maxReadBytes, this.deps.limits.maxReadBytes);
    return this.run(
      context,
      "browser.page_read",
      "browser.read",
      { tabId: tabRef(args.tabId), format: args.format, maxBytes },
      {
        summary: "Read the content of a browser tab",
        effects: [
          { label: "format", value: args.format },
          { label: "maximum bytes", value: String(maxBytes) },
        ],
        target: { tabId: args.tabId },
      },
      async (bound) => {
        const raw = await this.send(
          "page.read",
          bindParams({ ...tab(args.tabId), format: args.format, maxBytes }, bound),
          bound,
        );
        const result = validate(BrowserPageReadResultSchema, raw, "page.read");
        expectTab("page.read", bound?.tabId ?? args.tabId, result.tabId);
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
      {
        summary: "Take a screenshot of a browser tab",
        effects: [{ label: "format", value: args.format }],
        target: { tabId: args.tabId },
      },
      async (bound) => {
        const raw = await this.send(
          "page.screenshot",
          bindParams(
            {
              ...tab(args.tabId),
              format: args.format,
              ...(args.quality !== undefined ? { quality: args.quality } : {}),
            },
            bound,
          ),
          bound,
        );
        const result = validate(BrowserScreenshotResultSchema, raw, "page.screenshot");
        expectTab("page.screenshot", bound?.tabId ?? args.tabId, result.tabId);
        if (result.mimeType !== `image/${args.format}`) throw invalidResponse("page.screenshot");
        if (Buffer.byteLength(result.data, "base64") > BROWSER_SCREENSHOT_MAX_BYTES) {
          throw new CrotError("LIMIT_EXCEEDED", `Screenshot exceeds ${BROWSER_SCREENSHOT_MAX_BYTES} bytes.`);
        }
        return result;
      },
    );
  }

  async openTab(context: AuthContext, input: BrowserTabOpenInput): Promise<BrowserControlResult> {
    const args = parseInput(BrowserTabOpenInputSchema, input);
    return this.run(
      context,
      "browser.tab_open",
      "browser.control",
      { origin: urlOrigin(args.url), active: args.active },
      {
        summary: "Open a new browser tab",
        effects: [
          { label: "URL", value: args.url },
          { label: "active", value: String(args.active) },
        ],
        target: { url: args.url },
      },
      async (bound) => {
        const settle = settleParams(args);
        const raw = await this.send(
          "tabs.open",
          bindParams({ url: args.url, active: args.active, ...settle }, bound),
          bound,
          bound?.connectionId,
          hasSettle(settle) ? this.waitBudget(args.timeoutMs) : undefined,
        );
        return validate(BrowserControlResultSchema, raw, "tabs.open");
      },
    );
  }

  async navigate(context: AuthContext, input: BrowserNavigateInput): Promise<BrowserControlResult> {
    const args = parseInput(BrowserNavigateInputSchema, input);
    return this.run(
      context,
      "browser.navigate",
      "browser.control",
      { tabId: tabRef(args.tabId), origin: urlOrigin(args.url) },
      {
        summary: "Navigate a browser tab to a URL",
        effects: [{ label: "URL", value: args.url }],
        target: { tabId: args.tabId },
      },
      async (bound) => {
        const settle = settleParams(args);
        const raw = await this.perTab(bound?.tabId ?? args.tabId, () =>
          this.send(
            "tabs.navigate",
            bindParams({ ...tab(args.tabId), url: args.url, ...settle }, bound),
            bound,
            bound?.connectionId,
            hasSettle(settle) ? this.waitBudget(args.timeoutMs) : undefined,
          ),
        );
        const result = validate(BrowserControlResultSchema, raw, "tabs.navigate");
        expectTab("tabs.navigate", bound?.tabId ?? args.tabId, result.tabId);
        return result;
      },
    );
  }

  async activateTab(context: AuthContext, input: BrowserTabActivateInput): Promise<BrowserTabActionResult> {
    const args = parseInput(BrowserTabActivateInputSchema, input);
    const approval = { summary: "Activate a browser tab", effects: [], target: { tabId: args.tabId } };
    return this.run(
      context,
      "browser.tab_activate",
      "browser.control",
      { tabId: args.tabId },
      approval,
      async (bound) => {
        const raw = await this.send("tabs.activate", bindParams({ tabId: args.tabId }, bound), bound);
        const result = validate(BrowserTabActionResultSchema, raw, "tabs.activate");
        expectTab("tabs.activate", args.tabId, result.tabId);
        return result;
      },
    );
  }

  async closeTab(context: AuthContext, input: BrowserTabCloseInput): Promise<BrowserTabCloseResult> {
    const args = parseInput(BrowserTabCloseInputSchema, input);
    const approval = { summary: "Close a browser tab", effects: [], target: { tabId: args.tabId } };
    return this.run(context, "browser.tab_close", "browser.control", { tabId: args.tabId }, approval, async (bound) => {
      const raw = await this.send("tabs.close", bindParams({ tabId: args.tabId }, bound), bound);
      const result = validate(BrowserTabCloseResultSchema, raw, "tabs.close");
      expectTab("tabs.close", args.tabId, result.tabId);
      return result;
    });
  }

  async click(context: AuthContext, input: BrowserClickInput): Promise<BrowserControlResult> {
    const args = parseInput(BrowserClickInputSchema, input);
    const legacy = args.ref === undefined && isLegacy(args, ["tabId", "selector"]);
    const options = {
      ...(args.button !== undefined ? { button: args.button } : {}),
      ...(args.clickCount !== undefined ? { clickCount: args.clickCount } : {}),
      ...(args.modifiers !== undefined ? { modifiers: args.modifiers } : {}),
    };
    return this.control(context, "browser.click", "page.click", args, BrowserControlResultSchema, {
      summary: "Click an element in a browser tab",
      params: options,
      details: options,
      effects: [
        ...(args.button !== undefined ? [{ label: "button", value: args.button }] : []),
        ...(args.clickCount === 2 ? [{ label: "click count", value: "2" }] : []),
        ...(args.modifiers?.length ? [{ label: "modifiers", value: args.modifiers.join("+") }] : []),
      ],
      legacy,
    });
  }

  async type(context: AuthContext, input: BrowserTypeInput): Promise<BrowserControlResult> {
    const args = parseInput(BrowserTypeInputSchema, input);
    const legacy = args.ref === undefined && isLegacy(args, ["tabId", "selector", "text", "clear"]);
    return this.control(context, "browser.type", "page.type", args, BrowserControlResultSchema, {
      summary: "Type text into an element in a browser tab",
      params: { text: args.text, clear: args.clear, ...(args.submit !== undefined ? { submit: args.submit } : {}) },
      details: { textLength: args.text.length, clear: args.clear, ...(args.submit ? { submit: true } : {}) },
      effects: [
        { label: "text length", value: String(args.text.length), flag: "secret_size_only" },
        { label: "clear first", value: String(args.clear) },
        ...(args.submit ? [{ label: "submit", value: "press Enter afterwards" }] : []),
      ],
      legacy,
    });
  }

  /** Accessibility snapshot with element refs (AD-16 point 5). An exposure source. */
  async snapshot(context: AuthContext, input: BrowserSnapshotInput = {}): Promise<BrowserSnapshotResult> {
    const args = parseInput(BrowserSnapshotInputSchema, input);
    const params = {
      ...tab(args.tabId),
      includeText: args.includeText,
      ...(args.frameRef !== undefined ? { frameRef: args.frameRef } : {}),
      ...(args.maxElements !== undefined ? { maxElements: args.maxElements } : {}),
    };
    return this.run(
      context,
      "browser.snapshot",
      "browser.read",
      {
        tabId: tabRef(args.tabId),
        includeText: args.includeText,
        ...(args.frameRef ? { frameRef: args.frameRef } : {}),
      },
      {
        summary: "Take an accessibility snapshot of a browser tab",
        effects: [{ label: "include text", value: String(args.includeText) }],
        target: { tabId: args.tabId },
      },
      async (bound) => {
        const raw = await this.perTab(bound?.tabId ?? args.tabId, () =>
          this.send("page.snapshot", bindParams(params, bound), bound),
        );
        const result = validate(BrowserSnapshotResultSchema, raw, "page.snapshot");
        expectTab("page.snapshot", bound?.tabId ?? args.tabId, result.tabId);
        return result;
      },
    );
  }

  async hover(context: AuthContext, input: BrowserHoverInput): Promise<BrowserControlResult> {
    const args = parseInput(BrowserHoverInputSchema, input);
    return this.control(context, "browser.hover", "page.hover", args, BrowserControlResultSchema, {
      summary: "Hover over an element in a browser tab",
    });
  }

  async scroll(context: AuthContext, input: BrowserScrollInput): Promise<BrowserControlResult> {
    const args = parseInput(BrowserScrollInputSchema, input);
    const deltas = {
      ...(args.deltaX !== undefined ? { deltaX: args.deltaX } : {}),
      ...(args.deltaY !== undefined ? { deltaY: args.deltaY } : {}),
    };
    return this.control(context, "browser.scroll", "page.scroll", args, BrowserControlResultSchema, {
      summary: "Scroll in a browser tab",
      params: deltas,
      details: deltas,
      effects: Object.entries(deltas).map(([label, value]) => ({ label, value: String(value) })),
    });
  }

  async drag(context: AuthContext, input: BrowserDragInput): Promise<BrowserControlResult> {
    const args = parseInput(BrowserDragInputSchema, input);
    const to = args.to.ref !== undefined ? { ref: args.to.ref } : { selector: args.to.selector as string };
    return this.control(context, "browser.drag", "page.drag", args, BrowserControlResultSchema, {
      summary: "Drag an element in a browser tab",
      params: { to },
      details: { to: auditTarget(to) },
      effects: [describeTarget(to, "drop on")],
    });
  }

  async pressKey(context: AuthContext, input: BrowserPressKeyInput): Promise<BrowserControlResult> {
    const args = parseInput(BrowserPressKeyInputSchema, input);
    return this.control(context, "browser.press_key", "page.press_key", args, BrowserControlResultSchema, {
      summary: "Press keys in a browser tab",
      params: { keys: args.keys },
      // Key sequences are never audited or shown, only their count (AD-16 point 6).
      details: { keyCount: args.keys.length },
      effects: [{ label: "key combinations", value: String(args.keys.length), flag: "secret_size_only" }],
    });
  }

  async selectOption(context: AuthContext, input: BrowserSelectOptionInput): Promise<BrowserSelectOptionResult> {
    const args = parseInput(BrowserSelectOptionInputSchema, input);
    return this.control(context, "browser.select_option", "page.select_option", args, BrowserSelectOptionResultSchema, {
      summary: "Select options in a browser tab",
      params: { values: args.values },
      details: { valueCount: args.values.length },
      effects: [{ label: "values", value: args.values.join(", ").slice(0, 500) }],
    });
  }

  async setChecked(context: AuthContext, input: BrowserSetCheckedInput): Promise<BrowserSetCheckedResult> {
    const args = parseInput(BrowserSetCheckedInputSchema, input);
    return this.control(context, "browser.set_checked", "page.set_checked", args, BrowserSetCheckedResultSchema, {
      summary: args.checked ? "Check an element in a browser tab" : "Uncheck an element in a browser tab",
      params: { checked: args.checked },
      details: { checked: args.checked },
      effects: [{ label: "checked", value: String(args.checked) }],
    });
  }

  /** Wait for one condition (browser.read): it observes the page and does not act on it. */
  async wait(context: AuthContext, input: BrowserWaitInput): Promise<BrowserWaitResult> {
    const args = parseInput(BrowserWaitInputSchema, input);
    const { tabId: _tabId, ...condition } = args;
    const kind = Object.keys(condition).find((k) => k !== "state" && k !== "timeoutMs") ?? "unknown";
    return this.run(
      context,
      "browser.wait",
      "browser.read",
      {
        tabId: tabRef(args.tabId),
        condition: kind,
        ...(args.state ? { state: args.state } : {}),
        ...(args.selector !== undefined ? { selector: auditSelector(args.selector) } : {}),
        ...(args.ref !== undefined ? { ref: args.ref } : {}),
        ...(args.text !== undefined ? { textLength: args.text.length } : {}),
        ...(args.textGone !== undefined ? { textLength: args.textGone.length } : {}),
        ...(args.urlPrefix !== undefined ? { origin: urlOrigin(args.urlPrefix) } : {}),
        ...(args.loadState ? { loadState: args.loadState } : {}),
      },
      {
        summary: "Wait for a condition in a browser tab",
        effects: [{ label: "condition", value: kind }],
        target: { tabId: args.tabId },
      },
      async (bound) => {
        const raw = await this.send(
          "page.wait",
          bindParams({ ...tab(args.tabId), ...condition }, bound),
          bound,
          bound?.connectionId,
          this.waitBudget(args.timeoutMs),
        );
        return validate(BrowserWaitResultSchema, raw, "page.wait");
      },
    );
  }

  async history(context: AuthContext, input: BrowserHistoryInput): Promise<BrowserControlResult> {
    const args = parseInput(BrowserHistoryInputSchema, input);
    const settle = settleParams(args);
    return this.run(
      context,
      "browser.history",
      "browser.control",
      { tabId: tabRef(args.tabId), action: args.action },
      {
        summary: `Browser history: ${args.action}`,
        effects: [{ label: "action", value: args.action }],
        target: { tabId: args.tabId },
      },
      async (bound) => {
        const raw = await this.perTab(bound?.tabId ?? args.tabId, () =>
          this.send(
            "tabs.history",
            bindParams({ ...tab(args.tabId), action: args.action, ...settle }, bound),
            bound,
            bound?.connectionId,
            this.waitBudget(args.timeoutMs),
          ),
        );
        const result = validate(BrowserControlResultSchema, raw, "tabs.history");
        expectTab("tabs.history", bound?.tabId ?? args.tabId, result.tabId);
        return result;
      },
    );
  }

  /**
   * One element-targeting control command (AD-16 points 5-7): target by ref or
   * selector, settle options, audit with the truncated selector or the ref,
   * a per-tab bound, a request timeout covering the settle phase.
   */
  private control<S extends z.ZodType<BrowserControlResult>>(
    context: AuthContext,
    operation: string,
    command: BrowserCommand,
    args: { tabId?: number; ref?: string; selector?: string; waitUntil?: BrowserWaitUntil; timeoutMs?: number },
    schema: S,
    spec: {
      summary: string;
      params?: Record<string, unknown>;
      details?: Record<string, unknown>;
      effects?: readonly ApprovalEffect[];
      /** The legacy selector form (page function); sent unchanged. */
      legacy?: boolean;
    },
  ): Promise<z.output<S>> {
    const target =
      args.ref !== undefined ? { ref: args.ref } : args.selector !== undefined ? { selector: args.selector } : {};
    const settle = settleParams(args);
    return this.run(
      context,
      operation,
      "browser.control",
      { tabId: tabRef(args.tabId), ...auditTarget(target), ...(spec.details ?? {}), ...settle },
      {
        summary: spec.summary,
        effects: [
          ...("ref" in target || "selector" in target ? [describeTarget(target)] : []),
          ...(spec.effects ?? []),
        ],
        target: { tabId: args.tabId },
      },
      async (bound) => {
        const params = { ...tab(args.tabId), ...target, ...(spec.params ?? {}), ...(spec.legacy ? {} : settle) };
        const raw = await this.perTab(bound?.tabId ?? args.tabId, () =>
          this.send(
            command,
            bindParams(params, bound) as BrowserCommandParams[typeof command],
            bound,
            bound?.connectionId,
            spec.legacy ? undefined : this.waitBudget(args.timeoutMs),
          ),
        );
        const result = validate(schema, raw, command);
        expectTab(command, bound?.tabId ?? args.tabId, result.tabId);
        return result;
      },
    );
  }

  /** Request timeout of a command with a settle or wait phase: the phase plus a margin, never below the default. */
  private waitBudget(timeoutMs: number | undefined): number {
    return Math.max(this.timeoutMs, (timeoutMs ?? BROWSER_WAIT_DEFAULT_MS) + BROWSER_WAIT_MARGIN_MS);
  }

  /**
   * Bound the commands in flight for one tab (the extension runs them one at a
   * time, in order). Beyond BROWSER_TAB_QUEUE_MAX Core refuses with RESOURCE_BUSY.
   */
  private async perTab<T>(tabId: number | undefined, run: () => Promise<T>): Promise<T> {
    const key = tabId ?? "active";
    const count = this.inFlight.get(key) ?? 0;
    if (count >= BROWSER_TAB_QUEUE_MAX)
      throw new CrotError("RESOURCE_BUSY", "Too many browser commands are queued for this tab.");
    this.inFlight.set(key, count + 1);
    try {
      return await run();
    } finally {
      const left = (this.inFlight.get(key) ?? 1) - 1;
      if (left === 0) this.inFlight.delete(key);
      else this.inFlight.set(key, left);
    }
  }

  /** Refuse new browser operations and cancel the ones waiting for the browser. Idempotent. */
  shutdown(): void {
    this.closed = true;
    for (const controller of this.pending) controller.abort();
    this.pending.clear();
  }

  /**
   * Run one browser operation through the guard. `approval` describes it for
   * the approval subject; `bind` is called by the guard only when a gate rule
   * matched. `execute` receives the binding of an approved operation, or
   * undefined when the operation is not gated.
   */
  private run<T>(
    context: AuthContext,
    operation: string,
    capability: Capability,
    details: Record<string, unknown>,
    approval: BrowserApproval,
    execute: (bound: ApprovalBrowserSubject | undefined) => Promise<T>,
  ): Promise<T> {
    let bound: ApprovalBrowserSubject | undefined;
    const target = approval.target;
    const bind =
      target === undefined
        ? undefined
        : async (): Promise<ApprovalBinding> => {
            const binding = await this.bindTarget(target);
            bound = binding.browser;
            return binding;
          };
    return this.deps.guard.run(
      context,
      {
        operation,
        capability,
        details,
        approval: { summary: approval.summary, effects: approval.effects, ...(bind ? { bind } : {}) },
      },
      () => execute(bound),
    );
  }

  /**
   * Bind a gated operation to its concrete target (AD-6, AD-8, AD-9): the
   * connection it will use, and the resolved tab with its normalized origin
   * (or, for tab_open, the origin of the URL). Throws when anything cannot be
   * determined; the guard then denies without creating a request.
   */
  private async bindTarget(target: BrowserTarget): Promise<ApprovalBinding> {
    const state = this.requireConnection().state();
    if (state.kind !== "connected") throw new CrotError("BROWSER_NOT_CONNECTED", WAITING_DETAIL);
    const connectionId = state.connectionId;
    if ("url" in target) {
      const origin = normalizedHttpOrigin(target.url);
      if (origin === undefined) throw new CrotError("INVALID_INPUT", "The URL has no http(s) origin.");
      return { browser: { origin, connectionId } };
    }
    const raw = await this.send("tabs.resolve", tab(target.tabId), undefined, connectionId);
    const resolved = validate(BrowserTabActionResultSchema, raw, "tabs.resolve");
    if (target.tabId !== undefined && resolved.tabId !== target.tabId) throw invalidResponse("tabs.resolve");
    const origin = normalizedHttpOrigin(resolved.url);
    if (origin === undefined) throw new CrotError("BROWSER_PAGE_RESTRICTED", "The tab has no http(s) origin.");
    return {
      browser: { tabId: resolved.tabId, origin, connectionId },
      effects: [
        { label: "tab", value: String(resolved.tabId) },
        // The URL is reported by the page's document (history.pushState can change its path).
        { label: "tab URL", value: resolved.url, flag: "page_supplied" },
        { label: "tab origin", value: origin },
      ],
    };
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

  /**
   * Send one command. With `bound` (an approved, gated operation) it is sent
   * only on the approved connection, and a PERMISSION_DENIED answer (the
   * expected subject no longer holds) becomes an ApprovalBindingError.
   * `connectionId` alone pins tabs.resolve to the connection being bound.
   */
  /** The connection of an approved operation; a changed or lost connection invalidates the approval (AD-9). */
  private boundConnection(bound: ApprovalBrowserSubject): BrowserConnection {
    this.assertOpen();
    const connection = this.deps.connection;
    const state = connection?.state();
    if (!connection || state?.kind !== "connected" || state.connectionId !== bound.connectionId)
      throw new ApprovalBindingError("The browser connection changed since the operation was approved.");
    return connection;
  }

  private async send<C extends BrowserCommand>(
    command: C,
    params: BrowserCommandParams[C],
    bound?: ApprovalBrowserSubject,
    connectionId: string | undefined = bound?.connectionId,
    timeoutMs: number = this.timeoutMs,
  ): Promise<unknown> {
    const connection = bound ? this.boundConnection(bound) : this.requireConnection();
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
        reject(new CrotError("TIMEOUT", `The browser did not answer ${command} within ${timeoutMs} ms.`));
        controller.abort();
      }, timeoutMs);
    });
    try {
      return await Promise.race([
        connection.request(command, params, {
          timeoutMs,
          signal: controller.signal,
          ...(connectionId !== undefined ? { connectionId } : {}),
        }),
        interrupted,
      ]);
    } catch (error) {
      if (bound && error instanceof CrotError && error.code === "PERMISSION_DENIED")
        throw new ApprovalBindingError(cleanMessage(error.message));
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

/** What a gated browser operation is bound to: a tab (given, or the active one), or the URL tab_open opens. */
type BrowserTarget = { readonly tabId: number | undefined } | { readonly url: string };

interface BrowserApproval {
  readonly summary: string;
  readonly effects: readonly ApprovalEffect[];
  /** Absent: the operation does not act on a tab (status, tabs_list) and has no browser binding. */
  readonly target?: BrowserTarget;
}

const NO_TARGET = (summary: string): BrowserApproval => ({ summary, effects: [] });

/**
 * Parameters of an approved operation: the concrete tab of the binding and
 * the expected browser subject (AD-11). Unchanged when the operation is not gated.
 */
function bindParams<P extends object>(params: P, bound: ApprovalBrowserSubject | undefined): P {
  if (!bound) return params;
  const expect = {
    ...(bound.tabId !== undefined ? { tabId: bound.tabId } : {}),
    origin: bound.origin,
    connectionId: bound.connectionId,
  };
  return { ...params, ...(bound.tabId !== undefined ? { tabId: bound.tabId } : {}), expect };
}

const tabRef = (tabId: number | undefined): number | "active" => tabId ?? "active";

function settleParams(args: { waitUntil?: BrowserWaitUntil; timeoutMs?: number }): {
  waitUntil?: BrowserWaitUntil;
  timeoutMs?: number;
} {
  return {
    ...(args.waitUntil !== undefined ? { waitUntil: args.waitUntil } : {}),
    ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
  };
}

const hasSettle = (settle: object): boolean => Object.keys(settle).length > 0;

/** Whether only the given keys carry values: the legacy selector form, kept on the page function. */
function isLegacy(args: object, keys: readonly string[]): boolean {
  return Object.entries(args).every(([k, v]) => v === undefined || keys.includes(k));
}

/** Audit form of an element target: the ref, or the truncated selector. */
function auditTarget(target: { ref?: string; selector?: string }): Record<string, string> {
  if (target.ref !== undefined) return { ref: target.ref };
  if (target.selector !== undefined) return { selector: auditSelector(target.selector) };
  return {};
}

function describeTarget(target: { ref?: string; selector?: string }, prefix = "element"): ApprovalEffect {
  return target.ref !== undefined
    ? { label: `${prefix} ref`, value: target.ref }
    : { label: prefix === "element" ? "selector" : `${prefix} selector`, value: target.selector ?? "" };
}

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
