# Support policy

> **Pre-release template — not an active legal/support commitment.** Before sales/publication the owner must fill and approve: legal entity/address, jurisdiction, operator contact, privacy/security/support channels, response commitments, retention/subprocessors and effective date as applicable. Placeholder channels must not be represented as operational.

## Channels and scope

The release operator must replace `[SUPPORT URL]` and `[SECURITY EMAIL]` before publication. Use normal support for installation, compatibility, billing and service availability. Use the private vulnerability channel described in `SECURITY.md` for suspected security issues.

Never submit access/refresh tokens, passwords, device private keys, payment-card data, full MCP bodies, private files, raw browser profiles or production signing keys. Safe diagnostics are CROT version, OS/version, browser/version, UTC time, request correlation code, redacted status and the explicit local diagnostic export.

## Severity and targets

Targets start when the operator acknowledges a reproducible report; they are service objectives, not guaranteed resolution times.

| Severity | Example | Initial response target |
| --- | --- | --- |
| S1 critical | active credential exposure, remote code execution, widespread production outage | 4 hours, 24×7 |
| S2 high | remote access unavailable for many users, update/rollback failure | 1 business day |
| S3 normal | single-user defect with workaround, compatibility issue | 3 business days |
| S4 request | documentation, feature or billing question | 5 business days |

Support covers the published OS/browser/client matrix and current plus supported prior protocol versions. Modified builds, disabled security controls, arbitrary Chromium forks and unsupported OS configurations receive best-effort guidance only.

## Lifecycle

Security fixes may require immediate update. Protocol-major tunnel compatibility is maintained for at least 12 months as documented by AD-34; the status page and release notes announce end-of-support dates. Account deletion, export, refund and privacy requests follow the published legal documents and operator contact.
