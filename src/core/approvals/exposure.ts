import type { AuthContext, SessionRef } from "../auth/principal.js";
import { KNOWN_OPERATIONS } from "./operations.js";
import type { ApprovalRule } from "./types.js";

/**
 * Session exposure (ARCHITECTURE.md §27, AD-12; docs/design/approval-gates.md
 * §13.2). A session is `clean` until a source operation succeeds, then
 * `exposed` until the session ends. Exposure depends only on the operation,
 * never on content, and never grants anything.
 */

/** Reserved id of the built-in rule set; user rules may not use it. */
export const UNTRUSTED_CONTENT_RULE_ID = "untrusted-content";

export const UNTRUSTED_CONTENT_SETTINGS = ["require-approval", "off"] as const;
export type UntrustedContentSetting = (typeof UNTRUSTED_CONTENT_SETTINGS)[number];

/**
 * Operations whose successful result carries externally controlled content.
 * External MCP results will be added here (AD-12 point 9).
 */
export const EXPOSURE_SOURCES: readonly string[] = Object.freeze([
  "browser.page_read",
  "browser.screenshot",
  "browser.tabs_list",
  "network.request",
]);

/**
 * The built-in `untrusted-content` rule set (AD-12 point 4): in an exposed
 * session, operations with effects need approval. Ordinary ApprovalRules,
 * evaluated by PermissionEngine.approvalRequirement() like user rules.
 */
export const UNTRUSTED_CONTENT_RULES: readonly ApprovalRule[] = Object.freeze([
  Object.freeze({
    id: UNTRUSTED_CONTENT_RULE_ID,
    match: Object.freeze({
      exposed: true,
      capabilities: Object.freeze([
        "shell.execute",
        "filesystem.write",
        "git.write",
        "network.access",
        "browser.control",
      ] as const),
    }),
  }),
  Object.freeze({
    id: UNTRUSTED_CONTENT_RULE_ID,
    match: Object.freeze({ exposed: true, operations: Object.freeze(["docker.compose_up", "docker.compose_down"]) }),
  }),
]);

/** Shown to the agent when an operation gated by the built-in rule is not approved (AD-12 point 6). */
export const UNTRUSTED_CONTENT_MESSAGE =
  "This session has read untrusted content (a web page, screenshot, tab list or network response), " +
  "so operations with effects need the user's approval for the rest of the session.";

const SOURCES: ReadonlySet<string> = new Set(EXPOSURE_SOURCES);

/**
 * Keeps the exposure state of sessions, in memory only. There is deliberately
 * no way to clear it: an exposed session stays exposed until it ends (its
 * SessionRef is dropped by the adapter).
 */
export class ExposureTracker {
  private readonly exposed = new WeakSet<SessionRef>();
  /** The session of contexts without one: the whole process (AD-12 point 2). */
  private readonly processSession: SessionRef = Object.freeze({ id: "process" });

  constructor() {
    const known = new Set(KNOWN_OPERATIONS);
    const unknown = EXPOSURE_SOURCES.filter((op) => !known.has(op));
    if (unknown.length > 0) throw new Error(`Unknown exposure source operation(s): ${unknown.join(", ")}`);
  }

  static isSource(operation: string): boolean {
    return SOURCES.has(operation);
  }

  isExposed(context: AuthContext): boolean {
    return this.exposed.has(context.session ?? this.processSession);
  }

  /** Called by the guard after execute() of an operation succeeded, before its result is returned. */
  recordSuccess(context: AuthContext, operation: string): void {
    if (SOURCES.has(operation)) this.exposed.add(context.session ?? this.processSession);
  }
}
