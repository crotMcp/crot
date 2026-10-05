# CROT — Status

Current snapshot of the v1 work. Per-work-package status, dependencies and
order are in [`docs/plan/crot-implementation-plan.md`](docs/plan/crot-implementation-plan.md);
architecture and decisions in [`ARCHITECTURE.md`](ARCHITECTURE.md). Every work
package PR updates this file.

## Last completed

**WP-17 — AD-15 "Remote MCP request contract v1"** (documents only).
ARCHITECTURE.md §27 AD-15 fixes:

- the sessionless request model: no `initialize` or `Mcp-Session-Id` is
  required; supported MCP versions 2026-07-28, 2025-11-25, 2025-06-18;
- the request pipeline and the mandatory security boundaries before local
  execution (PermissionEngine, approval gates, ExecutionGuard, L1, browser
  binding);
- principal kinds by entry point: stdio and loopback HTTP -> `local`, relay
  tunnel -> `remote` (with account, device and client ids);
- a request-scoped execution context, separate from transport sessions;
- exposure scopes: remote = (account, device, client), persistent, fail
  closed, reset only by the user;
- resource and audience rules (one resource URI per device, RFC 9728,
  RFC 8707), identity-provider criteria;
- the responsibilities of the Cloud Relay and of the local CROT.

No code has changed yet: today loopback HTTP is still `kind: "remote"` and
the HTTP endpoint still requires `initialize` (changed in WP-19).

## Next

| WP | What | Why now |
| --- | --- | --- |
| WP-19 | Principal kinds, exposure scope, sessionless HTTP per AD-15 | critical path; unblocked by WP-17 |
| WP-18 | Browser spike, AD-16 | browser branch; independent |
| WP-28 → WP-29 | Identity provider and verifier, then Cloud Relay | relay branch starts right after AD-15 (AD-14 point 6) |

## Open questions and follow-ups

| Item | Where it is decided |
| --- | --- |
| Does the MCP SDK v1 line (`^1.31.0`) support 2026-07-28, or do the adapters move to SDK v2? | first step of WP-19 |
| Which token claims carry `clientId` and the device id | WP-28 (depends on the identity provider) |
| Exact device resource URI form and PRM location | WP-29 |
| Transport matcher to gate loopback HTTP separately from stdio | ARCHITECTURE.md §26 question 12 (not required for v1) |
| Relay/tunnel timeouts for gated requests waiting for approval | §26 question 13, WP-29 / WP-30 |
| Browser technology, command set, preset rule set | §26 question 11, WP-18 (AD-16) |
| Approval policy in general (beyond presets) | §26 question 6 |
