# CROT user guide — current pre-release workflow

CROT is not yet a published autonomous GUI installer product. Operator-managed source/compiled installation requires Node, runtime dependencies and qualified native prerequisites; see [INSTALL](INSTALL.md). Store publication and vendor signing remain release gates.

## Local use

Configure stdio or authenticated loopback HTTP in your MCP client's own server settings. Local mode works without cloud entitlement. Install the extension/native messaging host as described in [BROWSER_EXTENSION](BROWSER_EXTENSION.md), then enable the bridge. There is no tray **Add client** button.

## Remote pairing

1. Open the configured relay `/portal`, sign in, and activate Trial/Pro (operator must configure the portal audiences and billing first).
2. In tray choose **Pair this device**, complete pinned WorkOS sign-in/MFA and return to CROT.
3. Enable the remote controls as appropriate; configure the device MCP endpoint in the client's own UI and complete OAuth there.

Pairing registration requires entitlement; Free remote registration is rejected. Pairing does not grant arbitrary capabilities. Unpair/re-pair creates a new device identity. Never paste tokens into support tickets.

## Presets and approvals

**Ask for every action** is the existing UI label: it gates effectful allowed operations in **exposed sessions**, not every read or every tool call. Authorization/path/tab rules always apply. **Autonomous browser** changes the documented remote-safe confirmation behavior, not raw CDP/runtime authority. Local and remote profile rules differ; see architecture AD-12/15/23.

Actual approval buttons are **Approve** and **Reject**. No remembered-rule UI is promised. Tray also exposes presets, remote controls, Pair/Unpair, exposure reset and client revoke/regrant. Do not approve a website's instruction to bypass these controls.

## Update and recovery

The operator uses signed `crot-mcp update`; see [INSTALL](INSTALL.md). Configuration, binding, secrets and exposure state are outside version payloads. Rollback is tested for runtime failures, not a guarantee against disk failure/power loss. GUI uninstall/purge, Restart and Add client actions are not supplied by this tray.

For service issues use `crot-mcp service status|stop`, the OS service manager and [SUPPORT](SUPPORT.md). Browser disconnection requires checking extension/native host and allowed identities. Unknown operation outcomes must be inspected before retrying. Denied isolation/approval/entitlement must not be bypassed.
