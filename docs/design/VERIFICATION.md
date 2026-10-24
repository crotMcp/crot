# AD-42 verification record

## Identity and scope

- Baseline: `8306e94bf12ab033524de2b45016d8e3750a164b` (`crotMcp/crot`).
- Final revision: the commit containing this record; exact hash is included in the
  delivery manifest (not self-embedded in its own commit).
- Environment: Linux x64, Node 24.22.1, local headless Chromium.
- Implementation: design assets, renderer presentation, navigation, local themes
  and fonts. Existing Core/ExecutionGuard/PermissionEngine boundaries preserved.
- Not verified: live OAuth/Stripe, DNS, Windows/macOS native tray or installers,
  provider publishing, signing, store submission or deployment. No CI claim.

## Observed gates

- `npm run check`: passed. Main suite: 190 files passed, 27 skipped; 2,226
  tests passed, 219 skipped. Extension suite: 15 files / 193 tests passed.
  Lint, formatting, documentation links, both typechecks and builds passed.
  Platform/native skips remain explicit: Electron smoke had no DISPLAY/xvfb;
  Windows/macOS and opt-in Linux L1 qualification were not available here.

- `npm run test:e2e:browser`: passed after the sequential check. 10 files
  passed; 58 tests passed, 3 skipped. The three skips are non-Linux placeholder
  cases in browser-layout/browser-v1/real-browser, not skipped Linux executions.
  Chromium 153, headless, `CROT_E2E_CHROME=/usr/local/bin/chromium`,
  `CROT_E2E_HEADLESS=1`, `CROT_E2E_CHROME_ARGS='--no-sandbox --disable-dev-shm-usage'`.
- Design/architecture unit tests: 2 files, 10 tests passed (includes transparent
  raster-padding regression).
- Design Chromium + axe: 81 audited states, 29 captured screenshots, zero reported
  WCAG A/AA violations, zero page errors, no document horizontal overflow. This is
  automated coverage, not a claim of complete accessibility certification.
- Owner-IPC UI integration: passed; three-screen onboarding, EN/RU route traversal,
  project tabs, eleven settings sections, approval focus retention, confirmation
  before Full Control, 960×640 desktop, extension surfaces and CSP rendering.
- Real-service UI harness: passed. Shipped renderer → test-only IPC bridge → real
  isolated CrotService; project/files/git/terminal, local HTTP connector probe, MCP
  stdio discovery, task cancellation and real audit. This is not live provider auth.
- Asset regeneration: 38 generated/support files compared before/after a second
  run; zero changed hashes. SVG/PNG/ICO/ICNS signatures and transparent padding tested.
- `git diff --check`: passed before delivery.

## Visual inspection

Canonical Login, Plans, Home, Chat, Agents, Projects, Local Connectors, Web
Connectors, Accounts, Permissions, Browser and Settings were opened individually
in Light/RU and Dark/EN. Journal was also inspected in both combinations; Home at
390, 960 and 1024px; compact Plans at 1180×780; Home at 960×640; and a separate
brand sheet with dark/light vectors, app icons, extension and tray sizes.

Fixed during inspection: invisible black vendor marks on dark surfaces, blank
mobile menu icon, vertically centered recent-project row, compact plan overflow,
missing Home h1, PNG fit-padding black bars, and dark recent-state contrast.

No clipped labels or unintended overlap in the inspected viewports. Lower dashboard
and long tool sections scroll internally by design; not every action is above the
fold. These are composition checks, not pixel-equality claims against references.

## Failures retained as evidence

Intermediate runs found and fixed: stale five-destination/minimum-size test
expectations, invalid `aria-selected` on ordinary buttons (now `aria-pressed`),
small-text color contrast, missing Home heading, browser-evaluation globals in the
lint configuration, and case-sensitive hex-color assertions after formatting.

A configured intermediate full browser run also hit a 10-second cross-origin
shadow-frame click timeout in an unchanged browser test; the UI integration itself
passed. The final sequential browser gate is recorded separately.

An intermediate full check also reported two real-service `Connection closed`
failures while multiple build/test commands shared the same output directory.
Those failures are not silently discarded; isolated reruns and the final sequential
gate are the relevant confirmation. First E2E launch lacked the Chromium environment
configuration and failed; configured runs are recorded separately.

Reports, logs and presentation captures are provided in the delivery evidence
archive, not packaged into the production renderer. Original attached references
remain unchanged under `reference/`.
