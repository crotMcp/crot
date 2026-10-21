# Implementation roadmap

[STATUS](STATUS.md) is the current four-axis matrix. This roadmap records remaining work/dependencies, not a second binary Done table. Original package cards remain in [work packages](docs/plan/crot-agent-work-packages.md); their full-product DoD is not silently reduced to repository delivery.

## Delivered implementation foundations

WP-17/18 contracts; WP-19 request pipeline; WP-20 service; WP-21 secrets; WP-22 tray; WP-23a/b/c platform L1; WP-24…27 browser; WP-28 identity; WP-29 relay; WP-30 tunnel; WP-31 remote profiles; WP-36 commercial contour are implemented. Qualification and delivery limitations are separate axes in STATUS. WP-29/30 and WP-27 are merged, not pending PRs.

## Remaining work and acceptance

| Scope | Dependency | Remaining acceptance |
| --- | --- | --- |
| N0–N7 normalization | baseline 80d463b, curator approval | Safety fixes, unified package/CLI, regression tests, truthful documents, history/secret review, fixed-SHA CI |
| WP-19b | existing adapters | Optional SDK consolidation without protocol regression |
| WP-25 headed/manual | implemented browser contract | Outstanding headed/manual cases; keep existing limitations visible |
| WP-32 | identity/relay/browser/platforms | ≥4 external-client compatibility runs and retained evidence |
| WP-33 | normalized RC + findings | Scoped functional review; independent/live assessment if required, not replaced by text assertions |
| WP-34 | signed update + launcher + prerequisites | Real OS autostart qualification, autonomous GUI platform packages, vendor signing; repository chain alone is partial delivery |
| WP-35 | extension archive | Actual Chrome/Edge publication approval |
| WP-37 | approved operator/entity | Legal/contact completion and publication; documentation must match final package |
| WP-38 | owner-reported live staging | Recorded end-to-end live OAuth/device/client qualification; distinguish report from rerun |
| WP-39 | commercial configuration + deployment | Production DNS/TLS, live Stripe, live restart/revoke/backup/disaster/SLO drills |
| WP-40 | release-blocking rows above | Source/artifact provenance, platform qualification, signed publication, beta acceptance and GA |
| WP-41…70 | accepted design decisions | Planned only; see extension work packages, not implied by shell availability |

## Order

Safety/path/config protection → transactional lifecycle regressions → package/CLI and provenance → documentation/UX consistency → branch semantics/history scan → clean fixed-SHA full check/Chromium/CI → operator qualification/publication.

N0–N7 may share one coherent curator-approved PR because its invariants cross modules. Future unrelated features retain separate WP/PR boundaries. No production deployment, automatic branch deletion, merge or history rewrite is authorized by this roadmap.

## Historical material

The original expanded dependency graph, package narrative and prior qualification history are preserved in [historical roadmap](docs/history/CROT_IMPLEMENTATION_ROADMAP.md). Its old “not merged/Target/Done” labels are baseline facts, not current instructions. AD-36 is accepted; external production gates are not closed by it.
