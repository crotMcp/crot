# WP-24 — manual run 2 on real sites (owner)

- **Run by:** the owner, with a local agent (OpenCode) connected to CROT over
  stdio; Google Chrome 153, CROT Browser Extension 0.1.0, Linux x64. Build:
  PR #23 at `efce361` (the run-1 fixes), before the fixes below.
- **Scope:** blocks A–F of the run-2 checklist (A1–A22 the-internet, B1–B4
  Wikipedia, C1–C4 cross-origin and same-origin frames on CodePen, W3Schools,
  MDN and jqueryui.com, D1–D2 the Polymer shop, E1–E5 window states, F1–F2
  reconnection). Block H (approvals) was not part of this run.
- **Result:** D, E and F1 passed; B mostly passed; C failed or passed in part;
  A passed with the findings below. Run-1 findings confirmed fixed: keys in
  an unfocused window, hidden-text waits, `select_option` (also on custom
  shadow-DOM comboboxes), background tabs (every action activated the tab).

## Passed

Shadow DOM purchase flow (D1) and the same flow from a background tab (D2);
history back / forward / reload with honest `navigated`; scroll and
screenshot; clicks, focus and screenshots with the window minimized, behind
another application or with two Chrome windows (E1–E4); closing the tab
during `browser_wait` fails at once with `NOT_FOUND` (E5); reloading the
extension reconnects at once and makes old refs stale (F1); the CodePen
cross-site frame (C1); the Wikipedia language dialog by keys (B4).

## Findings and what changed

All causes below were reproduced in a real Chromium before the fix and are
covered by the new E2E file `tests-e2e/browser/browser-layout.e2e.test.ts`.

| Finding | Cause | Change (PR #24) |
| --- | --- | --- |
| False `obscured` on scrolled pages: Wikipedia body links after jumping to a section (B2, "survived reload, gone after leaving and returning"), MDN's cross-origin example frame "regardless of position" (C3), the-internet floating menu (A14) | `DOM.getNodeForLocation` takes **document** coordinates; the check passed viewport coordinates, so on any scrolled page (or scrolled frame) it tested another point. Reproduced: at scroll 500 the point under a fixed header answered "no node", and 540 px down hit the header | The hit test adds the page's scroll offset, and in a frame the frame's own scroll offset |
| False `obscured` for elements under a sticky header (A14, B2) | The element really was under the fixed header after scrolling to it | A covered element is scrolled towards the viewport centre with one wheel step and re-checked (about 1.5 s at most); the error now names what covers it ("covered by header#sticky", tag and id only) |
| False `obscured` for text refs (A21, B4 clicks in the language dialog, hover on text in C4) | Hit tests never return text nodes, they return the parent element, which the check treated as a cover | For a text node the parent element counts as a hit |
| False `BROWSER_STALE_REF` for every ref in a same-process frame: W3Schools `iframeResult` (C2), the jqueryui.com demo frame (C4) | CDP marks the frame's **owner element** (`<iframe>`) with the child frame's id as well; the connectedness check took the owner instead of its `contentDocument` and found nothing below it | The frame's document is the owner's `contentDocument` (cross-site frames were not affected) |
| Selectors never reached into frames; `selector` + `frameRef` was refused or ignored (C2, C4) | `frameRef` for selectors (AD-16 point 5: `{ selector, frameRef? }`) was not implemented | `frameRef` on every command with a target, the drop target of `browser_drag` and element waits: the selector is resolved in that frame (checked like a ref). With a ref, `frameRef` must be the ref's frame. Approvals for a selector in a child frame show the frame's origin |
| `browser_drag` could not be used in frames (C4) | Consequence of the two findings above | Drag by refs in same-process frames works; `to` takes `frameRef` |
| A JavaScript dialog blocked every command for 30 s, then `TIMEOUT` (A22) | Commands wait for the blocked page | A command that opens a dialog fails at once ("The action opened a JavaScript alert dialog …"; the action was performed); while it is open every command fails at once; after the user closes it, commands work again. Dialogs are still not answered by CROT |
| A dialog at the end of a large page appeared only with `maxElements: 5000` (B4) | Elements were cut in document order | Elements of open `dialog` / `alertdialog` subtrees come first in the snapshot |
| `activated` and `loadTimedOut` missing in results (D2, E1, A19) | Not reproduced with the build of PR #23: both are returned (E2E). The CROT service was most likely still the process started before the rebuild: Core validates results with its own schema and drops fields it does not know | No change. After a rebuild, stop the service (`node dist/bin/crot-mcp.js service stop`) and restart the agent so that it starts the new service |
| Screenshot of a minimized window succeeded (E2) | On Linux the browser often keeps rendering a minimized window and does not report it as minimized | Documented as expected; a window the browser reports as minimized still fails at once |
| `window` in `browser_tabs_list` is `null` (E4) | The field is `windowId` | None |
| Input values not in the snapshot (A3) | Not reproduced: a number input reports `value` (E2E checks typing and ArrowUp) | None |
| After `service stop` OpenCode does not reconnect (F2) | By design the stdio shim exits when its service stops; OpenCode does not restart a failed local MCP server | Documented; restart the agent after stopping the service |
| The Chrome notice "… started debugging this browser" showed in windows of other Chrome profiles | Chrome shows this notice in every window of the browser process | Documented; the extension cannot attach to other profiles. The notice goes when the debugger detaches (tab closed, connection ended, or 5 minutes without commands) |

## Not done

A run on the build with these fixes (run 3: blocks B2, C1–C4, A14, A15,
A21, A22 and block H) has **not** been performed; WP-24 acceptance stays
open.
