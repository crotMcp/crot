# CROT v1 security and architecture whitepaper

## Executive summary

CROT is a local-first MCP bridge. One Core and PermissionEngine authorize operations regardless of whether a request arrives through local stdio/loopback or the optional Cloud Relay. The relay authenticates and routes but cannot authorize or execute a tool. Local mode is accountless and remains available when cloud services are unavailable.

The security design combines explicit capabilities, canonical resource checks, auditable approval gates, OS-specific L1 confinement, a fixed browser/CDP surface, device-bound remote identity and signed transactional updates. It narrows authority; it does not claim to make untrusted instructions safe or defend a host already controlled by administrator/root.

## Components and trust

- **Core/PermissionEngine:** sole authorization point for tool actions.
- **Per-user service and tray:** owns protected state and the authenticated approval/control channel.
- **Adapters:** Git, filesystem, process, container and browser implementations; they cannot bypass Core.
- **Browser native host + MV3 extension:** release-ID-bound channel and fixed CDP allowlist, explicit tab/document targeting and FIFO execution.
- **L1:** qualified Linux, macOS and Windows confinement for operations that require it; unavailable isolation refuses.
- **WorkOS AuthKit:** pinned authorization server. CROT verifies RS256 signatures, byte-exact issuer, canonical device audience, account/client/time facts and device binding.
- **Cloud Relay:** TLS entry point and signed device tunnel router. It repeats admission checks and commercial entitlement, but the device repeats identity/policy and is authoritative.
- **Account service and billing adapter:** cloud-only metadata, device limits, tombstones and signed/authoritatively-resolved subscription events. It is not imported by local authorization.
- **Release pipeline:** pinned public identity, extension archive, CycloneDX SBOM, checksums, Ed25519 update/RC manifests, health rollback.

## Data minimization

The relay streams MCP content without logging or persistent storage of request/response bodies. Logs and Prometheus metrics use an allowlisted, fixed-cardinality operational vocabulary—status classes, bounded event names, aggregate tunnel/stream/request counts. They exclude bodies, headers, tokens, URLs, account/device/client identifiers and software strings. Account storage contains plan/status, device identifiers, bounded client/session metadata needed for management, billing event IDs and revocation tombstones. CROT has no device telemetry by default; diagnostic export is explicit and local.

## Security flows

### Local request

The transport creates a local principal. Core validates the operation, canonical target, capabilities, protected-path rules, source exposure, L1 availability and approval. Audit must be durable before a gated action. The adapter receives only the checked operation.

### Remote request

The relay validates the pinned issuer’s signed access token and canonical device audience, entitlement, registration and tunnel state, then streams bytes over the device-authenticated tunnel. The device independently validates token/account/device/client facts and applies the same Core policy. A dropped tunnel never triggers an automatic retry; the outcome can be `unknown`.

### Browser action

Core requires the browser capability and, remotely, an explicit `tabId`. Commands are serialized by connection/tab and use document references to detect navigation. The native host accepts only reviewed extension IDs. The MV3 extension exposes only documented CDP methods; `Runtime` and arbitrary JavaScript execution are absent.

### Update

The updater verifies an Ed25519 signature over the canonical manifest and SHA-256 for every payload before activation. It stages a new immutable version, keeps the separate private state root, re-registers service/tray/native host, and rolls back if health verification fails. Vendor signing/notarization and operator key custody remain release gates.

## L1 isolation profiles

- **Linux:** qualified user-namespace/bubblewrap-style profile, protected filesystem projection and policy-driven network mode. With network `on`, independently trusted host-local services remain a disclosed risk.
- **macOS:** qualified sandbox profile, canonical filesystem roots and native escape tests. Unsupported/disabled sandbox configurations are unavailable, not silently weaker.
- **Windows:** restricted token, Job Object, controlled handle inheritance and owner/ACL checks. Only the qualified Windows matrix is claimed.

L1 is one layer. The capability engine, protected paths, child-environment allowlist, approval and audit remain active inside every profile.

## Threat boundaries and assurance

The complete boundary matrix and abuse cases are in [security/THREAT_MODEL.md](security/THREAT_MODEL.md). The authorized repository review found no open critical/high findings in scope; its limitations are explicit in [security/SECURITY_REVIEW.md](security/SECURITY_REVIEW.md). CI covers unit/integration tests on Linux, macOS and Windows plus real Chromium E2E on Linux. Live DNS/TLS, IdP/merchant qualification, vendor signing, store review and beta remain operator evidence.

## Accepted residual risks: AD-13…AD-36

All accepted risks are disclosed individually in [security/RESIDUAL_RISKS.md](security/RESIDUAL_RISKS.md). In summary:

- AD-13–AD-19 accept bounded local-client, transport, remote, browser, service/tray and sticky-exposure risks while retaining central authorization.
- AD-20–AD-24 accept host-network endpoints, managed-identity dependency, uncertain tunnel outcomes, capability-profile limits and mutable browser documents.
- AD-25–AD-32 bound hostile files, browser/OS compatibility, confinement availability, recovery and remote-client qualification to the published matrix.
- AD-33–AD-35 separate cryptographic repository packaging from vendor/operator signing, cloud commercial trust and reviewed extension IDs.
- AD-36 accepts absence of an advertised RFC 9207 authorization-response `iss` only in the single byte-pinned WorkOS environment; JWT issuer/audience checks and optional response-`iss` comparison remain mandatory.

No AD authorizes payload logging, relay-side tool authorization, arbitrary issuer discovery, agent-supplied extension IDs, silent L1 downgrade, or unsigned updates.
