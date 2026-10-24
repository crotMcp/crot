# Control Center product architecture

> Current presentation override: [AD-42](../ARCHITECTURE.md#ad-42--owner-requested-control-center-design-system-and-navigation) and [design implementation](design/IMPLEMENTATION.md).
> Startup onboarding remains; ten destinations now appear in the sidebar.
> Historical mobile and local-autoadmission evidence below does not qualify the new desktop flow.

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

AD-39 added `tool(name, input)`; AD-40 adds fixed `product(name, input)`. Sender-frame checks and
smoke-mode denial cover it. Closing the tray closes its MCP client. The SDK transport
uses the already-running service; service configuration mismatches fail closed.
A lost connection discards the MCP client, including its exposure scope; the next
connection is a new normal MCP session. Requests are not automatically replayed.

CSP permits only bundled script/style, no renderer network, frames, forms or inline
script. The sole media exception is `img-src data:` for screenshots returned as
MCP image blocks with an allowlisted image MIME type. Untrusted results, filenames,
DOM snapshots and approval subjects are text nodes, never HTML. Clipboard actions
still originate in main and never accept arbitrary renderer clipboard bytes.

## AD-40: service-owned product runtime and owner-only administration

The authenticated owner channel now accepts a fixed, strictly validated product RPC
allowlist (`product-protocol.ts`). These are **owner configuration and lifecycle**
commands, not a tool endpoint available to MCP clients. External connector probes and
MCP lifecycle/calls are explicit owner operations; each effect still uses Core's
ExecutionGuard, capabilities, network policy, workspace confinement, approvals and L1.
There is no general command/network escape on the owner channel. Workspace screens
continue through the ordinary local MCP client described in AD-39.

- **Auth:** `pairing.start` and the hosted portal carry validated `login_hint` and
  explicit `authkit`, `GoogleOAuth` or `GitHubOAuth` provider parameters. PKCE,
  state, issuer and device binding are unchanged. No SSO button. Real provider
  completion requires configured AuthKit applications and external credentials;
  automated checks verify routing and protocol behavior, not production sign-in.
- **Projects:** service-private persistent registry, create/open/select/favorites,
  removal from registry (never recursive deletion), tool/agent/connector settings.
  Owner registration explicitly grants the selected directory as the service's
  workspace. Selection rebuilds Core only while idle and retains a single audit
  file across workspaces. Files/Terminal/Git/Docker use the selected Core, not a
  renderer path pretending to expand authorization.
- **Agents:** server-created connection identities (verified account/device/client
  triples remotely; server-owned local session IDs), project/browser/rate grants,
  sanitized calls, disconnect/revoke. Enforcement is inside ExecutionGuard and
  repeated after approval. Local session identity is not cryptographic application
  identity: a reconnect is a new session for the same OS owner. No claim of process
  identity isolation between applications sharing the owner account.
- **Connectors:** real fixed provider probes for GitHub, GitLab, ElevenLabs,
  YouTube, TikTok, Notion, Drive and Slack; guarded custom HTTP and local FFmpeg.
  Credentials are encrypted using AES-256-GCM; the encryption key is held in
  SecretStore and migrates with its backend. Metadata includes configured state,
  scopes/grants, HTTP status, check time and latency, never plaintext keys.
  `Disconnect` disables locally; `Revoke` erases the local credential. Provider-side
  token revocation/consent and arbitrary provider business operations are not
  implied by local credential removal or a successful identity probe. Requested
  scopes are configuration metadata, not proof the provider granted them.
- **External MCP:** SDK client with guarded stdio pipes (normal L1 launcher and
  filtered environment) or guarded Streamable HTTP JSON requests. Discovery of
  tools/resources, JSON-schema input validation, default-deny tool policies and
  bounded sanitized connection logs. Metadata/results mark untrusted exposure via
  `mcp.call`; effectful calls still need normal capabilities/approvals. The HTTP
  adapter is bounded request/response JSON, **not a claimed long-lived SSE client**.
- **Tasks:** durable bounded metadata (latest 500), real process IDs and cancellation,
  encrypted local replay inputs (8 MiB total retained budget), retry in the original local identity and selected
  project with current policy re-evaluated. Remote OAuth requests are not replayed
  as owner. Interrupted tasks are marked on restart. Progress is lifecycle state
  (0/100), not invented intermediate percentages. Non-process adapters can only be
  interrupted at their supported cancellation boundaries; cancellation cannot undo
  completed external effects. Task results are not stored as plaintext request logs.
- **Monitoring:** streaming active `audit.jsonl`, time/project/agent/type filters,
  service/task metrics and sanitized report export. Service-created identifiers
  remain in audit records after task retention expires. UI reports use an explicit
  field allowlist: no headers, request/response bodies, command text or arbitrary
  error strings. Electron main alone chooses and writes the report path through
  a native save dialog; the renderer supplies neither a file path nor report bytes.
- **Existing sections:** Browser remains the real three-column bridge workspace;
  Files, Terminal, Git and Docker retain existing guarded services. Remote Git
  operations, OS browser-profile switching and native installer qualification are
  not fabricated by this product runtime. Settings retains eleven subsections,
  working controls and honest explanations of platform-managed configuration.

`product-state.json` and `product-vault.enc` are owner-private and Core
secret paths; encrypted credentials and replay payloads never appear in RPC listings.
MCP command arguments are owner configuration and should not be used to embed secrets;
HTTP bearer credentials belong in the dedicated encrypted token field. SecretStore's
product encryption key is deliberately excluded from blind identity-key rotation.

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

## Real-service Chromium integration gate

`node scripts/ui-e2e.mjs --service` serves the shipped assets with a **test-only**
HTTP replacement for Electron IPC. The harness starts an isolated actual CrotService,
uses authenticated ControlClient and the ordinary TrayToolClient, and never returns
fixture project/task/audit data. Only this test page changes CSP connect-src to self;
production renderer networking remains denied. It verifies project creation and
workspace selection, actual disk file writes, Git status, terminal execution, a real
local connector HTTP probe, child MCP discovery, cancellation and filtered audit.
The provider HTTP endpoint and child MCP server are controlled peers, not a fake
CrotService. `tests/service/product-runtime.test.ts` additionally covers SDK HTTP
roundtrips, default-deny/schema enforcement, per-agent restrictions, retry, encrypted
storage and daemon restart. Live provider accounts and OS installers remain separate
operational qualification. CI status must be checked on the exact PR head.
