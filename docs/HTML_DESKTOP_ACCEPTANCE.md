# Public HTML routing and detached desktop startup

## Source provenance

Real full git clone of `feat/flagship-control-center`, followed by `git fetch origin main`.
Parent: `c04afe05f292641b7151e6385d654e630853fdfa`; fetched main: `5dc81e5ceab7f92cbf4901dce519e0685c92c8a9`.
All tracked source, deployment examples and documentation are present (487 tracked entries under docs at the parent). Dependencies installed with `npm ci`.
This supersedes the missing-tree/GTK limitations in the [earlier record](INSTALLATION_GATES.md); historical results are not rewritten.

## HTML contract

Public pages are handled synchronously before download, account API and MCP dispatch.
`/`, `/welcome`, `/portal` and `/portal/callback` are independent of tokens, OAuth configuration, billing and device admission.
GET returns 200, `text/html; charset=utf-8`, uppercase `<!DOCTYPE html>` and embedded Zinc CSS. HEAD returns the same headers and content length, without a body.
The static stylesheet is authorized by its exact CSP SHA-256; no unsafe-inline or external stylesheet is required.
Unknown APIs remain JSON 404, POST to pages is 405 and account authentication is retained. Five real relay integration tests cover these contracts.

An initial live staging probe already returned 200 HTML for the three GET routes; the owner's JSON failure was not reproduced at that time. HEAD /portal did reproduce 405.
These source changes do not deploy themselves. An operator must rebuild/restart staging and verify GET and HEAD after deployment. No operator credentials, configuration or production data were changed.

## Unified desktop startup

The explicit desktop launcher registers the native host, reuses or starts a managed service through the existing authenticated start lock, waits for its welcome, then launches Electron.
The managed service is detached with a private log. The launcher can exit without stopping the service or UI. Default stdio on-demand behavior is unchanged.

Real Linux Xvfb/Electron verification in an isolated owner profile: app CLI returned successfully, managed service stayed alive, one Electron tray subscribed, repeated npm start reused the same UI, and Chrome/Edge/Brave native-host manifests were registered. Test processes were cleaned up.
A real managed-bootstrap integration test checks service survival after the bootstrap channel closes. The Electron smoke API allowlist includes the existing repairL1 method; security assertions remain enabled. The launcher path assertion now uses native platform path semantics on Windows.

## Verification record

The full-checkout `npm run check` passed: 2199 unit/integration tests passed, 218 skipped; 193 extension tests passed. This includes the real Electron smoke, five HTML contracts and managed bootstrap. No checks were disabled.
Browser E2E completion and fixed-head CI must be recorded separately in the PR after execution, not inferred from earlier commits.
Privileged L1 installation on every OS, signed native installers, live Stripe qualification and staging deployment remain separate release/operational gates.

## Chromium CI cleanup follow-up

A full graphical Xvfb run also passed all 57 tests (3 skipped).
The owner-provided log for head `3385907` identified the remaining CI failure as
`ENOTEMPTY` deleting the temporary Chromium profile in the portal test teardown,
not a portal assertion failure. The test now checks signal termination as well as
exit status and retries profile removal with the same bounded filesystem policy
used by the other browser suites. Portal assertions are not retried or suppressed.
