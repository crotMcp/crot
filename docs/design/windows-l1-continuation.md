# WP-23c continuation — WinPS and native process transport

**Partial implementation, not Windows L1 acceptance.** Production Windows
confinement still reports `not_implemented`; PR #27 stays open and Draft. No
backend, write-through filesystem, global write boundary or architecture
selection is claimed by the 11 green checks below.

## Native process component — qualification in progress

Continued from verified `6fbfc2d634819f576a7d807ab7389800a37a7d80`
(11 completed successful checks). The new `byte-stdio.ts` implements owned
OVERLAPPED byte streams, independent concurrent stdout/stderr draining, bounded
Node stream backpressure, partial stdin writes and EOF. Asynchronous ReadFile /
WriteFile use NULL immediate-count pointers: no temporary FFI output object can
outlive the call. OVERLAPPED, event and data buffers remain pinned until native
completion; cancellation is acknowledged before release. Incomplete cancellation
quarantines native memory/handles and prevents further transport creation.

`restricted-stdio.ts` supplies exactly three privately branded child handles via
PROC_THREAD_ATTRIBUTE_HANDLE_LIST. Parent handles and unrelated inheritable host
handles are not on that list. The child is still suspended until verified Job
assignment. Child handle copies are released before resume. The native primary
process exit code is saved before handle release, including after forced cleanup.
Trusted cmd.exe wrappers preserve CommandSpec.windowsVerbatimArguments; ordinary
argv uses CRT escaping. Windows environment names such as ProgramFiles(x86) no
longer fail an incorrectly POSIX-shaped name validator.

`native-process.ts` implements the existing ProcessLauncher / ManagedProcess
contract and owns Jobs even after a direct child exits. Core can consume its
streams through the existing authorized ProcessService. A fatal transport error
is distinct from a real child exit status (`ManagedProcess.failure`); foreground
execution and background output reads report it rather than return false
success. Foreground cleanup now runs in finally. The additive error field is not
an authorization or permission-policy change; Node/Linux/macOS implementations
retain their contracts. No new IPC/filesystem broker authority is introduced.

Portable ownership/state-machine tests and compiled C ABI tests check deferred
buffer writes, NULL count pointers, 64-bit layouts and cancellation-before-free.
Real Windows gates cover binary megabyte stdio, argv/cwd/environment/exit 23,
Core stdin/timeout/permission denial, production cmd/WinPS shell preparation,
.cmd escaping, a ready detached grandchild after parent exit and cancellation
with pending reads/backpressured writes. CI qualification is pending; Linux skips
are not native proof. Existing strict WinPS and all original RPC gates remain.

This is an implementation component, not another filesystem RPC adapter and not
a complete backend. It is intentionally **not registered as CommandConfinement**.
The MIC-only native fixture is not a global write boundary. Same-backing writes,
bounded confinement environment, actual CROT state/control/Docker protection,
crash/recovery and supported-machine matrix remain mandatory unclosed criteria.
No user workspace SD is modified and production availability remains false.

## Previous qualification and retained rerun failure

**Latest qualified code/test source: `01ed8cece9c867bc7aef9e56b3c7c0b793bf14c7`.**
All 11 checks completed successfully; synthetic checkout
`475650d5e17e52ee02e1e4b89c63732464e34c10`.
Windows [Node 20 job 116167869297](https://github.com/mysteriumpersonae/crot-mcp/actions/runs/38656643071/job/116167869297)
and [Node 22 job 116167869398](https://github.com/mysteriumpersonae/crot-mcp/actions/runs/38656643071/job/116167869398)
pass the strict ordinary-redirection and all original workspace-RPC assertions.
Full local `npm run check` on this source passed again: 1526 core / 144 skipped,
147 extension. The implementation in `src/` is unchanged from `43f7392`.

The documentation-only HEAD `ec11e2e0dae0b4d3f0bcb70ca2b5f5fe266ab331` had
**9 successful / 2 failed** checks on its separate rerun: the initialized
strict redirection gate passed, but the legacy `powershell` workspace-RPC test
timed out on both Node versions. That test still used a raw runtime invocation,
not Core's initialized shell preparation. The failure is retained in the full
check/event snapshots; the earlier 11/11 at `43f7392` is not retroactively
rewritten as a durable raw-startup guarantee.

`01ed8ce` makes that legacy RPC gate use the same production `shellCommand`
preparation. Its user command, 60-second existing exit wait, ordinary stream
redirection, exit 23, RPC CRUD/negatives, Unicode and observed-descendant
assertions are unchanged. The separate module-free .NET path is unchanged.
The original raw discovery/redirection controls still explicitly time out; no
raw direct-process compatibility guarantee is inferred from initialized-shell
success. This correction aligns the product-like test with the production fix,
not a separate fixture-only module workaround.

## Final documentation rerun: Windows passed, external ECR failure retained

Documentation/evidence HEAD `2a09e5081500e5e92bc217716a261f76ae3c956d`
completed **10 success / 1 failure**. Both native Windows Node 20/22 jobs passed,
including the initialized strict redirection and legacy RPC gates. Linux L1
Ubuntu 24.04 x64 failed while pulling the unchanged Alpine fixture image:
`public.ecr.aws/docker/library/alpine:3.20` returned
`toomanyrequests: Data limit exceeded`.

The failure is pinned to
[job 116170366198](https://github.com/mysteriumpersonae/crot-mcp/actions/runs/38657412482/job/116170366198),
with its complete annotation snapshot retained beside the check/event arrays.
It is classified as an external registry failure, not silently skipped,
converted to PASS or called a Windows regression. The other three Linux L1
jobs passed. The prior full 11/11 at qualified code/test pin `01ed8ce` remains
valid for that run only. This documentation/evidence update triggers a bounded
repeat on **unchanged src/tests/workflows/dependency manifests**; its result is
reported separately in the final PR/archive, not assumed in this document.

## Restored baseline and implementation commits

The supplied handoff was restored in a fresh Linux checkout. `git fetch origin`
confirmed source and remote branch HEAD
`3c913841f28276e4b9d1819d9a5d10f42e5d06c1`, with no unpublished patch.
Koffi 3.3.2 installed through a fresh `npm ci`. Its baseline `npm run check`
passed: 1522 core tests / 140 skips; 147 extension tests. Windows-only skips are
not Windows proof.

- `3a677623c36669290eca3a431bc742c6602c4132`: owned debugger output now retains
  native and managed call-site names with separate budgets, removes addresses,
  parameter text and unrelated output, and runs native stacks before CLR stacks.
  Three portable regressions cover sanitization and independent budgets. Added
  paired trusted/Low discovery, explicit import and assembly-load controls.
- `43f739224cf39c7bac688aa5609de5959e73f001`: **production shell preparation**
  explicitly imports Windows PowerShell's Utility module from that runtime's
  `$PSHOME` before the unchanged user script. `shellCommand` selects this only
  for legacy `powershell`, not `pwsh` or POSIX. Core's existing ProcessService
  already calls that shell provider after authorization. No second permission
  system, audit change, new launch backend or availability change was added.

The module-qualified `Microsoft.PowerShell.Core\Import-Module` uses an explicit
runtime-relative manifest, not a name searched in the project or user module
path. `-ErrorAction Stop` prevents continuation into the user script if
initialization fails. Initialization executes **inside the launched child**;
for the Low probe the token/Job setup is completed before any child code runs.
There is no trusted execution of the user's program before lowering integrity,
no insecure retry, no execution-policy override and no disabling of module
analysis, auto-loading or security checks.

Changed production code: `src/core/platform/shells.ts`. Coverage includes
`tests/platform/windows-command.test.ts`, the native Low redirection gate and
`tests/capabilities/process.test.ts`'s real Core shell regression.

## What the native comparison actually established

At `3a67762`, raw discovery of Out-File timed out at 15 seconds for the trusted
process as well as the earlier Low case. Explicit import of the fixed system
Utility manifest completed for both trusted and Low processes, followed by
ordinary expression redirection and verified output. CDB completed with exit 0
on both Node versions. The pipeline native stack at that snapshot is in CLR
`ClassLoader::PopulateAvailableClassHashTable` / nested-type hash-table work,
not a demonstrated RPC wait or the normal remoting listener wait.

This does **not** identify every unrelated assembly encountered by discovery,
prove an infinite deadlock or explain every internal CLR cause. It does prove
that the observed failure is not unique to Low integrity and that loading the
required system module explicitly avoids this discovery path. The known
Utility assembly loads successfully in both identities in the corrected GAC
control at `43f7392`.

Two new diagnostic fixture defects at `3a67762` remain visible in the archived
failed results: an early trusted-control assertion prevented collecting the
paired Low discovery row, and the assembly control guessed a DLL next to
powershell.exe. The latter was an invalid test input, not an isolation denial.
`43f7392` collects both identities before assertions and loads the one fixed
Utility DLL under the system GAC directory. No functional acceptance assertion
was removed to fix those fixture defects.

## Strict gate and real Core regression

The original ordinary redirection script is unchanged. The supported
`bounded-runtime` row now uses the **same shared shell preparation as Core**,
not a test-only import wrapper. Each child still has its original 15-second
functional deadline; output content, completion and Medium-attempt assertions
remain. The prior bare invocation is retained as `bounded-runtime-raw`, with
all observations preserved. The suite allowance is 150 seconds only to include
that additional raw observation/debugger collection, not to extend the
functional deadline.

Both native Node versions at `43f7392` observe:

- `bounded-runtime`: exit 0, private-Low UTF-16 output contains the marker;
  `low-complete;medium-attempt` is reached, then
  `System.UnauthorizedAccessException` / `OutFileCommand` FileOpenFailure;
  no Medium output file. This is a reached MIC denial, **not** successful
  transparent Medium workspace writing.
- `bounded-runtime-raw`: still reaches `low-attempt` and times out without
  output. Direct `process.exec` of powershell.exe with arbitrary arguments is
  **not fixed** by the shell-provider initialization. Other arbitrary module
  discovery is not qualified or claimed fixed.
- The separate Core regression starts a local unconfined PowerShell shell with
  a fresh profile/cache and verifies real Medium file content, stdout, stderr
  and exit 23 before 15 seconds. It proves production process correctness,
  **not** confinement or a Low-to-Medium writable view.
- All seven original `workspace-native.test.ts` RPC gates pass. That remains
  special-adapter behavior, not ordinary filesystem compatibility.

NUL stdio remains a research startup mode. This change does not implement the
native stdin/stdout/stderr byte bridge or independently qualify every inherited
handle case.

## Pinned evidence

All decoded event arrays (including repeated titles, raw timeouts and fixture
failures) and full check snapshots are in
`docs/evidence/windows-l1-continuation/`. `manifest.json` records the SHA-256 of
each JSON file's exact stored bytes. Gzip/base64 annotation parts were retrieved
only after Windows checks completed and verified for complete ordered parts.

| Source HEAD | Synthetic PR checkout | Windows Node 20 | Windows Node 22 | Overall |
| --- | --- | --- | --- | --- |
| `3a677623c36669290eca3a431bc742c6602c4132` | `ad4284cc3e95c3b4e9a229cb0628a92bcb433d65` | FAIL; strict gate and two new fixture controls | Same | 9 success / 2 failure |
| `43f739224cf39c7bac688aa5609de5959e73f001` | `89b79d98559e25873a5965c5ec4e84dd62a8be6c` | PASS, [job 116160740422](https://github.com/mysteriumpersonae/crot-mcp/actions/runs/38654435566/job/116160740422) | PASS, [job 116160740353](https://github.com/mysteriumpersonae/crot-mcp/actions/runs/38654435566/job/116160740353) | 11 success |

Additional retained pins:

- `ec11e2e`: documentation-only source above, Windows rerun FAIL at
  [Node 20 job 116164221850](https://github.com/mysteriumpersonae/crot-mcp/actions/runs/38655518644/job/116164221850)
  and [Node 22 job 116164221991](https://github.com/mysteriumpersonae/crot-mcp/actions/runs/38655518644/job/116164221991).
- `01ed8ce`: corrected shared-initialization legacy gate, latest successful
  qualification and exact merge/job pins at the top of this report.

The event field `sourceBaseline=4031536a...` is a historical hardcoded probe
label, **not** the tested source HEAD. Source pins above come from GitHub's
commit checks and the published branch; `testedCheckout` records the merge
checkout independently. Documentation commits are separate from these code
pins.

Measured configuration: Windows Server 2025 Datacenter, Rtl 10.0.26100,
UBR 33438, x64; Node 20 v20.20.2 / libuv 1.46.0 and Node 22 v22.23.3 /
libuv 1.51.0; WinPS 5.1.26100.33438. Trusted parent High IL/elevated, children
Low IL. These admin-runner results are **not** standard-user, Windows 11 or
native ARM64 qualification. No workflow-write authorization limit from the old
connection is asserted as a fact about this session.

Local full `npm run check` on `43f7392` passed: **1526 core / 144 skipped**,
**147 extension**; lint/format/types/builds passed. Local runtime was Node v24.14.1 on Linux x86_64, not a
native Windows substitute. All four actual Linux L1 CI jobs, Linux/macOS
Node 20/22, extension checks and real Chromium CI passed on that source pin.

## Full acceptance status — remains OPEN

| Required criterion | Result of this continuation | Blocking work still required |
| --- | --- | --- |
| Developer workflows / same Medium backing / unchanged user SDs | Not met | Transparent ordinary Node/cmd/PS writes against original backing; no ACL/IL weakening; full SD comparison |
| Process correctness and lifecycle | Partial | Shared WinPS fix retained; native byte ProcessLauncher component now implemented, native qualification pending. Bounded production environment, crash/recovery and full tree qualification remain open |
| Global write boundary | Not met | Unapproved Low sibling remains writable; MIC alone is not an allowed-write policy |
| Protected actual CROT state/control/Docker | Not met | Actual service fixtures, secret store/device key, control/IPC/self-approval/Docker and descendants/concurrent attacks |
| Native supported-machine acceptance | Partial | Node 20/22 x64 Server shell/RPC gates pass; ordinary Medium positives/full negatives, Windows 11/standard-user/ARM64 remain unqualified |
| Regression | Met at latest qualified code/test pin | Full local check and all 11 native/regression CI checks passed; this alone is not L1 acceptance |
| Production integration | Partial compatibility fix only | No Windows CommandConfinement backend or filesystem/global boundary; NativeHost remains fail-closed for remote workspace process/shell |
| No known critical blockers | Not met | All above critical gaps remain; raw direct WinPS discovery also remains a bounded-runtime limitation |

No user workspace labels or ACL grants were changed. ARCHITECTURE.md,
WP-25/26/27, Linux confinement, existing permissions/full_control/local
semantics and the macOS/Windows ARM64 v1 targets are unchanged. OD-6/OD-9
remain open. A new filesystem/identity/driver trust boundary must follow the
project's decision-before-code order and be proven by a real vertical slice;
this shell fix is not that mechanism decision. The full requested implementation
has **not** been delivered or accepted, and no backend is enabled.
