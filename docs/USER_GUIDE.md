# CROT user guide

CROT lets an MCP-compatible assistant use approved local and browser tools. Local mode works offline without an account. Remote mode is optional and requires pairing plus an eligible plan.

## Install without a terminal

1. Download the CROT installer for your OS only from the operator’s official release page.
2. Verify the publisher shown by Windows/macOS/Linux packaging. Do not bypass an unknown-publisher warning.
3. Run the installer. It installs the per-user service, tray application, L1 components and the native-messaging host.
4. Install the CROT browser extension from the official Chrome Web Store or Microsoft Edge Add-ons listing linked by the release page.
5. Open CROT from the tray. **Service: running** and **Browser: connected** should appear.

The repository also exposes administrative CLI commands for development and managed deployment; ordinary users should not need them.

## Pair this device

1. In the tray, choose **Pair this device**.
2. Your browser opens the pinned WorkOS sign-in page. Complete sign-in and MFA.
3. Confirm the device name and return to CROT. The tray shows the account and device state; it never asks you to paste a token.
4. Pairing enables identity, not remote access by itself. Select a plan/trial in the account portal if remote mode is needed.

If pairing is canceled or the issuer/relay differs from the release’s pinned environment, CROT refuses it. Re-pairing after removal creates a new device identity.

## Connect an MCP client

In the tray choose **Add client** or copy the displayed MCP connection details. For a local client, choose stdio or the loopback service and follow that client’s “Add MCP server” flow. For a remote client, use the exact device MCP URL shown by CROT and complete the client’s OAuth flow. Never copy another device’s URL or access token.

CROT does not contain client-specific bypasses. A compatible client must support MCP authorization and the protocol versions shown by the tray.

## Choose a preset

- **Ask for every action** — recommended while learning CROT. Allowed actions still require explicit confirmation.
- **Autonomous browser** — allows the documented remote-safe browser capabilities, but keeps fixed CDP restrictions, explicit tab targeting, exposure rules, audit and L1 controls.

A preset grants only capabilities listed on screen. It does not grant arbitrary file access, shell authority, OS input, credential access, browser `Runtime`, or the ability to approve itself. Review changes before saving.

## Approval requests

The tray displays the requesting client, operation, target, risk and source/exposure state. Choose **Allow once**, a bounded remembered rule where offered, or **Deny**. Treat unexpected, vague or page-instructed approvals as hostile. A website, remote client or relay cannot click the approval channel.

## Remote mode

Use the tray’s **Remote access** switch. Turning it off closes the device tunnel; local mode continues. Revoking a client clears its remote authorization. Revoking a lost device in the account portal removes its relay registration and blocks reconnection. Disabling remote mode does not erase persistent source-exposure state; reset that only from the local tray after reviewing the consequences.

## Updates and removal

CROT accepts only update packages whose Ed25519 manifest and SHA-256 payload hashes verify. It preserves configuration, device binding, secrets and `remote-exposure.json`. If the updated service fails its health check, CROT returns to the previous version. Uninstall removes service autostart, tray/native-host registrations and installed L1 components. User data is retained by default so accidental uninstall does not destroy pairing; select **Purge user data** only when intended.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| Service unavailable | Restart from tray; check the per-user service status; reinstall if files are missing. |
| Browser disconnected | Confirm the official extension is enabled, not incognito, and matches the installed CROT release. Restart the browser/native host. |
| Pairing fails | Check system time, network, pinned issuer shown by the tray, MFA and callback completion. Do not change issuer manually. |
| Remote device offline | Enable Remote access, verify entitlement/device limit and network, then check the public status page. |
| `update_required` | Update the desktop app/extension/client named by the message. Local capabilities are not relaxed. |
| Action denied | Read the audit/approval reason: capability, path, L1, exposure, tab selection or entitlement. Do not work around a refusal. |
| Isolated command unavailable | Install/enable the qualified L1 prerequisite for this OS; CROT intentionally does not degrade to unconfined execution. |
| Unknown operation outcome | Do not retry automatically. Inspect target state and audit history first. |

For support and safe diagnostics see [SUPPORT.md](SUPPORT.md). Never send tokens, secrets, private keys, complete MCP bodies or private files in a ticket.
