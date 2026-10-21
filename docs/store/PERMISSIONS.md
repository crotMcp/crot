# CROT Browser Extension — store permission justifications

Use these texts verbatim in Chrome Web Store and Microsoft Edge Add-ons review forms.

## `debugger`

CROT uses the Chrome DevTools Protocol only after the user enables browser control in the local CROT application. It provides trusted clicks and keyboard input, accessibility snapshots, cross-origin frame handling, JavaScript dialog handling, file-input selection and screenshots of a selected background tab. The extension exposes only CROT's fixed command allowlist. It does not intercept network traffic, execute remotely supplied code, or provide raw CDP access.

## `downloads`

CROT uses the downloads API to identify and safely hand off the single file that the user or their approved AI-agent action requested. The local CROT service verifies ownership, size and destination and then publishes the file into the user's selected project path. The extension does not inspect unrelated download contents or upload browsing data.

## `tabGroups`

CROT groups tabs opened for an approved agent task into a visible “CROT” tab group. This lets the user recognize and manage agent-created tabs. It does not hide tabs or infer authorization from group membership.

## Other requested permissions

- `nativeMessaging`: connects only to the installed local `com.crot.host` process.
- `tabs`: lists and manages tabs selected for CROT browser operations.
- `scripting`: performs the fixed, bundled page operations that do not require CDP.
- `alarms`: maintains bounded service-worker timers and cleanup.
- `<all_urls>`: browser tasks may target a URL chosen by the user; access is still gated by the local PermissionEngine and approvals.

The extension does not run in incognito (`"incognito": "not_allowed"`), has no content scripts, `externally_connectable`, web-accessible resources, or remote-code loader.
