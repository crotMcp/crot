import { remoteExposureScope, type AuthContext, type ExposureScope } from "../auth/principal.js";
import { KNOWN_OPERATIONS } from "./operations.js";
import { RemoteExposureStore } from "./remote-exposure.js";
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

export interface ExposureTrackerOptions {
  /**
   * Persistent state of remote scopes (AD-15 point 8). Without a store every
   * remote scope is treated as exposed (fail closed).
   */
  readonly remote?: RemoteExposureStore;
}

/**
 * Keeps the exposure state per exposure scope (AD-15 point 8). There is
 * deliberately no way to clear it:
 *
 * - local scopes (stdio connection, legacy loopback session, sessionless
 *   loopback principal) are kept in memory, keyed by identity, and stay
 *   exposed until the adapter drops the scope;
 * - remote scopes are keyed by (accountId, deviceId, clientId), independent of
 *   sessions and tokens, and persisted by the RemoteExposureStore.
 */
export class ExposureTracker {
  private readonly exposed = new WeakSet<ExposureScope>();
  /** The scope of contexts without one: the whole process (AD-12 point 2). */
  private readonly processScope: ExposureScope = Object.freeze({ id: "process" });
  private readonly remote: RemoteExposureStore | undefined;

  constructor(options: ExposureTrackerOptions = {}) {
    const known = new Set(KNOWN_OPERATIONS);
    const unknown = EXPOSURE_SOURCES.filter((op) => !known.has(op));
    if (unknown.length > 0) throw new Error(`Unknown exposure source operation(s): ${unknown.join(", ")}`);
    this.remote = options.remote;
  }

  static isSource(operation: string): boolean {
    return SOURCES.has(operation);
  }

  /**
   * A remote principal without an identifiable remote scope: always exposed,
   * never shared (fail closed).
   */
  private readonly unidentifiedRemote: ExposureScope = Object.freeze({ id: "remote-unidentified" });

  /**
   * The exposure scope of a context: its exposure scope, else its session,
   * else the process. A remote principal is never placed in a local scope:
   * without a remote scope it gets one from its (accountId, deviceId,
   * clientId), and without those identifiers it is always exposed.
   */
  scopeOf(context: AuthContext): ExposureScope {
    const scope = context.exposureScope ?? context.session;
    if (context.principal.kind !== "remote") return scope ?? this.processScope;
    if (scope?.remoteKey !== undefined) return scope;
    const { accountId, deviceId, clientId } = context.principal;
    if (accountId && deviceId && clientId) return remoteExposureScope(accountId, deviceId, clientId);
    return this.unidentifiedRemote;
  }

  /** Whether two contexts share one exposure scope. */
  sameScope(a: AuthContext, b: AuthContext): boolean {
    const x = this.scopeOf(a);
    const y = this.scopeOf(b);
    if (x.remoteKey !== undefined || y.remoteKey !== undefined) return x.remoteKey === y.remoteKey;
    return x === y;
  }

  isExposed(context: AuthContext): boolean {
    const scope = this.scopeOf(context);
    if (scope === this.unidentifiedRemote) return true;
    if (scope.remoteKey !== undefined) return this.remote ? this.remote.isExposed(scope.remoteKey) : true;
    return this.exposed.has(scope);
  }

  /** Called by the guard after execute() of an operation succeeded, before its result is returned. */
  recordSuccess(context: AuthContext, operation: string): void {
    if (!SOURCES.has(operation)) return;
    const scope = this.scopeOf(context);
    if (scope === this.unidentifiedRemote) return;
    if (scope.remoteKey !== undefined) this.remote?.markExposed(scope.remoteKey);
    else this.exposed.add(scope);
  }
}
