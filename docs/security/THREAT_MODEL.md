# CROT v1 threat model

**Scope:** repository implementation for WP-33. **Review date:** 2026-10-21. The authoritative controls are in `ARCHITECTURE.md`; this document is the release-review map, not a replacement.

## Assets and adversaries

Protected assets are user files and repositories, credentials, browser sessions, local applications, device keys, identity tokens, account/subscription state, approval decisions, update trust roots and remote-exposure history. Adversaries include a hostile MCP client, prompt-injected page or file, malicious repository/package/container, compromised remote network peer, stolen device, forged IdP/relay response, tampered update, and a local process running as the user. CROT does not claim to protect against a fully compromised user account, kernel, administrator/root, browser, identity provider or release-signing machine.

## Trust boundaries and controls

| Boundary | Principal threats | Enforced controls | Verification |
| --- | --- | --- | --- |
| Local MCP operations | confused deputy, path escape, secret read, command injection | centralized `PermissionEngine`, canonical paths, protected state, capability gates, audit-before-action | core permission/path/audit tests |
| Git | hook/config execution, credential leakage, unexpected mutation | structured Git adapters, protected paths, metadata locks, approval gates | Git integration and security tests |
| Docker/containers | socket authority, host mounts, privileged escape, secret environment | fixed profiles, denied dangerous flags/mounts, minimal child environment, L1 where required | container and child-environment suites |
| stdio/HTTP/service | unauthenticated local caller, framing confusion, stale service | loopback/private control channel credentials, bounded parsing, owner-only state, single instance | service/channel/transport tests |
| Approval provider and tray | forged approval, agent self-approval, UI spoofing | approval is accepted only from the authenticated private control channel; Core/tools/pages/relay cannot mint it; request facts shown to user | approval broker, tray and control-channel tests |
| Browser extension/native host | arbitrary CDP, script execution, cross-extension caller, wrong tab | release-pinned extension IDs, native-host framing, fixed CDP allowlist, no Runtime domain, explicit `tabId`, document references, per-tab FIFO | extension/native-host/browser suites |
| Remote MCP and tunnel | token replay, wrong account/device/client, relay authorization, payload observation | pinned issuer/relay, RS256/JWKS, exact `iss`/`aud`/account checks at relay and device, signed device tunnel, end-to-end request body, limits, local Core remains authoritative | identity, relay, tunnel and remote acceptance suites |
| Device binding/revocation | cloned/stolen device, orphan registration, reconnect after revoke | Ed25519 device credential, account-bound registration, tombstones, immediate tunnel close and registry removal, fresh identity on re-pair | account/relay/binding tests |
| Commercial layer | billing spoof, quota race, subscription transfer | signed webhook plus authoritative provider lookup, single-writer transaction domain, subscription ownership and event replay protection; no import into Core authorization | account-service suites |
| Untrusted content/exposure | data exfiltration after reading hostile source | source sensitivity propagation, persistent fail-closed remote exposure, explicit user-only reset, remote-safe profile | untrusted-source and remote-exposure tests |
| L1 Linux | namespace/profile escape, host endpoint pivot | qualified user-namespace/bubblewrap profile, protected mounts, bounded network policy; host-network residual disclosed | native Linux L1 tests |
| L1 macOS | sandbox profile escape, symlink/descriptor race | qualified `sandbox-exec` profile where available, canonical roots and native escape tests; unavailable means refusal | macOS L1 qualification |
| L1 Windows | token/job escape, inherited handles, ACL weakness | restricted token, Job Object, handle allowlist, ACL/ownership checks; unavailable means refusal | Windows native qualification |
| Updates/installers | package substitution, downgrade/partial install, state loss | Ed25519 manifest, SHA-256 per file, staged version, health check and rollback, preserved state root, pinned identity, SBOM/checksums | installer and supply-chain tests |
| Operations/backups | payload logging, telemetry cardinality, state loss, backup tamper | metadata-only fixed vocabulary metrics, protected endpoint, sanitized logs, hash-verified offline backup/restore, runbook drills | operational-drills suite |

## Data flows

1. A local or verified remote principal enters Core. Remote identity facts come only from the verified token; headers and relay claims are not authority.
2. Core resolves capabilities, policy, source exposure and approval. The relay cannot approve or execute tools.
3. Browser commands cross the native-messaging channel to the reviewed extension and fixed CDP surface for the selected tab.
4. Remote request bytes are streamed through the relay tunnel. The relay retains only bounded operational/account metadata; it does not log body, token or headers.
5. Release artifacts originate from a pinned public identity profile, reproducible extension archive and supply-chain manifest; update activation is transactional.

## Abuse cases and fail-closed behavior

Malformed state, unavailable L1, invalid token, wrong issuer/audience, stale JWKS beyond the configured window, missing `tabId`, disallowed CDP method, failed audit, untrusted update, missing entitlement and revoked device all refuse. A lost relay connection returns an explicit unknown outcome rather than retrying an operation. Restore is offline and refuses any hash or JSON mismatch.

## Residual risk

Accepted risks and compensating controls are enumerated in [RESIDUAL_RISKS.md](RESIDUAL_RISKS.md). Release operators must also close the live gates in `docs/RELEASE_CHECKLIST.md`.
