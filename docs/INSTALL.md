# Install, update and uninstall

## Release artifacts

A release build must pin public identity metadata. Set `RELEASE_IDENTITY_ENVIRONMENT` to the reviewed JSON file (or pass `--environment`) and run:

```sh
RELEASE_IDENTITY_ENVIRONMENT=deploy/staging/identity.json npm run build:release
npm run package:extension
```

`dist-release/` contains compiled CROT, `release-identity.json`, CycloneDX `sbom.cdx.json`, `SHA256SUMS` and `THIRD_PARTY_NOTICES.md`. An unpinned release build fails (N3). OS distribution signing/notarization credentials remain outside the repository.

## Per-user service autostart

```sh
crot-mcp service autostart install
crot-mcp service autostart status
crot-mcp service autostart remove
```

Linux writes `~/.config/systemd/user/crot-mcp.service` with `Restart=on-failure` and `~/.config/user-tmpfiles.d/crot-mcp.conf`, excluding `/var/tmp/crot-l1-*` from age cleanup. macOS writes `~/Library/LaunchAgents/network.crot.service.plist` with failed-exit `KeepAlive`. Windows creates the least-privilege per-user logon task `CROT MCP Service` with restart-on-failure.

`crot-mcp browser install` registers `com.crot.host` for the current user. Its `allowed_origins` is generated only from `src/cli/release-extension-ids.ts` (OD-10); no command accepts an extension ID.

## Transactional package lifecycle

`src/installer/update.ts` is the package-manager core used by OS installer front ends. An update package has `update-manifest.json`, detached `update-manifest.sig` (Ed25519), and `payload/`. Before any current-version change it validates the strict manifest, signature, every SHA-256 and every relative path. It stages a version, atomically switches `current`, registers service/tray/native-host/L1 hooks, and runs a health check. Failed startup restores the prior current version and registrations. Forged or corrupted packages are rejected before activation.

User configuration, device binding, secrets and `remote-exposure.json` live under the state root, outside version directories. Upgrade never replaces them. Normal uninstall stops/unregisters service, tray, native messaging and L1 through installer hooks and removes installed versions; user state is retained unless an explicit purge is requested.

## Verification

All six Linux/macOS/Windows × Node 20/22 CI jobs run lifecycle tests: three-OS autostart plans; fresh install and upgrade; state preservation; bad signature/hash rejection; failed-health rollback; uninstall; AuthKit issuer/relay-host independence; extension packaging; SBOM/checksum/notices generation. Real Chromium E2E remains the separate browser job; installed native L1 jobs remain separate qualification jobs.
