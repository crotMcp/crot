# Reference-driven desktop onboarding

> Presentation clauses (five destinations, fixed-light theme, 1180×780 minimum) are
> superseded by [AD-42](../ARCHITECTURE.md#ad-42--owner-requested-control-center-design-system-and-navigation).
> The verified startup/commercial handoff below remains authoritative.

This change follows the owner's three supplied Russian screenshots, not the old
thirteen-link sidebar. The invoked UI UX Pro Max skill and its pinned guidance
were read; no local catalog generator or verified catalog search was claimed.

## Layout and behavior

- Light surface tokens: `src/tray/control-center-welcome.ts`, appended after legacy
  tool styles. Offline SVG mark: `src/ui/mascot.ts`. The mole is vector-traced from the
  raster reference; exact vector identity/pixel equivalence is not claimed.
- First launch always shows Auth, including a saved local preference or `#terminal`.
  Verified account sign-in opens Plans. Accountless mode opens the same Plans screen.
  Free/skip opens Home. Trial opens secure hosted Checkout, not a simulated plan.
- Desktop 1280 × 820, minimum 1180 × 780. The three screens have no window scrolling.
  Existing long tools and approval details use internal scroll regions; safety details
  are not shortened or removed. Phone-sized Control Center is outside this requested
  desktop geometry; website and extension responsive tests remain.
- Home has five primary destinations and real projects/counts/service states.
  Empty projects remain empty. Connector tiles are discovery shortcuts, not a claim
  that credentials or native adapters exist. OpenAI/Figma lead to Custom HTTP API
  with an explicit notice. Unavailable probes/grants remain enforced by the service.
- RU/EN/ES/DE/ZH remain available offline. Welcome surface is fixed light; a fake
  dark-mode switch is not offered. Hosted portal and extension retain their own theme.

## Commercial and authentication boundaries

See [AD-41](../ARCHITECTURE.md#ad-41--reference-driven-desktop-onboarding-and-verified-plan-handoff).
The account sign-in boolean cannot authorize remote requests. Trial requires verified
billing plus device pairing. An owner may need to click “Verify subscription and pair
device” after Checkout; this intentionally does not infer success from a redirect.
If identity/billing are unconfigured, a localized error is shown and Free remains usable.
No new account, charge, Stripe price or production deployment is created by these tests.

The reference's Free/Pro feature lists are display requirements, not newly enforced
local monetization restrictions: existing local Core tools/projects remain independent
of billing. Native product tiers, third-party API credentials and operator Stripe
configuration require separate operational qualification. Never describe a fixture
entitlement event as a live payment or live identity test.

## Reproducible checks

`node scripts/ui-e2e.mjs --onboarding` uses actual Chromium with explicit owner-IPC
fixtures. It captures all three stages in RU and EN at both desktop sizes, checks
root document overflow and essential action bounds, rejects hash bypass and fake
OAuth/Checkout success, and admits Home only on verified fixture entitlement.
`node scripts/ui-e2e.mjs` retains contextual tool routes, seven project tabs, eleven
settings tabs, approval focus, permission confirmation, portal and extension tests.
`node scripts/ui-e2e.mjs --service` connects the UI to a real CrotService fixture.
Use `CROT_E2E_CHROME` and, only when required by the test container,
`CROT_E2E_CHROME_ARGS`. This is not a claim that the shipped Linux renderer is OS-sandboxed.

Fresh command outcomes and publication/CI status belong in the handoff report,
not historical test counts in this document. PR #2 was already merged by its owner;
this patch is based on main and requires an authorized new branch/PR for exact-head CI.
