# Real-browser E2E of the browser bridge

`tests-e2e/browser/real-browser.e2e.test.ts` checks the existing browser chain
(ARCHITECTURE.md §16) against a **real Chromium**, end to end:

```
MCP client (agent) -> crot-mcp -> BrowserService -> ExecutionGuard/PermissionEngine
  -> BrowserBridge -> Unix socket -> crot-browser-relay (started by Chromium via
  native messaging) -> CROT Browser Extension -> real tab -> ... and back
```

None of these is mocked: the test starts the built `dist/bin/crot-mcp.js` over
MCP stdio (the SDK client, as an agent would), registers the host with the real
`crot-mcp browser install`, and launches a real browser with the unpacked
extension from `extension/`. Permissions come from an ordinary CROT config file;
there is no test-only code path in CROT. The mock-based unit tests (`npm test`,
`npm run test:extension`) are unchanged and still run separately.

## Requirements

- Linux (the harness uses `/proc` and the Linux native-messaging locations).
  macOS and Windows are not covered by this E2E yet.
- Node.js >= 20 and `npm ci` (the MCP SDK and vitest are dev/runtime deps).
- A Chromium-based browser that still supports `--load-extension`: **Chrome for
  Testing** or **Chromium**. Branded Google Chrome 137+ ignores
  `--load-extension` and cannot be used.
  Install one with `npx @puppeteer/browsers install chrome@stable`.
- A display, or `xvfb-run`, or `CROT_E2E_HEADLESS=1` (`--headless=new`).

## Run

```sh
npm ci
export CROT_E2E_CHROME=/path/to/chrome   # Chrome for Testing / Chromium binary
xvfb-run -a npm run test:e2e:browser     # or run it directly with a display
```

`test:e2e:browser` runs `npm run build` (CROT, incl. `crot-browser-relay`),
`npm run build:extension` (extension into `extension/dist/`) and then vitest
with `tests-e2e/vitest.config.ts`.

Environment variables:

| Variable | Meaning |
| --- | --- |
| `CROT_E2E_CHROME` | **Required.** Browser binary. Without it the run fails (it is never reported as passed). |
| `CROT_E2E_HEADLESS=1` | Add `--headless=new`. |
| `CROT_E2E_CHROME_ARGS` | Extra browser flags (e.g. `--no-sandbox` in containers without user namespaces). |
| `CROT_E2E_ARTIFACTS` | Directory for logs: browser output, CROT stderr, audit JSONL, HTTP requests. |
| `CROT_E2E_KEEP=1` | Keep the temporary sandbox directory. |

CI: `.github/workflows/browser-e2e.yml` (Ubuntu, Chrome for Testing, Xvfb) runs
on pull requests, pushes to `main` and manually; logs are uploaded as the
`crot-browser-e2e-logs` artifact.

## Isolation

Everything lives in a temporary `/tmp/crot-e2e-*` directory: `HOME`, `XDG_*`
(so `browser install`, the CROT state directory, token and socket are
separate), the browser profile (`--user-data-dir`, a fresh empty profile) and
the workspace. The user's own browser profile and CROT installation are never
used or modified. `browser install` writes the Chrome manifest; the harness
copies the same, unchanged manifest to `<profile>/NativeMessagingHosts` and the
Chromium / Chrome for Testing config directories, which is where those builds
look for user-level hosts.

## Test page

`tests-e2e/browser/fixtures/fixture.html` (and `start.html`) are served by a
local HTTP server on `127.0.0.1` with an ephemeral port (CROT only accepts
`http:`/`https:` URLs). Each run uses a random nonce in the query string:

- `#static-text` - fixed text for reading;
- `#js-rendered` - the reversed nonce, computed by the page script; the served
  HTML only says `pending`, so seeing it proves the content came from the live
  DOM of a real browser;
- `#action-button` / `#status` - the click target and the state it changes
  (`STATUS: idle; clicks=0` -> `STATUS: clicked; clicks=1; nonce=...`); each
  click is also reported to the test server (`/event`) as an independent witness.

## What is checked

1. `crot-mcp browser install` produces the `com.crot.host` manifest for the
   fixed extension origin; CROT starts in state `waiting`.
2. The real browser starts with the extension; `browser_status` becomes
   `connected` with the extension version from `extension/manifest.json`; a
   `crot-browser-relay` process exists as a descendant of the browser process
   (native messaging), the bridge socket exists, `crot_status` reports it.
3. Tabs: `browser_tabs_list`, `browser_tab_open`, `browser_navigate`, and tab
   info (URL, title set by page script, active) through `browser_tabs_list`.
4. `browser_page_read` (text and html, and `maxBytes` truncation) returns the
   live content described above.
5. `browser_click` changes the page state; verified via `browser_page_read`
   and the server-side click event.
6. Validation: `file:` / `javascript:` URLs are rejected with `INVALID_INPUT`.
7. Audit: successful `browser.*` operations are recorded, without the page
   text or the query string (origins only).
8. **Negative:** CROT is restarted with `browser.read` only; the same browser
   reconnects. `browser_click`, `browser_navigate`, `browser_tab_open` return
   `PERMISSION_DENIED`, the page state, tabs and the HTTP server show that
   nothing happened in the browser, and the audit records them as `denied`.

A green run means the whole chain worked in a real browser. A red run prints
the browser output and CROT stderr; a missing `CROT_E2E_CHROME` or a non-Linux
platform is reported as failed / skipped, never as passed.
