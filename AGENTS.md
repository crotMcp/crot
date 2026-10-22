# Agent rules — CROT

Read [STATUS](STATUS.md), [ARCHITECTURE](ARCHITECTURE.md), [roadmap](CROT_IMPLEMENTATION_ROADMAP.md), then relevant source/tests and package cards. Current documents use four independent axes: implementation, verification, delivery, operations. Never infer publication/live readiness from repository implementation.

- Every operation follows existing ExecutionGuard/PermissionEngine; no second policy or client-specific bypass.
- Architectural boundary changes require an AD. Existing AD records are chronological; superseded investigations are not current backends.
- Prefer one WP per PR. A curator-approved cross-cutting normalization (N0–N7) is an explicit exception; unrelated new features stay separate.
- Preserve history/evidence; do not delete files/branches based on import-graph guesses. See branch reconciliation register.
- Preserve local `opencode.json` and `.opencode/`; never commit secrets/operator config. No destructive Git synchronization without permission.
- Run `npm run check` and Linux Chromium E2E; record exact SHA, scope, skips and failure evidence. Do not claim CI passed before observing it.
- Release artifacts need safe output paths, signed canonical update manifest, staged hash checks, provenance and correct prerequisite notices. Repository-test artifacts are not qualified releases.
- Production, Stripe, GUI installers/vendor signing, legal/store publication and live drills remain external gates. Owner reports staging deployed; do not turn that into unobserved live qualification.
- Never merge without explicit permission.
