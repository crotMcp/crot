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

## Still required before Stage A acceptance / PR #5

- **General application-secret protection is not implemented at the L1 process
  boundary. Do not rely on this branch to protect arbitrary project `.env`,
  `*.pem` or `*.key` files from child commands.** Existing CROT service-secret
  protection remains distinct. Explicit owner access/revocation must also be
  implemented, not represented by a decorative UI control.
- Native macOS/Windows folder-picker smoke and project-owned port observation.
  Their current port result is explicitly unavailable; Linux
  results are point-in-time evidence, not proof that unlisted ports are free.
- Final complete-Stage-A native qualification and observed green remote CI for
  the final candidate SHA. Local checks and Chromium's test-only IPC bridge do
  not qualify macOS/Windows Electron dialogs, native L1 on other OSes or GitHub CI.

The real-service connect → task → owner approval → audit integration and shipped
Chromium chat → real CrotService → inline approval → actual write → audit journey
pass. The same UI also verifies project-persistent approval and a later action
without another request, and real manifest inspection. No live provider/Relay
account is claimed qualified by local fixtures. B/C remain unstarted; PR #5 is
not yet opened and no PR was merged by the agent.

See [verification](VERIFICATION.md) for observed command results and explicit
qualification limits. This is not
an installable release or qualification of live providers/Relay.
