# CROT — Status

Current snapshot of the v1 work. Per-work-package status, dependencies and
order are in [`docs/plan/crot-implementation-plan.md`](docs/plan/crot-implementation-plan.md);
architecture and decisions in [`ARCHITECTURE.md`](ARCHITECTURE.md). Every work
package PR updates this file.

## Last completed

**WP-18 — AD-16 "Browser contract v1"** (spike + documents; no product code).
ARCHITECTURE.md §27 AD-16 fixes:

- the technology: `chrome.debugger` (CDP) as the page backend, used only
  through a fixed CDP surface compiled into the extension (no
  `Runtime.evaluate` or other agent-supplied code); `chrome.downloads` for
  downloads; `chrome.scripting` only for the existing page functions;
- the command list v1 (22 tools: snapshot, wait, history, hover, scroll,
  drag, keys, select, checked, dialogs, upload, download and the extended
  existing tools) with operations, capabilities and exposure sources;
- element references bound to (connection, tab, frame, document), checked
  right before every action; stale is `BROWSER_STALE_REF`, never a guess;
- tab identity (`connectionId`, `tabId`), explicit `tabId` for remote
  principals and for every reference command, `openerTabId`, `newTabs`,
  `openedBy`, the "CROT" tab group, no focus changes;
- per-tab FIFO sequencing in Core (after approval, bounded), dialogs and
  file choosers that never block (`BROWSER_DIALOG_OPEN`, 60 s dismiss),
  frames incl. cross-origin, open shadow DOM, background screenshots;
- upload from an immutable private copy of a workspace file, download into
  the workspace only for the download the command started;
- isolation between agent contexts, audit without content, the approval
  binding for every new command, and the two presets:
  `permissions.approvals.untrustedContent` = `"require-approval"` (default) |
  `"autonomous-browser"` | `"off"`.

Spike (throwaway, not merged): Chrome for Testing 153, headless, local
cross-origin fixtures. CDP gave trusted events, OOPIF input, shadow DOM,
dialog handling, file inputs by path and background screenshots;
`chrome.scripting` gave untrusted events and hung on `confirm()`; node ids
outlive navigations, hence the document check.

## Next

| WP | What | Why now |
| --- | --- | --- |
| WP-19 | Principal kinds, exposure scope, sessionless HTTP per AD-15 | critical path; unblocked by WP-17 |
| WP-24 | Browser v1: CDP backend, snapshot and references, trusted input, frames, shadow DOM, waiting, history (AD-16) | browser branch; unblocked by WP-18 |
| WP-28 → WP-29 | Identity provider and verifier, then Cloud Relay | relay branch starts right after AD-15 (AD-14 point 6) |
| WP-35 | Extension publication, submitted early | needs the AD-16 permission justification (`debugger`, `downloads`, `tabGroups`) |

## Open questions and follow-ups

| Item | Where it is decided |
| --- | --- |
| Does the MCP SDK v1 line (`^1.31.0`) support 2026-07-28, or do the adapters move to SDK v2? | first step of WP-19 |
| Which token claims carry `clientId` and the device id | WP-28 (depends on the identity provider) |
| Exact device resource URI form and PRM location | WP-29 |
| Transport matcher to gate loopback HTTP separately from stdio | ARCHITECTURE.md §26 question 12 (not required for v1) |
| Relay/tunnel timeouts for gated requests and bounded browser waits | §26 question 13, WP-29 / WP-30 |
| Approval policy in general (beyond presets) | §26 question 6 |
| Limit remote agents to tabs they opened | §26 question 14 (opened by AD-16; not required for v1) |
| Input into background tabs on real sites; validation on at least three real sites | WP-24 |
| Debugger notice in headed Chrome/Edge/Brave on all OS; enterprise policies blocking `chrome.debugger` | WP-25 |
| Download hand-over mechanism (staging in the download directory or stream over the bridge) | WP-26 |
| Store acceptance of the `debugger` permission | WP-35 |
| How a preset change is applied by the supervised service (reload or restart) | WP-31 |
