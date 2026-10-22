---
name: crot-ui-design
description: Build and review CROT Control Center, browser popup, onboarding and account portal using the shared dark Obsidian design system. Use for UI changes, components, typography, states and accessibility.
---

Read `docs/DESIGN_SYSTEM.md` and the relevant source/tests before editing. Treat
`src/ui/theme.ts` as the sole token and capabilities-catalog source. Preserve the
execution/permission pipeline and existing AD-19 trust boundaries.

1. Reuse the shared CSS and semantic components. Use system sans; monospace only
   for commands, paths and opt-in diagnostics. Use bundled SVG icons, not emoji.
2. Design explicit loading, disconnected, unknown-plan, empty, error, pending,
   disabled and success states. Never infer cloud entitlement from a local
   connection. Free local use must never depend on billing or network access.
3. Keep IDs, process details and provider diagnostics inside collapsed Developer
   Diagnostics. Preserve complete approval subjects, hostile-character escaping
   and security warnings; never hide material approval facts for visual polish.
4. Use DOM creation/textContent for dynamic data, never innerHTML or remote code.
   Never relax CSP or accept arbitrary URLs/commands across renderer IPC.
5. Keep roadmap integrations clearly marked unavailable. Never advertise an
   artifact, installation, payment or release qualification that was not observed.
6. Verify keyboard navigation, focus restoration/trapping for dialogs, 44px
   targets, semantic non-color state labels, 4.5:1 text contrast, reduced motion,
   long strings, and 390/768/1024/1440px layouts.
7. Run the scoped tests, Chromium visual checks, `npm run check` and browser E2E.
   Save and inspect screenshots. Separate completed checks from external gates.
