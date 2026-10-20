# WP-27 — multi-agent browser safety

Base: main `386bf3b` (merged PR #32, accepted WP-26 `5df8345b`). Separate branch `feat/wp27-agent-tabs`; no merge by the agent.

## Preliminary WP-24 gate

Closed against the actual card criteria, not inferred from an open checkbox:
[criterion matrix](../acceptance/WP-24-final-engineering-gate.md). Historical owner runs are unchanged. The C1 demo's own Back link is not a CROT failure; the timeout regression is covered by delayed-commit real Chromium E2E. No extra mandatory product-owner action was identified. Full WP-25/G3 debugger-notice branded-browser/OS qualification is not declared complete.

## Implementation and evidence

| Requirement | Production path | Verification |
| --- | --- | --- |
| Remote tabId before authorization | BrowserService validates tab targets; file tools validate before staging/path preparation | Core multi-agent test enumerates 19 tools with permissions absent: INVALID_INPUT, zero audit/bridge traffic; same through actual MCP in Chromium E2E |
| Local default / ref compatibility | Authorized local implicit target resolved once and pinned for the operation | Existing capability/ref and approval suites; explicit remote tab works |
| FIFO, one running + 16 waiting | TabQueue, keyed by connection/tab, wraps full operation after guard approval; extension dispatcher mirrors it | Core and extension ordering/overflow tests; real MCP two-context shared-tab series |
| Different tabs concurrent | Independent operation queues; untargeted status/list/open bypass queue | Pending wait on A with control/read on B; same-tab read waits; Core untargeted concurrency tests |
| Queued cancellation | AbortSignal removes waiter immediately, frees slot, no action | Core and Chromium overflow/cancel/replacement tests |
| Approval never locks queue | Guard resolves approval before enqueue | Read/snapshot succeeds while control awaits UI in Core and Chromium |
| Queue-front subject binding | Core re-resolves concrete tab against approved normalized origin/connection; extension checks immediately before action | Preceding navigation changes origin, approved click denied without side effect in Core and Chromium |
| Connection/tab lifecycle | Queue resets at extension disconnect/tab close; Core pins old work and refuses changed connection; shutdown drains waiting work | Extension reset/close tests, existing binding lifecycle tests |
| openedBy | Exposure-scope identity for local; stable remote triple for remote; direct opens and verified popup opener | Core ownership/remote-scope/close/reconnect tests; two MCP contexts and actual Chromium popup |
| No authority/privacy regression | Ownership is informational only; no scope/connection identifiers added to returned tab metadata or audit | Other context may close tab; existing security/audit suites remain part of check |

Tests: `tests/core/browser-multi-agent.test.ts`, `extension/test/control.test.ts`, `tests-e2e/browser/wp27.e2e.test.ts`. Existing suites continue checking refs, trusted input, frames, dialogs, file staging and real AD-23.8 gates.

## Reproduction

- `npm run check`
- `CROT_E2E_CHROME=/path/to/chrome xvfb-run -a npm run test:e2e:browser`
- Existing CI: Linux/macOS/Windows × Node 20/22, four Linux L1 jobs, one real Chromium job (eleven checks). No workflow changes or platform skips added for WP-27.

## Verified local result

`npm run check` passed: Core **2023 passed / 215 existing skips**, extension
**186 passed**. The full real Chromium suite passed: **54 passed / 3 existing
opt-in skips** across six files, including **5/5 WP-27 E2E**. The new Core
multi-agent suite has **8/8 passed** (including origin change and tab closure
at queue head). No existing skips are counted as proof of acceptance.
CI results for the exact published head are linked from the pull request.

## Boundaries

The real browser suite uses Linux Chromium and local fixture pages, not real remote OAuth/tunnel/staging; MCP transport adapters provide two distinct authenticated contexts to the same real Core/bridge. Full remote deployment acceptance remains WP-32/WP-38. Native OS test coverage and browser-brand qualification are different claims.

Physical input still needs a visible tab. Its visibility/dispatch critical section is short and shared to avoid losing input when another tab activates; it does not cover settle or waits. This is not a global operation queue. A browser_wait waiting for a condition that only a later SAME-tab command could cause will time out by FIFO design: initiate that action first, or trigger it externally. User tab closure still interrupts an active wait. No fallback to an implicit active tab is allowed for remote callers.
