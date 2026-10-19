# WP-26 — production upload/download and OD-8 acceptance

Status: **WP-26 Done in PR #32 (not merged); OD-8 Decided by AD-33**.
Production commit: `4cc717184b3d3d6739b5a89e6af0b0edd24b1529`.
Base: `main` `e197f18475901992ce1fb389616de015dba20f4b` (PR #31 merged).
The accepted identity proof at `8920529` is retained below as historical
evidence; it is no longer the feature's implementation status.

## Production contract

- Both tools are registered in MCP and run through BrowserService, one
  ExecutionGuard authorization/audit path and the real native bridge. Upload
  requires browser.control + filesystem.read; download requires browser.control
  + filesystem.write. Neither introduces exposure.
- Upload: 1–16 files / 64 MiB total, workspace boundary plus protected/secret
  checks, canonical source with no-follow descriptor and immutable private
  read-only copy. Ref and pending chooser both use DOM.setFileInputFiles.
  Copies survive mutation of the original and are released on frame/document
  replacement, tab close or Core shutdown. Definite precondition errors clean
  immediately; indeterminate applies keep their copies until lifecycle release.
- Download: one extension-wide capture queue, target's existing verified
  frame/session tree, response-injected 192-bit capability, exact GUID + native
  numeric id proof. Unknown same-URL files always receive unchanged suggest()
  and are never read/moved/canceled. Only the proved id receives staging.
- Both completion streams + native danger safe are mandatory. Core opens only
  its nonce-derived expected regular single-link file, using O_NOFOLLOW and
  exact size. Descriptor-anchored temporary copy, fsync and atomic installation
  publish into savePath. Default no-overwrite uses link; explicit replacement
  uses rename. Interrupt/danger/error clean only owned bytes. Core ACK and a
  60 s lost-ACK cleanup bound the browser hand-over lifetime.
- Audit: relative workspace paths and sizes; no contents, ownership tokens,
  private staging paths or page-suggested download names.

## Qualification and limits

**File-transfer Core host is currently Linux only.** `/proc/self/fd`,
O_DIRECTORY and O_NOFOLLOW provide the destination-descriptor primitive.
Windows/macOS return OPERATION_FAILED, never an unsafe check-then-open fallback.
This explicit AD-33 fail-closed scope is not full product/OS qualification.
Owner config browser.downloadsDirectory must match the actual browser profile's
default directory (default ~/Downloads); CROT never changes profile-wide behavior.

Only supported HTTP(S) status-200 responses, one simple bounded ASCII filename
in Content-Disposition and already-verified sessions are captured. Redirects
continue unchanged. filename*, ambiguous dispositions, blob/data/internal,
new-tab/new-unverified-session downloads fail closed without taking unknown
items. The original dangerous suffix is preserved; Safe Browsing is not
disabled. Malware scanner effectiveness is not claimed by synthetic danger
fault injection.

## Production acceptance evidence

Local Linux / Chromium 153.0.8010.12, isolated throw-away profiles and HTTP
fixtures, headed under Xvfb (no shared/user profile):

| Acceptance | Evidence |
| --- | --- |
| Upload ref + intercepted chooser | Real MCP → Core → native bridge → Chromium |
| Lazy-read immutable bytes after original mutation | Real Chromium page reads retained File |
| Sandbox outside/protected/secret path denial | Real tools; no browser hand-over |
| Upload document/frame/tab lifetime | Chromium navigation/tab removal; unit child-frame/detach tests |
| Click + URL download; overwrite:false + explicit overwrite | Real tools, exact file bytes, destination absent while in flight |
| OOP child frame upload + download | Real cross-site Chromium iframe |
| Concurrent foreign identical URL, foreign first | Real second tab, foreign filename/history untouched; foreign bytes never read |
| Interrupted transfer cleanup | Real socket interruption; no workspace/staging artifact |
| Unsafe native classification cleanup | Real browser with explicitly test-only search-result fault injection, plus unit event tests; not malware-scan qualification |
| AD-23.8 both real tools | Exposed autonomous-browser: missing provider denies; pending approval blocks; matching approval executes |
| Audit content/path secrecy | Actual Core audit events checked after successes and denials |
| Destination/staging substitution, symlink, hardlink, size and permissions | BrowserFiles unit tests; native no-follow primitives |
| Event order, ambiguity, unproved/foreign items | Production capture + exact ownership unit tests |

Full local `npm run check`: passed (Core 1995 passed / 215 platform-dependent
skips; extension 179 passed; new non-Linux primitive test is skipped on Linux). Full headed
`npm run test:e2e:browser`: **5 files, 49 passed / 3 existing opt-in skips**;
WP-26 **11/11**. The opt-in skipped tests are not counted as passed.
Local Electron smoke lacked libgtk-3 and was skipped; native L1/other-OS
qualification is supplied by dedicated CI, not this local host.
CI must be verified on the final PR head; 11/11 on 8920529 is historical, not
evidence for later code. Merge remains exclusively the user's action.

Reproduce:

```sh
npm ci
npm run check
CROT_E2E_CHROME=/path/to/chromium CROT_E2E_CHROME_ARGS=--no-sandbox xvfb-run -a npm run test:e2e:browser
```

The container-specific no-sandbox flag is only for this isolated test host;
it is not a production browser configuration recommendation.

## Historical design investigation and initial witness

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
at that commit it was not yet wired into production command handlers. At that
commit the extension manifest and production CDP allowlist were unchanged. The helper alone does not perform
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

## Historical verification status at 8920529 (superseded)

At the identity-witness commit, runtime integration and real approval gates
were not implemented, and the first private-repository check reads returned
403. The repository was subsequently made public; checks on 8920529 were
verified 11/11 green. That witness alone did not complete WP-26. The production
implementation and separate acceptance evidence below supersede this status.
