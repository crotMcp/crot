# CROT design implementation — 2026-10-24

## Scope and source precedence

Baseline: `8306e94bf12ab033524de2b45016d8e3750a164b` from `crotMcp/crot`.
Owner directive → AD-42 presentation amendment → existing security architecture →
attached planning review → screenshot composition. No Core execution boundary changed.

## Implemented

- Fourteen original references identified by content. 03/05 canonical, 04/06 historical.
- Flat yellow mole master, outlined Inter wordmark, dark outer outline and monochrome
  silhouette. Script-generated desktop PNG/ICO/ICNS, template tray 16/22/32, extension
  16/32/48/128 and favicon. Main tray and extension sources consume derived assets.
- Local variable Inter and JetBrains Mono, Latin/Cyrillic, tabular numerals; no runtime
  font CDN. Exact owner tokens, semantic components, reduced motion, keyboard focus.
- Ten primary destinations, 240/72px sidebar, native 960×640 minimum, retained guarded
  contextual tools. Home has four category cards and real service/project state.
- Light/Dark/System restored in a CSP-safe head script before CSS. Live OS changes.
- New EN/RU strings in the existing offline dictionary. Other languages explicitly
  fall back to English for new detailed copy, as in the existing architecture.
- Single vendor-logo map. Unknown brands use a neutral plug, never another vendor's
  logo. No fake Remotion/After Effects or Claude/OpenAI/OpenCode substitutions.
- Local/web connector tabs over the existing provider catalog; no new provider
  dispatch in Core. Account summaries reuse the service registry.
- Masked Relay URL and fixed main-process copy command. No renderer-side clipboard,
  bearer credential or token rotation. Secret-like filenames marked with a lock;
  actual secret denial is still owned by Core, not a CSS class.
- Plan badge uses actual service state; L1 explicitly included in Free. Upgrade
  banner absent for verified paid state. Loading/failure/retry for registry loads.

## Conflict register and unimplemented backend requirements

| Requirement from review/screenshots | Resolution |
| --- | --- |
| Five-item, light-only desktop in AD-41 | Superseded only for presentation by AD-42; startup/security preserved. |
| Email-only OTP / fabricated remote Bearer token | Existing configured AuthKit/PKCE/OAuth and pairing retained. No invented auth endpoint. |
| Chat streaming, stop, uploads, model inventory | UI empty/draft state is implemented; send/attach disabled with explanation. No chat backend exists in this runtime. |
| New OpenAI/Anthropic/Remotion/Python/Node adapters | Not fabricated. Existing guarded catalog retained. New adapters need separate backend work; no npm executable masquerades as Remotion. |
| Provider-side revoke / TikTok publication dialog | Not implemented. Probe and local credential removal are not represented as consent revocation or publication. |
| Three independent permission toggles per operation | Existing service presets and Core policy remain authoritative; no duplicate local policy state. |
| Browser cookie/autoclick/background toggles | Real guarded browser workspace retained. No UI-only enforcement or mutually contradictory toggles. |
| Annual pricing / legal documents / signing | Not authorized or provisioned by a visual change. Existing verified $3 catalog and commercial gates retained. |
| OS file dialog / environment discovery / secret allowlist editor | Existing project path flow retained; not claimed as newly implemented native discovery. |
| Exact master-vector identity with screenshot | Hand-authored approximation requested by owner; not a claim of pixel-perfect tracing. |

This is a design-system and UI-source implementation, **not full completion** of all
backend and commercial acceptance items in the attached review. Disabled chat is
intentional, not an assertion of working generation. No deployment, DNS migration,
provider account creation, paid service, native installer signing or store release occurred.

## Reproduction

1. `npm ci` (native dependencies may need their standard installation prerequisites).
2. Wordmark regeneration needs Python `fonttools[woff]` and `brotli` (the supplied
   environment includes fonttools; Brotli was installed for this run).
3. `npm run generate:design` builds deterministic assets from SVG and pinned packages.
4. `npm run check` — lint, formatting, documentation links, types, builds, unit/integration.
5. `npm run test:e2e:browser` — existing Linux Chromium browser integration gate.
6. `npm run test:design` — local Chromium (override `CHROMIUM_PATH` if needed),
   production CSP, owner-IPC fixture, EN/RU × Light/Dark, axe and layout checks.
7. `node scripts/ui-e2e.mjs --service` — separate real-service integration harness.

Reports/screenshots live under ignored `artifacts/`, never in production bundles.
See `VERIFICATION.md` for observed results and exclusions. Test fixture data does
not qualify live OAuth, native Electron, subscriptions or publication.
