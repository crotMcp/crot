# CROT

Controlled local-computer and real-browser tools for MCP-compatible assistants. One per-user service supports local stdio/loopback clients and optional remote OAuth clients through CROT Cloud Relay and an outbound device tunnel.

## Current state

Core permissions/approvals/audit, filesystem/process/Git/Docker/network/browser tools, service/secrets/tray, identity/tunnel/relay and commercial admission are implemented. They are not equivalent to a publicly released product. See [STATUS](STATUS.md) for implementation, verification, delivery and operations as separate axes.

GUI MSI/DMG/DEB installers, vendor signing, store approval, production/Stripe qualification and beta/GA remain incomplete or external. Media/editors/external MCP gateway are plans, not existing modules.

## Development and local use

```sh
npm ci
npm run check
node dist/bin/crot-mcp.js --workspace /absolute/project
```

Node is required (CI: 20/22). Platform confinement prerequisites must be installed for process tools; CROT does not silently fall back to unconfined execution. Use `--help` for CLI options. Local mode does not require an account or paid plan. Loopback HTTP requires its local bearer token.

Browser use additionally needs the built MV3 extension and `node dist/bin/crot-mcp.js browser install`; see [browser extension](docs/BROWSER_EXTENSION.md). Compatible browsers/extension identities and permissions remain constrained.

## Remote use

Use an identity-pinned build. Activate Trial/Pro in the configured relay `/portal`, then choose **Pair this device** in tray. Remote entitlement does not grant local capabilities: verified device/principal identity, remote policy, approvals, audit and native confinement still apply. There is no tray **Add client** button; configure MCP in the client's own UI using the device endpoint.

Owner-reported live staging: `https://relay-staging.crot.network` (Caddy TLS, Oracle Linux 9 ARM64). This is not production or live Stripe acceptance. See [STAGING](docs/STAGING.md) and [ACCOUNTS](docs/ACCOUNTS.md).

## Release and updates

[INSTALL](docs/INSTALL.md) documents the signed update package and `crot-mcp update`. Release output requires externally provisioned runtime dependencies/native prerequisites. Test-mode RC artifacts are not qualified releases. GUI installation and external publication remain separate gates.

## Navigation

- [Architecture and decisions](ARCHITECTURE.md)
- [Current status](STATUS.md), [roadmap](CROT_IMPLEMENTATION_ROADMAP.md), [agent rules](AGENTS.md)
- [User guide](docs/USER_GUIDE.md), [service](docs/SERVICE.md), [tray](docs/TRAY.md)
- [Identity](docs/IDENTITY.md), [relay](docs/RELAY.md), [tunnel](docs/DEVICE_TUNNEL.md)
- [Native host](docs/NATIVE_HOST.md), [L1](docs/L1.md), [browser E2E](docs/BROWSER_E2E.md)
- [Operations](docs/OPERATIONS_RUNBOOK.md), [release checklist](docs/RELEASE_CHECKLIST.md)
- [Security findings](docs/security/SECURITY_REVIEW.md), [support](docs/SUPPORT.md)
- [Normalization evidence](docs/NORMALIZATION.md), [branch decisions](docs/BRANCH_RECONCILIATION.md)

Previous README is preserved as a [historical baseline](docs/history/README.md), not current instructions.

## Default locations

Configuration defaults: Linux `~/.config/crot`, macOS `~/Library/Application Support/CROT`, Windows `%APPDATA%\CROT`. State/secrets follow platform-specific service directories; do not move them into update payloads. Use absolute configuration/workspace paths and inspect service/secrets status rather than copying credentials.
