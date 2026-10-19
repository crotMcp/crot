# CROT Browser Extension

The CROT Browser Extension gives an MCP agent controlled access to the user's
browser: tabs, page content, screenshots, clicks and typing. It is part of
ARCHITECTURE.md §16, step 11, and builds on the Native Host platform layer
(step 10, see [`NATIVE_HOST.md`](NATIVE_HOST.md)).

Supported browsers: **Chromium-based browsers only** — Google Chrome, Microsoft
Edge and Brave (Chrome 120 or newer). Firefox is not supported.

## Terminology

ARCHITECTURE.md §7–8 describes the extension talking to the "CROT Native Host"
through browser Native Messaging. In this implementation that host side is the
CROT Host as a whole:

- `crot-mcp` — the CROT process (Core, MCP adapter and the browser bridge);
- `crot-browser-relay` — a small program the browser starts as its
  native-messaging host. It only forwards frames between the browser and the
  running `crot-mcp`.

[`NATIVE_HOST.md`](NATIVE_HOST.md) uses "Native Host" for the OS platform layer
inside Core; that layer is unchanged by the extension. The relay is a
transport, not a second Core: it has no permissions, no configuration and no
tools of its own.

## Architecture

```text
MCP client ──► CROT MCP ──► BrowserService ──► ExecutionGuard / PermissionEngine ──► audit
                                 │
                                 ▼
                           BrowserBridge            (inside crot-mcp)
                                 │  local IPC: Unix socket / named pipe
                                 ▼
                        crot-browser-relay          (started by the browser)
                                 │  native messaging: stdin/stdout
                                 ▼
                  CROT Browser Extension (MV3 service worker)
                                 │  chrome.tabs / chrome.scripting
                                 ▼
                              Browser
```

Rules:

1. **The PermissionEngine is the only authorization authority.** Every browser
   tool is a Core operation: input validation → `browser.read` or
   `browser.control` check → bridge state → request → result validation →
   audit. Denials return `PERMISSION_DENIED`, as for every other capability.
2. **The bridge, the relay and the extension are dumb transports.** None of
   them authorizes anything, and none of them can bypass Core.
3. **The browser side cannot initiate operations.** After the handshake the
   bridge accepts only responses to requests it sent; any other message closes
   the connection. The extension cannot call MCP tools, read files or run
   commands.
4. **No code from the host is executed.** The extension implements a fixed set
   of commands with built-in page functions; there is no `eval` and no way to
   send arbitrary JavaScript.

The bridge and the relay communicate over local IPC only; no TCP port is
opened and no public server is involved.

## File transfers (WP-26 / AD-33)

- **Host requirement:** Linux with `/proc/self/fd`, `O_NOFOLLOW` and
  `O_DIRECTORY`; Windows/macOS Core hosts fail with `OPERATION_FAILED`, no
  unsafe path-open fallback. This does not qualify every browser/OS/version.
- Owner config `browser.downloadsDirectory` is an absolute canonical directory
  matching the profile's actual default download directory; default
  `~/Downloads`. CROT never changes browser-wide download behavior. A mismatch
  fails without reading a browser-reported absolute path. Both staging roots
  are CROT-secret/protected, owner-only.
- `browser_file_upload`: `tabId?`, input `ref?`, `paths` (1–16 workspace
  files, 64 MiB total). No ref answers a pending intercepted chooser only;
  JavaScript dialogs cannot be bypassed. Multiple files require a multiple
  input. `browser.control` + `filesystem.read`; canonical source resolution,
  protected/secret denial and immutable read-only private copies. Copies live
  until frame/document replacement, tab close or Core shutdown; dead-process
  leases are reclaimed on restart/next use. Result: tabId, names and sizes.
- `browser_download`: `tabId?`, exactly one `ref` / `selector` / HTTP(S) `url`,
  optional selector `frameRef`, workspace `savePath`, `overwrite:false`,
  `timeoutMs:20000` (max 60000), 64 MiB maximum. Requires `browser.control` +
  `filesystem.write`. The download directory must already be configured as
  above; parent workspace directory must exist. Result only size/mimeType.
- Capture uses only the selected tab's verified sessions and the AD-33 random
  response capability in both CDP and native filename events; foreign same-URL
  items are never renamed, read, moved or canceled. Capture is serialized with
  a bounded queue. Complete GUID + complete numeric id + danger safe are
  required before no-follow byte-count validation and atomic publication.
  Default no-overwrite uses atomic link installation; explicit overwrite uses
  atomic rename. Core ACK / lost-ACK timer clean up only the proved download.
- Supported responses: HTTP(S), status 200, one simple ASCII
  `Content-Disposition: attachment; filename="file.ext"` (or inline with the
  same bounded syntax), verified existing frames, preserving original suffix.
  Ordinary redirects pass unchanged. `filename*`, ambiguous/multiple headers,
  blob/data/internal, newly opened tabs and unverified new frame sessions
  fail closed; there is no replay, response-body extraction or generic Fetch
  API. An uncaptured native item is left alone, even on timeout.
- Upload/download are not exposure sources. In an exposed
  `autonomous-browser` session both actual paths require the user's matching
  approval; absent UI denies. Audit records only workspace-relative paths and
  sizes, never bytes, private paths, capabilities or page-suggested filenames.
  See [test evidence](design/browser-wp26-transfer-review.md).

## Setup

Requirements: a built checkout (`npm install`, `npm run build`), Node.js 20 or
newer, and Chrome, Edge or Brave 120 or newer.

### 1. Register the native-messaging host

```sh
node dist/bin/crot-mcp.js browser install
```

The command takes no options except `--help`, works for the current user only
and grants no permissions. It requires `npm run build` first (otherwise it
fails with `NOT_FOUND`). It writes:

- a launcher `<state>/native-messaging/crot-browser-host` (POSIX shell script,
  mode `0700`) or `crot-browser-host.cmd` (Windows). It runs the current Node
  executable with `dist/bin/crot-browser-relay.js --state-dir <state>`;
- the host manifest `com.crot.host.json` (`"type": "stdio"`, `path` = the
  launcher), which allows only the CROT extension:
  `chrome-extension://bllcepanlhojbddfbbpegmnokpaakool/`.

The manifest is registered for each supported browser:

| OS | Location |
| --- | --- |
| Linux | `$XDG_CONFIG_HOME` (or `~/.config`) + `google-chrome/`, `microsoft-edge/`, `BraveSoftware/Brave-Browser/`, each `NativeMessagingHosts/com.crot.host.json` |
| macOS | `~/Library/Application Support/` + `Google/Chrome/`, `Microsoft Edge/`, `BraveSoftware/Brave-Browser/`, each `NativeMessagingHosts/com.crot.host.json` |
| Windows | manifest at `<state>\native-messaging\com.crot.host.json`; registry keys `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.crot.host` (Chrome and Brave) and `HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.crot.host`, written with `%SystemRoot%\System32\reg.exe` |

Files are written atomically. `<state>` is the CROT state directory (see
[Default locations](../README.md#default-locations)). Rerun the command after
moving the CROT checkout or changing the Node.js installation, because the
launcher contains absolute paths.

### 2. Enable the browser bridge

Add to the CROT configuration and restart CROT:

```json
{
  "browser": { "enabled": true }
}
```

`browser.enabled` (default `false`) only starts the bridge. It grants nothing.

### 3. Grant browser capabilities

Browser tools require `browser.read` and/or `browser.control`. Neither is part
of the sandbox defaults; `full_control` grants both. An explicit
`permissions.capabilities` list **replaces** the mode defaults, so list
everything the agent needs, for example sandbox defaults plus read-only browser
access:

```json
{
  "permissions": {
    "mode": "sandbox",
    "capabilities": [
      "filesystem.read", "filesystem.write", "shell.execute", "process.manage",
      "git.read", "git.write", "browser.read"
    ]
  }
}
```

Add `browser.control` to let the agent open, navigate, activate and close tabs,
click and type.

### 4. Build and load the extension

```sh
npm run build:extension
```

This compiles the extension into `extension/dist/` (not committed). Then open
`chrome://extensions`, `edge://extensions` or `brave://extensions`, enable
**Developer mode**, choose **Load unpacked** and select the `extension/`
directory. The manifest contains a public `key`, so the extension ID is always
`bllcepanlhojbddfbbpegmnokpaakool`, matching the host manifest. The
corresponding private key is not part of the repository.

### 5. Check the connection

`crot_status` reports `browser.state` (no capability required):

| State | Meaning |
| --- | --- |
| `disabled` | `browser.enabled` is `false`, or the bridge could not start |
| `waiting` | the bridge is listening; no extension is connected |
| `connected` | an extension completed the handshake |
| `in_use` | another process owns the bridge endpoint (not in normal use since WP-20, see below) |

On startup CROT logs either `browser bridge: waiting …` with the endpoint path
or `browser bridge: in use by another CROT instance …`. The `browser_status`
tool reports the same state but requires `browser.read`.

The extension logs connection events to its service worker console (open it
from the extensions page) with the prefix `CROT: `.

## MCP tools

| Tool | Capability | Command |
| --- | --- | --- |
| `browser_status` | `browser.read` | — (bridge state and browser) |
| `browser_tabs_list` | `browser.read` | `tabs.list` |
| `browser_page_read` | `browser.read` | `page.read` |
| `browser_screenshot` | `browser.read` | `page.screenshot` |
| `browser_file_upload` | `browser.control` + `filesystem.read` | `files.upload` |
| `browser_download` | `browser.control` + `filesystem.write` | `files.download` |
| `browser_dialog_handle` | `browser.control` | `dialog.handle` |
| `browser_tab_open` | `browser.control` | `tabs.open` |
| `browser_navigate` | `browser.control` | `tabs.navigate` |
| `browser_tab_activate` | `browser.control` | `tabs.activate` |
| `browser_tab_close` | `browser.control` | `tabs.close` |
| `browser_click` | `browser.control` | `page.click` |
| `browser_type` | `browser.control` | `page.type` |
| `browser_snapshot` | `browser.read` | `page.snapshot` |
| `browser_wait` | `browser.read` | `page.wait` |
| `browser_hover` | `browser.control` | `page.hover` |
| `browser_scroll` | `browser.control` | `page.scroll` |
| `browser_drag` | `browser.control` | `page.drag` |
| `browser_press_key` | `browser.control` | `page.press_key` |
| `browser_select_option` | `browser.control` | `page.select_option` |
| `browser_set_checked` | `browser.control` | `page.set_checked` |
| `browser_history` | `browser.control` | `tabs.history` |

The last nine tools and the `ref` forms of `browser_click` / `browser_type`
are Browser v1 (ARCHITECTURE.md §27 AD-16, WP-24), described in
[Browser v1](#browser-v1-cdp-backend-wp-24) below.

Behaviour:

- URLs must be absolute `http:` or `https:` URLs of at most 8192 characters.
  Selectors are limited to 1000 characters, typed text to 100 000 characters.
- Pages can be read or controlled only if they are `http(s)` pages; other pages
  (browser settings, other extensions, the Web Store, `file:` URLs and so on)
  return `BROWSER_PAGE_RESTRICTED`, as do pages the browser does not allow the
  extension to access.
- `browser_tab_open` and `browser_navigate` wait up to 20 seconds for the page
  to load.
- `browser_page_read` returns `text` (`document.body.innerText`) or `html`
  (doctype + `outerHTML`). `maxBytes` may not exceed `limits.maxReadBytes`
  (default 10 MiB); Core truncates the content. **Page content is untrusted
  input** — the tool description tells the agent so.
- `browser_screenshot` captures the requested HTTP(S) tab through CDP without
  activating it; background tabs, `ref` clipping and `fullPage` are supported
  (details below). Images are limited to 16 MiB and are returned as MCP image
  content followed by viewport/devicePixelRatio metadata.
- **Legacy form.** `browser_click` with only `tabId` / `selector` scrolls the
  element into view and calls `element.click()` (a synthetic event).
  `browser_type` with only `tabId` / `selector` / `text` / `clear` sets the value through the native setter and dispatches
  `input` and `change` events, or uses `insertText` for `contenteditable`
  elements. Only text-like inputs and textareas are accepted; disabled and
  read-only elements are rejected. With `clear` the value is replaced,
  otherwise text is appended.
- Legacy-form page functions run in the extension's isolated world, in the
  main frame only, and use `document.querySelector` on the top document.
  Every other form (a `ref`, or any Browser v1 option such as `button`,
  `submit` or `waitUntil`) goes through the CDP backend below and reaches
  frames and open shadow roots.
- Each request has a 30 second timeout in Core (`TIMEOUT`).

Errors the extension may report are limited to `NOT_FOUND`, `INVALID_INPUT`,
`TIMEOUT`, `LIMIT_EXCEEDED`, `RESOURCE_BUSY`, `OPERATION_FAILED`,
`BROWSER_PAGE_RESTRICTED`, `BROWSER_STALE_REF` and `BROWSER_DIALOG_OPEN`. `BROWSER_NOT_CONNECTED` and `BROWSER_BRIDGE_IN_USE`
are decided by Core from the bridge state; the extension cannot claim them or
any authorization error, with one exception: `PERMISSION_DENIED` answers a
command of an approved operation whose expected browser subject no longer
matches (see below); for any other command it becomes `OPERATION_FAILED`. Results are validated against Core's schemas: an
invalid result, or a result for a different tab, becomes `OPERATION_FAILED`.

### Browser v1: CDP backend (WP-24)

The Browser v1 commands use `chrome.debugger` (Chrome DevTools Protocol 1.3)
through a fixed, extension-built command surface (AD-16 point 3):

- **Fixed CDP allowlist** (`CDP_ALLOWED_METHODS` in `extension/src/cdp.ts`):
  Accessibility, DOM (read, box model, focus, scroll, hit test), DOMSnapshot,
  Input, Page (lifecycle, frame tree, history, reload, dialogs, chooser interception, screenshot), `Target.setAutoAttach`
  event-only `Network.enable` and `Emulation.setFocusEmulationEnabled` (so
  keys and focus reach the page while the user works in another window). No
  `Runtime.*`, `Debugger.*`, generic `Fetch.*` (only the four fixed AD-33
  response-stage methods are allowed), storage, cookie, other emulation or
  target-creation method can be sent; no host- or agent-supplied code runs in
  the page.
- **Attach on demand** to a tab when a Browser v1 command needs it; detached
  after 5 minutes without commands and for every tab when the CROT connection
  ends. Chromium shows its "is debugging this browser" notice while attached;
  cancelling it detaches, and the refs of that tab become stale.
- **`browser_snapshot`** (`browser.read`, an exposure source, AD-12) returns
  the tab's frames (`frameRef`, parent, URL, normalized origin, `restricted`)
  and its interactive and landmark elements in document order, each with an
  opaque `ref` (`e1`, `e2`, …), `frameRef`, role, accessible name, bounded
  value, states, bounds in top-level viewport CSS pixels and `inViewport`.
  Options: `frameRef`, `includeText`, `maxElements` (default 500, max 5000);
  results are bounded and report `truncated`. Elements inside an open
  dialog (`dialog` / `alertdialog` role) come first, so a dialog at the end of
  a large page is not cut off by `maxElements`; text refs (`includeText`) can
  be hovered and clicked like elements. Password fields never return a
  value, only `hasValue`.
- **References.** A `ref` names one element of one document in one tab and
  one CROT connection. Right before acting, the extension checks the tab, the
  debugger session, the frame's document (loader id) and that the element is
  still connected; otherwise `BROWSER_STALE_REF` and nothing is done. A stale
  ref is never re-resolved by role, name, text, position or selector. The same
  element of the same document keeps its ref across snapshots.
- **Frames and shadow DOM.** Same-process frames and **out-of-process
  (cross-site) frames** are covered up to depth 8 and 100 frames:
  out-of-process frames are auto-attached child sessions of the tab's own
  debugger session (`Target.setAutoAttach` with `flatten`), through the same
  allowlist. DOM and accessibility commands go to the frame's session; input
  is dispatched at top-level viewport coordinates (the owner iframe's
  position is added, and a hit test first checks the iframe in the parent).
  Elements in open shadow roots are addressable by `ref`; selectors do not
  pierce shadow roots.
- **Selectors and frames.** A `selector` (CSS, first match, light DOM) is
  resolved in the top-level document, or in the frame named by `frameRef`
  (from `browser_snapshot`; checked like a ref: a frame that shows another
  document fails with `BROWSER_STALE_REF`). This holds for every command that
  takes a target, the drop target of `browser_drag` and element waits. With a
  `ref`, `frameRef` is optional and must be the ref's own frame
  (`INVALID_INPUT` otherwise); `frameRef` without a target is refused. An
  approval for a selector in a child frame shows the frame's origin as the
  last snapshot reported it.
- **Trusted input** (`Input.dispatchMouseEvent`, `Input.dispatchKeyEvent`,
  `Input.insertText`): click (buttons, double click, modifiers), hover,
  scroll, drag, typing into any editable element (`clear`, `submit`), key
  combinations (`ControlOrMeta` is Meta on macOS), native `<select>` options
  and checkboxes / radios. Before pointer input the element is scrolled into
  view and must be visible, inside the viewport, enabled and not obscured;
  otherwise `INVALID_INPUT` naming the reason. The obscured check hit-tests
  the element's centre in document coordinates of the page and of each frame
  (their scroll offsets are added). A covered element (a fixed header over
  an element at the top, a fading overlay) is scrolled towards the viewport
  centre with one wheel step and re-checked a few times within about 1.5 s;
  if it stays covered the error names what covers it, by tag and id only
  ("obscured (covered by header#top)"). Own and descendant pseudo-elements
  (`::before`/`::after`) count as part of the target; unrelated overlays
  still fail. There is no `force` option.
  An element in a frame is scrolled into the frame's view and then exactly
  that part of the frame into the page's view.
- **Visible page first; no false success.** Browsers do not deliver input to
  hidden pages (a background tab or a minimized window: each mouse event is
  held for about five seconds and dropped). Before every control command the
  extension makes the tab the active tab of its window, restores a minimized
  window and, only if the page is still hidden (a window fully covered by
  others), focuses the window; the result then carries `activated: true`. A
  page that stays hidden fails the command with `OPERATION_FAILED` before
  anything is dispatched. Control commands of different tabs therefore run
  one at a time. After the action:
  - `browser_click` and `browser_drag` check, with a probe in the
    extension's isolated world that counts trusted pointer events (counts
    only), that the input reached the page; if every probed document is still
    there and none saw an event, the command fails (`OPERATION_FAILED`, "not
    delivered") instead of reporting success;
  - `browser_set_checked` fails unless the element shows the requested state
    (within 1 s); `browser_select_option` fails unless the page shows the
    requested options selected (single choice: the select's accessible value,
    which is the selected option's label; multiple: the options' state);
  - a navigation that does not reach `waitUntil` within `timeoutMs` is
    reported with `loadTimedOut: true` (control commands, `browser_navigate`,
    `browser_tab_open`, `browser_history`), including the default/legacy
    wait with no explicit waitUntil/timeoutMs; the page goes on loading.
    Returned URL can be a pending destination, not the committed page. If
    a new tab has not committed an HTTP document, snapshot still refuses
    its initial non-http document. Observe the same tab in browser_tabs_list
    until loading finishes, then take a fresh snapshot; do not blindly open
    replacement tabs or bypass page restrictions.
- **Screenshots (WP-25).** `browser_screenshot` uses `Page.captureScreenshot`,
  including background tabs, without activating a tab or focusing its window.
  `format` is `png` (default) or `jpeg`; JPEG `quality` is 0–100. `ref` clips
  one current snapshot element (stale → `BROWSER_STALE_REF`); `fullPage` captures
  the document. These two options are mutually exclusive. Results include
  `viewport` in CSS pixels and `devicePixelRatio`; image bytes are bounded at
  16 MiB, the capture area at 64 million CSS pixels, capture timeout at 10 s.
  Oversized captures fail, never silently truncate. Discarded tabs fail with
  `INVALID_INPUT`, without a hidden reload. No emulation override is used.
- **Dialogs (WP-25).** Attached tabs track one `alert`, `confirm`, `prompt`,
  `beforeunload` or intercepted `file_chooser`. Commands that open a dialog
  return `dialog: { type }` only. Other page commands fail immediately with
  `BROWSER_DIALOG_OPEN`; snapshot, tabs list, dialog handling and tab close
  still work. Snapshot returns empty frame/element arrays plus the pending
  dialog, without trying to read a blocked page. Only snapshot / tabs list
  expose the bounded message/default prompt (10,000 characters each).
  `browser_dialog_handle({tabId, accept, promptText?})` passes the normal
  `browser.control` guard and tab/origin/connection approval binding.
  `promptText` applies only to prompts and is never audited. At 60 s, an
  unanswered dialog is dismissed (`accept:false`; beforeunload stays) and a
  content-free `browser.dialog_auto_dismissed` record is audited, stamped by
  the host with the current connection. Notices cannot initiate operations,
  carry page content or select an actor; the bridge limits them to 120/min.
  File choosers never open the OS picker while intercepted; `browser_file_upload` may supply workspace copies or `browser_dialog_handle` may dismiss. Closing a tab safely dismisses its
  pending alert/chooser. If closing itself opens beforeunload, the result is
  `closed:false, dialog:{type:"beforeunload"}`: it never silently confirms.
- **Debugger status (WP-25).** External detach invalidates references and
  fails in-flight work with `OPERATION_FAILED`; the next command may attach
  afresh, without retrying the failed action. If a caller detached through
  the extension API (which emits no onDetach), the next CDP refusal invalidates
  the cached session too. `browser_status.cdp`, `overview.browser.cdp` and
  `overview.cdp` report availability: initially false / `not_probed`, after
  successful attachment true / null, after refused attachment false /
  `debugger_unavailable`. Status never attaches to an untargeted tab merely
  to probe. There is no synthetic-input or alternate-tab fallback.
- **CROT groups (WP-25).** `browser_tab_open` groups the tab under `CROT` in
  its own window; popups from that group are grouped when the browser permits.
  `browser_tabs_list` includes `groupedByCrot` and `discarded`.
- **Settle and waits.** After an action the extension observes the tab for a
  short quiet period (300 ms); a navigation started by the action is awaited
  until `waitUntil` (`commit`, `domcontentloaded`, `load` (default),
  `networkidle`) within `timeoutMs` (default 20 s, max 60 s). Control results
  are facts only: `{tabId, url, navigated, newTabs}`. `browser_wait`
  (`browser.read`, not an exposure source) waits for one condition: element
  state, text present / gone, URL prefix, load state, new document or new
  tab. Text conditions count **rendered text only** (from the layout:
  `display:none` and `visibility:hidden` text, scripts and templates do not
  count; text made transparent with CSS opacity still counts).
  Closing the target tab during `browser_wait` returns `NOT_FOUND` promptly,
  including while a CDP poll is blocked. Its absolute `timeoutMs` deadline
  returns `TIMEOUT` even if that poll never answers.
  `browser_history` goes back, forward or reloads.
- **Frame references** belong to one document of the frame: when a frame
  navigates (for example an embed loading its real content after
  `about:blank`) it gets a new `frameRef` and the old one is stale. Take the
  snapshot after the frame has loaded (`browser_wait` with a `ref` of an
  element in it, or for `loadState`).
- **Per-tab queue.** Commands on one tab run one at a time in order, at most
  16 queued (then `RESOURCE_BUSY`), in the extension and in Core.
- `browser_tabs_list` reports `openerTabId`; a click that opens a pop-up
  reports it in `newTabs`.

### Approval gates

**When a browser action asks for approval.** Only when an approval rule
matches it. Without your own rules that is the built-in `untrusted-content`
rule (README, *Approval gates*): once a session has read page content
(`browser_snapshot`, `browser_page_read`, `browser_screenshot`,
`browser_tabs_list`), every `browser.control` operation of that session needs
approval in the CROT tray — unless the tray preset is **Autonomous browser**
(browser control without approval; shell, file writes, Git writes, network
and uploads stay gated) or **Off**. `crot_status` shows the value in effect
and its source. A denied or unanswered request fails the tool with
`PERMISSION_DENIED` (`details.approval.status`) and is audited with
`outcome: "denied"`; nothing is done. To gate every browser action
regardless of exposure, add a rule, for example
`{ "id": "browser", "match": { "capabilities": ["browser.control"] } }`.

When a `permissions.approvals` rule matches a browser operation (ARCHITECTURE.md
§27, AD-6, AD-8, AD-9, AD-11):

- Before the approval request, Core resolves the concrete tab with the
  `tabs.resolve` command (`{ tabId? }` → `{ tabId, url }`: the given tab or the
  active tab of the last focused window; it never acts on the page).
  `browser_tab_open` is bound to the origin of the URL instead. If the tab or
  its `http(s)` origin cannot be determined, the operation is denied without a
  request.
- The approval records the tab id, the normalized origin and the bridge
  `connectionId` (a random id the bridge assigns to every accepted `hello` and
  sends in `welcome`).
- After the approval, the command names the concrete tab and carries
  `expect: { tabId?, origin, connectionId }`. The bridge sends it only on that
  connection; the extension checks connection, tab and the origin of the
  committed URL (a pending navigation to another origin is a mismatch)
  immediately before acting. Any mismatch returns `PERMISSION_DENIED` and
  nothing is done; the approval is never transferred to another tab or origin.
- `browser_status` and `browser_tabs_list` do not target a tab and are not
  bound to one.
- **Element targets** (AD-16 points 10, 16). For a command that names an
  element by `ref`, the subject also shows the element as the last
  `browser_snapshot` of that tab on that connection described it: its role
  and accessible name (flagged as page-supplied text) and, when the element
  is in a child frame, the **frame origin**; for `browser_drag` the same for
  the drop target. The subject digest covers them. A ref that no snapshot of
  that tab and connection described is shown as such. The binding itself
  stays the tab and its top-level origin; a ref is valid for one document
  only, so the frame cannot change origin between approval and action
  without the command failing with `BROWSER_STALE_REF`.

## Protocol

Both hops use Chrome native-messaging framing: a 32-bit little-endian length
followed by UTF-8 JSON. Protocol version: 1.

Handshake:

1. The relay connects to the bridge endpoint and sends an `auth` frame
   (`protocol`, `token`).
2. It then forwards the extension's `hello`.
3. The bridge validates both and answers with `welcome` (`protocol`,
   `connectionId`), which the relay forwards to the extension.

After that, the bridge sends requests and the extension answers each with a
response carrying the same id.

Limits:

| Limit | Value |
| --- | --- |
| Handshake frames | 4096 bytes |
| Host → browser message | 1 MiB (larger requests are split into at most 64 chunks of 256 Ki UTF-16 units) |
| Browser → host message | 32 MiB |
| Handshake timeout (bridge) | 5 s |
| Concurrent handshakes | 4 |
| Pending requests (bridge) | 16 (more return `RESOURCE_BUSY`) |
| In-flight requests (extension) | 32 |
| Welcome timeout (extension) | 10 s |

## Bridge endpoint and token

| | POSIX | Windows |
| --- | --- | --- |
| Endpoint | Unix socket `<state>/browser.sock` (mode `0600`, state directory `0700`) | named pipe `\\.\pipe\crot-browser-<32 hex chars of SHA-256 of the token>` |
| Token | `<state>/browser-token` | `<state>\browser-token` |

- The token is 256 random bits (base64url), created on first start as a private
  file (mode `0600` on POSIX, owner-only ACL on Windows through the Native Host
  platform layer) and compared in constant time.
- While `browser.enabled` is `true`, the token file is a protected path: CROT
  tools cannot modify, delete or move it in any mode.
- POSIX socket paths are limited to 103 bytes. A longer path is a
  `CONFIG_ERROR`: the bridge is disabled with a warning and CROT keeps running.
  A stale socket is removed only after a liveness check, under a `.lock`
  directory; a non-socket file at the socket path is a `CONFIG_ERROR`.
- A bridge that fails to start never stops CROT; browser tools then report the
  bridge state.

## Connection lifecycle

- The extension calls `connectNative("com.crot.host")`, sends `hello` and waits
  for `welcome`. It reports the detected browser (Brave, Edge, Chrome or
  Chromium).
- If the connection fails or closes, it reconnects with exponential backoff
  from 1 s to 30 s. An alarm (`crot-reconnect`, every 30 seconds) wakes the
  service worker; an open native port keeps it alive.
- The relay reads the token, connects to the endpoint once and never retries
  or starts CROT. It exits with `0` when the connection closes in order and with
  `1` on errors — for example when `browser-token` does not exist (not set up)
  or when no CROT instance is listening. Its diagnostics go to stderr and never
  contain the token. The origin argument and `--parent-window` passed by the
  browser are ignored.
- Only one extension can be connected at a time; further connections are
  refused.
- When the extension disconnects, pending requests fail with
  `BROWSER_NOT_CONNECTED`.
- **Several MCP clients.** Since WP-20 the bridge belongs to the per-user CROT
  service (see [`SERVICE.md`](SERVICE.md)): every stdio client attaches to
  that service through the `crot-mcp` shim, so all clients share one bridge
  and one connected extension, and `in_use` no longer occurs in normal use.
  It remains possible only when an unrelated process (for example an older
  CROT version run separately) owns the endpoint: the CROT service then stays
  `in_use` for its whole lifetime; its other tools work
  normally, only browser tools fail with `BROWSER_BRIDGE_IN_USE`.
- Shutdown order: MCP connections and HTTP → Core (aborts browser requests) →
  bridge → Native Host platform layer.

## Extension permissions

Manifest V3, `minimum_chrome_version` 120:

| Permission | Why |
| --- | --- |
| `nativeMessaging` | connect to `com.crot.host` |
| `tabs` | list, open, navigate, activate and close tabs; tab URLs and titles |
| `scripting` | run the built-in page functions (read, click, type) |
| `alarms` | wake the service worker to reconnect |
| `debugger` | the fixed CDP backend (snapshot, input, frames, waits, history, dialogs, chooser interception, background screenshots) |
| `tabGroups` | visible CROT tab groups and grouping of their popups |
| host permissions `<all_urls>` | read and control pages and capture screenshots on any site the agent is asked to use |

The extension has no UI, no content scripts, no `externally_connectable` and no
web-accessible resources. Web pages cannot talk to it. It is not allowed in
incognito windows (`"incognito": "not_allowed"`).

## Audit

Every browser operation is audited like any other Core operation, as
`browser.status`, `browser.tabs_list`, `browser.page_read`,
`browser.screenshot`, `browser.dialog_handle`, `browser.tab_open`, `browser.navigate`,
`browser.tab_activate`, `browser.tab_close`, `browser.click`, `browser.type`,
`browser.snapshot`, `browser.wait`, `browser.hover`, `browser.scroll`,
`browser.drag`, `browser.press_key`, `browser.select_option`,
`browser.set_checked` or `browser.history`.
Details are limited to the tab id (or `active`), the URL **origin**, the selector
(truncated to 200 characters) or the opaque `ref`, the element role
(`elementRole`) and, for a target in a child frame, its origin
(`frameOrigin`; `dropElementRole` / `dropFrameOrigin` for a drag target), the
typed text length, the number of key combinations or option values, `clear`,
`format`, `maxBytes` and the settle options. Audit events never contain page
content, accessible names, values, screenshots, typed text, key sequences or
full URLs.

## Security notes

- `browser.control` lets the agent act in the user's browser profile with the
  user's logged-in sessions. Grant it deliberately, as with `shell.execute`.
- CROT itself still makes no outbound connections, but browser tools make the
  browser load pages the agent asks for.
- Pages are untrusted: their content may contain instructions aimed at the
  agent. CROT does not filter page content.
- The bridge token protects the endpoint from other programs; on POSIX the
  socket and state directory are owner-only as well.

## Uninstall

1. Remove the extension from the browser's extensions page.
2. Delete the host manifests listed above (Linux/macOS) or the registry keys,
   for example:

   ```bat
   reg delete HKCU\Software\Google\Chrome\NativeMessagingHosts\com.crot.host /f
   reg delete HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.crot.host /f
   ```

3. Delete `<state>/native-messaging`.
4. Set `browser.enabled` to `false` (or remove it).

To rotate the bridge token, stop CROT, delete `<state>/browser-token` and start
CROT again.

## Limitations and unverified areas

- Brave on Windows is registered through the Chrome registry key; this follows
  public documentation and has not been verified on a real Brave installation.
- Snap and Flatpak browser packages, and Chrome Beta/Dev/Canary or Chromium
  profile directories, are not registered and not tested.
- The relay's stderr is not shown in the browser UI; use the extension's
  service worker console and CROT's own log.
- Browser v1 is implemented in part (WP-24: CDP backend, snapshot and refs,
  trusted input, frames including out-of-process frames, open shadow roots,
  waits, history), plus WP-25 dialogs, chooser interception, background/ref/
  full-page screenshots, debugger status and CROT groups. WP-26 adds file upload/download with `downloads` permission (Linux transfer host). Not yet: explicit remote `tabId` and
  `openedBy` (WP-27). `tabGroups` is now requested. Arbitrary JavaScript and OS-level input stay excluded.
- Elements in closed shadow roots may appear (the snapshot follows the
  accessibility tree) but are not guaranteed. A frame-limited snapshot of an
  out-of-process frame and `browser_wait` text conditions cover that frame's
  session; `networkidle` counts requests of the tab's own session only.
- Browser v1 is checked end to end in a real Chromium (Chrome for Testing)
  by `npm run test:e2e:browser` (see [`BROWSER_E2E.md`](BROWSER_E2E.md)).
  Manual runs on real sites in Google Chrome found the problems fixed above
  ([`acceptance/WP-24-manual-run-1.md`](acceptance/WP-24-manual-run-1.md),
  [`acceptance/WP-24-manual-run-2.md`](acceptance/WP-24-manual-run-2.md)).
  [Run 3](acceptance/WP-24-manual-run-3.md) fixes merged in PR #25.
  [Run 4](acceptance/WP-24-manual-run-4.md) confirms language clicks,
  close-during-wait and native windows; CodePen back remains partial.
  [Run 5 / follow-up](acceptance/WP-24-manual-run-5.md) reports audit and
  approvals passed, including no-UI fail closed. Default-load timeout
  signalling is fixed here; manual confirmation, C1 and final review
  keep acceptance open.
- The "… started debugging this browser" notice is Chrome's own and is shown
  in **every** window of the browser, including windows of other Chrome
  profiles where the extension is not installed: the browser shows it for the
  whole browser process. It does not mean the extension has access to those
  profiles (it can only attach to tabs of its own profile). The notice goes
  away when the extension detaches: when the tab is closed, when the
  connection ends, or after 5 minutes without commands on a tab.
- Input needs a visible page: CROT activates the tab (and restores or, last,
  focuses its window) for page input commands, which the user sees. Dialog handling, screenshots and grouping do not activate tabs. Two
  agents driving different tabs of one window take turns.
- Native `<select>` on macOS: selection uses keys on the focused select;
  where the platform opens the pop-up instead, the command fails (the
  post-condition) rather than reporting a selection. Not verified on macOS.
- Setup is manual. A one-click installer for the extension and the host is a
  later step (ARCHITECTURE.md §16, step 13; work package WP-34).

## WP-25 qualification and limits

The browser matrix decision (AD-32 / OD-9 browser part) is Chrome, Edge and
Brave based on Chromium 120+ on the supported Linux/macOS/Windows platforms;
`minimum_chrome_version` is 120. A support target is not evidence of testing
all branded browsers or the minimum build itself. Automated real-browser
coverage is Linux Chromium (`tests-e2e/browser/wp25.e2e.test.ts`), including
real 60 s timeout and host audit, actual debugger API detach, file chooser,
beforeunload, background/ref/fullPage captures and popup grouping. Enterprise
attach refusal is injected in the test witness, **not** a real managed-policy
installation. The native-picker claim is checked by actual CDP interception
and pending chooser state; no OS accessibility automation is claimed.

Remaining manual qualification: headed debugger infobar / user-cancel UX in
Chrome, Edge and Brave on Linux, macOS and Windows; actual enterprise policies;
minimum-version / HiDPI / occluded-window variants; WP-24 final owner acceptance.
None is reported as passed merely because CI is green. Store acceptance and
signed distribution remain WP-35 / WP-34. See
[`design/browser-wp25.md`](design/browser-wp25.md) for the evidence map.
