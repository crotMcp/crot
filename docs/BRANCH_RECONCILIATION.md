# Branch reconciliation — N7 decision register

Baseline: audited tree 27cb63c, merged main 80d463b. No branch is deleted and no historical commit is rewritten. Counts below are relative to that baseline, not claims that cached remote branches still exist.

## Local branches

| Branch | Unique commits vs baseline | Decision |
| --- | --- | --- |
| feat/wp33-security-wp39-rc | 0 | Preserve; accepted tree is in main via PR #39 |
| feat/wp34-installers-supply-chain | 0 | Preserve; ancestor fb88e56 |
| feat/wp36-commercial | 0 | Preserve; accepted commercial baseline db3fab5 |
| main | 0 | Previously stale 20d0ea9; synchronize only by fast-forward, no destructive reset |
| feat/wp36-accounts-entitlements | 3 | Preserve parallel alternative; do not cherry-pick implementation |

## Alternative WP-36 semantic review

- `15ee4dd`: commercial AD-34/OD-11/12/13 proposal. Accepted `db3fab5` contains those decisions; alternative provider API assumptions are not authoritative.
- `18baf00`: parallel account/billing/device implementation. Compared with accepted db3fab5: 37 changed files, not patch-identical. Current code separates portal/version handling, uses authoritative billing resolution and observed provider session revocation. Do not replace these with older authorized-application endpoint assumptions.
- `775407a`: completion/acceptance prose for that alternative, not evidence the branch was merged.

Test intent reconciliation:

| Alternative intent | Current evidence / action |
| --- | --- |
| Local stdio + loopback filesystem use while cloud Free/offline | Ported, adapted to current AccountService API as `tests/account-service/local-offline.test.ts`; real MCP transports, cloud proxy points at unavailable local port; does not claim firewall-level network isolation |
| Webhook raw-body HMAC, freshness, tampering | Existing `tests/account-service/service.test.ts` billing cases; current provider-authoritative resolution is stronger than trusting event payload; added explicit future/missing signature regressions |
| Server-owned checkout price, Stripe failure | Existing account HTTP/service/portal tests; do not port old provider abstraction |
| Device commercial status cache, proof purpose, provider ownership and cloud failure | Existing `tests/account-service/relay.test.ts` device-side status/provider cases; extended with refresh throttling, stale-cache expiry, cross-owner refusal, metadata-only proof request canaries; different service/harness API |
| WorkOS authorized-app revoke endpoint | Not ported: obsolete provider assumption; current session revocation and failure tests retained |

## Cached refs with unique commits

| Ref / commits | Semantic decision and current coverage |
| --- | --- |
| origin/diag/l1-renderer-report: 3122c14 | Repetition/timing diagnostics, explicitly not for merge; preserve. No production behavior to transfer |
| origin/diag/windows-ci: 58cd104, 398cb02 | Other-user/timing diagnostics, not a replacement for current Windows qualification. Preserve, do not weaken current gates |
| origin/docs/ad-21-identity-device-resource: 01c99eb, 3e950d1 | Earlier AD-21 + status synchronization. Exact patches differ, accepted AD-21 and identity/tunnel tests now cover the decisions; stale status prose not transferred |
| origin/probe/l1-mechanism: 8a3c3e9, 8e6d4c0, 73c099c, f38c500, ec0f682 | AppArmor/parser/NNP investigation workflow. Research retained; production L1 and installed qualification are authoritative, no automatic workflow transplant |
| origin/wp-24-browser-v1: 0625a94 | Manual-run-1 fixes: input activation, async state, frame scrolling, background behavior. Current `extension/test/control.test.ts`, `input.test.ts`, `frames.test.ts`, and `browser-v1.e2e.test.ts` retain these intents; WP-25 background screenshot and browser-layout timeout tests extend them. No missing distinct regression intent identified after test/code comparison; preserve branch anyway |
| origin/wp-24-browser-v1-fixed: 5b2969e | Only old WP-31 merged-status synchronization; current STATUS supersedes it |

## Unreachable objects

Read-only fsck found 7d20e47, 35f7579, 4bbe9a3. Trees equal respectively 6203202, 27cb63c, fb88e56. No unique tree changes in those objects. Preserve; no GC/prune is part of this work. This is not a claim about other clones or objects never committed.
