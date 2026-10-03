# CROT — Architecture Contract

> **Status of this document.** This is the primary architectural reference for
> CROT development. It describes both the architecture that is **implemented**
> in this repository and the agreed **target** product architecture.
>
> Every major component carries a status marker:
>
> - **[Implemented]** — exists in this repository and is covered by tests/CI;
> - **[Partial]** — part of the component exists; the gap is stated explicitly;
> - **[Target]** — agreed part of the product, not implemented yet. Target
>   sections define boundaries and responsibilities, not finished designs.
>
> Implementation details of implemented components live in `README.md`,
> `docs/NATIVE_HOST.md` and `docs/BROWSER_EXTENSION.md`. Section numbers 1–17
> are stable (they are referenced from those documents); new sections start at 18.
> Open questions that need a separate architectural decision are listed in §26.

## 1. Product

**CROT** is an installable, commercial, local AI-agent bridge and MCP gateway.

CROT combines the user's computer, the user's browser and external
MCP-compatible services into one controlled environment for AI agents.

The product has three parts:

| Part | What the agent gets | Status |
| --- | --- | --- |
| Local computer | files, processes, shell, Git, Docker and further local capabilities | **[Implemented]** files, processes, shell; **[Partial]** Git/Docker (see §5) |
| User's browser | the user's real browser session through the browser bridge and extension | **[Implemented]** Chromium browsers |
| External MCP services | tools of external MCP-compatible servers, reached through CROT | **[Target]** (§18) |

CROT is a **controlled layer** between AI agents and these resources, not a
direct proxy: every operation passes CROT's permission, execution and audit
pipeline (§6, §19).

The goal is to let an AI agent work as a real developer/operator on the user's machine:
- read and modify local projects;
- execute development commands;
- use Git, Docker and local tools;
- interact with the browser;
- combine computer and browser operations in one workflow;
- use external MCP services in the same controlled workflow (target).

CROT is **not a Notion-specific product**. Notion is only one possible MCP client.

## 2. Architecture

> Correction: the previous diagram placed the browser extension and the Native
> Host above CROT Core and attributed files/shell to the Native Host. In the
> implemented system CROT Core is central; the Native Host is the OS platform
> layer *below* Core, and the browser is reached from Core through the browser
> bridge and a native-messaging relay. The diagrams below reflect the code.

CROT Core must remain independent of any specific AI client, model, browser,
external service, identity provider or commercial backend.

### 2.1 Implemented architecture

```text
  MCP clients on the same machine (Notion via local bridge, Claude, Cursor, ...)
            |  stdio                |  Streamable HTTP, loopback only, bearer token
            v                       v
+------------------------- crot-mcp process (user device) --------------------------+
|  CROT MCP adapter        adapters/mcp, adapters/http                              |
|    request -> Principal / AuthContext  (AccessTokenVerifier seam for HTTP)        |
|                     |                                                            |
|                     v                                                            |
|  CROT Core                                                                        |
|    ExecutionGuard: validate -> resolve paths -> PermissionEngine                 |
|                    -> execute -> audit                                            |
|    capabilities:  FileSystemService | ProcessService | BrowserService             |
|                         |                 |                 |                     |
|                         v                 v                 v                     |
|    Platform interfaces (PathRules, ProcessLauncher,    BrowserConnection          |
|    ShellProvider, PrivateFileProtection, ...)               |                     |
|         ^  implemented by Native Host (OS platform layer)   |                     |
|                                                     BrowserBridge                 |
+---------|---------------------------------------------------|---------------------+
          v                                                   | local IPC (Unix socket /
   OS: files, processes, shells                               | named pipe, token-auth)
   (git, docker, ... today via shell.execute)                 v
                                                     crot-browser-relay
                                                     (native-messaging host, started by browser)
                                                              | Native Messaging (stdin/stdout)
                                                              v
                                                     CROT Browser Extension (MV3)
                                                              | chrome.tabs / chrome.scripting
                                                              v
                                                     User's browser profile
```

### 2.2 Target architecture

```text
                         AI agent / MCP client
                 local |                         | remote                       [Target]
                       |                         v
                       |              CROT Cloud Relay   <---- Identity provider (OIDC)   [Target]
                       |              (connection only,  <---- CROT Account & Commercial
                       |               no content store)       service (accounts, plans,
                       |                         ^             licences, entitlements,
                       |     outbound secure     |             device limits)            [Target]
                       |     tunnel from device  |                    ^
+----------------------|-------------------------|-----  User device  |------------------+
|                      v                         |                    |                  |
|  CROT Tray app [Target] <-- local control --> CROT local service (sidecar) ------------+ |
|  status, permissions,        channel           = the crot-mcp process, supervised       |
|  confirmations, account,                                                                 |
|  device, remote on/off                                                                   |
|                                                                                          |
|  Transport adapters:  stdio [Impl] | HTTP loopback [Impl] | remote tunnel [Target]       |
|  Auth adapters:       local token [Impl] | OAuth/OIDC verifier + device credential [Target]
|                                   |  Principal (no credentials)                          |
|                                   v                                                      |
|  CROT Core: ExecutionGuard -> PermissionEngine -> [user confirmation, Target]            |
|             -> execute -> audit                                                          |
|        local capabilities      browser capability        external MCP capability        |
|              |                        |                   [Target]  |                    |
|              v                        v                             v                    |
|   Platform / Native Host        BrowserBridge              MCP client connectors        |
|              |                        |                    (outside Core) [Target]       |
+--------------|------------------------|-----------------------------|--------------------+
               v                        v                             v
          OS resources      relay -> extension -> browser      external MCP servers
```

### 2.3 Request paths

All paths end in the same Core pipeline; no path bypasses it.

1. **Local operation** [Implemented]: agent -> MCP client -> CROT MCP (stdio or
   loopback HTTP) -> Principal -> ExecutionGuard -> PermissionEngine ->
   FileSystemService / ProcessService -> Platform (Native Host) -> OS -> audit ->
   result.
2. **Browser operation** [Implemented]: agent -> CROT MCP -> BrowserService ->
   ExecutionGuard / PermissionEngine (`browser.read` / `browser.control`) ->
   BrowserBridge -> local IPC -> `crot-browser-relay` -> Native Messaging ->
   extension -> browser -> validated result -> audit.
3. **External MCP operation** [Target]: agent -> CROT MCP -> external-MCP
   capability -> ExecutionGuard / PermissionEngine -> MCP client connector ->
   external MCP server -> result treated as untrusted data -> audit (§18).
4. **Remote operation** [Target]: remote agent/client -> CROT Cloud Relay
   (client authentication, routing to the bound device) -> outbound tunnel ->
   local CROT remote-transport adapter -> token re-verification -> Principal
   (`kind: remote`) -> the same paths 1–3 (§22).
5. **User confirmation** [Target]: ExecutionGuard -> confirmation request ->
   UI provider (tray) -> explicit user decision -> continue or deny -> audit (§21).

### 2.4 Component placement

| Component | Runs where | Responsibility | Status |
| --- | --- | --- | --- |
| CROT Core | device, inside `crot-mcp` | permissions, execution guard, capabilities, audit, config | **[Implemented]** |
| CROT MCP server (adapter) | device, inside `crot-mcp` | MCP tools over stdio and Streamable HTTP (loopback) | **[Implemented]** |
| Native Host (OS platform layer) | device, inside `crot-mcp` | OS-specific Platform implementations (Windows Job Objects, ACLs) | **[Implemented]** |
| Browser bridge | device, inside `crot-mcp` | local IPC endpoint, handshake, request/response | **[Implemented]** |
| `crot-browser-relay` | device, started by the browser | native-messaging host; forwards frames only | **[Implemented]** |
| CROT Browser Extension | user's browser | fixed browser commands | **[Implemented]** (Chromium) |
| MCP client connectors / external MCP gateway | device, outside Core | connections to external MCP servers | **[Target]** |
| Confirmation mechanism | Core interface + UI provider | explicit user approval of sensitive operations | **[Target]** |
| CROT local service (sidecar) | device, background | supervised long-running `crot-mcp` | **[Target]** (today: started manually / by the MCP client) |
| CROT Tray app | device | user UI | **[Target]** |
| Installer / packages | device | Linux, Windows, macOS installation | **[Target]** |
| CROT Cloud Relay | cloud | secure connection between remote clients and device | **[Target]** |
| Identity provider (third party) | cloud | user authentication, tokens | **[Target]** |
| Account & Commercial service | cloud | accounts, subscriptions, plans, licensing, entitlements, device limits | **[Target]** |
| User / device / account | identities | see §20 | **[Partial]**: only a local principal and a static local token exist |

## 3. CROT Core

**[Implemented]**

CROT Core is the central product layer. It owns:
- permissions and capabilities;
- workspace configuration;
- execution policy;
- filesystem and process access;
- the browser capability (`BrowserService`); the bridge transport is outside
  Core behind the `BrowserConnection` interface;
- the principal model and authorization (the PermissionEngine);
- audit logging;
- configuration.

Core does **not** own:
- credential verification — done by adapters behind replaceable seams
  (`AccessTokenVerifier`); Core receives only a verified `Principal`, never
  tokens;
- accounts, licensing, subscriptions or entitlements (§13, §23);
- code of specific external services or MCP servers (§18);
- user-interface code (§21, §24).

> Correction: the previous version listed "authentication/authorization" and
> "future licensing/subscription integration" as Core responsibilities. The
> implemented system keeps authentication in adapters, and the target
> architecture keeps the commercial layer out of Core.

MCP is an interface exposed by CROT Core, not the entire product.

## 4. MCP

CROT exposes a standards-compatible MCP interface (CROT as **MCP server**).

- **[Implemented]** stdio transport; Streamable HTTP transport on loopback with
  a local bearer token behind the replaceable `AccessTokenVerifier`. The tool
  set, Core services, PermissionEngine and audit are identical on both.
- **[Target]** remote exposure with MCP authorization (§20, §22).
- **[Target]** CROT as **MCP client** of external MCP servers (§18).

Tools must have explicit schemas and validated inputs. Tool execution must enforce authorization, path validation, timeouts/rate limits where appropriate, and auditable execution.

Remote HTTP MCP must be designed around the current MCP authorization model rather than a permanent static bearer token.

## 5. Local Computer Capabilities

When the user grants them, CROT can provide:
- Filesystem — **[Implemented]**
- Shell — **[Implemented]**
- Processes — **[Implemented]**
- Git — **[Partial]**: usable through `shell.execute`; dedicated operations gated by `git.read` / `git.write` are not implemented
- Docker — **[Partial]**: usable through `shell.execute`; dedicated operations gated by `docker.use` are not implemented
- Python, Node.js, FFmpeg, project tools — **[Partial]**: usable through `shell.execute` / `process.manage`

New local capabilities are added as Core capability services that go through
the ExecutionGuard, with their own capability names in the PermissionEngine.

CROT must support fully autonomous development; it is not a read-only product.

## 6. Permission Architecture

**[Implemented]**

Permissions are a first-class centrally managed subsystem. There is one
permission model, enforced by one PermissionEngine. Every Core operation passes
the ExecutionGuard:

```text
AI agent -> request -> PermissionEngine (via ExecutionGuard) -> execute -> audit
            (validate input -> resolve paths -> authorize -> execute -> audit)
```

This pipeline is the foundation of CROT security and applies unchanged to every
transport, principal and capability, including all target components.

### SANDBOX

The agent operates only inside a user-selected workspace, for example:

```text
/home/user/projects/my-project
```

The agent may have full developer capabilities inside that workspace, while paths and operations outside it are denied.

Sandbox confines CROT's own file operations and command working directories; it
is not OS-level isolation of commands (see README).

### FULL CONTROL

The user explicitly grants CROT the full OS-level capabilities available to the CROT process.

FULL CONTROL is an explicit user choice for unrestricted local coding/automation.

The architecture must also support future granular capabilities such as:

```text
filesystem.read
filesystem.write
filesystem.full
shell.execute
process.manage
git.read
git.write
docker.use
browser.read
browser.control
network.access
```

Enforced today: `filesystem.*`, `shell.execute`, `process.manage`,
`browser.read`, `browser.control`. `git.*`, `docker.use` and `network.access`
are part of the model and reported by `crot_status`, and will gate dedicated
operations when those are added.

**[Target]** extensions of the same model (not a second permission system):
capabilities for external MCP servers (§18), user confirmation as a possible
authorization outcome (§21), and policy for remote principals (§22).

## 7. Browser Extension

**[Implemented]** for Chrome, Edge and Brave (Chromium 120+). Firefox is not supported.

The extension provides browser integration:
- tabs;
- pages;
- DOM;
- page context;
- screenshots;
- browser actions;
- browser state.

It communicates through browser Native Messaging with `crot-browser-relay`,
which forwards frames over local IPC to the browser bridge inside the running
CROT process. It does not require a public server for local communication.

The chain is: AI agent -> CROT (BrowserService, ExecutionGuard,
PermissionEngine) -> browser bridge -> relay / Native Messaging -> extension ->
user's browser.

Architectural rules (details in `docs/BROWSER_EXTENSION.md`):
- the PermissionEngine is the only authorization authority; bridge, relay and
  extension are dumb transports;
- the browser side cannot initiate operations;
- no host-supplied code is executed in the browser;
- the browser is a separate trust boundary (§19) and **web page content is
  untrusted input**.

## 8. Native Host

**[Implemented]**

> Terminology: "Native Host" in CROT means the **OS platform layer** below Core.
> The browser's native-messaging host is `crot-browser-relay` (§7). The previous
> version of this section described the Native Host as the provider of files,
> shell, Git and Docker; in the implementation those are Core capabilities, and
> the Native Host supplies the OS mechanisms they use.

The Native Host implements Core platform interfaces (`ProcessLauncher`,
`PrivateFileProtection`) with stronger OS mechanisms (Windows kill-on-close Job
Objects, owner-only ACLs). It is not a second Core: it performs no
authorization and has no request API (see `docs/NATIVE_HOST.md`).

Extension + Host must be presented to the user as **one CROT product** and
installed through a simple setup flow — **[Target]** via the installable
application (§24); today setup is manual.

## 9. Unified Browser + PC Agent

A primary CROT capability is one AI agent combining computer and browser operations:

```text
AI Agent
   |
   +-- read local project
   +-- modify code
   +-- run tests
   +-- open browser
   +-- inspect web application
   +-- interact with web application
   +-- return results
```

Example workflows include software development, web testing, and content workflows such as preparing and publishing a video through a web service using local project files.

The building blocks are implemented (§5, §7); combined workflows run as
separate tool calls through the same Core. Data read from the browser never
triggers local operations by itself (§19).

Specific service integrations must not be hard-coded into CROT Core unless necessary.

## 10. Installation UX

**[Target]** (today: `npm install`, `npm run build`, CLI commands, unpacked extension).

Target user flow:

```text
Install CROT (app: service + tray, registers browser host)
        |
        v
Install CROT Extension
        |
        v
Select project
        |
        v
Choose permissions
        |
        v
Connect AI Agent (local; remote optional, requires account, §22)
        |
        v
Ready
```

The user should not need to understand MCP, Native Messaging, ports, tunnels,
OAuth, or internal architecture, and should not need to start processes from a
terminal (§24).

A true one-click experience is a product goal subject to browser/OS security restrictions.

## 11. Client Independence

CROT must remain client-neutral.

Potential clients:
- Notion;
- Claude;
- Cursor;
- other MCP-compatible applications.

Notion is only the first real integration.

## 12. Security and Privacy

CROT must not depend on trusting a third-party local MCP implementation.

Security requirements:
- explicit permissions;
- secure authentication and authorization;
- validated tool inputs;
- path traversal protection;
- process timeouts;
- controlled subprocess execution;
- secure token handling;
- audit logs;
- clear user-visible permissions;
- no hidden telemetry;
- no hidden data collection;
- no silent external transmission of user files.

CROT follows a local-first principle. Project data must not leave the user's computer merely because CROT is installed. Cloud services receive project contents only when an explicitly used feature requires it.

This applies to target components: the Cloud Relay carries only traffic of a
remote session the user enabled and never stores it (§22); the commercial
service receives account/device/licence data, never computer contents (§23).

FULL CONTROL is powerful and inherently sensitive; the goal is to make that trust boundary explicit and user-controlled, not to pretend it is risk-free.

Trust boundaries are defined in §19.

## 13. Commercial Product

CROT is architected as a commercial, installable, subscription product from the beginning.

Potential layers:

```text
CROT Core
CROT Extension
CROT Host
CROT MCP
Account
Licensing
Subscription
Device management
Team features
Cloud services
```

Commercial functionality must remain separate from the local execution engine. The local installation should remain useful independently of cloud services.

The commercial layer is **[Target]**; its boundaries are defined in §23.

## 14. First Real Milestone

The first real user is the developer building CROT.

The first real project is:

```text
/home/kos/telegram-stream
```

The first usable milestone is:

```text
Notion Agent
      |
      v
CROT MCP
      |
      v
telegram-stream
```

The agent must be able to perform real development work.

The MVP must be part of the final architecture, not disposable prototype code.

Status: the local MCP side is implemented; completion of this milestone is not
recorded in the repository. See §26, question 1.

## 15. Development Principles

Build the smallest working implementation of the final architecture.

Do not:
- build Notion-specific core logic;
- create disposable MCP code;
- duplicate permission systems;
- hard-code browser integrations into the core;
- hard-code commercial services into local execution;
- hard-code external services or specific MCP servers into the core;
- make the core depend on a specific identity provider;
- make local mode depend on network access or an active subscription;
- put user-interface logic into the core;
- sacrifice final architecture for the first demo.

## 16. Development Order

Approximate order (status in brackets):

```text
1. Repository and project foundation              [Implemented]
2. CROT Core interfaces                           [Implemented]
3. Permission engine                              [Implemented]
4. Local filesystem capabilities                  [Implemented]
5. Shell/process capabilities                     [Implemented]
6. MCP interface                                  [Implemented]
7. Local MCP connectivity                         [Partial: stdio + loopback HTTP; no remote]
8. Notion integration as first client             [not recorded in repository]
9. Real telegram-stream workflow                  [not recorded in repository]
10. Native Host                                   [Implemented]
11. Browser Extension                             [Implemented]
12. Unified browser + PC workflows                [Partial: building blocks implemented]
13. Installer                                     [Target, §24]
14. Authentication/authorization hardening        [Target, §20]
15. Commercial account/licensing layer            [Target, §23]
```

Further target work, order to be set by the work packages:

```text
16. User confirmations                            [Target, §21]
17. Identity, accounts and device binding         [Target, §20]
18. Remote mode and CROT Cloud Relay              [Target, §22]
19. External MCP gateway (CROT as MCP client)     [Target, §18]
20. Tray app and supervised local service         [Target, §24]
21. Dedicated Git/Docker capabilities             [Target, §5]
```

The order may change when technically justified, but architectural boundaries must remain intact.

## 17. Non-Negotiable Principle

**CROT is not a Notion MCP.**

CROT is a universal local AI-agent bridge and MCP gateway:

> **An installable local bridge that gives AI agents controlled or full access to the user's computer, browser and external MCP services through a standard MCP interface, with one local point of control.**

The product must support both:
- safe/controlled automation;
- full-control autonomous development;

with the user explicitly choosing the permission level.

CROT remains the **single local controlled gateway**: local operations, browser
operations and external MCP connections all pass through the same Core
pipeline.

## 18. External MCP Gateway

**[Target]** — not implemented.

CROT acts as an MCP client of external MCP-compatible servers and exposes their
tools to the agent through CROT MCP:

```text
AI agent -> CROT MCP -> Core (ExecutionGuard / PermissionEngine / audit)
         -> MCP client connector -> external MCP server
```

Boundaries:
- **Placement.** MCP client connectors live outside Core (an adapter-level
  module). Core knows a generic "external MCP tool call" operation, never the
  code or semantics of a specific service. Adding a service is configuration
  or a connector, not a Core change.
- **Authorization.** Every external tool call is a Core operation through the
  ExecutionGuard, gated by capabilities in the existing PermissionEngine
  (naming/granularity: §26, question 3). Servers are enabled explicitly by the
  user.
- **Isolation.** External servers get no access to the local computer, the
  browser, the workspace, Core or other connected servers. They receive only
  the arguments of the call the agent made. MCP features initiated by an
  external server (e.g. requests back to the client, root listings) are not
  forwarded by default (§26, question 5).
- **Untrusted data.** External tool descriptions, results and errors are
  untrusted. They are returned to the agent as data and never executed or
  turned into local operations by CROT.
- **Credentials.** Credentials for external servers are stored as CROT private
  files / OS secure storage, are never exposed to the agent and never appear in
  audit events.
- **Audit.** Calls are audited like other operations (server, tool, principal,
  outcome, duration), without request/response contents.

## 19. Trust Boundaries

| Boundary | Trusted side | Untrusted / external side | Enforcement | Status |
| --- | --- | --- | --- | --- |
| Agent -> CROT | Core | agent requests | schemas, ExecutionGuard, PermissionEngine, audit | **[Implemented]** |
| Local operations | Core + Platform | commands and their effects | workspace boundary, protected paths, timeouts, process-tree control; not OS sandboxing | **[Implemented]** |
| Local transports | Core | other local programs | stdio parent only; loopback HTTP with bearer token, Host/Origin checks | **[Implemented]** |
| Browser | Core | bridge, relay, extension, browser, web pages | token-authenticated IPC, browser cannot initiate, fixed commands, result validation; page content untrusted | **[Implemented]** |
| External MCP | Core | external servers, their tools and data | §18 | **[Target]** |
| Remote access | local CROT | relay, remote clients, network | §22 | **[Target]** |
| User tokens | identity provider + local verifier | token holders | short-lived, revocable, audience-bound tokens; Core sees only a Principal | **[Target]** (today: static local token) |
| Device | device credential | other devices, cloned installs | device identity and binding, revocation (§20) | **[Target]** |
| Commercial | local execution | commercial service | entitlements never enter local authorization (§23) | **[Target]** |
| User confirmation | user via UI provider | agent, page/tool content | §21 | **[Target]** |

Cross-cutting rule: **untrusted content never becomes a local command by
itself.** Web pages, external MCP results, files read by tools and relay
traffic are data. CROT never parses results to trigger operations; every
operation must arrive as a new tool call and pass the full pipeline. CROT cannot
stop an agent from following injected instructions; mitigations are capability
scoping, user confirmations (§21) and audit.

## 20. Identity: User, Device, Account

**[Partial]**: implemented are the `Principal` model (`local-user` for stdio,
`local-token:<fingerprint>` for HTTP, with transport and auth method in every
audit event) and the replaceable `AccessTokenVerifier` seam. Everything else is
**[Target]**.

Target model:
- **User account** — authenticated by a third-party identity provider
  (OAuth/OIDC). The provider is behind adapter-level interfaces
  (`AccessTokenVerifier` and an app-level identity client); it is not a Core
  dependency.
- **Device** — each installation has a device identity; the device is bound to
  an account; device credentials are kept in OS secure storage / private files.
- **Authorization tokens** — short-lived, revocable access tokens bound to the
  account, device and CROT audience; refresh handled outside Core.
- **Revocation** — the user can revoke a device or a client; revocation ends
  remote sessions and invalidates its tokens.
- **Remote access control** — remote mode is permitted per device and per
  account (§22).
- **Core contract** — Core receives only a `Principal` (identity, kind,
  transport, auth method; target: account and device ids). Credentials never
  reach Core or the audit log.
- **Local mode** — stdio and loopback use do not require an account.

## 21. User Confirmations

**[Target]** — not implemented.

CROT can require explicit user approval before a sensitive operation.

- **Placement.** The decision "this operation needs confirmation" is part of
  the existing authorization pipeline (PermissionEngine policy, evaluated by the
  ExecutionGuard before execution) — not a second permission system.
- **UI independence.** Core requests a confirmation through an interface;
  implementations (UI providers) live outside Core — the tray app is the
  planned first provider.
- **Safe default.** No provider available, timeout or dismissal means deny.
- **Authenticity.** A confirmation can only come from the user through a
  provider on an authenticated local channel; it cannot be granted by the
  agent, a web page, an external MCP server or the relay.
- **Audit.** Requests and decisions are audited.

Which operations require confirmation is a policy question (§26, question 6).

## 22. Remote Mode and CROT Cloud Relay

**[Target]** — not implemented. Today HTTP binds to loopback only.

```text
AI agent / remote MCP client
        |  HTTPS, MCP authorization (OAuth)
        v
CROT Cloud Relay        (authenticates client, routes to bound device)
        |  secure tunnel, opened outbound by the device
        v
local CROT on the user's device  (re-verifies token -> Principal kind: remote
                                  -> ExecutionGuard / PermissionEngine -> audit)
```

Boundaries:
- **Relay role.** The relay establishes and maintains the secure connection
  between external clients and the local CROT. It is **not a store of computer
  contents**: it keeps only what is needed for routing and access control
  (account, device, connection state), never persists or logs payloads.
- **Authorization stays local.** The local CROT verifies every remote request
  itself and applies the PermissionEngine; the relay cannot authorize local
  operations.
- **No inbound exposure.** The device opens the connection to the relay; no
  local port is opened to the internet.
- **Explicit and visible.** Remote mode is off by default, enabled explicitly
  per device, visible in the tray while active, and can be stopped/revoked at
  any time.
- **Not a remote desktop.** Remote mode exposes only the CROT tool set under
  the same permissions — no screen streaming, no OS-level input, no hidden
  access.
- **Separate trust boundary.** Remote principals are distinguishable from
  local ones in authorization and audit (`kind: remote`).
- Remote mode requires an account, device binding and the corresponding
  entitlement (§23).

## 23. Commercial Layer

**[Target]** — not implemented.

A separate Account & Commercial service (cloud) owns accounts, subscriptions,
plans, licensing, entitlements, device limits and access to cloud features.

Boundaries:
- **Not in Core.** Core, the ExecutionGuard and the PermissionEngine contain no
  licence, plan or subscription logic. Entitlements may limit which product
  features are offered (e.g. remote mode, cloud features, number of devices);
  they never grant local capabilities.
- **Consumers.** The Cloud Relay (admits remote sessions only for entitled
  devices) and the installed app (shows the plan, gates cloud features).
- **Offline local mode.** The basic local mode works without network access and
  without an active subscription.
- **Data.** The commercial service never receives computer, browser or
  workspace contents.

## 24. Installable Application

**[Target]** — not implemented. Today CROT is run from a source checkout with CLI
commands, and the extension is loaded unpacked.

Target for Linux, Windows and macOS:
- **CROT local service (sidecar)** — the existing `crot-mcp` process (Core,
  MCP adapters, browser bridge, Native Host) running in the background,
  started and supervised by the app;
- **CROT Tray app** — status, workspace and permission settings, confirmations
  (§21), account/device, remote mode on/off; talks to the service over an
  authenticated local control channel and never bypasses Core;
- **Installer / packages** — installs the service and tray, registers the
  browser native-messaging host, guides the extension installation, updates;
- no manual start of multiple processes from a terminal.

The tray app is a UI; control logic stays in Core/service.

## 25. Implementation Status Summary

| Component | Status |
| --- | --- |
| Core, PermissionEngine, ExecutionGuard, audit | **[Implemented]** |
| Filesystem, shell, processes | **[Implemented]** |
| Git, Docker as dedicated capabilities | **[Target]** (usable via shell) |
| Local MCP tools over stdio | **[Implemented]** |
| Streamable HTTP, loopback, local token | **[Implemented]** |
| Native Host (OS platform layer) | **[Implemented]** |
| Browser bridge, relay, extension (Chromium) | **[Implemented]** |
| External MCP gateway / MCP client | **[Target]** |
| User confirmations | **[Target]** |
| OAuth/OIDC identity, accounts, device binding | **[Target]** |
| Remote mode, Cloud Relay | **[Target]** |
| Commercial layer: subscriptions, plans, licensing, entitlements | **[Target]** |
| Installer, tray app, supervised service | **[Target]** |

## 26. Open Architectural Questions

These need explicit decisions before the corresponding work packages.

1. **First milestone vs remote mode.** §14 targets a Notion Agent as the first
   client, but clients that only reach servers on the internet need remote
   exposure (README), which is placed after the local steps (§16, steps 14,
   18). Decide whether the first Notion milestone needs remote mode or a local
   bridge.
2. **Single service vs per-client processes.** Today each stdio MCP client
   starts its own `crot-mcp`, and only one instance can own the browser bridge
   (`in_use`). The target supervised service (§24) needs a decision on how
   stdio clients attach to it.
3. **Capability naming for external MCP and remote principals.** Per-server /
   per-tool capabilities, and whether remote principals get a separate (e.g.
   stricter) capability profile.
4. **Isolation of locally started external MCP servers.** An external server
   started locally over stdio is local code with the user's OS permissions;
   CROT has no OS-level sandbox. Decide whether such servers are supported and
   how they are confined.
5. **Server-initiated MCP features** of external servers (requests back to the
   client, root listings and similar): forwarding policy.
6. **Confirmation policy.** Which operations require confirmation, and the
   behaviour without an available UI (headless use).
7. **Relay encryption model.** Whether traffic is end-to-end encrypted between
   client and device or TLS terminates at the relay (the relay then sees
   traffic in transit, even though it never stores it).
8. **Licensing offline.** Whether any local feature is paid and, if so, how
   entitlements are checked offline without making local mode depend on the
   network.
9. **Local HTTP credentials.** Whether the static local token is replaced by
   device credentials for local HTTP clients too, or only for remote mode.
