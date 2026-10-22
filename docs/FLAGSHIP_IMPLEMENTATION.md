# Flagship product surfaces — implementation and evidence

## Scope

Working branch: `feat/flagship-control-center`, based on main
`5dc81e5ceab7f92cbf4901dce519e0685c92c8a9`.

This is a **partial implementation, not a release qualification**. Do not mark the
six-stage curator directive complete or advertise native installers from this
change alone.

Implemented:

- Shared dark-first tokens/catalog, permanent repository design skill and design
  specification; first-party CSS and bundled generated icons, no CDN resources.
- Control Center four-tab navigation, module summaries, security presets, remote
  controls, complete approval cards, account panel, Free upgrade dialog and
  collapsed/copyable developer diagnostics. Existing permission/approval paths
  and AD-19 renderer isolation are retained.
- MV3 popup, read-only extension-origin status channel, install-only welcome tab,
  local onboarding and deterministic extension UI/icon build/package assets.
- Product homepage/welcome, account website, seven-day hosted card-backed Stripe
  checkout, verified subscription-backed trial admission (two remote devices),
  account-bound hosted billing portal. Local Free use is unchanged.
- Real-Chromium visual suite wired into browser E2E and targeted trial tests.

## Observed local checks

- Targeted Vitest account suites: **35/35 passed** (29 existing service assertions,
  six new card-trial/provider assertions).
- `scripts/ui-e2e.mjs`: **passed** against a real local Chromium binary, with
  shipped renderer assets and explicit owner-IPC/extension-status fixtures.
  Includes all four Control Center tabs, Free paywall/no paid enable dispatch,
  Escape dismissal, approval decision delegation, 390px overflow checks, product
  welcome/account pages and extension popup/onboarding screenshots.
- Additional Playwright visual inspection captured twelve desktop/mobile images.
  Diagnostics canary IDs are absent from the main Dashboard.

These checks do **not** replace service/Electron integration, live Stripe/OAuth,
real extension-native messaging or platform installer qualification. The local
workspace contains a source subset obtained through GitHub MCP, not a complete
checkout, so a full repository `npm run check` has not been established locally.
Exact-head GitHub CI and complete browser E2E remain required. GitHub MCP readback
of PR #1 check runs and combined commit status returned HTTP 403 (`Resource not
accessible by personal access token`). The connection can push code and create
PRs but cannot currently read those CI results; no 11/11 result is asserted.

## Outstanding release work

1. A unified one-step installer and signed/distributable Windows/macOS/Linux
   bundles are **not implemented** here. Existing separate platform install paths
   remain; no assumption that L1 is available follows from installing the UI.
2. Actual Linux systemd and macOS LaunchAgent product-autostart qualification in
   CI remains outstanding. Existing Windows qualification is unchanged.
3. The popup's Control Center action is explicitly a guide, not a working desktop
   launcher. L1 repair opens installation guidance, not privileged repair.
4. The website intentionally shows installer qualification pending rather than
   serving nonexistent executable downloads. Deployment to `crot.network` and
   operator OAuth/Stripe configuration have not been performed.
5. Migrate existing trusted trial fixtures away from `AccountService.startTrial`
   and remove that legacy in-process provisioning helper. Public owner HTTP no
   longer calls it. Live provider lifecycle/cancellation must be qualified.
6. Observe all eleven required CI jobs on the final commit before changing the
   PR from Draft to Ready for review. Do not report a pending/skipped/failed job
   as passing.

## Reproduce

```sh
npm ci
npm run check
CROT_E2E_CHROME=/absolute/path/to/chrome npm run test:e2e:browser
```

The browser workflow uploads `flagship-ui/*.png` and `verification.json` alongside
existing E2E artifacts. These fixtures test rendering and IPC delegation, not
permission bypasses or fabricated platform availability.
