# Stage A functional slices — verification

The latest verified implementation checkpoint is
`e2dd2c0315f9de8f85f3d0dfa3488871fc0ee90a`; see its section below.
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
