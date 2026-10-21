# WP-33 authorized repository security review

**Review date:** 2026-10-21  
**Scope:** Core, service/tray, browser/native host, L1 implementations, identity, relay/tunnel, commercial service, installers/updates and production templates.  
**Method:** code review against the 12 release-blocking invariants, abuse-case analysis, targeted automated regression tests and existing cross-platform CI.

This is the curator-authorized automated repository review. It is **not an independent third-party assessment**, penetration test of a live deployment, legal review, or compromise-resistance claim for the host OS/IdP/signing infrastructure.

## Result

- Open critical: 0
- Open high: 0
- Open medium: 0
- Accepted/documented residual risks: see `RESIDUAL_RISKS.md`
- Live/operator gates: production secrets, TLS/DNS, vendor signing/notarization, store publication, legal publication, external penetration testing if required by the operator, and beta acceptance.

## Review matrix

| Invariant | Evidence | Result |
| --- | --- | --- |
| Secret protection | child environment allowlist, protected paths/state, no cloud secret on devices | pass |
| L1 all supported OSes | Linux/macOS/Windows implementations and native qualification tests | pass for qualified matrix |
| Authentic approvals | private authenticated control channel; relay/pages/tools cannot approve | pass |
| Exposure persistence | durable digested state, malformed/unreadable state fails closed | pass |
| Token facts | pinned issuer; RS256/JWKS; exact issuer, audience, account, device and time checks | pass |
| Relay privacy/authority | streaming router only; sanitized metadata logs/metrics | pass |
| CDP surface | fixed allowlist, no Runtime/eval, release-pinned extension origins | pass |
| Browser ordering | explicit remote `tabId`, per-connection/tab FIFO and document references | pass |
| Remote profile | explicit minimum defaults and user presets, sandbox-forbidden grants excluded | pass |
| Update chain | Ed25519/SHA-256, pinned identity, staging, health rollback, SBOM/checksums | pass |
| Critical/high findings | none open in this repository review | pass |
| Residual disclosure | AD-13 through AD-36 and operational gates mapped | pass |

## Findings closed during WP-33

1. **Operational observability boundary:** added an authenticated, fixed-cardinality Prometheus export; it consumes sanitized records and emits no identifiers, headers, tokens or payload fields.
2. **Disaster recovery integrity:** added hash-manifested offline backup/restore for both registry and commercial state; corrupted backups are rejected.
3. **Release assembly gap:** added a single RC pipeline that requires pinned identity, complete checks/E2E and an Ed25519 key in production mode, and inventories desktop, extension, SBOM and checksum artifacts.
4. **RFC 9207 condition:** AD-36 explicitly accepts the WorkOS v1 deviation only for the single pinned authorization server; optional response `iss` remains byte-exact checked.

No severity was reduced by omitting an affected component. Medium-or-higher future findings reopen G6 and block release until fixed or explicitly accepted by a new AD.
