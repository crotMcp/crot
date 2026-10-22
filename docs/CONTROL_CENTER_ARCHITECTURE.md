# Control Center product architecture

## AD-39: ordinary MCP client for owner workspace operations

The curator requested a thirteen-section application shell rather than the former
four diagnostic tabs. The owner renderer remains sandboxed and network-denied.
The authenticated control channel continues to carry **only controls and approvals**;
it never executes tools or constructs a privileged principal.

Workspace operations use a **separate ordinary local MCP client** in tray main:

```text
renderer → fixed preload tool API → Core-owned input schemas + tool allowlist
         → SDK stdio client → existing crot-mcp shim → CrotService
         → ordinary local MCP principal → ExecutionGuard → capability service
```

The entry script and service configuration arguments come from tray main / the
service overview, never the renderer. The subprocess does not run a renderer-supplied
executable. The renderer cannot call network_request, raw CDP, arbitrary MCP methods,
service shutdown or remote Git operations. Input size is bounded to 256 KiB before
schema parsing. Core still owns workspace/secret boundaries, confinement, capability
authorization, approval requirements and audit. This is not an owner policy bypass.

The preload adds exactly one method, `tool(name, input)`. Sender-frame checks and
smoke-mode denial cover it. Closing the tray closes its MCP client. The SDK transport
uses the already-running service; service configuration mismatches fail closed.
A lost connection discards the MCP client, including its exposure scope; the next
connection is a new normal MCP session. Requests are not automatically replayed.

CSP permits only bundled script/style, no renderer network, frames, forms or inline
script. The sole media exception is `img-src data:` for screenshots returned as
MCP image blocks with an allowlisted image MIME type. Untrusted results, filenames,
DOM snapshots and approval subjects are text nodes, never HTML. Clipboard actions
still originate in main and never accept arbitrary renderer clipboard bytes.

## Information architecture and actual capability scope

- **Auth:** first-run gate, email validation, no SSO, five-language selection,
  remembered local admission and `Free (Local)`. The local gate is a preference,
  not an authentication or security boundary. Paired device state comes from the
  service, never localStorage. Account buttons open the fixed hosted portal;
  provider-specific Google/GitHub routing and email prefill are **not implemented**.
  No email or credential is stored by this UI. Real provider login remains external
  qualification and is not claimed by screenshots or fixture E2E.
- **Home:** service-derived health, four next actions, recent projects/session
  events and complete approval subjects. No settings or diagnostic output.
- **Projects:** local project registry, search/favorites, configured workspace
  context, guarded directory inspection/creation, seven detail tabs. It is not a
  multi-Core workspace manager: projects cannot expand service authorization.
- **Agents:** generated local-client configuration, paired remote URL, real session
  counts and registered remote-client revoke/re-grant. Local per-session disconnect,
  per-agent editors and provider account details are not exposed by the service.
- **Connectors:** searchable, category-filtered catalog with honest Roadmap labels.
  All ten entries are planned; no fabricated connection or credential forms.
  Connector runtimes, SecretStore bindings, scopes and project grants remain open.
- **MCP Servers:** explicitly separate from Agents; external stdio/HTTP/SSE gateway
  remains planned rather than pretending CROT already manages external servers.
- **Browser:** three-column tabs/snapshot/inspection workspace; ordinary guarded
  bridge calls for tabs, snapshots, screenshots, refs, forms and dialogs. No embedded
  live browser or invented OS profile switching. Download/upload management remains
  in Core; a dedicated UI for those workflows remains open.
- **Files:** real directory listing and file read/write via FilesystemService.
- **Terminal:** real background process start/output/stop through ProcessService.
- **Git:** status/diff/log/branches/commit via GitService; network actions disabled.
- **Docker:** guarded workspace ps/logs/Compose up/down via DockerService.
- **Tasks / Monitoring:** metadata for operations in this UI session, not a global
  durable job engine or full historical audit explorer. No command/credential/request
  content is placed in monitoring event records. Native diagnostic copy remains the
  existing status-summary action; it is not an export of tool results.
- **Settings:** eleven navigable sections; real control-channel preset, pairing,
  remote mode and Full Control actions, plus language/theme and service-policy
  inspection. Unsupported policy editors/autostart/update actions are explained,
  not represented as working toggles. Dangerous changes require a modal confirmation;
  their existing service-side audit behavior is preserved.

## Visual and localization scope

Control Center has a surface-specific override in `src/tray/control-center-style.ts`:
light canvas, blue primary CTA, semantic service statuses, 44px controls and a
persistent sidebar. Its dark variant uses the same semantic token names. This does
not retheme the portal or extension, whose canonical Zinc tokens remain in
`src/ui/theme.ts`. Offline translations remain in the single `src/ui/i18n.ts`
dictionary. Auth, navigation and settings labels have five-language translations;
new detailed copy has EN/RU translations with explicit English fallback in ES/DE/ZH.
No complete five-language detail-copy qualification is claimed.

The invoked Notion adaptation of UI UX Pro Max was read, as was its pinned upstream
SKILL.md. No local catalog engine or verified catalog recommendation was available;
layout and accessibility decisions use its documented fallback guidance.

## Verification boundaries

`scripts/ui-e2e.mjs` uses real Chromium and shipped HTML/CSS/JS with an **owner IPC
fixture**, not a live OAuth provider or Electron service integration. It checks auth
without SSO, local-choice persistence, 13 routes × EN/RU, 7 project tabs × EN/RU,
11 settings sections × EN/RU, Browser columns, approval delegation/polling focus,
dangerous-change confirmation and narrow layouts. Screenshots are test artifacts,
not release or production qualification. Existing browser-bridge E2E and Electron
smoke tests remain separate gates. Do not infer CI 11/11 from local check success.
