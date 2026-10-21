# Install, update and removal — operator-managed pre-release

There are no published autonomous MSI/DMG/DEB GUI installers. Node/runtime dependencies and qualified native prerequisites must be provisioned externally; compiled output alone is not standalone. Vendor signing/notarization and store publication remain gates.

## Build

Create/review a local public metadata file from `deploy/staging/identity.example.json` (do not put secrets in it):

```sh
cp deploy/staging/identity.example.json /trusted/staging-identity.json
npm run build:release -- --environment /trusted/staging-identity.json --out dist-release
node dist-release/bin/crot-mcp.js --help
```

Run from a provisioned runtime/dependency tree. Source `native/`, notices, npm/native source SBOM and checksums accompany the payload; this does not claim all native binaries/runtimes are bundled. Platform/image packages must add their actual OS/runtime inventory.

## Per-user autostart

```sh
CROT_CONFIG=/absolute/config.json node dist/bin/crot-mcp.js service autostart install
node dist/bin/crot-mcp.js service autostart status
node dist/bin/crot-mcp.js service autostart remove
```

Generators invoke the exact Node binary plus JS entrypoint, not a non-executable JS file. Linux daemon-reloads user units and uses failure restart/tmpfiles exclusion. macOS uses LaunchAgent. Windows uses a least-privilege per-user task with honest UTF-8 XML. Automated tests validate generation/lifecycle via controlled runners; actual systemd/launchd/schtasks installation is a separate qualification, not implied by these tests. Use absolute paths. `CROT_CONFIG` is carried into service arguments.

## Signed RC/update format and CLI

```sh
# Production-mode assembly requires checks, Chromium and an externally held Ed25519 key.
CROT_E2E_CHROME=/path/to/chromium CROT_UPDATE_SIGNING_KEY=/private/update.private.pem npm run build:rc -- --environment /trusted/staging-identity.json --out artifacts/rc
node dist/bin/crot-mcp.js service stop
node dist/bin/crot-mcp.js update --package /absolute/artifacts/rc/update   --public-key /trusted/update-public.pem --install-root /private/crot-install --config /absolute/config.json
```

`update/` contains canonical `update-manifest.json`, Ed25519 `.sig` and `payload/`. The trusted key is supplied out-of-band, never trusted from the package. A repository-test RC is explicitly not release-qualified; unsigned test output cannot be installed as a signed package.

The updater verifies paths/signature/source hashes, copies and rehashes staging bytes, preserves the previous version bytes until health success, and restores current/registration on activation failure. Same-version replacement is covered. CLI requires the service stopped, registers exact Node/entrypoint via OS autostart and checks local service control readiness. Runtime dependencies must resolve from the installed location; otherwise health fails/rolls back. The CLI does not register tray/browser/native prerequisites as if GUI installers existed.

An exclusive lock prevents simultaneous updates. This is a runtime-failure transaction, not crash/power-loss recovery. On interrupted update, keep service stopped, retain `.previous-*`/staging/current and `.update-lock` for offline inspection; do not delete a lock while a writer runs. Rollback failure is explicit. User configuration/bindings/secrets/exposure remain outside payload; never choose install root overlapping private state/config. No arbitrary GUI uninstall/purge is promised. The library uninstall defaults to preserving state; operator-specific registrations must be removed deliberately.
