# Current project status

Four axes are independent: **implementation** (planned/partial/implemented), **verification** (static/unit/integration/platform-qualified), **delivery** (source/artifact/installable/published), **operations** (not deployed/staging/production-qualified). No single “Done” means all four. Baseline `80d463b`; normalization N0–N7 is curator-authorized. Test results for this change live in [NORMALIZATION](docs/NORMALIZATION.md); historical counts are not fresh evidence.

| Scope | Implementation | Verification | Delivery | Operations |
| --- | --- | --- | --- | --- |
| Core, permissions, approvals, audit; file/process/Git/Docker/network | Implemented | Unit/integration; platform-specific gates | Compiled source artifact | Local runtime |
| Service, secrets, tray | Implemented | Unit/integration, scoped smoke tests | Source/compiled; tray packaging external | Per-user runtime |
| Browser WP-24…27 | Implemented | Unit + 8 Linux Chromium suites; headed/manual limits retained | Extension archive; store publication pending | User setup required |
| Linux/macOS/Windows L1 | Implemented | Qualified CI scopes below | Native prerequisites required | Not universal OS qualification |
| Identity/relay/tunnel/remote profiles WP-28…31 | Implemented | Unit/integration/TLS emulator/E2E | Pinned build + relay template | Staging owner-reported |
| Commercial WP-36 | Implemented | Billing/account/relay tests + WP-36 E2E | Configurable cloud service | Live Stripe pending |
| WP-32 compatibility | Partial | Automated acceptance; external-client matrix incomplete | Test evidence | Live compatibility pending |
| WP-33 security review | Repository review + fixes | Functional tests and findings register; not independent audit | Review materials | Independent/live assessment external |
| WP-34 install/update/autostart | Repository update chain implemented; GUI installers partial | Lifecycle tests; real autostart OS qualification pending | Signed update artifact; Node/dependencies external; no autonomous MSI/DMG/DEB | Operator-managed |
| WP-35 extension publication | Archive/store materials implemented | Packaging tests | Store approval/publication pending | Not claimed published |
| WP-37 documentation/legal | Documentation + pre-release templates | Code/document checks | Legal publication pending | Operator fields/approval required |
| WP-38 staging | Repository templates implemented | Local container/TLS tests | Deployment template | Owner reports live staging; not freshly requalified here |
| WP-39 operations | Metrics/backup/restore/drill code implemented | Automated drills incl. fault injection | Runbook/template | Production/live drills pending |
| WP-40 RC/beta/GA | Repository RC/update format implemented | Provenance + package tests; CI evidence required | Test/RC artifact, not GUI release | Beta/GA pending |
| WP-19b SDK consolidation | Planned | Not qualified | None | None |
| WP-41…70 extensions/media/jobs/connectors/editors | Planned | Design only | None | None |

## Platform qualification, not blanket support

- Linux L1: Ubuntu 22.04/24.04 x64/arm64 CI.
- macOS L1: macOS arm64 runner, Node 20/22; evidence is scoped to observed runner versions.
- Windows L1: Windows Server 2025 x64 runner, Node 20/22.
- General CI: Node 20/22 on Linux/macOS/Windows. Chromium E2E: Linux.
- Architectural targets are broader than this matrix; untested environments remain unqualified. Live staging Oracle Linux 9 ARM64 is owner deployment information, not an additional L1 CI qualification.

## External gates

Production `relay.crot.network`, live Stripe, vendor signing/notarization, GUI installers, store publication, legal operator approval, live disaster recovery, ≥4 external-client compatibility runs, beta and GA remain open. AD-36 resolves the single-issuer RFC 9207 deviation; it is not an open requirement to add unsupported issuer metadata.

Unique branch decisions are retained in [BRANCH_RECONCILIATION](docs/BRANCH_RECONCILIATION.md). No branch deletion/history rewriting is part of normalization. Local `opencode.json` is private and must be preserved.

The former mixed status narrative remains [historical](docs/history/STATUS.md).
