# WP-26 — download hand-over review

Status: **AD-33 selected; identity-bridge witness passed; WP-26 runtime
integration and acceptance incomplete; not Ready for review**.
Base: `main` `e197f18475901992ce1fb389616de015dba20f4b` (PR #31 merged).
The curator authorized an architecture amendment. AD-33 in ARCHITECTURE.md
now selects a response-bound capability mechanism for OD-8. This does not
waive acceptance criteria or mark WP-26 / AD-23 point 8 complete.

## Required invariant

AD-16 point 12 requires attribution by browser events to the selected tab,
including its frames. Unrelated user downloads must never be moved, read,
or exposed. A random staging name prevents a path-substitution attack; it
does not establish which download belongs to the authorized command.

## Historical gap in the unmodified CDP + downloads API combination

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

## Requirements retained after selecting AD-33

AD-33 selects an additional mechanism; the implementation must still preserve
all of AD-16 point 12 and the documented acceptance scope. Do not silently
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

## AD-33 mechanism and reproduced evidence

The built-in extension response interceptor inserts a fresh 192-bit random
capability into one response's Content-Disposition filename. Both the exact
frame/session CDP event and the downloads filename callback must carry that
capability before the numeric id and GUID are bound. This is a generated
identifier, not URL, server-filename or timing correlation. The complete
original filename, including dangerous suffixes, is retained. Unsupported
or ambiguous disposition syntax fails closed.

`extension/src/download-ownership.ts` implements only this ownership ledger;
it is not yet wired into production command handlers. The extension manifest
and production CDP allowlist are unchanged. The helper alone does not perform
workspace I/O, acquire approvals, implement cancellation, or establish the
full causal scope of a command's trigger.

Reproduction (Node >=24 and Chromium on PATH, or CROT_E2E_CHROME):

```sh
node scripts/spikes/wp26-ownership.mjs
```

This isolated witness uses the checked-in ownership helper, fixed extension
code, local HTTP fixtures and throw-away profiles. In Chrome for Testing
153.0.8010.12 / Linux headless, four scenarios passed:

- top-frame trusted click;
- selected OOP child-frame trusted click;
- target-tab URL navigation;
- target-tab URL navigation through a redirect.

Every scenario overlaps a foreign-tab download of the identical URL and
server filename, created first. Exactly one filename callback is overridden;
the foreign callback is left unchanged. The owned GUID reports completed,
both native items report complete/safe, the owned bytes equal the fixture,
and the server sees exactly two body requests (no replay). Only owned bytes
are read; no foreign file is read. The test owns and deletes its entire
isolated profile after browser shutdown, not a user's download directory.

Additional local checks passed:

- extension Vitest suite: 12 files, 170 tests, including 16 ownership tests;
- ESLint and Prettier for the three new source/test/spike files;
- isolated strict TypeScript check of the ownership helper.

The first suite attempt used a local package.json stub and failed the version
assertion. After restoring the actual repository package.json, all 170 tests
passed. A first four-scenario attempt also exposed a transient profile cleanup
ENOTEMPTY; bounded Node rm retries were added and all four scenarios reran
successfully. Neither failure is hidden or counted as a successful run.

## Verification status and outstanding work

These results prove the tested identity bridge, not the complete feature.
Production browser_file_upload and browser_download remain unimplemented.
Immutable upload staging, safe download publication, lifecycle cleanup,
interruption/danger handling, full trigger/response binding, protected path
checks and real exposed autonomous-browser approval-gate E2E remain pending.

Neither npm run check nor npm run test:e2e:browser has passed for this work.
The full source/test checkout is not present locally. Both GitHub check-runs
and combined commit-status reads returned 403 with the current connection,
so CI 11/11 is unknown, not green. PR #32 remains Draft and must not be merged
as a completed WP-26 or AD-23.8 delivery.
