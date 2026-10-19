# Real-browser E2E of the browser bridge

Four suites run against a real Chromium:
`tests-e2e/browser/real-browser.e2e.test.ts` (the chain and legacy tools),
`browser-v1.e2e.test.ts` and `browser-layout.e2e.test.ts` (WP-24 contract and
layout regressions), and `wp25.e2e.test.ts` (dialogs, background screenshots,
debugger lifecycle and CROT groups; AD-16 / AD-32).

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

## Browser v1 suite

`tests-e2e/browser/browser-v1.e2e.test.ts` runs its own isolated sandbox,
CROT instance (`browser.read` + `browser.control`, untrusted-content rule
off because there is no approval UI) and browser over the same unmocked
chain. Pages: `fixtures/form.html` (sign-up form, a removable button, an
element with an **open shadow root**, a `target=_blank` link, an iframe and
a button revealing hidden text),
`fixtures/frame.html` (served under `http://localhost:<port>`, a different
origin **and site** than `http://127.0.0.1:<port>`, so Chromium puts it in
its own process) and `fixtures/done.html` (form target). Every input event
is reported to the test server with its `isTrusted` flag.

Checked:

1. `browser_snapshot`: top-level and cross-origin frame with their origins;
   refs for top-level, out-of-process-frame and shadow-root elements; stable
   refs across snapshots; a frame-limited snapshot.
2. A multi-step form by refs: `browser_type` (text and password),
   `browser_select_option`, `browser_set_checked`, `browser_press_key`, and a
   submit click with `waitUntil: "load"` (`navigated`, the submitted values at
   the server); the password value is never returned (`hasValue` only);
   keydown, input and click events are trusted.
3. `BROWSER_STALE_REF` after navigation, reload (nothing typed; the new
   snapshot has a new ref), element removal, and after the debugger detaches
   (CROT restarted: the extension detaches every session when the connection
   ends; the old ref fails in the new connection and nothing is clicked).
4. Cross-origin (out-of-process) frame: bounds in top-level coordinates, a
   trusted click and trusted text input by ref, and the audit record with
   `elementRole` and `frameOrigin` but no accessible name.
5. Open shadow root: trusted click by ref.
6. Pop-up: the click reports `newTabs`; `browser_tabs_list` names the
   `openerTabId`.
7. Background tab: with another tab in front, hidden (`display:none`) and
   invisible (`visibility:hidden`) text never satisfies `browser_wait`; a
   click by ref first activates the tab (`activated: true`), the page sees a
   trusted click while `visible`, then the revealed text satisfies the wait;
   a click on the now visible tab reports no `activated`.
8. Fixed CDP surface: every command the extension sent to a tab during the
   run is in `CDP_ALLOWED_METHODS`, none is `Runtime.*`, and input really went
   through `Input.dispatchMouseEvent` / `Input.dispatchKeyEvent`.

### Layout and frames suite (manual runs 2 and 3)

`tests-e2e/browser/browser-layout.e2e.test.ts` uses the same chain and its
own sandbox with `fixtures/layout.html` (a fixed header, a wrapping link,
plain text, a same-origin iframe, an iframe whose document is written by
script, a cross-origin iframe inside an open shadow root, a number input, an
alert button and a `role=dialog` at the end of a tall page). It checks, with
the page's own `isTrusted` reports:

1. Same-origin frame: click and type by ref (no false `BROWSER_STALE_REF`),
   `selector` + `frameRef` for click, type, drag target and `browser_wait`;
   a ref with another frame's `frameRef` is refused; a selector without
   `frameRef` stays in the top-level document.
2. Frame written by script: click and `browser_set_checked` by ref.
3. Cross-origin frame inside a shadow root, below the fold: click by ref
   after the page scrolled (hit test in document coordinates).
4. A text ref (`includeText`) is hovered; a link wrapping over lines is
   clicked.
5. An element scrolled under the fixed header is scrolled clear and clicked.
6. A number input reports the typed value and ArrowUp; a cut snapshot
   (`maxElements: 3`) still lists the dialog's button.
7. A click that opens `alert()` returns only `dialog: { type }`; snapshot
   exposes the pending message, page reads fail promptly with
   `BROWSER_DIALOG_OPEN`, and `browser_dialog_handle` dismisses the dialog.
   This replaces the historical pre-WP-25 fail-fast regression expectation.

8. Own/descendant pseudo-elements: trusted clicks; unrelated pseudo-element
   overlays are refused by unit tests.
9. A tab closed by the test's Chrome API during a text wait returns prompt
   `NOT_FOUND` (not a full timeout).
10. Two native windows have distinct Chrome `windowId`s; input reaches the
    target tab of the second window.
11. Three iframe form submission/history.back cycles keep snapshots responsive.
12. Three returns to a scrolled document allow its link to be clicked.
13. First response headers delayed 23 s exceed default 20 s tab-open budget:
    loadTimedOut:true; immediate snapshot still refuses the non-http initial
    document. After commit, snapshot in the SAME tab succeeds. The local
    delay does not prove why the real site stalled during manual run 5.

Points 11–12 are local regression scenarios, not reproductions of the exact
CodePen AX hang or Wikipedia's transient cover from manual run 3.
Unit tests separately cover a never-answering CDP poll: tab removal interrupts
it and the wait's absolute deadline expires without another poll.

For the browser witness, this suite launches the browser with
`--remote-debugging-port=0` (test harness, `watchExtensionCdp`): the test
attaches its own DevTools session to the extension's service worker and wraps
`chrome.debugger.sendCommand` there to record method names. Nothing in CROT
or the extension changes; that the extension itself refuses a method outside
the allowlist is covered by the unit tests (`extension/test/cdp.test.ts`).

### WP-25 lifecycle suite

`tests-e2e/browser/wp25.e2e.test.ts` uses `fixtures/wp25.html` and the same
real MCP-to-extension chain. Seven tests cover:

1. Alert / confirm / prompt: content-free control results, metadata exposed
   only by snapshot / tabs list, blocked page reads, explicit answers.
2. Intercepted file chooser with safe dismissal; acceptance is refused until
   WP-26 supplies upload (no native OS chooser automation).
3. Beforeunload: rejected navigation stays, pending close reports
   `closed: false`, explicit acceptance leaves; alert + tab close works.
4. Background PNG, ref crop and full-page pixels/dimensions, viewport / DPR,
   unchanged active tabs and focused windows, discarded-tab refusal.
5. Actual Chrome debugger API detach, stale refs, reconnect, fixed failure
   and status when attach is refused. The policy refusal is an injected test
   seam, **not** a real managed enterprise policy. Chrome API detach does not
   emit `onDetach`; cancellation of an unanswered command by that event is
   separately covered by unit tests. User-infobar cancel remains manual.
6. CROT groups for opened tabs and real popups.
7. The actual production 60-second timeout: confirm is rejected, a content-free
   auto-dismiss audit entry has the current connection ID.

The test-only witness wraps Chrome APIs / observes windows; it does not add
production operations or synthetic input fallbacks. See
[`design/browser-wp25.md`](design/browser-wp25.md) for qualification results
and explicit gaps (headed branded-browser / OS matrix, actual policy,
minimum-version and HiDPI variants). Linux headless results do not qualify
macOS / Windows UI. Skipped tests are never counted as passes.

Not covered here (later packages): upload / download (WP-26), two concurrent
agents and remote `tabId` (WP-27). WP-24 manual acceptance remains separate:
see [`acceptance/WP-24-manual-run-1.md`](acceptance/WP-24-manual-run-1.md).

Local run without a display (as used during WP-24):

```sh
export CROT_E2E_CHROME=/path/to/chrome CROT_E2E_HEADLESS=1 CROT_E2E_CHROME_ARGS=--no-sandbox
npm run test:e2e:browser
```
