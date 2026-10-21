# Repository map and file responsibilities

This is an inventory, not a deletion list. Source without a static incoming import may be a binary entrypoint, subprocess probe, barrel, test fixture or historical qualification. Dynamic entrypoints must be examined before removal.

| Area | Responsibility |
| --- | --- |
| src/bin, src/cli | Product/operator entrypoints, parsing and lifecycle |
| src/service, src/tray | Per-user runtime/control/secrets and separate owner UI |
| src/core | ExecutionGuard, permission/approval/audit and capability services |
| src/adapters | MCP/HTTP translation; no second policy |
| src/identity, src/tunnel, src/cloud-relay | Verified identity, transport and relay routing |
| src/account-service | Cloud commercial admission, portal and billing |
| src/native-host | Platform L1, leases, OS boundary and Docker mediation |
| src/installer | Autostart and signed update transaction; called by CLI |
| extension | Fixed MV3 browser backend and tests |
| native | Vendored/qualification/native source; not all files are product runtime |
| tests, tests-e2e | Unit/integration/platform and Linux Chromium acceptance |
| deploy | Templates; local configuration/secrets ignored |
| docs/design, acceptance, evidence, history | Baseline-pinned design/history/evidence; root STATUS owns current state |

## Scripts

| Script | Purpose (source header / name) |
| --- | --- |
| `scripts/browser-files-native-qualification.mjs` | Native runner evidence; missing/skipped cases are a failure, not qualification. |
| `scripts/build-rc.mjs` | WP-40 repository RC pipeline. Production mode requires tests, Chromium and an Ed25519 signing key. |
| `scripts/build-release.mjs` | Pin public identity metadata into a separate release artifact, never a runtime override. |
| `scripts/build-windows-local-shim.ps1` | Operator/test helper; inspect source before invocation |
| `scripts/ci-other-user.mjs` | * CI only (GitHub Actions): create a second OS account for the WP-20 endpoint |
| `scripts/generate-supply-chain.mjs` | Deterministic CycloneDX SBOM and SHA-256 manifest for a release directory (WP-34). |
| `scripts/l1-components-win.ps1` | Operator/test helper; inspect source before invocation |
| `scripts/l1-host-exec.py` | Operator/test helper; inspect source before invocation |
| `scripts/l1-install-win.ps1` | Operator/test helper; inspect source before invocation |
| `scripts/l1-install.sh` | Operator/test helper; inspect source before invocation |
| `scripts/output-path.mjs` | Only disposable children of artifacts/dist-release or a named OS temp directory. |
| `scripts/package-extension.mjs` | Reproducible, dependency-free Chrome/Edge MV3 store archive (WP-35). |
| `scripts/spikes/wp26-ownership.mjs` | global Buffer, WebSocket, console, process, setTimeout, clearTimeout |
| `scripts/staging.mjs` | Fixed-scope staging lifecycle. No shell expansion and no arbitrary volume deletion. |

## Non-static entrypoints / research

- `src/cloud-relay/index.ts`: public barrel, not evidence of abandoned implementation.
- Windows L1 probe/helper entrypoints (`command-token`, `control-profile-probe`, `desktop-helper`, `device-map`, `npfs-root`, `probe-integrity`, `workspace-pipe-probe`, `workspace-probe`, `workspace-view`) participate in qualification/research/dynamic child processes. Production selection is AD-30; do not activate old candidate backends based on file presence.
- `native/windows-workspace-view` includes historical candidate/qualification work. Preserve its README, tests and evidence; no blanket unused-file deletion.
- `scripts/spikes/` contains historical browser research, not a hidden supported API.
- Durable schemas are versioned in account/registry/binding modules. There is no dedicated migration directory; incompatible version handling must be reviewed when schemas change.
- All three platform dependencies and release outputs require explicit qualification; vendored source is not proof of a built native product artifact.
