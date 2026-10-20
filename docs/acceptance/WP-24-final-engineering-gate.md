# WP-24 — final engineering acceptance gate before WP-27

Baseline: main `386bf3b647b87fc8dd84561aca6cab8fc725a5b5` (merged PR #32), identical tree to accepted WP-26 head `5df8345b5106578b33b4c828ba83985f2210eaf2`. This is engineering acceptance against the WP-24 card and AD-16.19, not a substitute for a product owner's optional final review.

## Criterion-by-criterion evidence

| Criterion / expected result | Actual result and reproducible source | Status | Limits |
| --- | --- | --- | --- |
| Multi-step form operated by refs, submitted values correct | `tests-e2e/browser/browser-v1.e2e.test.ts`, form flow and server-observed values | Passed | Local real Chromium fixtures |
| Navigation/reload/removal/detach invalidate refs | Browser-v1 stale-ref cases; debugger detach coverage in `wp25.e2e.test.ts` | Passed | No stale-target recovery/retry |
| Click, keys and text are trusted | Browser-v1 records page-observed `isTrusted` events | Passed | Fixed built-in input functions only |
| Cross-origin frame and open shadow root work | Browser-v1 and layout suites; owner run 1 CodePen / Polymer; run 4 frame submissions | Passed | Closed shadow roots remain outside scope |
| Forbidden CDP cannot be sent | `extension/test/cdp.test.ts` allowlist rejection; browser-v1 CDP witness | Passed | No Runtime / arbitrary execution surface added |
| Audit contains metadata, not content | Browser-v1 audit assertions; owner run 5 G5.1–G5.3 real audit interval and H follow-up | Passed | Owner used equivalent one-off scripts, not missing helper |
| At least three real third-party sites recorded | `WP-24-manual-run-1.md`: Wikipedia, CodePen, Polymer shop, the-internet; subsequent retests in runs 2–5 | Passed | Historical manual evidence, not rerun on every commit |
| All reported blocking implementation defects resolved | PRs #23–#26, layout suite; run 4 B4/E5/windows and run 5 G5/H0–H6 | Passed | Site-specific transient origins are not proven |
| Default load timeout is observable without pretending a pending document is readable | PR #26 (`289f500`); layout E2E delayed headers 23s: `loadTimedOut:true` at 20s, immediate restricted snapshot, SAME tab readable after commit | Passed | Reproduces mechanism, not external-server delay cause |
| C1 no snapshot hang during frame form/history workflow | Run 4: six successful real CodePen submissions, no stalled snapshots; layout E2E three local iframe form/history cycles | Passed | Demo's “back” link goes to codepen.io, not form; not a CROT failure. Original external AX incident not reproduced; retained as observation, not mislabelled fixed |

## Current-code verification, not an inferred platform gap

All eleven checks on accepted head are successful:

- Main OS × Node matrix (Linux/macOS/Windows, Node 20/22): https://github.com/mysteriumpersonae/crot-mcp/actions/runs/39345422427
- L1 matrix: https://github.com/mysteriumpersonae/crot-mcp/actions/runs/39345422980
- Real Chromium: https://github.com/mysteriumpersonae/crot-mcp/actions/runs/39345422739
- PR #32: https://github.com/mysteriumpersonae/crot-mcp/pull/32

The accepted browser run has 49 passed / 3 opt-in skips; the WP-24 mandatory scenarios are not those skips. The six native Core file-contour qualifications are each 30/30 with zero skips. This does NOT claim branded-browser E2E on Windows/macOS. The Chrome/Edge/Brave debugger-notice × OS matrix is tracked by WP-25 / release gate G3, not silently closed by WP-24.

## Disposition

- **Engineering:** all mandatory WP-24 card criteria have evidence. No outstanding demonstrated blocking CROT defect was found in runs 4–5. Timeout signalling already has a stricter automated regression than repeating a slow external site; C1's demo mismatch is not a product defect. No redundant manual test is required for those observations.
- **Owner-only mandatory action:** none in the WP-24 card. Earlier “final owner acceptance” labels did not specify an additional product-only pass/fail criterion. The curator's preliminary-gate instruction permits closing such a formal label once mandatory criteria are evidenced. This document does not invent owner approval or rewrite the historical manual reports.
- **Optional owner review:** retry a formerly slow real site and observe `loadTimedOut` / reuse the same tab; not a prerequisite to WP-27.
- **Dependency:** WP-24 engineering gate CLOSED; proceed to WP-27. Remaining full Browser v1 release criteria (WP-27 and G3 branded-browser notice matrix) stay separate.
