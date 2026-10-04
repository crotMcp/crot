import { StringDecoder } from "node:string_decoder";
import type { z } from "zod";
import { normalizedHttpOrigin } from "../../approvals/subject.js";
import type { ApprovalBinding, ApprovalBrowserSubject, ApprovalEffect } from "../../approvals/types.js";
import type { AuthContext } from "../../auth/principal.js";
import type { Limits } from "../../config/schema.js";
import { CrotError, parseInput, type CrotErrorCode } from "../../errors.js";
import { ApprovalBindingError, type ExecutionGuard } from "../../execution/guard.js";
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

  async openTab(context: AuthContext, input: BrowserTabOpenInput): Promise<BrowserTabActionResult> {
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
        const raw = await this.send("tabs.open", bindParams({ url: args.url, active: args.active }, bound), bound);
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
      {
        summary: "Navigate a browser tab to a URL",
        effects: [{ label: "URL", value: args.url }],
        target: { tabId: args.tabId },
      },
      async (bound) => {
        const raw = await this.send("tabs.navigate", bindParams({ ...tab(args.tabId), url: args.url }, bound), bound);
        const result = validate(BrowserTabActionResultSchema, raw, "tabs.navigate");
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

  async click(context: AuthContext, input: BrowserClickInput): Promise<BrowserTabActionResult> {
    const args = parseInput(BrowserClickInputSchema, input);
    return this.run(
      context,
      "browser.click",
      "browser.control",
      { tabId: tabRef(args.tabId), selector: auditSelector(args.selector) },
      {
        summary: "Click an element in a browser tab",
        effects: [{ label: "selector", value: args.selector }],
        target: { tabId: args.tabId },
      },
      async (bound) => {
        const raw = await this.send(
          "page.click",
          bindParams({ ...tab(args.tabId), selector: args.selector }, bound),
          bound,
        );
        const result = validate(BrowserTabActionResultSchema, raw, "page.click");
        expectTab("page.click", bound?.tabId ?? args.tabId, result.tabId);
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
    const approval: BrowserApproval = {
      summary: "Type text into an element in a browser tab",
      effects: [
        { label: "selector", value: args.selector },
        { label: "text length", value: String(args.text.length), flag: "secret_size_only" },
        { label: "clear first", value: String(args.clear) },
      ],
      target: { tabId: args.tabId },
    };
    return this.run(context, "browser.type", "browser.control", details, approval, async (bound) => {
      const raw = await this.send(
        "page.type",
        bindParams({ ...tab(args.tabId), selector: args.selector, text: args.text, clear: args.clear }, bound),
        bound,
      );
      const result = validate(BrowserTabActionResultSchema, raw, "page.type");
      expectTab("page.type", bound?.tabId ?? args.tabId, result.tabId);
      return result;
    });
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
        { label: "tab URL", value: resolved.url },
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
        reject(new CrotError("TIMEOUT", `The browser did not answer ${command} within ${this.timeoutMs} ms.`));
        controller.abort();
      }, this.timeoutMs);
    });
    try {
      return await Promise.race([
        connection.request(command, params, {
          timeoutMs: this.timeoutMs,
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
