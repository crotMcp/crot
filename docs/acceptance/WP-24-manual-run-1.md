# WP-24 — manual run 1 on real sites (owner)

- **Run by:** the owner, with a local agent (OpenCode) connected to CROT over
  stdio; Google Chrome 153, CROT Browser Extension 0.1.0, Linux x64,
  `permissions.mode: sandbox`. Build: PR #22 (merged as `d273473`) before the fixes below.
- **Sites:** ru.wikipedia.org, codepen.io (cross-origin frame `cdpn.io`),
  shop.polymer-project.org (SPA, shadow DOM), the-internet.herokuapp.com.
- **Result:** 7 pass, 4 fail, 1 partial out of 12 scenarios.

## Passed

Connection and tab list (incl. unloaded tabs); Wikipedia search, navigation
and history by refs; `BROWSER_STALE_REF` after reload, DOM changes and for a
ref of another tab; the CodePen cross-origin frame (frame-scoped refs, click
inside `cdpn.io`, `frameOrigin` in the audit); the Polymer shop SPA flow;
`browser_set_checked`, `browser_hover`, `browser_drag`, keys on a focusable
ref; disconnect / reconnect (`waiting`, `BROWSER_NOT_CONNECTED`, automatic
recovery); a closed tab answers `NOT_FOUND`; audit privacy (`textLength`
only, origins only, no names).

## Failures and what changed

| Finding | Cause | Change (PR #23) |
| --- | --- | --- |
| Clicks on the-internet.herokuapp.com reported `ok` but did nothing, each taking about 5.3 s; `target=_blank` opened no tab; the first `set_checked` reported `changed: false` | The tab was **not the visible tab** (other tabs in front). Browsers hold each mouse event to a hidden page for about 5 s and drop it. Reproduced in Chromium: 5.3 s per click on a background tab, 0.3 s when visible | Before every control command the extension makes the tab visible (activates it, restores a minimized window, as a last resort focuses the window; `activated: true`), or fails before dispatching. Clicks and drags are checked for delivery (isolated-world probe counting trusted pointer events): undelivered input fails instead of succeeding. Control commands of different tabs run one at a time |
| `browser_wait {text}` satisfied in 11 ms by `display:none` text | Text was matched against the DOM | Text conditions use rendered text only (DOMSnapshot layout, `visibility:hidden` excluded) |
| `browser_select_option` reported `selected` although the page showed no change | No post-condition | Fails unless the page shows the requested option(s) selected |
| `set_checked` could answer `ok` with `changed: false` | No post-condition | Fails unless the element shows the requested state |
| `browser_screenshot` hung for 30 s | A capture of a hidden or minimized window is not answered | Minimized: fails at once; no answer within 10 s: `TIMEOUT` |
| `press_key` without a target / on `body` | The page had no focus (the user worked in the terminal); `DOM.focus` refuses `body` | Focus emulation (`Emulation.setFocusEmulationEnabled`, the only Emulation method allowed); `body` / `html` take keys without focusing |
| No approval prompt for any browser action; "denial recorded as success" | Approvals appear only when a rule matches; the tray preset in use let browser control run without approval. The 5.3 s "silent denial" was the hidden-tab delay above. Denials are audited as `outcome: "denied"` | Documented in BROWSER_EXTENSION.md, *Approval gates* |
| Navigations that did not finish in time looked finished | Not reported | `loadTimedOut: true` |
| An element in the hidden part of a partly visible frame was "obscured" (found by the new E2E test) | Only the frame owner was scrolled into view | The element's part of the frame is scrolled into view |

Also observed and documented, not changed: a frame that navigates gets a new
`frameRef` (wait for it to load before the snapshot); a closed native
`<select>` exposes its selection as the select's `value`, not as `selected`
on the options; "The browser debugger was detached" can occur once after the
extension was reloaded (the next command re-attaches).

## Still open

A second manual run on the fixed build (same scenarios, especially 6, 7, 11
and 12) has not been performed yet; WP-24 acceptance stays open until it is
recorded here.
