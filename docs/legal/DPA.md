# Data Processing Addendum (DPA) — template

> Complete all schedules and obtain counsel before execution. This template does not identify a controller, processor, governing law, subprocessor region or transfer mechanism.

This DPA is between **Customer** `[NAME/ADDRESS]` and **Provider** `[NAME/ADDRESS]`, effective `[DATE]`, and supplements `[AGREEMENT]`.

## 1. Roles and instructions

The parties identify their roles per processing activity in Schedule 1. Where Provider is a processor/service provider, it processes personal data only on documented Customer instructions necessary to provide CROT Cloud Relay/account/support services, unless law requires otherwise. Customer is responsible for lawful instructions, notices and authority.

## 2. Confidentiality and security

Provider ensures authorized personnel are bound to confidentiality and maintains measures in Schedule 2, including access control, TLS, short-lived signed tokens, per-device credentials, metadata-only relay logging, signed updates, backup integrity, incident response and deletion controls. Measures may evolve without materially reducing protection.

## 3. Subprocessors

Approved subprocessors and locations are listed in Schedule 3. Provider gives `[NOTICE PERIOD]` notice of a new subprocessor and a reasonable objection process. Provider imposes materially equivalent data-protection duties and remains responsible as required by law.

## 4. Assistance

Taking account of the processing, Provider reasonably assists with data-subject requests, security, breach notice, DPIAs and regulator consultation. Customer remains responsible for responding unless law requires otherwise. Fees for extraordinary assistance: `[TERMS]`.

## 5. Incidents

Provider notifies Customer without undue delay after confirming a personal-data breach affecting Customer data, to `[CONTACT]`, and provides available nature, scope, likely consequences and mitigation. Notice is not an admission of fault.

## 6. Return, deletion, audit

At termination, Provider returns/deletes Customer personal data within `[PERIOD]`, except legally required retention and protected backups deleted on `[CYCLE]`. Provider supplies current security documentation and `[AUDIT/QUESTIONNAIRE]`; on-site audits are limited by `[TERMS]`.

## 7. Transfers and conflicts

Transfer mechanism: `[ADEQUACY/SCC/UK ADDENDUM/OTHER]`; modules, exporter/importer details and supplementary measures appear in Schedule 4. Applicable privacy law, liability, precedence and governing law: `[COUNSEL TEXT]`.

## Schedule 1 — Processing details

| Item | Complete before signing |
| --- | --- |
| Subject/purpose | account authentication, remote routing, subscription/device management, support |
| Duration | agreement term plus documented retention/deletion |
| Data subjects | Customer-authorized users/admins/support contacts |
| Data | WorkOS subject/account ID; device/client/session metadata; plan/subscription/event IDs; fixed operational metadata; support submissions |
| Special categories | not intended; Customer must not submit them in support or MCP content |
| Frequency | continuous while service is enabled |
| Instructions/contact | `[DETAIL]` |

Relay request/response content is transiently transmitted and designed not to be logged or persistently stored by the relay.

## Schedule 2 — Technical and organizational measures

Identity pinning and signed-token verification; MFA policy; least privilege; per-device Ed25519 tunnel credentials; centralized authorization on the device; encrypted transit; metadata-only logs/metrics; owner-restricted state; cryptographically verified releases; vulnerability handling; tested backup/restore; revocation and incident runbooks; retention/access reviews; personnel controls `[COMPLETE OPERATOR CONTROLS]`.

## Schedule 3 — Subprocessors

`[WORKOS]`, `[STRIPE]`, `[HOSTING/DNS/STATUS]`, `[SUPPORT]`: add legal entity, service, processing location and transfer safeguard.

## Schedule 4 — Transfers

`[EXECUTED SCC/UK ADDENDUM OR OTHER MECHANISM, MODULES, ANNEXES, SUPPLEMENTARY MEASURES]`.
