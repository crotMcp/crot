# Stage A functional slices — verification

The latest verified implementation checkpoint is
`efca35d7ff58c36a5cab34a28c300adba0da26a0`; see its section below.
Earlier sections are historical checkpoint records, not current branch status.
PR #4 was subsequently merged by the owner; Stage A remains incomplete.

## Initial security slice — historical scope and immutable source

- Branch: `feat/core-stage-a`.
- Current functional source: `5e4bdedb8657013bd269014b474aad1dd75009e3`.
- Initial security/UI slice: `79dad913bb998436ef4722dac290d9db2d475390`.
- Base: PR #4 head `720ba09008fb23ea9a2a7f7573b822868f52613a`.
- PR #4 was still open/unmerged in both GitHub MCP and Git refs when checked;
  `main` remained `8306e94bf12ab033524de2b45016d8e3750a164b`.
- No merge performed. PR #5 deliberately not opened: Stage A is incomplete.
- Official domain remains `crot.network`; no production-domain migration made.

## Observed local results

Environment: Linux x64, Node `24.22.1`; installed repository dependencies.

| Command / scope | Result | Source |
| --- | --- | --- |
| `npm run check` (lint, docs, formatting, TS, Core/extension builds, main tests, extension tests) | Passed | `5e4bded` |
| Main suite | 191 files passed / 27 skipped; 2,236 tests passed / 219 skipped | `5e4bded` |
| Extension suite | 15 files / 193 tests passed | `5e4bded` |
| Linux Chromium E2E | Passed: 10 files; 58 tests passed / 3 platform placeholders skipped | `5e4bded` |
| Chromium design + axe fixture QA | 81 checks, 29 screenshots; zero failures/page errors | `79dad91`; UI sources unchanged in `5e4bded` |

Browser command:

```sh
CROT_E2E_CHROME=/usr/local/bin/chromium \
CROT_E2E_HEADLESS=1 \
CROT_E2E_CHROME_ARGS='--no-sandbox --disable-dev-shm-usage' \
npm run test:e2e:browser
```

## Security cases covered

- Runtime schema rejects unknown fields, ambiguous selectors, duplicate selectors
  and invalid states; read snapshots cannot mutate the authoritative policy.
- Runtime allow cannot grant missing capabilities, escape workspace bounds, read
  protected service secrets or remove mandatory configured approval gates.
- Strict Mode gates a real file read; owner approval and execution are audited.
- Deny wins over strict. Policy changes while approval is pending are checked
  again before execution; denied writes never create the target file.
- Core emergency stop terminates an actual background process, cancels pending
  approval, invalidates its ticket, and refuses new filesystem/process calls.
- Real owner IPC stop leaves owner diagnostics reachable, refuses subsequent shim
  admission, is idempotent and produces one emergency-stop journal entry.
- Actual service workflow: connect MCP agent → request file-write task → receive
  approval on subscribed owner channel → approve the exact digest → observe file
  and successful execution in the journal. Strict policy survives service restart.
- A failed policy audit does not publish a new policy. A durable pre-audit
  snapshot restored after a simulated crash recovers the prior policy, not the
  uncommitted policy. The commit snapshot is written only after audit succeeds.

## Attempts and limits

An intermediate run failed the newly added recovery assertion
(`securityPrevious` absent). Source/test edits had overlapped that run's compiled
snapshot. The subsequent clean rebuild of the fixed source at `5e4bded` passed the
complete check, including both product-cancellation/recovery tests. That mixed
snapshot run is not final acceptance evidence.

Native Electron tray smoke was skipped because this environment has neither
DISPLAY nor Xvfb. Other platform-specific skips are not passing qualifications of
macOS/Windows/native installers. Chromium fixture QA qualifies presentation, not
provider credentials, transport authorization or live side effects.

Remote GitHub CI was not run for this partial branch: workflows trigger on main
push or PR. No green remote CI is claimed. Before Stage A acceptance, create the
completed PR #5 and observe every required check on its actual head SHA.

This slice does **not** complete scoped agent tokens, project-scoped approval
persistence, native project selection/discovery, L1 application-secret file
blocking, provider model inventory/chat, attachments, streaming or tool-call UI.
B/C, live Relay/provider qualification, deployment, native signing and publication
remain outside this result. See [progress](PROGRESS.md) and AD-43.


## Next working slice: named tokens and folder-picker wiring

The historical results above apply only to their recorded SHAs. On the current
uncommitted working tree, a targeted run passed 4 files / 69 tests:
`service.test`, `client-tokens.test`, `runtime-security.test`, `confinement.test`.
TypeScript passed. This is not yet the full check or remote CI for this slice.

Added coverage: real service owner issue/rotate/revoke; actual HTTP scope denials;
rotation cancels a pending file-write task (file never created); old bearer
credentials rejected; no plaintext in listing/storage/audit; TTL boundary and
expiry invalidation; restart persistence; audit-failed issuance stays inactive;
malformed registry rejected; bounded TTL and strict scopes; every Core capability
intersected; scoped process execution requires L1; launcher-selection fixture
terminates an actual token-owned process under Strict Mode while preserving an
unrelated token's process. That last fixture is **not native L1 qualification**.

An initial integration attempt timed out while awaiting an SDK promise after
forced SSE disconnection: the SDK waited to reconnect a resumable stream. The
corrected test independently asserts the service-side Cancelled task and absent
file, then closes the obsolete client and verifies the rejected result. Native
folder-picker GUI smoke remains unavailable without DISPLAY/Xvfb. See AD-44.


### Verified checkpoint `57a043aa74bc265bb08a7aa0f76f0184074c709e`

The exact 21 pushed files were compared byte-for-byte with the working source;
no implementation edits overlapped the following sequential verification runs:

| Command / scope | Observed result |
| --- | --- |
| `npm run check` | Passed: lint/docs/format/types/Core and extension builds |
| Main tests | 192 files passed / 27 skipped; 2,244 tests passed / 219 skipped |
| Extension tests | 15 files / 193 tests passed |
| Linux Chromium E2E | 10 files; 58 tests passed / 3 platform placeholders skipped |
| Design + axe Chromium QA | 81 checks, 29 screenshots; zero failures or page errors |

Logs: `stage-a-tokens-check.log`, `stage-a-tokens-e2e.log`,
`stage-a-tokens-ui.log` in the agent workspace. Native L1 execution suites and
native Electron GUI have platform/prerequisite skips; these are not passing
qualifications. In this service test environment, named-token process execution
is correctly refused when L1 is unavailable. Process teardown under Strict Mode
is independently exercised with an explicit launcher-selection/lifecycle fixture.

These are local results for the named-token slice, **not** complete Stage A
acceptance and **not** observed GitHub CI. PR #5 has not yet been created. The
remaining acceptance gates in PROGRESS.md still apply. B/C have not begun.

## Verified guarded-chat checkpoint `66c58f9a6b0750a4cffcfcc93829a75c29a3fce6`

The implementation is in `4c6e057`; `66c58f9` adds its real-service UI scenario
and replaces the obsolete test that required the disabled chat placeholder.
All 19 pushed source/test files were compared byte-for-byte with the worktree;
the preserved local merge tree also exactly matches the remote checkpoint.
No implementation edits overlapped these sequential verification commands.

| Command / scope | Observed result |
| --- | --- |
| `npm run check` (final repeat) | Passed: lint/docs/format/types/Core and extension builds |
| Main tests | 194 files passed / 27 skipped; 2,248 tests passed / 219 skipped |
| Extension tests | 15 files / 193 tests passed |
| Linux Chromium E2E | 10 files; 58 tests passed / 3 platform placeholders skipped |
| Design + axe Chromium QA | 81 checks, 29 screenshots; zero failures or page errors |

Logs: `stage-a-chat-final-check.log`, `stage-a-chat-e2e.log`,
`stage-a-chat-ui.log` in the agent workspace. The first full check failed one
obsolete UI assertion requiring the chat to remain disabled; the other 2,247
tests passed. The updated test verifies owner IPC, explicit tool selection,
plain-text output and no direct renderer networking. The full repeat above is
the passing evidence, not the initial failed run.

Coverage includes actual local HTTP model inventory and SSE formats for OpenAI,
Anthropic and OpenAI-compatible Local HTTP; validated text attachment transfer;
a real Core file write held for the broker's digest-bound owner approval; audit;
visible partial response and stop closing HTTP; no plaintext provider key in
listing, metadata, encrypted vault, audit or logs. Negative cases reject malformed
or incomplete streams without executing tools, refuse unselected tools, close a
cancelled pending approval without writing, enforce runtime network deny before
contacting the fixture, reject invalid attachments, and redact decoder failures.

The shipped Chromium UI test uses an isolated real CrotService and the real tray
controller behind a test-only IPC bridge. Its chat model list, streamed response,
inline approval, actual file contents, registered chat identity and audit are
asserted; they are not fabricated renderer fixtures. This does not qualify
native Electron IPC/dialogs or live provider credentials. Presentation-only axe
checks remain a separate fixture qualification.

PR #5 is still not created and remote CI is not observed. Project-persistent
approval grants, stack/project-port discovery and application-secret enforcement
at the L1 process boundary remain Stage A gates. B/C have not begun, nothing has
been merged, and the domain remains `crot.network` / `mcp.crot.network`.


## Verified project grants checkpoint `00613ecfecab4d55304e80a52473e70997c5f082`

Twenty-one pushed source/test files matched the local bytes. Sequential local
verification (no implementation edits during a run) observed:

| Scope | Result |
| --- | --- |
| `npm run check` | Passed: lint/docs/format/types/Core and extension builds |
| Main tests | 194 files passed / 27 skipped; 2,252 tests passed / 219 skipped |
| Extension tests | 15 files / 193 tests passed |
| Linux Chromium E2E, full repeat | 10 files; 58 passed / 3 platform placeholders skipped |
| Design + axe QA | 81 checks, 29 screenshots, zero failures/page errors |

Logs: `project-grants-check.log`, `project-grants-e2e-repeat.log`,
`project-grants-ui.log`. The first full E2E run failed one shadow/OOPIF click with
a missing server event (57 passed / 3 skipped). Its isolated repeat and full
repeat passed, but the same failure recurred at the inspection checkpoint. It
was investigated as a real input-routing defect, not dismissed as a passing
qualification or hidden with retries. See the final checkpoint below.

Coverage includes wrong digest refusal, persistent exact workspace/operation
grants, restart restoration, Strict/deny/mandatory-gate precedence, revocation,
audit failure and cancelled-ticket rollback, and shipped real-service UI
Allow once / Allow for project / later action with no new request.

## Verified project inspection and input checkpoint `e2dd2c0315f9de8f85f3d0dfa3488871fc0ee90a`

Inspection source is in `bca9b9a4e28d8be881f8bfebd951af8a24a72186` (13 pushed files
matched byte-for-byte). The final checkpoint adds a 512-listener response limit,
compositor/input preparation, activation-delivery checks and regression evidence.
Its 12 pushed files and the entire preserved local merge tree exactly matched
the remote checkpoint before the following sequential final runs completed.
No implementation edits overlapped those runs.

| Command / scope | Observed result |
| --- | --- |
| `npm run check` | Passed: lint/docs/format/types/Core and extension builds |
| Main tests | 195 files passed / 27 skipped; 2,260 tests passed / 219 skipped |
| Extension tests | 15 files / 196 tests passed |
| Linux Chromium E2E | 10 files; 58 passed / 3 platform placeholders skipped |
| Design + axe QA | 81 checks, 29 screenshots; zero failures/page errors |

Final logs: `stage-a-project-final-check.log`, `stage-a-project-final-e2e.log`,
`stage-a-project-final-ui.log` in the agent workspace. These are local results,
not observed remote GitHub CI. Native prerequisite/platform skips remain skips,
not qualification. This is not complete Stage A acceptance or an installable
release; no PR #5 or B/C acceptance is claimed.

### Project evidence

- Core: fixed package/Python/Docker manifest evidence, malformed/oversized/non-file
  reporting, no scripts or arbitrary package metadata returned, existing
  filesystem/port-operation deny gates, cancellation while awaiting approval.
- Linux: actual listening child with workspace cwd found; a child outside that
  cwd excluded; closed listener disappears. The response is bounded, explicitly
  reports partial/unavailable observations, and grants no network access.
- Real service: pending port approval holds the workspace-switch barrier; owner
  approval produces audit; cancellation remains responsive; task replay disabled.
- Shipped Chromium UI: actual fixture manifest yields Node.js/TypeScript/React
  evidence through the real service, alongside the existing projects/files/Git/
  terminal/chat/approval/audit scenarios.
- macOS/Windows port observation is not implemented; returns unavailable. Native
  Electron picker and native platform L1/application-secret policy remain gates.

### Failed runs and actual browser regression

The initial inspection full check passed (2,260 main / 193 extension tests), but
full Chromium again failed the shadow/OOPIF case (57 passed / 3 skipped). The
product-service UI scenario itself passed. Diagnostic reproduction recorded
trusted pointerdown on the parent iframe, pointerup on the target button, no
click and unchanged target status. The old broad pointer-count probe reported
success even though the intended activation never happened.

The fix prepares compositor routing with a move and bounded settle, rechecks
geometry/coverage/enabled state before any press, and makes click completion
require a trusted activation instead of split pointer events. Failure warns of
possible partial input and never automatically repeats a press. The real test
now asserts trusted down/up/click on the actual target plus its server event.
The isolated-world probe is also serialized and executed in its own unit test,
independently of the fake browser's count fixture.

Two initial unit assertions failed because they assumed preparation emitted no
mouse move; the assertions were updated to distinguish wheel/key events from
that move, without weakening the no-replayed-press checks. The focused suite
passed 57 tests before the additional serialized-probe test. Four full layout
runs then passed in sequence (13 cases passed / 1 platform placeholder each):
`iframe-fix-real.log`, `iframe-fix-repeat-1.log`, `iframe-fix-repeat-2.log`,
`iframe-fix-repeat-3.log`. The final whole-project and full browser results above
are the passing evidence, not the earlier failures. See AD-48.

### Outstanding security acceptance boundary

A renderer or Core filename filter alone cannot enforce secret-read denial
inside an arbitrary child process. Nor can masking only the secret files that
exist at process startup cover a host-created secret appearing later, aliases
or rename races. The general `.env` / `*.pem` / `*.key` L1 policy and explicit
owner grant/revoke workflow are **not implemented** by these checkpoints.
Existing static CROT service-secret protection is not a substitute. This remains
a release/Stage-A gate; it must not be marked done by adding an unenforced UI
switch. Domain remains `crot.network` / `mcp.crot.network`; nothing was merged.


## Native folder picker and inspection rerender — verified efca35d

Implementation commits: `0ca05c5e7ddb38563a6c82db7321ac553d01389e`
(native picker workflow/qualification) and
`efca35d7ff58c36a5cab34a28c300adba0da26a0` (inspection rerender fix).
The entire local source tree matched the latter remote commit byte-for-byte
before final qualification. No source edits occurred during those runs. This
supersedes historical statements that this Linux host could not run Electron:
Xvfb, xdotool and GTK/GUI libraries were installed for the native test desktop.
Environment: Linux x64, Node 24.22.1, Electron 44.5.1.

| Final command / scope | Observed result |
| --- | --- |
| npm run check | Passed: lint/docs/format/types/builds/main/extension |
| Main suite | 197 files passed / 26 skipped; 2,275 tests passed / 218 skipped |
| Extension suite | 15 files / 196 tests passed |
| Existing real Electron tray smoke | 1 test passed, no longer skipped on this host |
| New real OS folder chooser | 3 workflow checks passed, zero errors |
| Full Linux Chromium E2E | 10 files; 58 tests passed / 3 platform placeholders skipped |
| Chromium design + axe QA | 81 checks / 29 screenshots; zero failures/page errors |

The 14 new picker unit cases cover native-choice registration, cancellation,
invalid paths/multiple choices, invalid registration/selection acknowledgements,
overlap refusal and lock release after service exceptions. Native Linux evidence
separately proves cancellation preserves registry and Core root; actual folder
selection (with spaces) registers/selects the canonical project, refreshes the
shipped UI, changes real Core and writes projects.open/projects.select audit.
Neither test claims the unfinished L1 application-secret filename policy.

Native qualification command (after npm run build; Linux X11 only):

```sh
xvfb-run -a -s '-screen 0 1600x1200x24' \
  node scripts/project-picker-native-qa.mjs --output=project-picker-native.json
```

Initial native driver attempts incorrectly used Enter after GTK location input:
the actual chooser returned cancelled. Those are failed driver attempts, not
successful selections. Diagnostic native screenshots identified the controls;
the final driver clicks the real native Open button once, without replacing the
dialog or retrying a possibly committed selection. The final report is passed.

An intermediate full E2E run on `0ca05c5` failed 1/61 tests (57 passed, 3 skipped):
the real-service inspection result disappeared after a page replacement. AD-50
fixes the production presentation race rather than increasing the timeout.
The final real-service browser journey deterministically delays the real response,
rerenders, verifies one request through navigation, discards the snapshot across
workspace switches, and admits one new request only after an explicit click.
The subsequent complete check, complete browser E2E and axe QA above passed at
`efca35d`; the earlier failed run is not acceptance evidence.

Remote CI is still not observed: this branch is partial, PR #5 is not opened,
and workflows run on main push/PR. A proposed addition of the standalone native
picker job was refused by GitHub with HTTP 403 (token cannot update workflows).
No workflow change was pushed; existing CI configuration remains unchanged.
Ordinary source pushes succeeded. Running the documented native command locally
is not evidence that the standalone job ran remotely. macOS/Windows dialogs and
port discovery, native L1 application-secret enforcement with owner grants/revoke,
and complete-Stage-A remote CI remain gates. No PR was merged; B/C remain unstarted.


## AD-51 native project ports — pending cross-platform qualification

Adds Darwin libproc creation/UID checks + fixed absolute-path lsof commands,
and Windows owner-PID TCP tables, same-owner SID checks, process creation time
and bounded read-only CurrentDirectory observation. The existing process guard
runs first. No command-line/environment read, port scan, remote connection or
new authorizer is introduced. Unknown/changed metadata is incomplete, not free.

Linux observations before the final cancellation regression addition:

- Complete npm run check passed: 197 main files / 2,285 tests passed,
  27 files / 219 tests skipped; extension 15 files / 196 tests passed.
- Complete Chromium E2E: 10 files; 58 passed / 3 platform placeholders skipped.
- UI + axe: 81 checks / 29 screenshots; zero failures or page errors.
- Native chooser did not run: xvfb-run was absent in the current environment.
  This is a failed environment precondition, not a passed chooser check.

GUI dependencies were restored afterwards. Review also found a late cancellation
window in the new native observer; checks after awaited identity/cwd reads now
refuse publication, with a dedicated final-recheck abort test. The final focused
regression run passed 2 files / 18 tests. Complete checks and native chooser must
be rerun on this final source. A Draft PR is for actual existing macOS/Windows CI,
not a claim that parser fixtures qualify those APIs or Stage A is complete.
General project-secret L1 enforcement and explicit owner access/revocation remain
unimplemented; B/C remain unstarted. No merge is performed.


## Observed remote CI and final local evidence — eaac4b8

Source SHA: `eaac4b82f69b0e5176f17e5fbdfac39cf9fc0f05`. The local tree matched
the pushed source before the final runs; no edits occurred during testing.

- Final complete check: 198 main files / 2,287 tests passed, 26 files / 218 tests
  skipped. Extension: 15 files / 196 tests passed. Real Electron smoke passed.
- Final complete Chromium E2E: 10 files; 58 passed / 3 platform placeholders skipped.
- Final UI/axe: 81 checks / 29 screenshots; zero failures or page errors.
- Final real Electron/GTK chooser: all 3 workflow checks passed, zero errors.

PR #5 was opened as **Draft**, not accepted or merged. Observed GitHub results
for this SHA: **10 of 11 checks successful**. Both macOS jobs, Linux Node 20/22,
all four Linux L1 jobs, real-chromium and Windows Node 20 passed. Windows Node 22
failed with a 20,000 ms timeout in the composite scoped-loopback-token test
(`tests/service/service.test.ts:316`), not a native-port assertion. This failed
run is not full Pass. Local isolated reproduction passed; the failing phase was
not identified by the old test's generic timeout.

The follow-up splits the composite test into independent HTTP scope/identity
ceilings, rotation/pending approval/credential invalidation/audit, and confined
terminal revoke contracts. Every previous security assertion remains; the
normal 20s budget is unchanged, with no retries or platform skips. Each contract
also reports its last phase on failure. A complete service-file run passed
locally after this refactor. Remote CI must validate the follow-up; splitting
the contracts is not proof that the original timeout was only aggregate cost.

The actual Darwin/Windows process adapters are now exercised by non-skipped
real child-listener tests in the existing OS matrix. That evidence does not
qualify native folder dialogs on those OSes or the still-unimplemented general
project-secret L1 filename policy and explicit owner grant/revoke. B/C remain
unstarted; no merge is performed.

## AD-52 project secret policy candidate (not Stage A acceptance)

Prior head `48420e9276c6ac00be405a2e1824d2dc695b31c9` completed all eleven
GitHub check runs successfully (six Node/OS combinations, four Linux L1 jobs,
and real Chromium). This qualifies that head's tested contracts, not the new
project-secret policy or complete Stage A.

Initial local targeted AD-52 checks: 25 passed; 23 macOS-native tests skipped on
Linux. The first full local run passed lint/format/docs/typechecks/builds but
failed the old Compose implicit `.env`-access contract: 2297 passed, one failed,
220 skipped. The test is updated to require the new exact owner opt-in and adds
sandbox/full-control refusals before any Docker invocation. No security check is
relaxed. A fresh complete run must verify this follow-up.

Native macOS tests now compile the new profile, check files created after an
actor is running, real EACCES/EPERM for reads/writes/rename/hardlink attempts,
exact opt-in and fresh-sandbox removal, and read-only project bind refusal while
retaining a positive mediated Docker request. These must pass on actual macOS;
Linux parser/preflight tests cannot qualify Darwin kernel behavior. Linux/Windows
general secret-file L1 and live owner IPC/UI grant/revoke remain unimplemented.
PR #5 stays Draft; no merge or full Stage A Pass is claimed.

The first AD-52 candidate `7f9ecd59bf9f11638dd0a4b9f14a0f05865b34a0`
passed the complete local check (main 2300 tests, extension 196), real Chromium
(58 pass/3 platform placeholders skipped), shipped UI (81 checks, 29 screenshots,
zero failures), and Linux native folder workflow (3 checks, zero errors). The
new macOS late-secret test FAILED on both Node 20 and 22: an already-running
actor read a future secret. This is real negative security evidence, not a
flaky-test dismissal; that candidate is not qualified.

Follow-up changes the regex from a raw `#` literal with string-escaped
backslashes to an ordinary Scheme string. The native adversarial assertion is
retained, with per-action failure labels. Admission self_test now creates a
unique `.env.crot-l1-*` non-secret canary after the preflight layout was built
and requires actual kernel denial of read and rename before admitting work.
A profile compiling successfully is insufficient. Both local reruns and actual
macOS CI must validate the follow-up; no native Pass is inferred in advance.


## AD-52 observed qualification and AD-53 follow-up

The regex-corrected head `cb71d2bd57aa79a356619df41e9300c7f316430d`
completed all eleven GitHub checks successfully: six Node/OS combinations,
four Linux L1 jobs and real Chromium. Both actual macOS jobs passed the strict
future-secret and special-character workspace tests. Final Windows completion
was observed at 2026-10-24T13:08:13Z. Runs:
- https://github.com/crotMcp/crot/actions/runs/40095438256
- https://github.com/crotMcp/crot/actions/runs/40095438287
- https://github.com/crotMcp/crot/actions/runs/40095438222

Matching frozen-tree local checks: main 2300 pass / 221 skip, extension 196
pass; browser 58 pass / 3 platform placeholders skipped; shipped UI 81 checks,
29 screenshots, zero failures/page errors; real Linux GTK folder workflow
3 checks, zero errors. These results supersede the pending-correction status
above, not the recorded failure of `7f9ecd5`.

AD-53 is a new source candidate, not covered by that SHA's green CI. Initial
targeted service/Core checks passed 36 tests; expanded transition-fault checks
passed 33 tests before adding the drain-failure case. The first direct shipped
UI run used stale `dist` (the unit global setup builds an isolated cache), so
it correctly failed on the missing new control. A fresh production build and
complete local/remote qualification remain required; this is not a UI Pass.
Linux/Windows general secret-file L1 and actual macOS/Windows folder workflow
remain unqualified. PR #5 stays Draft; no Stage A acceptance or merge.


After a fresh production build, the shipped real-service Chromium scenario
passed the new explicit cancel/grant/revoke assertions and preserved the prior
project/chat/task/audit journey. The first complete AD-53 `npm run check`
passed lint/format/docs/types/builds but had two failures: old browser/process
shutdown tests expected the later capability-specific `OPERATION_FAILED`.
The retired Guard now refuses synchronously with `RESOURCE_BUSY`. Expectations
are updated to the stricter lifecycle contract; browser transport remains
untouched, command admission remains denied and shutdown idempotence remains
asserted. A new assertion covers refusal before asynchronous drain completes.
A fresh complete run is required, not an automatic Pass from this explanation.

### AD-53 complete local rerun

After updating only the retired-Core expectations, the complete sequential
frozen-source rerun passed:

- `npm run check`: lint, formatting, documentation, both typechecks, both builds,
  main **202 files / 2311 passed**, **26 files / 221 native-platform skips**;
  extension **15 files / 196 passed**. No retries or native skips were added.
- `npm run test:e2e:browser`: **10 files / 58 passed**, **3 existing platform
  placeholders skipped**. The shipped real-service UI verifies explicit cancel,
  exact grant and revoke (`ownerSecretConfirmationAndRevocation: true`) alongside
  the existing streamed-chat/tool/approval/audit journey.
- Shipped UI QA: **81 checks / 29 screenshots / 0 failures / 0 page errors**.
- Actual Linux Electron 44.5.1 GTK folder workflow: **3 checks / 0 errors**.

Only documentation was updated after these runs; formatting/local links are
checked again before publication. This candidate still needs actual remote CI;
prior-head green checks do not cover it. Linux/Windows future-secret L1 and
actual macOS/Windows native folder workflows remain acceptance blockers.


## AD-53 observed remote qualification

Head `8ca0cd7581d559b743635dcdd37d357f6ea0447f` completed all **11/11**
GitHub checks SUCCESS. Both macOS jobs, both Ubuntu jobs, all four Linux L1
jobs, real Chromium and both Windows jobs passed. The final Windows Node 20
job completed at `2026-10-24T14:10:40Z`. Runs:
- https://github.com/crotMcp/crot/actions/runs/40099838650
- https://github.com/crotMcp/crot/actions/runs/40099838646
- https://github.com/crotMcp/crot/actions/runs/40099838662

This qualifies the AD-53 exact owner grant/revoke/retirement tests on the actual
OS matrix. It does not prove Linux/Windows future-secret L1 or their native
folder chooser workflows.

AD-54 adds actual AppKit/Windows chooser drivers and a mandatory native-host
integration test in the existing matrix, without workflow/security changes.
The generalized GTK path passed 3 checks locally. AppKit/Windows are new
candidates pending actual CI; no native Pass is inferred from the Linux result.

AD-54 complete local candidate checks passed: `npm run check` main 2311 pass /
222 skip (the new test is explicitly macOS/Windows-only), extension 196 pass;
real Chromium 58 pass / 3 existing placeholders skipped; generalized actual GTK
folder workflow 3 checks / 0 errors. No production authorization or native-dialog
implementation changed. Only this evidence paragraph is added after the frozen
source run. AppKit/Windows driver behavior remains pending actual native CI.


AD-54 first native candidate `a88a2f1` FAILED actual macOS: the inspector VM
used by Playwright has no dynamic-import callback, so the test driver could not
load Koffi. This is a test-runtime failure before native chooser inspection,
not native acceptance. The follow-up uses Electron's `process.getBuiltinModule`
loader; a separate real Electron 44 local probe loaded the same Koffi module
successfully through this API. Strict real chooser/service assertions remain.
Actual macOS must validate the follow-up; no bypass or skip is substituted.


Loader candidate `e36ca7f` reached and recognized the real AppKit chooser, but
both macOS jobs FAILED when cancelling it: the Electron target terminated.
This is not native Pass. The next driver schedules native mutations through
AppKit `performSelectorOnMainThread:withObject:waitUntilDone:` asynchronously,
avoiding UI mutation/reentrant dialog completion inside the inspector FFI call.
It also retains the last native main-thread observation and child exit signal
on failure. The service/registry and all three acceptance assertions are
unchanged. Only actual macOS can qualify this follow-up.


The first AD-54 Windows Node 20 job also FAILED: searching only direct desktop
UIAutomation children by title found no chooser. The follow-up resolves a
single visible native common-dialog handle through Win32 process/owner
identity, then drives that handle's actual UIAutomation provider. Unrelated
processes, hidden windows and ambiguous owned dialogs are refused. The exact
real-service selected-path/cancel/audit assertions remain unchanged. Native
window/control metadata is included on failure, rather than declaring this
runner unsupported or skipping acceptance.
