# WP-23c stage 6A — workspace mediation diagnosis and direction

Status: investigation in progress. **Not WP-23c acceptance or production L1.**
Baseline: `4031536a45d67743e5fe25b18faaf36895692f67`, branch
`wp-23c-restricted-token-spike`, draft PR #27. Architecture and WP-25/26/27
are outside this change. The prior stage-6 narrative is input, not a fresh
independent qualification.

## Evidence collection contract

`tests/native-host/windows-l1/stage6a-diagnostics.test.ts` runs on actual
Windows only. Linux skips must never be counted as Windows results. Existing
stage-6 positive compatibility assertions are retained, including failures.
New diagnostic tests passing means a bounded report was collected, NOT that
every row is compatible or secure.

Native reports identify the tested checkout/CI SHA, actual Node/libuv
versions, process architecture, native RtlGetVersion build, registry UBR,
trusted/Low integrity and elevation, and validity/type of own standard handles.
They contain no credentials, environment dump, secret bytes or process memory.
Only synthetic test state and test-owned child processes are inspected.

The trusted runtime control starts with ordinary pipe stdio, waits for a GO
message until placed in its owned kill-on-close Job, then runs the same
bounded spawn matrix. It is not claimed as an untrusted pre-execution boundary.
The Low research launcher still uses suspended creation and Job assignment
before resume. The matrix distinguishes Node spawn/spawnSync, stdio modes,
Medium workspace versus private Low cwd, and direct native CreateProcessW.
Rows record actual errors, exit status and child-side readiness/integrity.
Tree cleanup is exercised only when the descendant itself reported ready and
was actually observed alive; a successful parent exit is never substituted.

PowerShell records entry, exact version/language mode, parameter/environment
presence and each attempted phase before execution. It compares legacy native
invocation with pure-.NET ProcessStartInfo redirecting all three streams.
Exception types, HResults and native error codes are retained without message
contents. A timed-out/incomplete phase is explicitly unresolved.

Reports are emitted as bounded escaped `CROT-6A-*` GitHub notice annotations,
so they survive a red CI without requiring workflow changes or logging a run
capability. Final results will be pinned to a source SHA and copied verbatim
into an evidence file. No workflow/ARM64 write permission is requested.

## Results and interpretation

Pending the first native stage-6A run. Do not infer a root cause from the
earlier null spawn results or from a successful Node 22 parent.

## Ordinary writes and security boundary

Pending independent runtime/RPC/redirection and positive-control observations.
The current RPC helper is not syscall interception. Low MIC alone is not
assumed to define a global workspace-only write policy or protect secrets
without appropriate provisioning. Static alias tests are not a complete
concurrent-reparse proof.

## Alternatives and recommendation

Pending a documented comparison of fixed RPC, a genuine writable filesystem
view, ProjFS, stronger identities/AppContainer and kernel mediation. No final
mechanism or architecture decision is made by adding diagnostic tests.