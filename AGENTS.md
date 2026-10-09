# AGENTS.md — start here

This repository is CROT: a local AI-agent bridge that gives MCP clients
controlled access to the user's computer and real browser.

## Current goal (v1)

Any compatible **remote MCP client -> internet / CROT Cloud Relay -> local
CROT -> the user's computer + real browser, tabs and web services**, with real
multi-step browser tasks. Concrete clients (Notion, Claude, Cursor, …) are only
compatibility examples. The external MCP gateway (CROT as an MCP client) is
post-v1 and not part of current work.

**After v1 (planned, not implemented):** CROT grows into an extensible
execution environment for local and remote agents — media, video editors,
external services — through the same Core (ARCHITECTURE.md §1 "Expanded
product goal", [`docs/plan/product-reassessment.md`](docs/plan/product-reassessment.md)).
Its work packages (WP-41…WP-70) never displace v1 work. Research may
start early, but a WP whose card lists an OD is implemented only after
that OD's AD is accepted; WP-41 and WP-42 depend on no open decision
(`docs/plan/product-reassessment.md` §8).

## Read in this order

1. [`ARCHITECTURE.md`](ARCHITECTURE.md) — the source of truth: §1 (goal), §2
   (architecture and status), §7.1 (browser contract v1), §19 (trust
   boundaries), §21–22 (confirmations, remote mode), §26 (open questions) and
   §27 decisions, especially **AD-12, AD-13, AD-14, AD-15 and AD-16** (browser
   contract v1).
2. [`STATUS.md`](STATUS.md) — current snapshot: last completed work
   package, what is next, open questions.
3. [`CROT_IMPLEMENTATION_ROADMAP.md`](CROT_IMPLEMENTATION_ROADMAP.md)
   — the authoritative implementation roadmap: phases, critical path, status
   of every work package, the next WP.
4. [`docs/plan/crot-agent-work-packages.md`](docs/plan/crot-agent-work-packages.md)
   — the card of the work package you are doing.
5. [`README.md`](README.md), [`docs/BROWSER_EXTENSION.md`](docs/BROWSER_EXTENSION.md),
   [`docs/NATIVE_HOST.md`](docs/NATIVE_HOST.md), [`docs/SERVICE.md`](docs/SERVICE.md),
   [`docs/design/approval-gates.md`](docs/design/approval-gates.md) — how the
   current implementation behaves.

## Rules

- Decision before code: changes to architectural boundaries need an AD in
  ARCHITECTURE.md §27 first.
- One work package — one PR; update `STATUS.md`, the roadmap status and the
  ARCHITECTURE.md status markers in that PR.
- `npm run check` must pass; do not break implemented behaviour.
- Every operation goes through the ExecutionGuard / PermissionEngine; no
  second permission system; no client-specific logic; no host- or
  agent-supplied code in the browser.
