# UI/UX remediation — PR #1

This change implements the second curator directive on `feat/flagship-control-center`. It is not a release qualification or a claim that all six acceptance stages are complete.

## Implemented

- Shared Zinc Dark / Linear design map: exact requested colors, 13px base text, 16px application headings, 32px web hero, 32px controls / 36px primary CTA, 16px card padding and 12px grid gaps. The repository UI skill and design specification agree with these tokens.
- Static popup shell and a first-loaded local geometry stylesheet reserve 380 × 520 pixels before JavaScript. Connection updates retain the installation card's space. Status refresh updates fields rather than rebuilding the root.
- Shared offline EN / RU / ES / DE / ZH dictionary, generated into the extension without a runtime dependency. First selection follows browser language; a saved explicit selection wins. Header selectors update text in place. Approval values, code and paths are excluded from translation. Unrecognized service/provider diagnostic strings remain literal.
- Control Center polling caches unchanged sections, retaining tabs, focus and scroll. Technical diagnostics remain collapsed and approval operation/path values remain visible to the owner.
- Quick Start shows the actual service workspace. Owner-only main-process actions open that directory and copy a Claude/Cursor MCP configuration containing absolute installed entry/workspace paths and service launch options. Existing pairing actions remain delegated to the authenticated service; copying a remote connection URI is unavailable until a valid URI exists.
- Popup and welcome actions use packaged extension URLs or an absolute HTTPS portal URL, never extension-relative `/portal` or `/download` routes. Refresh queries the real background channel. A fixed native `ui_open` request asks the service to launch Control Center; unavailable service/host produces a visible launch instruction instead of a dead button.
- The native owner-UI request accepts no URL, path, arguments or tool operation. It has exact schema checks, a bounded pending request and timeout, launch throttling, and a connection-level request budget. Only the extension's exact popup/welcome pages can dispatch it through the background script.
- Explicit `crot-mcp app`, `npm start` and `npm run tray` register the native host, reuse/start the local service and request the shipped Electron window. Default stdio MCP entry behavior is unchanged. First desktop launch saves a private workspace configuration rather than overwriting an existing policy.
- Linux launcher and Electron main add `--no-sandbox` automatically. This is an explicit Chromium process-sandbox reduction requested for compatibility, not an improvement to sandbox security. Context isolation, no renderer Node, fixed IPC and local CSP are retained. L1 command confinement is a separate boundary and is not thereby installed or verified.

## Evidence and limits

- 8/8 targeted tests: design/i18n/static geometry, strict native UI schema, fixed Electron launch arguments and failure handling, clean extension UI generation.
- 193/193 extension tests; extension TypeScript validation passes.
- Changed-source ESLint and formatting checks pass.
- `scripts/ui-e2e.mjs` passes in real Chromium with owner-IPC/status fixtures: tabs, approvals, Free paywall, focus/node identity during unchanged polling, five languages and RU/EN switching, popup geometry, packaged actions and responsive pages. It saves screenshots and a scope-labelled `verification.json` under `artifacts/flagship-ui`. This is rendering/interaction evidence, not native OS or provider qualification.
- A separate local real-extension-origin Chromium run loads the actual service worker and browser APIs: Russian auto-selection, all five selectors, persisted language, disconnected native-host fallback, 380 × 520 body geometry, packaged welcome navigation and an actual account tab. No native host was installed in that run; successful desktop launching is not proven by it.
- Final screenshots of the popup, dashboard, portal, welcome, paywall and approval surface were visually inspected.
- The requested `npm run check` was attempted and stopped at documentation-link checks because this local MCP-reconstructed checkout lacks other repository documentation. `npm run test:e2e:browser` was attempted and stopped at build because core/identity/relay modules and Electron dependencies are absent from this partial checkout. Neither command is reported as passing. Checks were not weakened to conceal this.
- The authenticated GitHub connection cannot read Checks/status (403 on the preceding attempt). Earlier-head green CI reported by the owner does not establish 11/11 for this new commit.

## Open acceptance gates

1. **One-click L1 repair is not implemented.** The button still opens installation guidance, not `confinement.installOrRepair`. Existing AD-20 intentionally prevents a service from silently invoking a privileged installer. A platform-qualified consented helper/installer must be designed and tested before this requirement can be marked complete.
2. **Qualified installer downloads are not provided.** The extension's installation button opens its packaged guide; it must not be represented as a real `.msi`, `.pkg` or `.deb` download. Unified installation and product-autostart qualification remain open from the first directive.
3. **Native desktop integration remains unqualified.** The fixed launcher is unit-tested, but this environment has no complete Electron installation or full project checkout. The one-command service/host/window flow, real pairing browser launch and clipboard configuration must be exercised on supported OS installations.
4. **Hosted pages require deployment/configuration.** A live probe found staging `/portal` available but `/` and `/welcome` returning 404. Local revised page rendering is not proof of deployment. OAuth and billing require operator configuration; the UI states when sign-in is unavailable.
5. **Full CI and complete button qualification are outstanding.** Run the two requested commands in a complete checkout, inspect 11/11 on the new commit and exercise connected native/privileged actions before marking the PR Ready for review. Do not infer native action success from fixture acknowledgements.

Keep PR #1 as Draft until these gates close. Main is not modified by this work.
