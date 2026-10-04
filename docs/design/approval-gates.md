# Approval Gates — Design (WP-14)

> **Status: Implemented (WP-15).** This document fixes the mechanism of user
> confirmations (ARCHITECTURE.md §21); WP-15 implements it in
> `src/core/approvals/`, `src/core/execution/guard.ts`, the browser bridge and
> the extension. No approval provider (UI) exists yet: with gate rules
> configured, gated operations are denied until the tray app provides one. The key
> decisions are recorded in ARCHITECTURE.md §27, **AD-5**, **AD-6** and **AD-7**.
>
> The former open decisions OD-1 (browser tab/origin binding) and OD-2 (audit
> failure for gated operations) are decided by AD-6 and AD-7 (§16).
>
> **WP-15 contract.** AD-8 (`tabs.resolve`), AD-9 (browser `connectionId`),
> AD-10 (`permissions.approvals` location and defaults) and AD-11 (expected
> browser subject check) were decided before the implementation started (§17).
> Together with AD-5, AD-6 and AD-7 they are the contract WP-15 implements.
>
> The TypeScript in this document is a **contract sketch** that pins down the
> design. It is not code in `src/` and is not an implementation.

## 1. Goal and scope

An **approval gate** makes CROT ask the user for an explicit decision before a
dangerous operation runs. The operation runs only after the user approves it.
In every other case it is denied: rejection, timeout, cancellation, no UI, or
a full queue.

In scope:

- where the gate sits in the Core pipeline and why it cannot be bypassed;
- what the user approves (the approval subject) and how the approval is bound
  to the operation that is executed;
- the request lifecycle: states, timeout, cancel, reject, approve;
- the request queue;
- the interface between Core and a future UI (approval provider);
- the result returned to the agent;
- audit requirements;
- the threat model;
- extension points for browser-originated actions, prompt-injection
  mitigation and remote FULL CONTROL.

Out of scope (separate work packages):

- the implementation;
- the list of operations that need approval by default (ARCHITECTURE.md §26,
  question 6, stays open — this design fixes only the mechanism and the
  headless behaviour);
- the tray app, the local control channel and its authentication (§24);
- remote mode, relay and remote approvers (§22);
- taint/exposure tracking for prompt-injection mitigation (only the extension
  point is defined here).

## 2. Current pipeline (as implemented)

From `src/core/execution/guard.ts` and `src/core/permissions/engine.ts`:

1. A capability service parses the input (`parseInput`), resolves paths
   (`Workspace.resolve`) and builds an `OperationDescriptor`: `operation`,
   `capability` (one or several), `paths`, `network`, audit-safe `details`.
2. `ExecutionGuard.run(context, op, execute)` calls
   `PermissionEngine.authorize()` once for **every** capability of the
   descriptor. Any `allowed: false` gives an audited `denied` event and a
   `PermissionDeniedError`.
3. Only then does it call `execute()`. The closure captures the arguments that
   were parsed in step 1. It writes one `AuditEvent` with outcome `success` or
   `error`.
4. `AuthorizationDecision` is binary (`allowed: true | false`). The policy
   (`PermissionPolicy`) is immutable and created once at startup.
5. Audit write failures go to `onAuditError` and do not affect the operation.

The approval gate fits into step 2/3 without changing steps 1, 2 or 4.

## 3. Terms

| Term | Meaning |
| --- | --- |
| Approval gate | The step in the ExecutionGuard that may suspend an authorized operation until the user decides. |
| Gate rule | A policy rule that marks an operation as requiring approval. Part of the PermissionEngine policy. |
| Approval request | One pending request for one guard operation. It has exactly one terminal status. |
| Approval subject | The immutable, Core-generated description of what will be executed if the user approves it. |
| Approval broker | The Core component that owns the queue and the state machine. |
| Approval provider | A UI outside Core (first: the tray app) that shows requests to the user and returns decisions. |
| Ticket | The per-request handle a provider uses to decide. It is the only way to decide a request. |

## 4. Placement in the pipeline

```text
service: parse input -> resolve paths -> build OperationDescriptor (+ approval subject input)
   |
   v
ExecutionGuard.run
   1. authorize every capability          (PermissionEngine.authorize — unchanged, binary)
        denied -> audit "denied" -> PermissionDeniedError
   2. gate evaluation                      (PermissionEngine.approvalRequirement — new, read-only)
        not required -> step 5
   3. approval request                     (ApprovalBroker: queue, provider, timeout)
        not approved -> audit "denied" (approval.status) -> PermissionDeniedError
   4. re-authorize every capability        (PermissionEngine.authorize again)
        + revalidation hook of the service (paths, targets still the same)
        denied -> audit "denied" (approval.status = approved) -> PermissionDeniedError
   4a. write the mandatory approval audit record (AD-7)
        write failed -> operation refused, approval not completed -> PermissionDeniedError
   5. execute()                            (browser: expected tab/origin re-checked by the
                                            extension right before the action, AD-6)
   6. audit "success" / "error"           (with approval block if a gate applied)
```

### 4.1 Invariants

- **I1 — Narrow only.** The gate runs only after `authorize()` allowed the
  operation. Its only possible results are "continue" or "deny". An approval
  never grants a capability, never allows a path outside the workspace without
  `filesystem.full`, never touches protected paths, and never adds network
  destinations. `authorize()` keeps its current meaning and signature.
- **I2 — One pipeline.** The gate lives inside `ExecutionGuard`. There is no
  second permission system and no service-level approval logic. A capability
  service cannot skip the gate: `OperationDescriptor` has no opt-out field,
  and the gate decision is made by the PermissionEngine policy, not by the
  service.
- **I3 — Deny by default.** Every non-`approved` terminal status means deny.
  So do missing providers, a full queue, shutdown and internal errors of the
  broker.
- **I4 — Only the user decides.** Only a provider registered in the
  composition root can decide, through the ticket of that request. No MCP tool,
  browser command, external MCP server, relay or agent-reachable API can list,
  approve or reject requests.
- **I5 — What you see is what runs.** The approval is bound to one guard
  operation and to the digest of its subject. `execute()` uses only arguments
  captured before the request. The approval is single-use.
- **I6 — Approval is not policy.** A decision affects exactly one request. There
  is no "always allow" or "allow similar". Changing what needs approval means
  changing the configuration, which is a protected path.
- **I7 — Nothing is held while waiting.** No lock (for example the Git metadata
  lock), process slot or browser request is held while a request is pending.
  Those are taken inside `execute()`, as they are today.
- **I8 — Everything is audited.** Every operation for which a gate rule matched
  produces an audit event with an `approval` block, whatever the outcome. An
  approved operation runs only after its mandatory approval audit record has
  been written (AD-7, §11).

## 5. Gate policy

The rules that decide whether an operation needs approval are part of the
PermissionEngine policy. They are configured in `permissions.approvals`, next
to `permissions.network` (AD-10), validated at startup and immutable at
runtime.

- A rule matches on facts Core knows: `operation` name, capabilities,
  `principal.kind`, permission mode, and whether any path is outside the
  workspace. Later extensions can also match on request origin and session
  exposure (§13). Facts reported by the client (`principal.client`) are never
  used for matching.
- A rule matches if every given condition matches. An operation needs approval
  if any rule matches. The engine returns the id of the first matching rule
  (for audit) and the effective timeout.
- **Default: no user rules.** Without configuration, no user rule exists. The
  only default is the built-in `untrusted-content` rule for exposed sessions
  (ARCHITECTURE.md §27, AD-12, amending AD-10), which can be turned off. The
  general default list of gated operations is decided separately (§26,
  question 6).
- Unknown operation names, unknown capabilities or rules that can never match
  are a `CONFIG_ERROR` at startup.
- If rules exist but no provider is registered, Core starts. A
  `crot_status` note says the operations affected by those rules will be
  denied. This is the headless behaviour: deny, never allow.

Each guard operation is gated on its own. A service that runs several guard
operations (for example `network.resolve` + one `network.request` per redirect
hop, AD-4) may create several requests if the rules match each one. Rule
authors target the operation names they want to gate.

## 6. What the user approves: the approval subject

### 6.1 Content

The user approves **one concrete operation as Core will execute it**. They do
not approve the agent's intent, a tool name or a capability. The subject is
built by Core from the same parsed arguments that `execute()` captures:

| Field | Source | Notes |
| --- | --- | --- |
| `operation` | descriptor | e.g. `process.shell` |
| `capabilities` | descriptor | all capabilities that were authorized |
| `summary` | service, fixed template per operation | e.g. "Run a shell script" — a template, never agent text |
| `effects` | service | structured key/value items: full command line or script, absolute canonical paths (marked *outside workspace* when true), full target URL and tab id/origin for browser actions, typed text length, HTTP method and origin, Compose project, branch names, … |
| `paths` | descriptor | absolute, as resolved |
| `network` | descriptor | scheme, host, port, addresses checked |
| `principal` | AuthContext | `id`, `kind`, `transport`, `authMethod`; `client` shown and marked *self-reported* |
| `mode` | policy | `sandbox` / `full_control` |
| `rule` | gate policy | id of the matching rule ("why am I asked") |
| `origin` | AuthContext (future) | §13 |
| `createdAt`, `expiresAt` | broker | |

The subject may contain more than audit `details`. Audit details are
intentionally lossy: for example `browser.navigate` records only the origin
and `browser.type` only the text length. The user may need the full URL or
script to decide. The subject is shown only to the local user through a
provider. It is **never written to the audit log**. Only its digest is (§10).
Secret-bearing inputs (environment values, stdin, file contents, typed text)
are shown as their size or key names, not their value, unless a later decision
says otherwise.

### 6.2 Binding

- The subject is serialized canonically (stable key order, UTF-8 JSON) and
  hashed (SHA-256) to `subjectDigest`.
- `approve` must carry the `subjectDigest` the provider showed. A mismatch is
  rejected and the request stays pending.
- The approval is valid only for the request id (128-bit random) of one guard
  operation and is consumed when the request leaves `pending`.
- `execute()` must not read agent-controllable state that was not part of the
  subject. Today's services already capture parsed arguments in the closure.
  The implementation WP must check this for every gated operation.
- After approval, step 4 runs `authorize()` again. It also runs an optional
  service-provided `revalidate()` that re-resolves paths and checks they are
  unchanged (for example symlink swaps during the wait). A difference means
  deny.
- Browser operations are additionally bound to the target tab identity and
  origin recorded when the request is created. The extension checks them again
  immediately before the action. A closed or changed tab or a different origin
  invalidates the approval; it is never transferred to another tab or origin
  (AD-6, §13.1). Core obtains the concrete tab and origin with `tabs.resolve`
  (AD-8), and the binding includes the `connectionId` of the browser
  connection, checked again before the command is sent (AD-9). The command
  carries an expected browser subject (`tabId`, normalized `origin`,
  `connectionId`); any mismatch denies the operation without acting (AD-11).

### 6.3 Presentation rules for providers

The subject contains untrusted strings (paths, scripts, URLs, selectors). These
can come from repositories, web pages or the agent. Providers must:

- render every value as plain text, never as Markdown/HTML or a link;
- make control characters, bidi overrides and zero-width characters visible;
- never shorten silently: truncation is shown together with the full size, and
  the full value is reachable;
- display the fields in a fixed order defined by Core, with Core-generated
  labels;
- show principal kind and *remote* prominently;
- show *outside workspace* and *full_control* prominently.

The protocol does **not** carry an agent-supplied justification text. It would
be a direct prompt-injection channel into the decision UI.

## 7. Request lifecycle

### 7.1 States

```text
                      +-------------+
     create --------> |   pending   |
                      +-------------+
       |     |        |      |       \
approve|  reject  timeout  cancel   shutdown / provider gone
       v     v        v      v        v
  approved rejected expired cancelled cancelled

  (no request is created when no provider is registered or the queue is full:
   terminal status `unavailable` is recorded directly)
```

| Status | Terminal | Meaning | Operation |
| --- | --- | --- | --- |
| `pending` | no | shown to the user, waiting | suspended |
| `approved` | yes | the user approved this subject | re-authorized, then executed |
| `rejected` | yes | the user rejected it | denied |
| `expired` | yes | `expiresAt` reached without a decision (**timeout = reject**) | denied |
| `cancelled` | yes | the caller aborted (MCP cancel, transport closed), CROT shuts down, or the last provider unregistered | denied |
| `unavailable` | yes | not queued: no provider registered, or queue full | denied |

The statuses are exhaustive and mutually exclusive. Every request reaches
exactly one terminal status, exactly once.

### 7.2 Transition rules

- The broker handles transitions sequentially, in one state machine per
  process. The first transition out of `pending` wins. Any later decision,
  timer or cancel is a no-op. A provider that decides too late gets
  `{ ok: false, reason: "not_pending" }`.
- Timeout: `expiresAt = createdAt + timeoutMs`. The default is configurable
  (`permissions.approvals.timeoutMs`) and is 45 s. It is bounded above at
  300 s; a larger value is a `CONFIG_ERROR` (AD-10). The default is
  below the common MCP client request timeout (60 s in the MCP TypeScript SDK).
  Otherwise the client may give up while the request is still pending.
- Cancellation: the guard passes the caller's abort signal to the broker. The
  adapter supplies it through an optional `signal` in `AuthContext`, an
  additive extension. Until adapters supply it, only timeout and shutdown
  cancel.
- Shutdown: `CrotCore.shutdown()` cancels every pending request **before**
  `guard.drain()`. Pending requests do not use up the drain window.
- Restart: requests are kept only in memory. A restart ends them. The tool call
  is gone with the process, so nothing runs. There is no persistence and no
  resumption.
- `approved` does not mean "executed". The execution outcome is the audit
  event's `outcome`.

## 8. Queue

- One in-memory queue per Core process, ordered by `createdAt` (FIFO).
- Bounded by `permissions.approvals.maxPending` (default: 8, AD-10). When the queue is
  full, a new request becomes `unavailable` immediately. It does not wait and
  does not evict other requests.
- Every request is decided on its own. There is no batch approval, no merging
  of similar requests and no automatic resubmission after `rejected` or
  `expired`. An agent that retries creates a new request, which is audited.
- Providers get a snapshot of all pending requests when they register, so a
  reconnecting tray shows the current state. They get request and resolution
  notifications after that.
- The queue is not visible to the agent.

## 9. Interface for the UI (approval provider)

Core defines the interface. Implementations live outside Core (§21, §24). The
tray app's provider maps it onto the authenticated local control channel. That
channel and its authentication are part of the tray/service work package. Core
assumes only that a provider object handed to it in the composition root
speaks for the local user.

Logical protocol (transport-independent):

| Direction | Message | Content |
| --- | --- | --- |
| Core -> UI | `approval.snapshot` | all `pending` requests (on registration) |
| Core -> UI | `approval.requested` | `requestId`, `subject`, `subjectDigest`, `expiresAt` |
| Core -> UI | `approval.resolved` | `requestId`, terminal `status` (UI removes the prompt) |
| UI -> Core | `approval.decide` | `requestId`, `decision: approve \| reject`, `subjectDigest` (required for approve) |
| Core -> UI | decide result | `ok`, or `not_pending` / `digest_mismatch` / `unknown_request` |

Rules:

- Providers are registered only in `CrotCore.create` options, in the same way
  as `BrowserConnection`. MCP adapters, the browser bridge and future external
  MCP or relay adapters get no reference to the broker.
- With several providers, every one sees every request, and the first valid
  decision wins (§7.2). The provider id is recorded in audit.
- A provider must not decide automatically (no "auto-approve" provider in
  product builds). Test providers exist only in tests.
- `channel` describes where the provider asks the user: `local-ui`. A future
  remote approver (for example a phone bound to the device) would be a
  separate channel value and needs its own decision (§13.3). A provider may
  never use the same channel the request came from.

## 10. Result returned to the agent

- Approved and executed: the normal tool result. The agent only sees that the
  call took longer.
- Every other case: the existing `PermissionDeniedError` (`PERMISSION_DENIED`).
  Its `details` are `{ operation, missing: [], approval: { requestId, status } }`.
  No new error code is needed, and clients that already handle
  `PERMISSION_DENIED` keep working. The message tells the agent that approval
  was not given and that it should not retry in a loop.
- The agent never receives the subject, the provider id or the rule
  definitions.

## 11. Audit requirements

Every guard operation for which a gate rule matched writes an `AuditEvent`
with an additional optional `approval` block. An approved operation also has a
mandatory approval audit record. It is written after the approval and before
`execute()`, and carries the same `approval` block (AD-7):

| Field | Required | Meaning |
| --- | --- | --- |
| `requestId` | yes | correlates with what the provider showed |
| `status` | yes | terminal status (§7.1) |
| `rule` | yes | id of the matching gate rule |
| `subjectDigest` | yes | SHA-256 of the canonical subject; never the subject itself |
| `requestedAt`, `resolvedAt` | yes | ISO timestamps |
| `waitMs` | yes | time spent in `pending` |
| `provider` | when decided by a provider | provider id and channel |
| `cancelReason` | for `cancelled` / `unavailable` | `caller_aborted`, `shutdown`, `provider_gone`, `no_provider`, `queue_full` |
| `reauthorization` | when approved but denied in step 4 | short reason |

Outcome mapping:

| Approval status | `outcome` | `error.code` |
| --- | --- | --- |
| `approved`, execution ok | `success` | — |
| `approved`, execution failed | `error` | as today |
| `approved`, re-authorization failed | `denied` | `PERMISSION_DENIED` |
| `approved`, mandatory approval audit record could not be written (AD-7) | `denied` (not executed) | `PERMISSION_DENIED` |
| `approved`, browser tab/origin/connection binding no longer holds (AD-6, AD-11) | `denied` (not executed) | `PERMISSION_DENIED` |
| `rejected` / `expired` / `cancelled` / `unavailable` | `denied` | `PERMISSION_DENIED` |

Rules:

- The existing audit content rules still apply: no file contents, output,
  stdin, environment values, typed text or full URLs where the operation's
  details avoid them today. The subject is not recorded; only its digest is.
  This lets an audit reviewer check a disputed decision against a subject
  saved by the UI, if the UI ever stores one.
- `timestamp` stays the start of the guard operation. `durationMs` includes
  `waitMs`.
- `outcome` values do not change (`success | error | denied`). `approval` is an
  additive optional field, like `network` added by WP-13.
- **Audit failure (AD-7).** For a gated operation, failure to write the
  mandatory approval audit record means the operation is refused. The
  approval is not successfully completed without that record. Operations that
  require no approval keep the global behaviour: audit failures go to
  `onAuditError` and do not affect the operation. Once `execute()` has
  started, its effects cannot be revoked.
- **Meaning of the mandatory record (AD-7).** It records that the operation
  was approved and authorized before execution. It does **not** state that the
  operation ran or succeeded. The execution result is only in the event
  written after execution (`success` or `error`). If the process stops after
  the mandatory record was written, or the operation fails, the mandatory
  record must not be read as successful execution. A mandatory record without
  a matching post-execution event means the result is unknown.
- Decisions that arrive after the terminal status do not create audit events,
  because they change nothing. The provider gets `not_pending`.
- A crash while a request is pending leaves no event. Nothing was executed, so
  no executed operation is missing from the audit trail. This is accepted and
  documented. A separate "requested" event is not introduced.

## 12. Contract sketch (design only)

```ts
// Core — permissions (additive; authorize() is unchanged)
type ApprovalRuleId = string;

interface ApprovalRule {
  readonly id: ApprovalRuleId;
  readonly match: {
    readonly operations?: readonly string[];
    readonly capabilities?: readonly Capability[];
    readonly principalKinds?: readonly PrincipalKind[];
    readonly modes?: readonly PermissionMode[];
    readonly outsideWorkspace?: boolean;
    readonly exposed?: boolean; // AD-12: session exposure (§13.2)
    // reserved for later decisions (§13): origins
  };
}

type ApprovalRequirement =
  | { readonly required: false }
  | { readonly required: true; readonly rule: ApprovalRuleId; readonly timeoutMs: number };

// PermissionEngine (new method, pure, no side effects):
//   approvalRequirement(context: AuthContext, op: OperationDescriptor): ApprovalRequirement

// Core — what the service adds to OperationDescriptor (additive, optional, never audited)
interface ApprovalSubjectInput {
  readonly summary: string; // fixed template per operation
  readonly effects: readonly { readonly label: string; readonly value: string; readonly flag?: "outside_workspace" | "secret_size_only" }[];
  /** Re-check after approval that resolved paths/targets are unchanged. */
  readonly revalidate?: () => Promise<boolean>;
}

// Core — broker
type ApprovalStatus = "pending" | "approved" | "rejected" | "expired" | "cancelled" | "unavailable";
type TerminalApprovalStatus = Exclude<ApprovalStatus, "pending">;

interface ApprovalSubject {
  readonly operation: string;
  readonly capabilities: readonly Capability[];
  readonly summary: string;
  readonly effects: ApprovalSubjectInput["effects"];
  readonly paths: readonly { readonly absolute: string; readonly insideWorkspace: boolean }[];
  readonly network: readonly { readonly scheme: string; readonly host: string; readonly port: number }[];
  readonly principal: Principal; // client marked self-reported in the UI
  readonly mode: PermissionMode;
  readonly rule: ApprovalRuleId;
}

interface PresentedApproval {
  readonly requestId: string;
  readonly subject: ApprovalSubject;
  readonly subjectDigest: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

type DecideResult = { readonly ok: true } | { readonly ok: false; readonly reason: "not_pending" | "digest_mismatch" };

interface ApprovalTicket {
  readonly requestId: string;
  approve(subjectDigest: string): DecideResult;
  reject(): DecideResult;
}

// Implemented outside Core (tray). Registered only in the composition root.
interface ApprovalProvider {
  readonly id: string;
  readonly channel: "local-ui";
  present(request: PresentedApproval, ticket: ApprovalTicket): void;
  resolved(requestId: string, status: TerminalApprovalStatus): void;
}

// Used only by ExecutionGuard.
interface ApprovalBroker {
  request(subject: ApprovalSubject, timeoutMs: number, signal?: AbortSignal): Promise<ApprovalOutcome>;
  cancelAll(reason: "shutdown"): void;
}

interface ApprovalOutcome {
  readonly requestId: string;
  readonly status: TerminalApprovalStatus;
  readonly subjectDigest: string;
  readonly requestedAt: string;
  readonly resolvedAt: string;
  readonly provider?: { readonly id: string; readonly channel: string };
  readonly cancelReason?: "caller_aborted" | "shutdown" | "provider_gone" | "no_provider" | "queue_full";
}
```

## 13. Extension points (not implemented, the design must allow them)

### 13.1 Browser-originated actions

Today the browser cannot initiate operations (§7). If a later work package
lets the extension originate requests, they get an explicit `origin`
(`browser`) in `AuthContext`, set by the adapter and never by the browser
payload. Gate rules can match on it. The extension and the bridge are never
approval providers, so a browser-originated request can never be approved
from the browser.

Binding browser operations to what the user saw is decided by **AD-6**
(formerly OD-1). When the request is created, Core records the target tab
identity (concrete tab id and browser connection; a default *active* tab is
resolved to a concrete tab) and its origin in the subject. The browser command
carries them as an expected-tab/origin precondition, and the extension checks
it immediately before it acts. A closed or changed tab or a different origin
invalidates the approval. An approval is never transferred to another tab or
origin. `browser.tab_open` is bound to the origin of the URL it opens. This is
the browser command protocol change for gated operations.

The concrete tab and its origin are obtained with the `tabs.resolve` command
(**AD-8**), and the tab identity includes the `connectionId` of the bridge
connection (**AD-9**). Minimal contract:

```ts
// tabs.resolve (AD-8): sent only for gated, tab-targeting browser.* operations,
// after authorize() and the gate rule matched, before the approval request.
// Resolves exactly like the operation's command: given tab, or the active tab
// of the last focused window. Reads tab id and URL only; never acts on the page.
interface TabsResolveParams { readonly tabId?: number }
interface TabsResolveResult { readonly tabId: number; readonly url: string } // untrusted, validated by Core

// connectionId (AD-9): new random id (>= 128 bits) for every accepted hello,
// generated on the host side, never reused, not visible to the agent.
type BrowserConnectionState =
  | { readonly kind: "waiting" }
  | { readonly kind: "connected"; readonly browser: BrowserInfo; readonly connectionId: string }
  | { readonly kind: "in_use" };

interface BrowserRequestOptions {
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
  /** When set, the bridge sends the request only on this connection; otherwise it rejects without sending. */
  readonly connectionId?: string;
}
```

- If the tab or its current state cannot be determined (no such tab, no
  active tab, invalid response, no `http:`/`https:` origin, timeout,
  disconnected or changed connection), no approval request is created and the
  operation is denied (AD-8 point 4).
- The resolved tab id, origin and `connectionId` are part of the subject and
  its digest. Immediately before the command is sent, the bridge checks the
  `connectionId`; a new connection invalidates the approval (AD-9).

Expected browser subject check (**AD-11**). Field names are chosen by the
implementation; the semantics and the error are fixed:

```ts
// Carried by every command of a gated browser.* operation; values are exactly
// those of the approved subject.
interface ExpectedBrowserSubject {
  readonly tabId?: number; // absent only for browser.tab_open
  readonly origin: string; // normalized WHATWG origin, http(s) only
  readonly connectionId: string; // AD-9
}
// Mismatch (any field, missing tab, undeterminable value):
//   bridge: connectionId differs -> command not sent
//   extension: checks tabId, current origin of the committed URL (a pending
//              navigation to another origin is a mismatch) and connectionId
//              immediately before acting -> action not performed, responds
//              with error code PERMISSION_DENIED (reserved for this check)
//   agent: PERMISSION_DENIED, details { operation, missing: [], approval: { requestId, status: "approved" } }
//   audit: outcome "denied", error.code "PERMISSION_DENIED"
```

- Origins are WHATWG origin serializations (lowercase scheme and host,
  punycode host, default port omitted), compared by exact equality; opaque
  origins and non-`http(s)` schemes never match.
- The check only narrows: passing it grants no capability and changes no
  permission. No new error code is introduced; browser-supplied messages are
  never passed to the agent.
- The bridge tells the extension its `connectionId` when it accepts the
  `hello`; the extension cannot choose or change it.

### 13.2 Prompt-injection mitigation

CROT cannot tell whether a tool call was induced by injected content (§19). The
mitigation is *exposure*, decided by **AD-12** (implementation: WP-16b).

- Provenance is tracked per session, not per value: MCP carries no label from
  a result into a later call, and matching arguments against earlier results
  would be a bypassable heuristic.
- Core marks the session `exposed` after a source operation succeeded
  (`browser.page_read`, `browser.screenshot`, `browser.tabs_list`,
  `network.request`; later external MCP results). Marking depends only on the
  operation, never on the content, and is never cleared during the session.
- The session identifier is supplied by the transport adapter in
  `AuthContext`; without one, the process is one session.
- The rule matcher `exposed` and the built-in rule `untrusted-content` (on by
  default, `permissions.approvals.untrustedContent: "off"` turns it off)
  require approval for operations needing `shell.execute`, `filesystem.write`,
  `git.write`, `network.access` or `browser.control`, and for
  `docker.compose_up` / `docker.compose_down`, in an exposed session. This is
  the WP-15 gate; there is no second mechanism.
- The subject can show the exposure ("this session read untrusted content
  before this request"). Exposure is computed only by Core, never reported by
  the agent.

### 13.3 Remote FULL CONTROL

Remote principals (`kind: remote`, §22) are distinguishable in the rule
matcher (`principalKinds`). A remote FULL CONTROL profile can require approval
for every mutating capability. Two invariants carry over:

- approvals for remote requests come from a provider on a channel independent
  of the remote request path; the relay and the remote MCP session can never
  approve;
- a remote approver (for example a phone app) would be a separately
  authenticated, device-bound provider channel. Defining it is part of the
  remote-mode work package.

## 14. Threat model

**Assets:** the user's files, processes, browser session, network position and
credentials, the integrity of the audit log, and the meaning of a user's
approval.

**Adversaries:** a misled or malicious agent, content that injects
instructions (web pages, repositories, tool output, external MCP results), a
compromised browser side (extension, page), other local processes, and later
the relay or remote network.

| # | Bypass scenario | Prevented by |
| --- | --- | --- |
| T1 | The agent approves its own request (tool call, crafted argument) | I4: no agent-reachable API; tickets go only to registered providers |
| T2 | A web page or the extension approves | I4: the bridge/extension cannot call Core and is never a provider |
| T3 | An external MCP server, the relay or the remote session approves | I4, §13.3: never a provider; the approval channel is independent of the request path |
| T4 | A service or new capability runs without the gate | I2: gate inside ExecutionGuard; no opt-out field; the implementation must test that every guard operation is gate-evaluated |
| T5 | Bait-and-switch: the user sees X, Core runs Y | I5: the subject is built from the captured arguments; digest-bound; single-use; no agent text in the subject |
| T6 | The target changes during the wait (symlink swap, policy change, browser tab) | Step 4: re-authorize and `revalidate()`; browser tab identity and origin re-checked by the extension right before the action (AD-6) |
| T7 | An old approval is replayed for a new request | Random request ids; approval consumed on the terminal transition |
| T8 | A late approval after timeout or cancel runs the operation | Sequential state machine; first terminal wins; `not_pending` |
| T9 | Approval fatigue / flooding the user until they click "yes" | Bounded queue with immediate `unavailable`; no batch or "always" approvals; no auto re-queue; every request audited |
| T10 | A misleading prompt (bidi, newlines, long text hiding the payload, lookalike paths) | §6.3 presentation rules; Core-defined fields and labels; absolute canonical paths; no Markdown |
| T11 | A spoofed identity in the prompt (`client` name) | `client` marked self-reported; matching uses only Core facts |
| T12 | Downgrade: no UI, provider crash, broker error → allow | I3: all of these mean deny |
| T13 | Approval used to widen permissions (missing capability, outside workspace) | I1: gate only after allow; approval cannot grant |
| T14 | The agent changes the gate policy | Policy immutable at runtime; configuration file is a protected path |
| T15 | Another local process poses as the tray | Providers registered only in the composition root; channel authentication required by the tray WP (§24) |
| T16 | Pending requests hold locks and block CROT | I7; timeout; queue bound |
| T17 | The client gave up, the user approves later, the operation runs unseen and the agent retries (double execution) | Cancel on caller abort; default timeout below client timeouts; residual risk documented |
| T18 | A dangerous action is split into ungated steps (write a script, then run it) | Policy concern: gate by capability, not only by operation name; documented limitation |
| T19 | An approved operation runs without a record of the approval (audit sink failing) | AD-7: the mandatory approval audit record is written before `execute()`; failure means refusal |

Residual risks (not prevented by design): the user approves a harmful but
correctly presented operation; a crash leaves no record of a pending request;
operations whose effects the subject cannot describe fully (an arbitrary shell
script is shown in full, but its effects are not analysed).

## 15. Impact on existing contracts

Additive changes the implementation WP will make. They are all optional fields
or new methods, and existing behaviour is unchanged when no gate rule is
configured:

- `ExecutionGuard.runGuarded`: steps 2–4 (§4). The public `run()` signature
  stays the same. `shutdown` cancels pending requests before `drain()`.
- `PermissionEngine`: new pure method `approvalRequirement()`. `authorize()` and
  `AuthorizationDecision` are unchanged.
- Configuration: new `permissions.approvals` section (`rules`, `timeoutMs`
  default 45 s and at most 300 s, `maxPending` default 8), no rules by default
  (AD-10).
- `OperationDescriptor`: optional `approval?: ApprovalSubjectInput`.
- `AuditEvent`: optional `approval` block (§11). `outcome` values are unchanged.
- `PermissionDeniedError.details`: optional `approval` key.
- `AuthContext`: optional `signal` for caller cancellation.
- `CrotCoreOptions`: optional approval providers. `CrotStatus`: approvals
  summary (rules configured, provider present).

- Browser command protocol: expected-tab/origin precondition for gated
  `browser.*` operations (AD-6), carried as the expected browser subject
  (`tabId`, normalized `origin`, `connectionId`) with `PERMISSION_DENIED` on
  mismatch (AD-11); new command `tabs.resolve` for gated tab-targeting
  operations (AD-8).
- Browser bridge: `connectionId` per accepted `hello` in
  `BrowserConnectionState`, optional expected `connectionId` in
  `BrowserRequestOptions`, `connectionId` sent to the extension when the
  `hello` is accepted (AD-9).
- Gated operations: mandatory approval audit record before `execute()`; failure
  to write it refuses the operation (AD-7).

Not changed: capability vocabulary, sandbox/full_control semantics, protected
paths, network policy, audit outcome values, the browser protocol for
operations without a gate, and the rule that audit write failures never affect
operations that require no approval.

WP-16 (AD-12) adds, additively: an optional session identifier in
`AuthContext`, the `exposed` matcher, the built-in `untrusted-content` rule
with `permissions.approvals.untrustedContent`, and the Core-owned list of
exposure sources. It amends AD-10 point 2 (the built-in rule is on by
default).

Still open but not blocking WP-15: the default list of gated operations and
headless profiles (§26, question 6). With no rules configured, nothing is
gated.

## 16. Decisions (formerly OPEN DECISIONS)

WP-14 left two questions open and required them to be decided before WP-15.
Both are now recorded as architectural decisions in ARCHITECTURE.md §27. No
open decision from this design blocks WP-15.

### OD-1 — decided by AD-6: browser approval binding

- An approval for a `browser.*` operation is bound to a concrete tab and
  origin.
- The tab identity and origin are recorded when the approval request is
  created.
- They are checked again immediately before the operation runs.
- A closed or changed tab or a different origin invalidates the approval.
- An approval cannot be transferred to another tab or origin.

### OD-2 — decided by AD-7: audit failure for gated operations

- For an operation that requires approval, failure to write the mandatory
  audit record means the operation is refused.
- An approval is not successfully completed until its mandatory audit record
  has been written.
- The global audit policy for all other operations does not change.

## 17. Decisions before WP-15 (part of the WP-15 contract)

Planning WP-15 against the current code showed four gaps that needed a
decision before implementation. They are recorded in ARCHITECTURE.md §27 and
are part of the WP-15 contract:

- **AD-8 — `tabs.resolve`.** Core cannot resolve the default active tab (the
  active tab of the last focused window) with the existing commands. A new
  command returns the concrete tab id and URL for a gated, tab-targeting
  `browser.*` operation before the approval request is created. If the tab or
  its state cannot be determined, no approval is created and the operation is
  denied.
- **AD-9 — `connectionId`.** The bridge creates a new random `connectionId` for
  every accepted `hello`. A browser approval records it, the bridge checks it
  immediately before the command is sent, and a new connection invalidates the
  approval.
- **AD-10 — configuration.** Approval rules live in `permissions.approvals`
  next to `permissions.network`. Defaults: `timeoutMs` 45 s, maximum 300 s,
  `maxPending` 8.
- **AD-11 — expected browser subject check.** Every command of a gated
  `browser.*` operation carries the expected `tabId`, normalized `origin` and
  `connectionId`. The bridge checks `connectionId` before sending; the
  extension checks all three immediately before acting. Any mismatch denies
  the operation without acting, with the existing `PERMISSION_DENIED` (no new
  error code). The check only narrows.
