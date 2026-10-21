# CROT Cloud operations runbook

> Offline restore validates complete schemas and registry→commercial ownership before writes. Each rename is atomic; the pair is NOT a power-loss-proof transaction. A second replacement failure restores previous bytes via rename; rollback failure is explicit and requires offline recovery. Keep relay stopped throughout. Automated drills are tests, not evidence that production live drills were performed. Metrics private exposure requires operator routing/ACLs.

**Scope:** WP-39 repository operations for `relay.crot.network` and pinned staging. Commands assume a built release and least-privilege service account. Record every production action/change ticket; never paste secrets in logs or tickets.

## Environment profiles

| Environment | Issuer | Relay | Pairing client |
| --- | --- | --- | --- |
| staging | `https://prestigious-continent-62-staging.authkit.app` | `relay-staging.crot.network` | `client_01M5FJB95CE7KH33Y1SPE5X77Q` |
| production | pinned `https://auth.crot.network` or the approved WorkOS `https://<production-slug>.authkit.app` | `relay.crot.network` | operator-provisioned production ID |

Issuer and relay may use different domains. The issuer is an exact HTTPS origin and must byte-match authorization metadata and JWT `iss`. Populate `deploy/production/*.json` through secret/config management; placeholders block release. Never set runtime development overrides on release artifacts.

## Deploy

1. Verify signed RC manifest, `SHA256SUMS`, SBOM, vendor signatures and pinned release identity.
2. Provision DNS/TLS, WorkOS metadata/client/MFA, Stripe webhook/provider lookup, state volume and secrets (TLS key, metrics bearer token ≥32 bytes, Stripe/WorkOS server credentials). Do not bake secrets into images.
3. Render `deploy/production/compose.yml`; expose the relay only through the TLS proxy. Metrics stays loopback/private-network only.
4. Stop the previous single writer, take a verified backup, deploy one relay instance, and verify `/.crot/health`.
5. Smoke-test PRM, pairing, entitled and non-entitled registration, tunnel, MCP request, device/client revocation and portal. Confirm the canary body/token/header does not appear in logs/metrics.
6. Roll out gradually; monitor error/admission/tunnel aggregates. Roll back on checklist thresholds.

## Metadata-only monitoring

`GET /.crot/metrics` requires `Authorization: Bearer <metrics token>`; an absent/wrong token receives 404. Scrape over a private interface or authenticated proxy. Exported series are process uptime, online-device/open-stream counts, tunnel phase, admission count and fixed event totals. Labels never contain account/device/client, path, URL, method supplied by a peer, header, token, body or software string.

Recommended alerts (tune after load qualification): health unavailable for 2 minutes; restart loop; refusal/error ratio >5% for 10 minutes; ready tunnels drop >30% without planned maintenance; admission near configured ceiling >5 minutes; backup older than 24 hours; certificate <21 days; IdP JWKS refresh failing beyond half the accepted stale window. Aggregate availability is public; account/device details are not.

SLO target for the operated relay: **99.9% monthly availability** for health and admitted relay handshakes, excluding announced maintenance and upstream/global internet failures as specified in published terms. Error-budget policy: 43m49s/month; at 50% consumption freeze risky changes, at 100% stop feature rollout and prioritize reliability. Latency and success SLI definitions must use aggregate status/outcome only, never MCP payload.

The status-page template is `deploy/production/status-page.example.yml`: relay, identity, account portal and billing webhooks. Publish only region-wide aggregate states and incident times.

## Backup and restore

Registry and account JSON are a single-writer consistency pair. **Stop the relay before backup or restore.**

```text
crot-relay-ops backup --registry <registry.json> --accounts <accounts.json> --backup <new-directory>
crot-relay-ops restore --registry <registry.json> --accounts <accounts.json> --backup <directory>
```

Backup writes owner-only copies plus a SHA-256/size manifest. Encrypt the directory at rest with the operator backup system, replicate off-host, restrict access, retain per policy, and test quarterly. Restore validates manifest, hashes and JSON before atomic replacement. After restore, start one relay, verify counts/portal and revoke any devices/sessions changed after the recovery point. Never merge JSON manually.

Targets: RPO ≤24 hours (or the configured backup interval), RTO ≤4 hours. Record measured drill values.

## Required drills

Run in staging each release and production at least quarterly:

1. **Relay restart:** connect devices, restart without changing state, verify exponential reconnect, fresh tunnel proof, no duplicated request and explicit unknown outcome for interrupted work.
2. **TLS/device key rotation:** rotate certificate via proxy with overlap; verify new connections, then retire old. Re-pair device credentials rather than mutating them in place.
3. **IdP signing-key rotation:** warm JWKS, introduce a new `kid`, verify bounded refetch/new-token acceptance, retire old key after token lifetime.
4. **IdP outage:** block metadata/JWKS. Cached known keys work only within configured max-stale; unknown/new keys and requests after the bound fail closed. Restore IdP and verify refresh.
5. **Mass revocation:** select an owned staging cohort, revoke provider sessions/device tombstones, ensure tunnels close 4403, PRM becomes 404 and reconnect/re-registration fails.
6. **Disaster recovery:** stop writer, restore a recent encrypted backup to isolated infrastructure, verify hash/counts/account-device relations and smoke tests, then destroy drill data.
7. **Target load/privacy:** run the approved load profile at configured limits; verify bounded memory/backpressure/rate limits and fixed metric cardinality. Inject unique canaries into body/header/token/method and prove none appears in production logs/metrics.

Automated equivalents live in `tests/cloud-relay/operational-drills.test.ts`; they do not replace live infrastructure drills.

## Incident response

Classify, page, preserve metadata-only evidence, contain (disable remote admission/revoke tokens/devices/rollback), eradicate, restore from verified state, monitor and publish an aggregate incident update. Never enable payload logging during an incident. If identity/signing credentials may be compromised, rotate them, invalidate sessions/releases as applicable and follow `SECURITY.md` plus legal breach procedures.

## Rollback

Stop rollout; preserve state/backup; select the last verified signed package; use the WP-34 transactional updater or restore previous container/image while retaining the state volume; run health and admission smoke tests. Schema/state changes in v1 remain backward-compatible; if integrity is uncertain, keep remote mode unavailable and restore offline. Document timeline, impact, decision and follow-up.
