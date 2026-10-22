# CROT design system

## Product and source of truth

CROT is a security-sensitive local computer and browser bridge for AI clients.
Control Center, extension, onboarding and portal share the Dark-first Obsidian
system. `src/ui/theme.ts` owns semantic tokens and the capability catalog; do not
create a parallel theme. The repository skill is
`.claude/skills/crot-ui-design/SKILL.md`.

## Tokens

| Role | Value |
| --- | --- |
| Canvas | `#090A0F` |
| Surface | `#11131C` |
| Raised surface | `#171A26` |
| Border | `1px solid rgba(255,255,255,0.08)` |
| Accent | `linear-gradient(135deg,#6366F1 0%,#8B5CF6 100%)` |
| Primary text | `#F4F4FB` |
| Secondary text | `#A9AFC4` |
| Link/focus | `#A5A7FF` |
| Active/Ready | `#10B981` |
| Warning/Pending | `#F59E0B` |
| Blocked/Error | `#EF4444` |

Status colors use glow and a written label, not color alone. Warning/error text
uses lighter foreground tints for contrast; saturated colors are indicators,
not small text. Use Inter/-apple-system/system-ui offline, no font CDN. Use
JetBrains Mono/monospace for paths, commands and diagnostics only. Use consistent
24px SVG strokes, decorative icons aria-hidden; name all icon-only controls.

## Layout and hierarchy

Spacing scale: 4/8/12/16/24/32/48/64px. Controls at least 44px high. Body 16px,
secondary labels at least 14px; headings 18/24/28–42px. Cards use 16px radii,
subtle borders and generous internal spacing. Gradients identify primary actions
and branding, not every surface. Avoid decorative dashboard metrics or fake data.

Desktop: header, persistent four-tab navigation, status modules and contextual
cards. Below 700px navigation becomes a horizontally scrollable row, grids
become one column. Portal content has a 1120px maximum width; popup is a compact
single-column surface. No clipped labels or page-wide horizontal overflow.

## Behavior and trust

- Free local use is offline/accountless. Cloud plan unknown is not Free and not
  Pro. UI plan labels do not authorize any operation.
- All dynamic strings use safe DOM nodes. Keep AD-19 CSP, sandbox,
  contextIsolation, no Node in renderer, main-process digest-bound decisions.
- Hide raw IDs, hashes, pid and provider diagnostics in collapsed Developer
  Diagnostics with explicit copy. Approval subjects remain complete, in Core
  order, with remote/full-control/outside-workspace/page-supplied warnings.
- Tabs expose selected state and keyboard operation. Dialogs have accessible
  names, initial focus, Escape dismissal and return focus to the invoking action.
- Buttons communicate loading/error; failure must allow retry. Never show success
  until the action resolves. Disabled controls explain why.
- Mark media/connectors/editors as Roadmap, not implemented integrations.
- Payment cards belong only in hosted Stripe Checkout. A checkout redirect or
  success URL is never proof of payment or trial entitlement.

## Verification

Test connected/disconnected/unknown cloud plan, pending approvals, paid-feature
prompt, all tabs, diagnostics disclosure, hostile and long strings, keyboard and
reduced motion. Capture and inspect 390/768/1024/1440px screens where applicable.
Check text contrast >=4.5:1 and meaningful UI boundaries >=3:1. Run full check,
Chromium E2E and observe exact-head CI before claiming qualification. Native
installers, OS sandbox support, live OAuth/Stripe and vendor signing need their
own evidence; a polished UI does not close those gates.
