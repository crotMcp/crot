# Desktop L1 repair and release downloads

Follow-up to `7d3535a` on `feat/flagship-control-center`. This document distinguishes implementation from platform/release qualification; passing browser tests is not proof of a successful privileged install.

## Owner-initiated L1 repair

The Control Center calls the fixed, no-argument `window.crot.repairL1()` preload API. Electron Main checks the sending window, rejects arguments and concurrent repair requests, and starts only the shipped platform installer. Neither a browser client nor CrotService can request an elevated shell through this API.

- Linux: fixed `pkexec /bin/bash …/l1-install.sh install`, or a waiting terminal running fixed `sudo` arguments. Missing prerequisites are installed by the explicitly authorized installer on supported apt/dnf systems. A missing authorization agent or terminal is a visible failure, not a success.
- Windows: fixed host-preparation script, UAC, wait and exit-code propagation. Missing per-user components are delivered separately. Existing component directories are not overwritten underneath live leases; broken existing delivery can still require the documented maintenance procedure.
- macOS: no elevation. Seatbelt executable availability is checked; the service's real Seatbelt/private-storage probe remains authoritative.

After the installer finishes or fails, Main requests `confinement.refresh`. The service only re-runs its existing nonprivileged confinement probe and refreshes overview. It does **not** run the installer. The UI can report Available only from that fresh probe, never from the installer exit code. This preserves the AD-20 separation between explicit owner setup and service operation.

## Public download routes

Set the optional `artifactDirectory` in the relay JSON configuration to a directory containing operator-published release artifacts. The existing configured HTTPS origin, not the request Host header, determines bootstrap URLs.

| Route | Preferred artifacts | If absent |
| --- | --- | --- |
| `/download/linux` | `crot-linux.deb`, then `crot-linux.tar.gz` | Bash bootstrap attachment |
| `/download/macos` | `crot-macos.pkg`, then `crot-macos.tar.gz` | Bash bootstrap attachment |
| `/download/windows` | `crot-windows.exe`, then `crot-windows.zip` | PowerShell bootstrap attachment |
| `/download/extension` | `crot-extension.zip` | Explicit HTTP 503 |

GET and HEAD return attachment metadata, `X-Checksum-SHA256`, Digest and nosniff. Fixed allowlists prevent request-derived filesystem paths. Files are streamed from a single opened descriptor, with a 512 MiB limit and a four-request concurrency cap. Publish by **atomic rename**, never modify a published file in place. The artifact directory must be trusted operator-owned storage.

Bootstrap scripts require Node.js 20+ and npm, download `/download/bundle/linux`, `/download/bundle/macos` or `/download/bundle/windows`, verify the corresponding `.sha256` before extraction, install dependencies, prepare L1, register the native host, install service autostart and request the Control Center. Elevation requires normal OS user authorization. The scripts do not bypass OS policy or install Node.js silently.

**A bootstrap is not a bundled release.** Missing bundles return HTTP 503 and installation stops. Downloading a script does not prove an end-to-end install can complete before the operator publishes its bundle. An operator must supply a platform-qualified package for each supported OS.

## Build and publication

From a complete Git working tree with dependencies installed:

1. Run the existing `build:release` command with the approved public environment configuration. This pins release identity; do not invent production identity values.
2. Run `npm run package:desktop` on each native OS. It requires a tracked source tree and `dist-release/release-identity.json`, includes the pinned build and L1 sources/scripts, and builds the Windows x64 local shim on Windows.
3. Run the existing extension packaging command separately.
4. Qualify the resulting packages, sign/notarize where required, and atomically publish the fixed filenames into `artifactDirectory`.
5. Deploy the updated relay and verify live download, onboarding, OAuth and billing routes.

The new desktop command produces tar.gz/zip bundles; it does not claim to produce signed MSI/EXE/PKG/DEB installers. Autostart uses the existing product CLI and still needs real OS acceptance.

## Verification for this follow-up

- Real dependencies installed using `npm ci`; production build, full TypeScript project check and extension build passed.
- 39 targeted integration/unit tests passed, including a real CrotService control-channel refresh, platform installer-command boundaries, real HTTP attachment downloads and trial tests.
- 193 extension tests passed.
- The full available `npm test` run was also attempted: 342 passed, 3 skipped, 2 failed in release acceptance because `deploy/staging/identity.example.json` and `deploy/staging/relay.example.json` are absent from this reconstructed workspace. This is not a passing full unit suite.
- `npm run test:e2e:browser` passed: 9 files, 57 passed, 3 skipped. This includes the real extension/native-messaging/Chromium path, MCP versions, portal flow and the UI suite. UI installer interaction is explicitly fixture-based; no privileged installer was executed by that test.
- Screenshots are generated in `artifacts/flagship-ui/` by the existing visual suite.

### Remaining acceptance gates

- This workspace is an MCP reconstruction, not a complete Git checkout: no `.git`, some linked documentation and the complete unit-test tree are still missing. Production imports and browser-E2E fixtures were restored, but a real `git fetch`/checkout was not possible through the available GitHub MCP file APIs. `npm run check` was run and stopped in `check:docs` on missing linked files. No validation was disabled or weakened.
- Electron was downloaded, but this container lacks `libgtk-3.so.0` and a display server. A real `npm start` → OS desktop window and privileged Linux/macOS/Windows installer acceptance have not been demonstrated here.
- Native release packaging/publication, signing, actual operator deployment, live OAuth/billing configuration and real autostart acceptance are not completed by this change.
- GitHub Checks/status access returned 403 through the current connection. A previous head's green CI is not evidence of 11/11 on this follow-up. PR remains Draft until the new head's CI and remaining acceptance gates are independently verified.
