# CROT privacy policy — publication template

> **Pre-release template — not an active legal/support commitment.** Before sales/publication the owner must fill and approve: legal entity/address, jurisdiction, operator contact, privacy/security/support channels, response commitments, retention/subprocessors and effective date as applicable. Placeholder channels must not be represented as operational.

**Effective date:** `[DATE]`  
**Controller/operator:** `[LEGAL NAME, ADDRESS, JURISDICTION]`  
**Privacy contact:** `[PRIVACY EMAIL/URL]`

> Publication gate: the operator must replace every bracketed field, select lawful bases/retention periods for its jurisdiction, list subprocessors and obtain legal review. Repository maintainers do not invent those facts.

## Scope

This policy covers the optional CROT account portal and Cloud Relay operated by the controller. CROT local mode works without an account and does not send device telemetry by default. Websites, MCP clients, WorkOS, Stripe, browser stores and support systems have their own notices.

## Data processed

- **Identity/account metadata:** WorkOS subject/account ID, authentication/session identifiers needed for verified management, plan/status and trial state.
- **Device/client metadata:** random device ID, registration/revocation timestamps, online state, bounded MCP client ID/last-seen and verified session IDs used for user-requested revocation.
- **Billing metadata:** Stripe customer/subscription/event IDs, selected plan, subscription status and expiry. CROT does not receive complete payment-card details.
- **Operational metadata:** timestamp, fixed event/code, HTTP status, counts, version admission and aggregate tunnel/stream/request metrics. No device telemetry is collected by default.
- **Support data:** information the user deliberately submits. Users are instructed not to submit secrets or content.

The relay is designed not to log or persist MCP request/response bodies, authorization headers/tokens, private files, browser content or arbitrary URLs. Metrics contain aggregate fixed-cardinality metadata and no account/device/client identifiers. Local audit and exposure state stay on the device unless the user explicitly exports diagnostics.

## Purposes and lawful basis

The operator must complete the applicable basis: provide the requested relay/account/subscription service `[contract]`; secure, prevent abuse and operate it `[legitimate interests/legal obligation]`; process payments `[contract/legal obligation]`; respond to support/privacy requests `[contract/legal obligation]`; and use optional communications only with `[consent/legitimate interests]`. CROT does not sell personal data or use MCP content for advertising/training.

## Extension-store disclosures

The CROT extension uses `debugger`, `downloads`, `tabGroups`, `nativeMessaging`, `tabs`, `scripting`, `alarms` and `<all_urls>` solely to execute user-authorized browser MCP operations through the local CROT service. It has no content scripts, externally-connectable API or web-accessible resources, and incognito is disabled. Browser/tab/download data is processed on the device and is not sent to the CROT relay as extension telemetry. Store disclosure text is in `docs/store/`.

## Sharing and processors

Expected categories are WorkOS (identity), Stripe (payments), infrastructure/DNS/status providers, Chrome Web Store/Microsoft Edge Add-ons, and support/error-response providers selected by the operator. Complete before publication:

| Processor | Purpose | Region/transfer safeguard | Link |
| --- | --- | --- | --- |
| `[WORKOS ENTITY]` | authentication | `[DETAIL]` | `[URL]` |
| `[STRIPE ENTITY]` | billing | `[DETAIL]` | `[URL]` |
| `[HOST/STATUS/SUPPORT]` | operations | `[DETAIL]` | `[URL]` |

Data may be disclosed when legally required or during a transaction with appropriate safeguards. It is not shared with MCP clients beyond the user-requested operation.

## Retention and security

Complete exact periods before publication: account/subscription records `[PERIOD]`; revoked-device tombstones `[PERIOD]`; operational logs `[PERIOD]`; backups `[PERIOD]`; support records `[PERIOD]`. CROT applies TLS, short-lived signed tokens, pinned identity, per-device keys, owner-only state, metadata-only logging, access control, signed updates and tested backup integrity. No system is risk-free.

## Rights, deletion and transfers

Depending on location, users may request access, correction, deletion, restriction, portability, objection or withdrawal of consent and complain to a regulator. Contact `[PRIVACY CONTACT]`. Some billing/security records may be retained as legally required. The operator must document international-transfer mechanisms and child/minimum-age rules before publication.

## Changes

Material changes will be announced at `[POLICY URL/NOTICE METHOD]` with a new effective date. Prior versions remain available at `[ARCHIVE URL]`.
