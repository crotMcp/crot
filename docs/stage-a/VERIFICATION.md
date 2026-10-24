# Stage A security slice — verification

## Scope and immutable source

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
