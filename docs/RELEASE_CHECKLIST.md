# CROT v1 release candidate checklist

> Use root STATUS four-axis matrix. Repository RC/update artifacts are not GUI installers or beta/GA. Production, Stripe, vendor signing, store/legal publication, external-client runs and live drills remain open. Historical repository Done labels below are not full-product acceptance.

This checklist separates repository evidence from actions only the release operator can perform. A generated RC is not GA. Each operator item needs an owner, timestamp and immutable evidence link.

## Build the RC

1. Use a clean reviewed commit and pinned Node/lockfile environment.
2. Set `RELEASE_IDENTITY_ENVIRONMENT` to the approved public profile, `CROT_E2E_CHROME` to qualified Chromium and `CROT_UPDATE_SIGNING_KEY` to a protected Ed25519 private-key file.
3. Run `npm run build:rc`. Production mode cannot skip `npm run check` or browser E2E.
4. Verify `artifacts/rc/rc-manifest.json` and signature; reconcile every listed SHA-256 with desktop package, extension zip, SBOM, notices and `SHA256SUMS`.
5. Archive provenance, CI run, commit, signer identity and review approvals. Never upload the private key.

Repository-only test mode may use `--repository-test --skip-check --skip-e2e`; it is not releasable and is visibly recorded in the manifest.

## §10 readiness criteria

| Criterion | Repository evidence | Operator closure |
| --- | --- | --- |
| Core capabilities, permissions, approvals and durable audit | `npm run check`, security invariant suite | review production policy/defaults |
| Git/Docker/local transports | integration suites | smoke on signed installed build |
| Browser/native host/download/tab groups | extension + Chromium E2E, store archive | Chrome/Edge store approval and signed IDs |
| L1 on Linux/macOS/Windows | native/matrix tests and installer plans | signed packages installed on each qualified OS |
| Identity/device binding/remote relay | verifier/tunnel/acceptance suites, AD-36 | live WorkOS, DNS/TLS and real-client staging evidence |
| Commercial entitlement/revocation | account/relay/portal tests | live Stripe/WorkOS merchant acceptance |
| Signed updates, rollback, uninstall | WP-34 tests, SBOM/checksums | vendor signing/notarization and manual install/upgrade/uninstall |
| Security review and residual risks | WP-33 report, 12-invariant suite | independent assessment if required by operator/customers |
| User/security/privacy/legal docs | WP-37 files | replace placeholders, counsel approval, publish URLs |
| Operations/SLO/DR | WP-39 templates and automated drills | live load, backup/restore, rotation, outage and revocation drills |
| Beta/GA | pipeline only | beta cohort, support readiness, no blocking issues, go/no-go |

## Gates

- **G6 technical security:** no open critical/high repository finding; threat model and residual register final. Reopen on any new critical/high.
- **G7 commercial RC:** WP-34/35/36/37 repository work complete, but gate closes only after signed three-OS installation, extension publication, live entitlement and published legal documents.
- **G8 production/GA:** closes only after production is live/monitored, drills pass, beta completes without blocker and every row above has operator evidence.

## Rollout

1. Freeze release commit/config; confirm on-call, support/status page, backups and rollback artifact.
2. Deploy production relay dark; validate health/metrics/privacy and IdP/billing webhooks.
3. Internal canary: pair/revoke, local/remote operations and update rollback on all OSes.
4. Beta cohorts 1% → 10% → 50%, holding at least one SLO observation window each. Stop on security finding, unexplained payload/privacy signal, data integrity issue, update/rollback failure, elevated unknown outcomes or exhausted error budget.
5. Publish store extension/desktop links and legal notices together; monitor compatibility/version admission.
6. GA only by named operator approval `[OWNER]` with completed evidence record `[URL]`.

## Rollback plan

Disable new remote admissions if containment is needed; announce aggregate incident; stop rollout; revoke compromised sessions/devices/keys; restore last signed app/container while preserving the private state volume; restore registry/accounts only from verified offline backup when state is corrupt; verify local mode remains available; run smoke/privacy checks before reopening. Store rollback may lag review—keep the last compatible desktop/protocol for at least 12 months and use `update_required` rather than weakening authorization.

## Final record

- Commit/tag: `[ ]`
- CI 11/11 and browser E2E: `[ ]`
- RC manifest/signature/checksums: `[ ]`
- Vendor signatures/notarization: `[ ]`
- Store approvals: `[ ]`
- Live staging/production drill report: `[ ]`
- Legal/privacy/support URLs: `[ ]`
- Beta report/no blockers: `[ ]`
- Go/no-go approvers and time: `[ ]`
