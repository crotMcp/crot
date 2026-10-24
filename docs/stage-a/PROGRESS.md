# Functional Stage A — working branch

Scope: the owner's A/B/C directive, Stage A first. Domain: **crot.network**.
No B/C work or merge is authorized by this progress record.

## Current slice

- Shared runtime allow/ask/deny rules and Strict Mode in PermissionEngine;
  existing hard denials and mandatory approvals remain authoritative.
- Owner RPC validation, protected two-phase persistence and audit for policy
  changes, including fail-closed recovery of interrupted changes.
- Emergency brake: Core process/network/browser cancellation, service admission
  latch, product task cancellation, HTTP/Relay close, audit, header/tray wiring.
- Restart explicitly required after stop; owner diagnostics remain reachable.

## Still required before Stage A acceptance / PR #5

- Multiple named scoped tokens, TTL, last-use, revoke/rotate, authenticated
  transport binding and revocation of active requests/sessions.
- Native folder selection, stack and project-owned port discovery, explicit
  secret access with enforcement at the L1 process boundary.
- Provider/model inventory, attachment validation, real streaming chat, stop,
  guarded tool-call execution and rendered tool-call/approval blocks.
- Allow once / allow for project / deny decisions through the existing broker.
- The service-level connect → task → owner approval → audit integration test
  passes. Repeat this flow through the unfinished chat/tool-call UI before
  accepting the complete Stage A user journey.
- Full check, extension and Chromium E2E plus observed green remote CI for the
  final candidate SHA. A local source test is not remote CI evidence.

See [verification](VERIFICATION.md) for observed command results and explicit
qualification limits. This is not
an installable release or qualification of live providers/Relay.
