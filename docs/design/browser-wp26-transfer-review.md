# WP-26 — download hand-over review

Status: **design review blocked; not implemented, not Ready for review**.
Base: `main` `e197f18475901992ce1fb389616de015dba20f4b` (PR #31 merged).
This review does not close OD-8, change AD-16, waive acceptance criteria, or
mark WP-26 / AD-23 point 8 complete.

## Required invariant

AD-16 point 12 requires attribution by browser events to the selected tab,
including its frames. Unrelated user downloads must never be moved, read,
or exposed. A random staging name prevents a path-substitution attack; it
does not establish which download belongs to the authorized command.

## Gap in the proposed CDP + downloads API combination

- `Page.downloadWillBegin` carries `frameId`, `guid`, `url` and
  `suggestedFilename`; `Page.downloadProgress` identifies that `guid`.
- `chrome.downloads.onDeterminingFilename` carries a `DownloadItem` and a
  filename suggestion callback. The documented `DownloadItem` has a numeric
  `id`, but no tab id, frame id, or CDP download GUID.
- Consequently these interfaces do not provide a documented common identity
  by which to join the CDP-attributed download with the `DownloadItem` whose
  staging filename would be changed. URL, suggested filename, event order,
  and timing are not that identity. In particular, simultaneous same-URL
  downloads in the command tab and another tab cannot safely be distinguished
  by those fields. No implementation may guess that mapping.
- `chrome.downloads.download` returns an exact numeric id and sends HTTP(S)
  cookies. This supplies an identity for a directly initiated URL download;
  it does not identify a download produced by an arbitrary page click.
- `Browser.setDownloadBehavior(allowAndName)` names downloads by GUID, but
  configures a **browser context**, not one tab or one authorized download.
  The Browser domain is not in the existing extension allowlist. Applying
  it to the user's shared profile would also alter unrelated downloads.
  It is not a permitted fallback under the current contract.
- Deprecated `Page.setDownloadBehavior` has `deny`, `allow`, `default`,
  not `allowAndName`. Its public parameters do not supply a per-download
  filename token or the missing API-id/GUID mapping.

This establishes a missing design proof for the proposed combination, not
an assertion that every alternative native/streaming design is impossible.
A streaming alternative must identify and verify its source descriptor and
preserve attribution, browser danger checks, cancellation, cleanup, profile
session semantics and the no-replay requirement before being accepted.

## Review required before download implementation

Choose and prove an additional mechanism that preserves all of AD-16 point 12,
or explicitly amend the architecture and acceptance scope. Do not silently
reduce click support to URL-only, replay a page download as a new GET, collect
all downloads, or weaken unrelated-download isolation.

At minimum, the proof/test matrix must distinguish two concurrent same-URL,
same-suggested-name downloads from different tabs, including an OOP child
frame of the selected tab, and prove that only the owned download receives
staging treatment. Unit event simulations alone are insufficient: this needs
a real Chromium witness of the identity bridge.

## Sources inspected

- [Chrome downloads API](https://developer.chrome.com/docs/extensions/reference/api/downloads):
  DownloadItem, download(), onDeterminingFilename.
- [Official CDP schema](https://github.com/ChromeDevTools/devtools-protocol/blob/master/json/browser_protocol.json):
  Page.downloadWillBegin, Page.downloadProgress, Page.setDownloadBehavior,
  Browser.setDownloadBehavior and Browser.downloadProgress.
- Repository: ARCHITECTURE.md AD-16 points 3, 11, 12 and 19;
  CROT_IMPLEMENTATION_ROADMAP.md section 6.5, WP-26.

## Verification status

No production code or permissions were changed. No unit/E2E/CI success is
claimed by this document. The WP remains incomplete; merge must not imply
that file transfer or AD-23 point 8 has been delivered.
