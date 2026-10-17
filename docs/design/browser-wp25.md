# WP-25 — Browser lifecycle implementation and qualification

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

Local and CI results are recorded below only after execution. A skipped
platform test is not a pass. Linux browser E2E does not qualify native macOS
or Windows browser UI. Existing Linux/Windows/macOS L1 suites remain unchanged.

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
