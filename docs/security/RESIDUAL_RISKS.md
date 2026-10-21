# Accepted v1 residual risks

This register consolidates decisions AD-13 through AD-36. “Accepted” means bounded for the documented v1 design, not eliminated. A changed assumption requires architecture review.

| Decision | Residual risk and bound |
| --- | --- |
| AD-13 | MCP client authentication establishes a principal but does not make client output trustworthy; PermissionEngine and approvals remain mandatory. |
| AD-14 | Local HTTP/stdio transport inherits the security of the user session and loopback boundary; a compromised same-user process remains outside CROT’s protection claim. |
| AD-15 | Remote access adds relay/IdP/tunnel dependencies; the device repeats authorization and treats uncertain execution outcomes explicitly. |
| AD-16 | Browser `debugger`, downloads, tab groups and broad host access are powerful; only the fixed method surface, explicit tab, store disclosures and user policy constrain them. |
| AD-17 | A persistent per-user service increases local attack surface; control credentials, owner-only state and uninstall hooks bound it. |
| AD-18 | Tray approval depends on trusted desktop UI and the user correctly reading displayed facts; a compromised desktop session can deceive the user. |
| AD-19 | Remote source exposure is intentionally sticky and may cause later refusals; reset is a deliberate local user action, and unreadable state fails closed. |
| AD-20 | Linux L1 with network `on` can reach host-local services that independently trust the user; operators must secure Docker/SSH/debug/notebook endpoints. |
| AD-21 | WorkOS and its signing keys are trusted identity dependencies; token revocation is bounded by short token age and the cached-JWKS window. |
| AD-22 | The relay is single-region/single-writer in v1; disconnects can leave an operation outcome unknown and clients must not retry blindly. |
| AD-23 | Remote profile safety is capability-based, not a semantic guarantee against every harmful allowed action; approvals and L1 still apply. |
| AD-24 | Remote browser state can change between observation and action; document references and FIFO detect/bound but cannot freeze a page. |
| AD-25 | File and download handling relies on native/browser boundaries and size limits; hostile file content remains untrusted. |
| AD-26 | Browser compatibility is limited to the qualified Chromium matrix; vendor changes can require an extension update. |
| AD-27 | L1 availability differs by host configuration; CROT refuses required isolation rather than silently degrading. |
| AD-28 | Service recovery and cleanup are best effort after abrupt host failure; startup reconciliation is required. |
| AD-29 | Remote acceptance covers protocol behavior, not every third-party client implementation or network middlebox. |
| AD-30 | Windows L1 relies on restricted-token, Job Object and ACL semantics in the qualified Windows matrix, not arbitrary compatibility layers. |
| AD-31 | macOS L1 relies on the qualified sandbox facility and OS versions; unavailable/changed facilities block isolated execution. |
| AD-32 | Browser support is Chromium ≥120 in the qualified products; Firefox/Safari and altered enterprise builds are not claimed. |
| AD-33 | Packaging and release identity pinning do not substitute for vendor code signing/notarization or protection of operator signing keys. |
| AD-34 | Account/billing metadata and WorkOS/Stripe are cloud trust dependencies; local/offline authorization remains deliberately independent. Provider session revocation is best effort. |
| AD-35 | Native-host origins trust reviewed release extension IDs; store reassignment/key loss needs a reviewed release and old IDs must be retired. |
| AD-36 | WorkOS does not advertise RFC 9207 response `iss`; v1 accepts this only because one byte-pinned issuer is configured and JWT `iss`/`aud` are verified. Multi-AS or unpinned discovery is forbidden. |

Operational gates that are not architecture risks—legal publication, production DNS/TLS, secret provisioning, vendor signing, store review, live recovery exercise and beta acceptance—remain in `docs/RELEASE_CHECKLIST.md`.
