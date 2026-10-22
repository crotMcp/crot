# WP-25 — Browser lifecycle implementation and qualification

> Historical design/package baseline, not current status. Implementation, verification, delivery and operations are tracked independently in root STATUS/roadmap. Old “not merged/not implemented” statements refer to this record’s original stage. Original full-product DoD (including publication/GUI installation) remains open where STATUS says partial/external; repository delivery does not silently satisfy it.

Base: `main` merge PR #30, `e072e614480f5ac4e688ba1601a4adae8991cc10`.
AD-16 remains normative; AD-32 records passive, content-free notices and the
browser version decision before code. No L1 / authentication / exposure gates
are removed. WP-24 manual acceptance is still open; the curator authorized
WP-25 implementation on its merged code without treating that acceptance as met.

## Evidence map

| Criterion | Implementation | Automated evidence | Manual / unqualified scope |
| --- | --- | --- | --- |
| JS dialogs + content separation | CdpSessions, command handlers, validated Core schemas, new guarded tool | extension/test/wp25.test.ts; tests-e2e/browser/wp25.e2e.test.ts (alert/confirm/prompt/beforeunload); updated layout regression | Branded browser / OS combinations not inferred |
| Timeout and audit | Fixed 60,000 ms, accept:false; host-stamped browser audit record; notices limited to 120/min | Unit deterministic timer + real Chromium 60 s timeout and JSONL audit | Best-effort audit write failures do not turn dismissal into acceptance |
| File chooser | Page.setInterceptFileChooserDialog; pending chooser + safe dismiss | Real Chromium event and no native chooser path; accept:true refused | Upload is WP-26; no OS accessibility automation |
| Screenshot | CDP background/ref/fullPage, viewport/dpr, decoded 16 MiB and area bound, discarded refusal | Real Chromium pixels/dimensions, unchanged active tabs/focused windows; unit limit/timeout tests | HiDPI, branded and occluded-window matrix not claimed |
| Debugger lifecycle | Cancel in-flight operations, generation invalidation, next-command attach; no action retry | Unit unanswered promise + onDetach; real Chrome debugger API detach and stale-ref recovery | API detach emits no onDetach; cached session invalidated on next CDP refusal. User-infobar cancel needs headed manual check |
| Availability | Browser status + service overview + tray; false/not_probed until observed attach, false/debugger_unavailable on refusal | Unit bridge/Core/status tests and real E2E with injected attach refusal | Test refusal is simulated policy, not a managed enterprise installation |
| CROT group | tabGroups permission, per-window serialized group creation, popup follow-up | Unit concurrent opens + real Chromium opens/popups | Popup grouping only when browser permits; branded UI manual matrix open |
| Guard / approvals / regression | browser.control, existing tab/origin/connection binding; screenshot ref subject; no message or promptText audit | MCP tool authorization suite, Core approval tests, strict notice validation/rate limit; full check and browser suites | Existing WP-24 acceptance and WP-26/27 are not closed by this package |

## Qualification log

Implementation revision:
[`8c84a4a`](https://github.com/mysteriumpersonae/crot-mcp/commit/8c84a4aad993901a57857355e2fc0f379c3c61aa).
The later documentation-only commit does not change the code under test.

Local execution on Linux x64, Node 24.14.1, Chrome for Testing 153.0.8010.12:

| Command / scenario | Observed result | Scope |
| --- | --- | --- |
| `npm run check` | Exit 0: lint, format, both typechecks / builds; root 1,985 passed + 215 skipped; extension 154 passed | Root skips include unavailable native-platform tests, not successful macOS / Windows qualification; extension API is fake in unit tests |
| `npm run test:e2e:browser` | Exit 0: 4 files, 38 passed + 3 existing platform-placeholder skips | Real Linux Chromium, isolated profile / HOME, `CROT_E2E_HEADLESS=1`, container `--no-sandbox` only in the test browser |
| New WP-25 suite | 7/7 passed, including actual 60 s auto-dismiss + JSONL audit | Unmocked MCP → Core → bridge → native messaging → extension → Chromium; policy attach refusal explicitly injected |
| Shadow-root OOP-frame regression | Whole-suite final run passed; 3 additional isolated runs each passed | The preceding local full run had one missed `frame-click` witness (37 passed / 1 failed / 3 skipped). No assertion was removed, no action retry or synthetic fallback was added. The intermittent failure is retained as a qualification caveat, not claimed to have a diagnosed root cause |

CI evidence for the implementation revision:

- [Real Chromium job](https://github.com/mysteriumpersonae/crot-mcp/actions/runs/39077672825/job/117528096154):
  successful; Ubuntu + Node 22 + Chrome for Testing under Xvfb, with
  `crot-browser-e2e-logs` uploaded by the unchanged workflow.
- [Node 20/22 OS matrix](https://github.com/mysteriumpersonae/crot-mcp/actions/runs/39077673081):
  Linux / macOS / Windows checks, not branded-browser UI qualification.
- [Linux L1 matrix](https://github.com/mysteriumpersonae/crot-mcp/actions/runs/39077672959):
  four jobs, unchanged confinement regression coverage.
- [PR #31 final-head checks](https://github.com/mysteriumpersonae/crot-mcp/pull/31/checks)
  must all be successful (11 jobs) before Ready for review. These are the
  final-head results; earlier implementation-run links above are a fixed
  evidence baseline, not a substitute for checking the final SHA.

A skipped platform test is not a pass. Linux browser E2E does not qualify
native macOS or Windows browser UI. Existing Linux/Windows/macOS L1 suites
remain unchanged. This log distinguishes passed automated implementation
checks from the manual acceptance / release gates below.

## Remaining work and release boundaries

- Complete WP-24 owner acceptance (including C1/default-load follow-up).
- Headed Chrome/Edge/Brave debugger notice and user-cancel on Linux/macOS/Windows;
  actual enterprise policies, minimum-version and HiDPI/window variants.
- WP-26: decide OD-8, implement file upload/download; WP-27: remote explicit tab
  and openedBy / two-agent ordering. Their dependency acceptance is not invented.
- WP-29 follow-up blockers remain before public WP-38; WP-32 depends on its
  browser/remote prerequisites and WP-38. No change to v1 boundaries.
- WP-34 signed distribution, WP-35 store approval, WP-33 independent review
  and later release gates remain separate. Green CI / Ready for review is not GA.
