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
- Named loopback tokens: protected hash-only registry, names, bounded TTL,
  files/terminal/browser scopes, last use, one-time display, rotation and revoke.
  Verified transport bindings narrow the existing PermissionEngine. Scoped
  command execution requires L1, never the owner's unconfined launcher.
- Token invalidation cancels pending/running tasks, closes HTTP sessions/requests
  and terminates matching background resources without Strict Mode approval.
- Fixed native Electron folder-picker action, canonical project registration and
  idle workspace switching. Real Electron/GTK cancellation and folder selection are
  now qualified on Linux, including Core switching, shipped UI refresh and audit.
  Concurrent pickers and false selection success are refused. See AD-49.

- Guarded OpenAI / Anthropic / OpenAI-compatible Local HTTP model inventory,
  streaming, bounded text/image attachments, cancellation and opt-in tool calls.
  Header and inline chat share the existing approval queue. Keys use the vault;
  provider fixtures do not qualify live vendor accounts. See AD-45.
- Digest-bound Allow once / Allow for project / Reject through the one existing
  approval broker. Exact workspace/operation grants persist in protected policy,
  survive restart, can be revoked separately, and never override Strict Mode,
  runtime deny, mandatory gates or hard capability/workspace ceilings. See AD-46.
- Owner project inspection reads fixed manifests through FileSystemService,
  reports bounded stack evidence, and observes actual Linux same-user/project-cwd
  TCP listeners through a separately guarded process operation. Cancellable tasks,
  audit and the idle workspace-switch barrier cover the whole workflow. See AD-47.
- Fixed a real Chromium scroll/OOPIF input race: prepare routing with a move,
  revalidate before pressing, require trusted activation for click delivery, and
  never replay a press. The real test asserts down/up/click in the target iframe,
  not only a broad pointer count. See AD-48.
- Project inspection survives a pending-response rerender and subsequent navigation
  without repeating a guarded Core operation. Workspace changes discard its bounded
  snapshot; only an explicit owner inspection refreshes it. See AD-50.

## Still required before Stage A acceptance

- **General application-secret protection is not implemented at the L1 process
  boundary on Linux/Windows. Do not rely on this branch to protect arbitrary project `.env`,
  `*.pem` or `*.key` files from child commands.** Existing CROT service-secret
  protection remains distinct. The macOS AD-52 native rule passed both actual
  macOS CI jobs at `cb71d2b`; its documented hardlink/host constraints remain.
  AD-53 adds owner IPC/UI access/revocation; current-slice qualification is separate.
- Native macOS/Windows folder-picker smoke. The project-owned port observers
  (AD-51) passed the actual-OS matrix at `48420e9`. Darwin uses libproc identity and fixed
  lsof fields; Windows uses owner-PID TCP tables and bounded same-owner cwd reads.
  Linux parser tests do not qualify either native ABI. Results are point-in-time
  evidence, never proof that unlisted ports are free.
- Final complete-Stage-A native qualification and observed green remote CI for
  the final candidate SHA. Local checks and Chromium's test-only IPC bridge do
  not qualify macOS/Windows Electron dialogs, native L1 on other OSes or GitHub CI.

The real-service connect → task → owner approval → audit integration and shipped
Chromium chat → real CrotService → inline approval → actual write → audit journey
pass. The same UI also verifies project-persistent approval and a later action
without another request, and real manifest inspection. No live provider/Relay
account is claimed qualified by local fixtures. B/C remain unstarted. [PR #5](https://github.com/crotMcp/crot/pull/5) is open as
Draft solely for the existing cross-platform CI; it is not Stage A acceptance or
a request to merge. No PR was merged by the agent.

See [verification](VERIFICATION.md) for observed command results and explicit
qualification limits. This is not
an installable release or qualification of live providers/Relay.

### Project secret-file gate (AD-52, in progress)

- Previous published head `48420e9276c6ac00be405a2e1824d2dc695b31c9`:
  all eleven existing GitHub checks passed. PR #5 remains Draft; this is not
  complete Stage A acceptance.
- Added mandatory shared Core filename policy and exact workspace-bound owner
  configuration opt-ins. Native macOS dynamic filename rule and adversarial
  tests are a candidate pending actual macOS CI, not a Linux-qualified claim.
- Linux/Windows future-file L1 protection and live owner grant/revoke IPC/UI
  remain open. macOS host Docker binds are conservatively refused (AD-52).


### Owner secret-file controls (AD-53 candidate)

The previous head `cb71d2bd57aa79a356619df41e9300c7f316430d` completed all
11 GitHub checks successfully, including actual macOS late-secret kernel tests.
It is not complete Stage A acceptance. AD-53 adds protected transactional owner
state, exact-file grant/revoke controls, irreversible old-Core retirement and
real process drain before acknowledgement. First targeted Core/service tests
passed, including an actor holding an open secret descriptor. Full local and
remote qualification of this new source is still required. Linux/Windows
future-file L1 and actual macOS/Windows native folder dialogs remain open.
B/C are not started and PR #5 is not merged.

AD-53 local qualification now passes: main 2311 tests, extension 196, real
Chromium 58 (3 existing platform placeholders skipped), shipped UI QA 81 checks
and Linux native picker 3 checks. All 221 host-inapplicable main tests remain
explicitly skipped; local Linux does not qualify their native implementations.
Current-source GitHub CI must still be observed before claiming this slice
remotely qualified. Full Stage A remains incomplete for the gates above.
