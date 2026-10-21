# CROT Browser Extension — privacy disclosure

## Data handling declaration

The extension processes tab URLs/titles, accessibility/page structure, screenshots, user-approved input actions, dialog text and download metadata only to complete a command in the user's browser. Data is sent over Chrome Native Messaging to the CROT service running under the same OS user. The extension has no analytics SDK, advertising, telemetry, sale of data, or direct cloud endpoint.

CROT may forward an MCP response to the local or remote MCP client that initiated the approved request. Remote mode is off by default and is separately controlled in the local CROT tray. The Cloud Relay routes encrypted request/response traffic and does not store MCP payloads. Account and billing services receive no browser payload, URL, page content, screenshot, typed text, file content or workspace path.

Authentication and payment secrets are not stored by the extension. Native host credentials remain in owner-only local storage. Download/upload staging is local, bounded and cleaned when its ownership lease ends. Incognito access is disabled.

## Store form answers

- **Collects or uses personal data:** only transient website data needed for a user-requested browser action; no independent collection.
- **Sale / advertising / credit / profiling:** no.
- **Analytics / telemetry:** no.
- **Remote code:** no; all executable extension code is in the submitted archive.
- **Data transfer:** local Native Messaging to CROT; optional response to the user's chosen MCP client.
- **Retention:** extension keeps no durable browsing history or payload archive.
