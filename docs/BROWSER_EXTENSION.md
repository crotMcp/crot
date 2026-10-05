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
| `in_use` | another CROT instance owns the bridge endpoint |

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
| `browser_tab_open` | `browser.control` | `tabs.open` |
| `browser_navigate` | `browser.control` | `tabs.navigate` |
| `browser_tab_activate` | `browser.control` | `tabs.activate` |
| `browser_tab_close` | `browser.control` | `tabs.close` |
| `browser_click` | `browser.control` | `page.click` |
| `browser_type` | `browser.control` | `page.type` |

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
- `browser_screenshot` captures the visible area of the active tab only. It
  never activates a tab: for any other tab it returns `INVALID_INPUT` and asks
  for `browser_tab_activate` first. The browser's capture rate limit returns
  `RESOURCE_BUSY`. Images are limited to 16 MiB and are returned as MCP image
  content followed by metadata.
- `browser_click` scrolls the element into view and calls `element.click()`
  (a synthetic event, not OS-level input).
- `browser_type` sets the value through the native setter and dispatches
  `input` and `change` events, or uses `insertText` for `contenteditable`
  elements. Only text-like inputs and textareas are accepted; disabled and
  read-only elements are rejected. With `clear` the value is replaced,
  otherwise text is appended.
- Page functions run in the extension's isolated world, in the main frame only,
  and use `document.querySelector` on the top document: elements inside
  iframes or shadow roots cannot be addressed.
- Each request has a 30 second timeout in Core (`TIMEOUT`).

Errors the extension may report are limited to `NOT_FOUND`, `INVALID_INPUT`,
`TIMEOUT`, `LIMIT_EXCEEDED`, `RESOURCE_BUSY`, `OPERATION_FAILED` and
`BROWSER_PAGE_RESTRICTED`. `BROWSER_NOT_CONNECTED` and `BROWSER_BRIDGE_IN_USE`
are decided by Core from the bridge state; the extension cannot claim them or
any authorization error, with one exception: `PERMISSION_DENIED` answers a
command of an approved operation whose expected browser subject no longer
matches (see below); for any other command it becomes `OPERATION_FAILED`. Results are validated against Core's schemas: an
invalid result, or a result for a different tab, becomes `OPERATION_FAILED`.

### Approval gates

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
- **Multiple CROT instances.** Only one CROT instance can own the bridge
  endpoint. A second instance stays `in_use` for its whole lifetime, even if
  the first one exits: its other tools work normally, only browser tools fail
  with `BROWSER_BRIDGE_IN_USE`. Restart it to take over the bridge.
- Shutdown order: transport → Core (aborts browser requests) → bridge → Native
  Host platform layer.

## Extension permissions

Manifest V3, `minimum_chrome_version` 120:

| Permission | Why |
| --- | --- |
| `nativeMessaging` | connect to `com.crot.host` |
| `tabs` | list, open, navigate, activate and close tabs; tab URLs and titles |
| `scripting` | run the built-in page functions (read, click, type) |
| `alarms` | wake the service worker to reconnect |
| host permissions `<all_urls>` | read and control pages and capture screenshots on any site the agent is asked to use |

The extension has no UI, no content scripts, no `externally_connectable` and no
web-accessible resources. Web pages cannot talk to it. It is not allowed in
incognito windows (`"incognito": "not_allowed"`).

## Audit

Every browser operation is audited like any other Core operation, as
`browser.status`, `browser.tabs_list`, `browser.page_read`,
`browser.screenshot`, `browser.tab_open`, `browser.navigate`,
`browser.tab_activate`, `browser.tab_close`, `browser.click` or `browser.type`.
Details are limited to the tab id (or `active`), the URL **origin**, the selector
(truncated to 200 characters), the typed text length, `clear`, `format` and
`maxBytes`. Audit events never contain page content, screenshots, typed text or
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
- No frames, shadow DOM, file uploads, downloads, OS-level input or arbitrary
  JavaScript. Element references, real (trusted) browser input events, frames,
  shadow DOM, dialogs, file upload and download, background-tab screenshots
  and explicit tab targeting are required for v1 (browser contract v1,
  ARCHITECTURE.md §7.1, §27 AD-14; work packages WP-24…WP-27); arbitrary
  JavaScript and OS-level input stay excluded.
- Setup is manual. A one-click installer for the extension and the host is a
  later step (ARCHITECTURE.md §16, step 13; work package WP-34).
