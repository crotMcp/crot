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
> Open questions that need a separate architectural decision are listed in §26;
> decisions taken for work packages are recorded in §27.

## 1. Product

**CROT** is an installable, commercial, local AI-agent bridge and MCP gateway.

CROT combines the user's computer, the user's browser and external
MCP-compatible services into one controlled environment for AI agents.

The product has three parts:

| Part | What the agent gets | Status |
| --- | --- | --- |
| Local computer | files, processes, shell, Git, Docker and further local capabilities | **[Implemented]** files, processes, shell, Git read (`git.read`), local Git write (`git.write`) and dedicated Docker operations (`docker.use`, see §5) |
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
   (git, docker: dedicated services; rest via shell.execute) v
                                                     crot-browser-relay
                                                     (native-messaging host, started by browser)
                                                              | Native Messaging (stdin/stdout)
                                                              v
                                                     CROT Browser Extension (MV3)
                                                              | chrome.tabs / chrome.scripting
                                                              v
                                                     User's browser profile
```

The `GitService` (`git.read`, §27 AD-1; `git.write`, §27 AD-2) is a Core
capability next to `ProcessService`: it runs through the same ExecutionGuard and
starts Git through the `ProcessLauncher` in PATH-only mode. Git network
operations (fetch, pull, push) are not part of it.

The `DockerService` (`docker.use`, §27 AD-3) is a Core capability of the same
kind: a fixed set of Docker operations (`ps`, `logs`, `compose up`,
`compose down`) through the ExecutionGuard, with the Docker CLI started through
the `ProcessLauncher` in PATH-only mode.

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
   FileSystemService / ProcessService / GitService -> Platform (Native Host) ->
   OS -> audit -> result.
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
- filesystem, process and Git read access;
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
- Git — **[Partial]**: read operations (`status`, `diff`, `log`, `branch`, `show`) are a dedicated capability gated by `git.read` (§27 AD-1); local write operations (`add`, `commit`, branch create/rename/delete, checkout of a branch or a detached commit) are gated by `git.write` (§27 AD-2); network operations (fetch, pull, push) and destructive operations (amend, force, reset) are not implemented and remain usable only through `shell.execute`
- Docker — **[Partial]**: dedicated operations gated by `docker.use` (§27 AD-3): list containers, read container logs, `compose up` and `compose down` with a reviewed Compose model; build, pull, push, run, exec and every other Docker command are not implemented and remain usable only through `shell.execute`
- Network — **[Partial]**: HTTP(S) requests made by CROT itself, gated by `network.access` and the host policy `permissions.network` (§27 AD-4); no OS-level egress control for processes or containers
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

Enforced today: all of the above. `network.access` gates CROT's own HTTP
requests (`network_request`) together with the host policy
`permissions.network` (§27 AD-4); it does not restrict the network traffic of
processes or containers started through other capabilities.

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
21. Dedicated Git/Docker capabilities             [Partial: git.read (WP-10, §27 AD-1), git.write (WP-11, §27 AD-2) and docker.use (WP-12, §27 AD-3) implemented; Git network operations Target, §5]
22. Network access for CROT requests               [Implemented: network.access (WP-13, §27 AD-4)]
23. OS-level egress control for processes/Docker  [Target, §27 AD-4]
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
| Repository contents (`git.read`) | Core + Git on `PATH` | repository files and repository Git configuration | §27 AD-1: PATH-only lookup, configuration allowlist, hardened invocation, metadata lock | **[Implemented]** |
| Repository contents (`git.write`) | Core + Git on `PATH` | repository files, repository Git configuration, hooks, agent-supplied messages and names | §27 AD-2: AD-1 checks plus hooks/editors/signing/maintenance disabled, fixed non-destructive commands, exclusive metadata lock, protected paths | **[Implemented]** |
| Docker (`docker.use`) | Core + Docker CLI on `PATH` | Compose files, env files, container labels and logs, the Docker daemon | §27 AD-3: fixed operations, Compose policy and host-path checks, canonical private model file, no build/pull, environment allowlist | **[Implemented]** |
| Local transports | Core | other local programs | stdio parent only; loopback HTTP with bearer token, Host/Origin checks | **[Implemented]** |
| Browser | Core | bridge, relay, extension, browser, web pages | token-authenticated IPC, browser cannot initiate, fixed commands, result validation; page content untrusted | **[Implemented]** |
| External MCP | Core | external servers, their tools and data | §18 | **[Target]** |
| Remote access | local CROT | relay, remote clients, network | §22 | **[Target]** |
| User tokens | identity provider + local verifier | token holders | short-lived, revocable, audience-bound tokens; Core sees only a Principal | **[Target]** (today: static local token) |
| Device | device credential | other devices, cloned installs | device identity and binding, revocation (§20) | **[Target]** |
| Commercial | local execution | commercial service | entitlements never enter local authorization (§23) | **[Target]** |
| User confirmation | user via UI provider | agent, page/tool content | §21, §27 AD-5…AD-11 (mechanism; no provider yet) | **[Partial]** |
| Untrusted content (prompt injection) | Core (session exposure) | web pages, HTTP responses, later external MCP results | §27 AD-12: session exposure from source operations; effectful operations in an exposed session need approval | **[Implemented]** (WP-16b) |

Cross-cutting rule: **untrusted content never becomes a local command by
itself.** Web pages, external MCP results, files read by tools and relay
traffic are data. CROT never parses results to trigger operations; every
operation must arrive as a new tool call and pass the full pipeline. CROT cannot
stop an agent from following injected instructions; mitigations are capability
scoping, user confirmations (§21), session exposure (§27 AD-12) and audit.

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

**[Partial]** — the mechanism (approval gates) is implemented in Core (WP-15);
no approval provider (UI) exists yet, so with gate rules configured the gated
operations are denied. The tray app provider is **[Target]**.

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
§27 AD-12 decides one part of it: in a session that has read untrusted content
(exposure), operations with effects require confirmation by default.

The mechanism (approval gates: placement, approval subject, request
lifecycle, queue, provider interface, audit, threat model) is designed in
`docs/design/approval-gates.md` (WP-14) and decided in §27 AD-5, AD-6
(browser tab/origin binding) and AD-7 (audit failure). AD-8 (`tabs.resolve`),
AD-9 (browser `connectionId`), AD-10 (`permissions.approvals` location and
defaults) and AD-11 (expected browser subject check) complete the contract.
WP-15 implements it: `src/core/approvals/` (broker, rules, subject digest),
the gated path of `ExecutionGuard`, `permissions.approvals`, `tabs.resolve`,
the bridge `connectionId` and the extension's expected browser subject check.

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
| Git read operations (`git.read`: status, diff, log, branch, show) | **[Implemented]** (WP-10, §27 AD-1) |
| Git local write operations (`git.write`: add, commit, branch create/rename/delete, checkout) | **[Implemented]** (WP-11, §27 AD-2) |
| Docker dedicated operations (`docker.use`: ps, logs, compose up/down) | **[Implemented]** (WP-12, §27 AD-3) |
| Git network operations | **[Target]** (usable via shell) |
| HTTP(S) requests with host policy (`network.access`) | **[Implemented]** (WP-13, §27 AD-4) |
| OS-level egress control for processes and containers | **[Target]** (§27 AD-4) |
| Local MCP tools over stdio | **[Implemented]** |
| Streamable HTTP, loopback, local token | **[Implemented]** |
| Native Host (OS platform layer) | **[Implemented]** |
| Browser bridge, relay, extension (Chromium) | **[Implemented]** |
| External MCP gateway / MCP client | **[Target]** |
| User confirmations | **[Partial]** (mechanism implemented: WP-15, §27 AD-5…AD-11; no approval provider yet) |
| Untrusted-content exposure (prompt-injection mitigation) | **[Implemented]** (WP-16b, §27 AD-12) |
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
   behaviour without an available UI (headless use). WP-14 (§27 AD-5) fixes
   the mechanism and the headless behaviour (deny); §27 AD-12 adds the
   built-in `untrusted-content` rule for exposed sessions. The general list
   of gated operations remains open.
7. **Relay encryption model.** Whether traffic is end-to-end encrypted between
   client and device or TLS terminates at the relay (the relay then sees
   traffic in transit, even though it never stores it).
8. **Licensing offline.** Whether any local feature is paid and, if so, how
   entitlements are checked offline without making local mode depend on the
   network.
9. **Local HTTP credentials.** Whether the static local token is replaced by
   device credentials for local HTTP clients too, or only for remote mode.

## 27. Architectural Decisions

Decisions taken for individual work packages that extend or constrain this
contract. Each decision states its context, the decision and its scope.

### AD-1. `git.read` never runs repository-controlled programs (WP-10)

**Context.** Git reads configuration from the repository (`.git/config`,
`config.worktree`, included files) and from the user's system and global
configuration. Several settings make Git start programs during *read*
commands: `core.fsmonitor`, `core.pager`, `diff.external`,
`diff.<driver>.textconv` / `.command`, `filter.<driver>.clean` / `.process`,
`gpg.program` with `log.showSignature`, credential helpers, `core.sshCommand`
and others. Repository contents are controlled by whoever produced the
repository (a cloned project, an archive, an agent with `filesystem.write`).
On Windows, command lookup searched the working directory before `PATH`, so a
`git.exe` / `git.bat` inside the repository could run instead of Git.

**Decision.**

1. **Read stays read.** A `git.read` operation never starts a program chosen by
   repository contents or by repository-local Git configuration. The only
   program it runs is the Git executable found on `PATH`.
2. **PATH-only executable lookup.** `ProcessLauncher.resolveCommand` has a
   PATH-only mode (`searchCurrentDirectory: false`): the working directory and
   relative `PATH` entries are not searched, and relative command paths are
   refused. `git.read` always uses this mode. Every launcher implementation
   (Core and Native Host) must honour it. The lookup of `shell.execute` /
   `process.manage` commands is unchanged.
3. **Repository discovery in Core.** The repository is located without running
   Git: from the working directory upwards to the first `.git` directory or
   `.git` file (`gitdir:`), plus `commondir` for linked worktrees. These
   pointers are treated like symlinks: the resolved worktree, Git directory and
   common directory are paths of the operation and are authorized by the
   PermissionEngine (in sandbox mode they must be inside the workspace unless
   `filesystem.full` is granted). Git then runs with explicit `--git-dir` and
   `--work-tree`, and inherited `GIT_*` environment variables are removed. Bare
   repositories are not supported.
4. **Configuration.** System and global configuration are not loaded
   (`GIT_CONFIG_NOSYSTEM`, `GIT_CONFIG_GLOBAL` points to an empty file created by CROT); a fixed
   list of line-ending and display settings that cannot start programs is
   carried over from them. Repository configuration (local and worktree scope)
   is checked against an allowlist of keys that cannot start programs. Any other
   key, including `include` / `includeIf`, fails the operation with
   `UNSAFE_REPOSITORY` before Git reads the repository; the error names the
   keys, never their values. The check is deny-by-default: keys are added to
   the allowlist only when they are known not to start programs.
5. **Hardened invocation.** Git runs with external programs disabled
   (`--no-pager`, `--no-ext-diff`, `--no-textconv`, `core.fsmonitor=false`, no
   signature verification, no submodule recursion, `protocol.allow=never`,
   `GIT_NO_LAZY_FETCH`), without optional writes (`GIT_OPTIONAL_LOCKS=0`) and
   with Git 2.32 or newer. Agent-supplied revisions cannot be options
   (`--end-of-options`; a leading `-` is refused); paths are passed after `--`
   as literal pathspecs.
6. **No check/use race inside CROT.** Core holds a lock per Git directory: a
   `git.read` operation (configuration check and Git commands) and a CROT
   `filesystem.write` operation (write, create directory, delete, move) whose
   paths are inside, or contain, that Git directory never run at the same time.
   The permission model is unchanged: writes into `.git` remain allowed under
   `filesystem.write`.

**Scope and limits.**

- Programs that modify the repository outside CROT's filesystem operations
  (commands run through `shell.execute` / `process.manage`, other local
  programs) are not serialized with `git.read`. They already execute code with
  the user's permissions; this decision guarantees that a *read* operation does
  not become such code execution.
- The Git installation on `PATH` and its built-in behaviour are trusted, like
  every other program on `PATH`.
- Write operations (`git.write`) are covered by AD-2, which builds on this
  decision without weakening it.

### AD-2. `git.write` never runs repository-supplied programs (WP-11)

**Context.** Git write commands start more programs than read commands: hooks
(`pre-commit`, `commit-msg`, `post-checkout`, `reference-transaction`, …) from
`.git/hooks` or `core.hooksPath`, editors (`core.editor`, `GIT_EDITOR`),
signing programs (`gpg.program`, `commit.gpgSign`), automatic `gc` /
maintenance, clean/smudge filters, and network access for some operations.
Hooks and their location are repository contents. An agent with `git.write`
also supplies commit messages and branch names, which must never become
options or programs.

**Decision.**

1. **Write never runs repository programs.** A `git.write` operation never
   starts a program supplied by repository contents, repository configuration
   or the agent. The only program it runs is the Git executable found on
   `PATH`. Every AD-1 rule applies unchanged: PATH-only lookup, repository
   discovery in Core and authorization of the worktree / Git directories,
   configuration allowlist with `UNSAFE_REPOSITORY` before Git touches the
   repository, hardened invocation and no inherited `GIT_*` variables.
2. **Programs disabled for every write command.** `core.hooksPath` points to the
   null device (no hook is ever found), `commit --no-verify`, signing off
   (`--no-gpg-sign`, `commit.gpgSign=false`, `tag.gpgSign=false`), editors are
   `:` (`core.editor`, `sequence.editor`, `GIT_EDITOR`, `GIT_SEQUENCE_EDITOR`),
   `gc.auto=0`, `maintenance.auto=false`, no submodule recursion,
   `protocol.allow=never`.
3. **Identity is data.** `user.name` and `user.email` are carried over from
   system/global configuration with `-c` as plain values only for the commit
   author/committer (repository-local values win; values with control
   characters are dropped). `user.useConfigOnly=true` keeps Git from guessing
   an identity. No further system/global configuration is loaded.
   The line-ending settings carried over by AD-1 (`core.autocrlf`, `core.eol`,
   `core.safecrlf`) and the repository's own settings and `.gitattributes`
   (`text`, `eol`) apply to `add` and `checkout` exactly as in the user's Git:
   for example, with Git for Windows' default `core.autocrlf=true` a checkout
   writes CRLF and `add` stores LF. CROT does not override them.
4. **Fixed, non-destructive operations.** `add` (literal paths in the worktree
   or the whole worktree; no `--force`, nothing inside the Git directories,
   symlinks staged as links), `commit` with a message (`--message=` as one
   argument; optional `allowEmpty`), `branch` create (`--no-track`) / rename
   (`-m`) / delete (`-d`), and `switch` to a local branch or to an explicitly
   requested detached commit (`--no-guess`, never `--force`). Branch names and
   revisions cannot be options (`--end-of-options`, a leading `-` is refused).
   Push, fetch, pull, amend, force, `-D`, reset, checkout of paths and every
   network operation are not available.
5. **Exclusive metadata lock.** A `git.write` operation holds the repository's
   Git directory and common directory exclusively: it never overlaps another
   `git.write`, a `git.read` or a CROT `filesystem.write` operation on them.
6. **Protected paths.** `git.write` is a write capability for the
   PermissionEngine's protected-path rule (like `filesystem.write`): an
   operation whose worktree or Git directories contain CROT's audit log or
   configuration file is denied. The rule is not extended to ordinary `.git` writes
   through other capabilities.
7. **Audit.** Paths and branch names are recorded; commit messages are recorded
   only as length and SHA-256 digest.

**Scope and limits.**

- `git.write` is independent of `git.read`; each is granted on its own.
- The limits of AD-1 apply: programs outside CROT's operations are not
  serialized, and Git on `PATH` with its built-in behaviour is trusted.
- Committing while a merge is in progress concludes the merge (Git's own
  behaviour); `git switch` refuses to overwrite local changes.

### AD-3. `docker.use` runs only fixed Docker operations under CROT's path rules (WP-12)

**Context.** Docker can mount any host path into a container and run any
program there; a Compose file can request privileged containers, host
namespaces, devices or builds. Without a dedicated capability Docker was only
reachable through `shell.execute`, which gives no Docker-specific guarantees.

**Decision.**

1. **Fixed operations, no shell.** `docker_ps`, `docker_logs`,
   `docker_compose_up` and `docker_compose_down` are the only operations. The
   Docker CLI is resolved on `PATH` only (never the current directory), started
   with a fixed argument vector (no shell), no stdin, a private temporary
   working directory, output limits and a timeout. Container references,
   project and service names are validated by strict patterns and placed after
   `--`; no agent value can become an option. Build, pull, push, run, exec, cp
   and every other Docker command are not available; `up` always uses
   `--pull never --no-build --detach`.
2. **Environment allowlist.** Only `PATH`, home/temp/locale variables, Docker
   connection variables (`DOCKER_HOST`, `DOCKER_CONTEXT`, `DOCKER_CONFIG`, TLS),
   `SSH_AUTH_SOCK` and proxy variables are passed; all `COMPOSE_*` variables are
   removed so the environment cannot add files, profiles or a project name.
3. **Every step is an ExecutionGuard operation** with `docker.use` and the
   paths it touches (`docker.inspect`, `docker.logs`, `docker.compose_config`,
   `docker.compose_up`, `docker.compose_ps`, `docker.compose_down`), so the
   PermissionEngine applies the normal workspace boundary: paths outside the
   workspace additionally need `filesystem.full`.
4. **Container scope.** A container belongs to the directory in its Compose
   `working_dir` label. `docker_ps` with workspace scope lists only containers
   whose label directory is inside the workspace; scope `all` and containers
   without the label need `filesystem.full`. `docker_logs` inspects the
   container first and checks its label directory the same way.
5. **Compose pipeline.** The project directory, Compose files and `.env` are
   resolved through the Workspace (canonical, symlinks followed) before any
   Docker call. The files are scanned as text (size, encoding, `include`,
   `extends`, `label_file`, YAML tags and escapes are refused), the env files
   they reference are resolved and checked, then `docker compose config`
   produces the normalized model. A deny-by-default policy reviews it: only
   allowlisted top-level, service, mount, volume, network, secret and config
   keys are accepted; privileged mode, capabilities, devices, host namespaces,
   `build`, security options and similar keys are refused with
   `UNSAFE_COMPOSE`. Every host path (bind mounts, file secrets and configs) is
   resolved through the Workspace and part of the guarded `docker.compose_up`
   operation; external volumes need `filesystem.full`.
6. **Canonical private model.** `up` does not read the user's files again: the
   reviewed model with canonical host paths is written to a private temporary
   file and passed with an empty `--env-file`, so a file changed after the
   review is not used.
7. **Protected paths.** A writable bind mount that exposes CROT's audit log or
   configuration file is denied (`PERMISSION_DENIED`) in every mode.
8. **Down.** `compose down` looks up the project's containers by label, checks
   their label directories like `logs`, and runs with an empty private model
   and `--remove-orphans`; volumes and images are never removed.
9. **Audit.** Operations, paths, project and service names, container ids and
   exit codes are recorded; logs and Compose contents are not.

**Scope and limits.**

- `docker.use` is not an OS sandbox: a container can do whatever its image does
  with the mounts and networks the reviewed model allows. Container labels are
  set by whoever created the container; a container created outside CROT can
  claim any `working_dir`.
- Host paths are checked when the model is reviewed; a path replaced by a
  symlink between the check and the daemon's mount is not detected.
- With a remote `DOCKER_HOST` host paths refer to the remote machine.
- `include`, `extends` and the implicit `compose.override.yaml` are not
  supported; additional files must be listed explicitly.
- `docker.use` is not part of the sandbox defaults; it is granted explicitly
  (in sandbox mode only for the workspace) or by `full_control`.
- Networks created by a project may remain after `down` if other containers use
  them.
- `shell.execute` remains a broader path to Docker and is governed by its own
  capability.

### AD-4. `network.access` is a host policy for CROT's own HTTP requests (WP-13)

**Context.** An agent that can send HTTP requests can reach services on the
user's computer and local network (loopback admin interfaces, routers, cloud
metadata endpoints) and can exfiltrate data. Hostname allowlists are commonly
bypassed with numeric IP forms, DNS names that resolve to internal addresses,
DNS rebinding between check and connect, redirects to internal hosts, proxy
environment variables and IPv4-mapped/NAT64 IPv6 addresses.

**Decision.**

1. **One dedicated operation.** `network_request` (Core `NetworkService`) sends
   one HTTP(S) request: methods GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS;
   `http`/`https` URLs only; URLs with credentials are refused; hop-by-hop,
   `Host`, `Content-Length`, `Transfer-Encoding`, proxy and similar headers are
   refused. No raw TCP, WebSocket or other protocol is available.
2. **Capability and policy.** The request needs `network.access` **and** an
   allow rule in `permissions.network.allow`; without the capability, without a
   matching rule or with a matching deny rule the request is denied
   (`PERMISSION_DENIED`). `network.access` is not in the sandbox defaults, and
   the default policy is empty, so the default is denial. Network destinations
   are authorized only through `network.access`: the PermissionEngine denies any
   operation carrying network targets under another capability, and
   `network.access` grants nothing for files, shell, processes, Git or Docker.
3. **Rules.** `host`, `*.host` (subdomains only), an IP address, a CIDR range or
   `*`, optionally with `:port` or `:*` (IPv6 in brackets when a port is given).
   An allow rule without a port allows ports 80 and 443; a deny rule without a
   port denies every port. Deny wins. Host rules match names only, IP/CIDR rules
   match addresses (the literal address or every resolved address). Rules are
   validated and canonicalized at startup; invalid or non-canonical rules are a
   `CONFIG_ERROR`. In sandbox mode `*`, single-label wildcards and ranges wider
   than /8 (IPv4) or /32 (IPv6) are refused.
4. **Address classes.** Addresses are parsed canonically (WHATWG URL parsing
   turns decimal, octal, hex and shortened IPv4 forms into dotted quads;
   IPv4-mapped, NAT64 and 6to4 IPv6 addresses are classified by their embedded
   IPv4 address). Loopback, private, link-local (including cloud metadata
   addresses), unspecified, multicast, documentation and reserved addresses are
   reachable only through an explicit IP/CIDR allow rule, never through a host
   rule or `*`.
5. **Check before DNS, pin after DNS.** The host name is checked before it is
   resolved (`network.resolve`), so a denied name is never looked up. The name
   is resolved once; every resolved address is then checked
   (`network.request`), and the connection is made only to those checked
   addresses through a pinned lookup. A DNS answer that changes after the check
   (DNS rebinding) is not used. `localhost` and `*.localhost` resolve to
   loopback without DNS.
6. **Redirects.** Redirects are followed manually up to
   `limits.maxNetworkRedirects` (or not at all with `followRedirects: false`);
   each hop is checked from step 5 again. An `https` request never follows a
   redirect to `http`; `Authorization` and `Cookie` are removed on a
   cross-origin redirect; 303 (and 301/302 after POST) become GET.
7. **No proxy, no ambient configuration.** Requests use a private agent without
   keep-alive; `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY` and similar variables are
   ignored, so a proxy cannot bypass the check. TLS uses the system/Node trust
   store with certificate verification on.
8. **Limits.** An overall deadline per request including DNS and redirects
   (`timeoutMs`, default `limits.defaultNetworkTimeoutMs`, at most
   `limits.maxNetworkTimeoutMs`) gives `TIMEOUT`; the request body is limited to
   1 MiB and the response to `maxResponseBytes` (at most
   `limits.maxNetworkResponseBytes`, then `truncated`). Shutdown aborts requests
   in flight.
9. **Audit.** Each hop is an ExecutionGuard operation with method, origin
   (scheme, host, port), hop number and the checked addresses; paths, query
   strings, headers and bodies are not recorded.

**Scope and limits.**

- `network.access` controls only requests made by CROT itself. It is **not an
  OS-level firewall**: programs started through `shell.execute` or
  `process.manage`, Git through the shell and Docker containers keep the
  network access the operating system gives them; `network.access` neither
  grants nor restricts it. Those paths are governed by their own capabilities;
  note that `shell.execute` and `process.manage` are sandbox defaults, so a
  sandbox that grants them can reach the network through child processes
  exactly as before WP-13. Restricting that traffic needs OS-level egress
  control (firewall rules per process, network namespaces, a filtering proxy
  forced on child processes, Docker network policy) and is a separate work
  package (§16, step 23).
- The system DNS resolver is trusted to answer the lookup; CROT pins the
  answer but cannot verify it. TLS protects `https` hosts against a hostile
  resolver, `http` does not.
- Response content is untrusted data and is returned to the agent as is.
- The browser bridge (`browser.*`) navigates the user's browser, which has its
  own network access; it is not governed by `network.access`.

### AD-5. Approval gates only narrow an authorized operation and only the user can open them (WP-14)

**Context.** §21 requires explicit user approval for sensitive operations, with
deny as the safe default, and §2.3 path 5 places it in the ExecutionGuard. The
mechanism has to be reusable later for browser-originated actions,
prompt-injection mitigation and remote FULL CONTROL. It must not become a
second permission system or a way around the PermissionEngine. Approval
prompts face the same adversaries as the rest of CROT: the agent, injected
content, the browser side, other local processes and later the relay. The
full design is `docs/design/approval-gates.md`.

**Decision.**

1. **Narrow only, after authorization.** The gate is a step of the
   ExecutionGuard. It runs after `PermissionEngine.authorize()` has allowed
   every capability of the operation. Its results are "continue" or "deny".
   `authorize()` and `AuthorizationDecision` stay unchanged and binary. An
   approval never grants a capability, a path outside the workspace, a
   protected path or a network destination.
2. **Policy in the PermissionEngine.** Gate rules are a validated, immutable
   policy section (`approvals`). They match on Core facts only: operation,
   capabilities, principal kind, mode and paths outside the workspace; later
   also origin and session exposure. A new pure engine method evaluates them,
   and services cannot opt out. The default is no rules, which keeps today's
   behaviour. Which operations are gated stays open (§26, question 6).
3. **The user approves one concrete operation.** Core builds the approval
   subject from the arguments `execute()` captures, never from agent-supplied
   text. The subject is bound by a SHA-256 digest and a random request id, and
   the approval is single-use. After approval the operation is re-authorized
   and re-validated before it runs. There are no "always allow" or batch
   approvals; changing what is gated means changing the configuration.
4. **Unambiguous lifecycle; everything except approval denies.** The statuses
   are `pending` and the terminal `approved`, `rejected`, `expired`,
   `cancelled` and `unavailable`. The first terminal transition wins. Timeout,
   caller abort, shutdown, a missing provider and a full queue all deny.
   Requests live only in memory, and nothing (locks, processes) is held while
   waiting.
5. **Bounded queue.** There is one FIFO queue per process with a configured
   maximum. A request that does not fit is `unavailable` immediately. Requests
   are never merged or resubmitted automatically, and the agent cannot see the
   queue.
6. **Providers outside Core, registered only in the composition root.** Core
   defines the `ApprovalProvider`, ticket and broker interfaces. UIs implement
   them outside Core (the tray first) and are registered only in
   `CrotCore.create`. MCP adapters, the browser side, external MCP and the
   relay never get the broker and are never providers. The approval channel is
   always independent of the request path.
7. **Agent result and audit.** When the gate does not approve, the agent gets
   the existing `PERMISSION_DENIED` with `details.approval: { requestId, status }`.
   Every gated operation still writes one audit event, with an additive
   `approval` block: request id, status, rule, subject digest, timestamps,
   wait time, provider and cancel reason. The subject itself is never recorded,
   and the audit outcome values stay the same.

**Scope and limits.**

- This is a design only. The implementation, the tray provider and its
  authenticated local control channel are separate work packages.
- If CROT crashes while a request is pending, no audit event is written;
  nothing was executed.
- An approval cannot make an operation safe if the user does not understand
  it. Policy scoping and audit remain the other mitigations (§19).

**Former open decisions.** The two open decisions recorded with this decision
(OD-1, OD-2) are decided: OD-1 by AD-6 (browser tab/origin binding), OD-2 by
AD-7 (audit failure for gated operations). AD-7 amends point 7 for approved
operations.

**WP-15 contract.** AD-8 (`tabs.resolve`), AD-9 (`connectionId`), AD-10
(`permissions.approvals` location and defaults) and AD-11 (expected browser
subject check) are part of the contract that
WP-15 implements, together with AD-5, AD-6 and AD-7.

### AD-6. A browser approval is bound to one tab and origin and checked again right before the action (WP-14, OD-1)

**Context.** AD-5 binds an approval to one guard operation and its subject.
Browser operations also act on mutable state outside Core. The tab can be
closed or reused, the active tab can change, and the page can navigate to
another origin while the request is pending. An approval given for one page
must not end up acting on another. The approval-gates design left this open as
OD-1 because it needs a change of the browser command protocol.

**Decision.**

1. **Binding fixed at request time.** When an approval request is created for a
   `browser.*` operation that targets a tab, Core records the identity of the
   target tab and its origin in the approval subject. The identity is the
   concrete tab id together with the browser connection it belongs to; a
   default "active tab" is resolved to a concrete tab id at that point. The
   origin is the tab's current origin. Both are covered by the subject digest
   and shown to the user. `browser.tab_open` has no existing tab, so it is
   bound to the origin of the URL it opens.
2. **Re-check immediately before execution.** The bound tab identity and origin
   are sent with the browser command as an expected-tab/origin precondition.
   The extension checks the precondition immediately before it performs the
   action, as part of the same command. This is the browser command protocol
   change for gated operations.
3. **Invalidation.** The approval is invalidated, and the operation is denied
   without acting, if the tab no longer exists, its identity no longer matches
   (for example after the browser connection changed), or its origin differs
   from the bound origin. If the binding cannot be established at request time,
   no approval can be given and the operation is denied.
4. **No transfer.** An approval is never applied to another tab or origin, and
   it is never re-bound after invalidation. A new attempt is a new request.

**Scope and limits.**

- This applies only to gated `browser.*` operations. Browser operations that no
  gate rule matches keep today's protocol behaviour.
- The binding is to the origin, not the full URL; navigation within the same
  origin does not invalidate the approval.
- The approval does not cover what the page does after the action (for
  example, a click that starts a navigation).

### AD-7. A gated operation is refused if its mandatory audit record cannot be written (WP-14, OD-2)

**Context.** Audit write failures never affect operations today
(`onAuditError`). For an operation that requires user approval, the audit
record is the only lasting evidence of what the user approved. Running such an
operation without it would leave an approved, executed operation with no
record. The approval-gates design left this open as OD-2.

**Decision.**

1. **Audit failure means deny.** For an operation that requires approval,
   failure to write its mandatory audit record means the operation is refused.
   It does not run.
2. **Approval completes only with its audit record.** An approval is not
   successfully completed until its mandatory audit record has been written.
   The record must therefore be written after the approval and before
   `execute()` starts; only then may the operation run. This amends AD-5 point
   7 (one audit event per operation) for approved operations: they have this
   record before execution in addition to the event written after execution.
3. **The record attests approval, not execution.** The mandatory record states
   only that the operation was approved and authorized to run. It does not
   state that the operation ran or succeeded. The execution result is only in
   the event written after execution (`success` or `error`). If the process
   stops after the mandatory record was written, or the operation fails, the
   mandatory record must not be read as successful execution. A mandatory
   record without a matching post-execution event means the result is
   unknown.
4. **Other operations unchanged.** This does not change the global audit
   policy. Operations that require no approval keep today's behaviour: audit
   failures are reported through `onAuditError` and do not affect the
   operation.

**Scope and limits.**

- Once `execute()` has started, its effects cannot be revoked. A failure to
  write the event after execution cannot undo the operation.
- A denied gated operation whose denial cannot be recorded stays denied.

### AD-8. `tabs.resolve` binds a gated browser operation to a concrete tab before the approval request (WP-15 contract)

**Context.** AD-6 point 1 requires Core to record the concrete target tab and
its origin when an approval request for a `browser.*` operation is created; a
default "active tab" must be resolved to a concrete tab id at that point. The
extension's default target is the active tab of the last focused window. The
existing `tabs.list` reports `active` per window but not which window was last
focused, so Core cannot reproduce that choice, and no existing command returns
the tab a command would act on. Found while planning WP-15.

**Decision.**

1. **New browser command `tabs.resolve`.** It is used only for gated
   `browser.*` operations that target a tab. It lets Core obtain the concrete
   tab and its current origin for the approval subject.
2. **Minimal contract.**
   - Parameters: `{ tabId?: number }`, the operation's own `tabId` argument.
   - Resolution: the extension resolves the tab exactly as the operation's
     command would: the given tab, or the active tab of the last focused window
     when `tabId` is omitted.
   - Result: `{ tabId: number, url: string }`, the concrete tab id and the URL
     currently committed in that tab. The result is untrusted and is validated
     by Core like every browser response. Core derives the bound origin from
     `url`; only `http:` and `https:` origins can be bound.
   - The command reads only the tab id and URL. It does not read page content
     and does not act on the page.
3. **Order in the pipeline.** Core sends `tabs.resolve` after `authorize()` has
   allowed the operation and the gate rule has matched, and before the approval
   request is created. It needs no capability of its own and adds none; it is
   not an agent-callable tool and is not audited as an operation of its own.
   For `browser.tab_open`, which targets no existing tab, it is not sent; the
   operation stays bound to the origin of the URL it opens (AD-6 point 1).
4. **Unknown state means deny.** If the concrete tab or its current state
   cannot be determined — no such tab, no active tab, an invalid or
   unvalidated response, a URL without an `http:`/`https:` origin, a timeout,
   or a disconnected or changed connection (AD-9) — no approval request is
   created and the operation is denied (AD-6 point 3).
5. **Use of the result.** The resolved tab id and origin are written into the
   approval subject and covered by its digest. They are the expected tab and
   origin of the expected browser subject that the command carries and that is
   checked immediately before the action (AD-6 point 2, AD-11).

**Scope and limits.**

- This is part of the WP-15 contract. Browser operations that no gate rule
  matches do not use `tabs.resolve` and keep today's protocol behaviour.
- The resolved state is a snapshot. The re-check before the action (AD-6) is
  what prevents acting on a different tab or origin.

### AD-9. Every browser bridge connection has a `connectionId`; a new connection invalidates browser approvals (WP-15 contract)

**Context.** AD-6 binds a browser approval to the tab id together with the
browser connection it belongs to, and invalidates it when the connection
changed. Tab ids are only meaningful within one browser session; after a
reconnect or browser restart the same id can denote another tab. Today
`BrowserConnection` and `BrowserConnectionState` carry no connection identity,
so Core cannot tell two connections apart. Found while planning WP-15.

**Decision.**

1. **One id per connection instance.** The browser bridge creates a new random
   `connectionId` (at least 128 bits from a cryptographic source) every time it
   accepts a new `hello`. It is never reused and never derived from data sent
   by the browser. A reconnect of the same extension is a new connection with a
   new id.
2. **Minimal contract.**
   - `BrowserConnectionState` in state `connected` carries `connectionId`.
   - A browser request can carry an expected `connectionId`. The bridge sends
     it only if the current connection has that id. Otherwise it rejects the
     request without sending it; this is an expected-subject mismatch
     (AD-11) and the operation is denied with `PERMISSION_DENIED`.
   - The id is generated on the host side (bridge). The bridge tells the
     extension the id of its connection when it accepts the `hello`, so that
     the extension can perform the AD-11 check; the extension does not choose
     it and cannot change it. The authoritative check is the bridge's. The id
     is not part of agent-visible results or `crot_status`.
3. **Binding.** An approval for a `browser.*` operation records the
   `connectionId` of the connection current when the request is created. The
   `tabs.resolve` request (AD-8) is sent with that id. The id is part of the
   approval subject and covered by its digest.
4. **Re-check before execution.** Immediately before the operation's command
   is sent, the bridge checks that the connection is still the recorded one. If
   the connection was replaced, lost or never re-established, the approval is
   invalid and the operation is denied without acting. As today, requests in
   flight on a connection that goes away fail.
5. **No transfer.** An approval is never moved to a new connection. A new
   attempt is a new request (AD-6 point 4).

**Scope and limits.**

- This is part of the WP-15 contract. It is needed only for gated `browser.*`
  operations; other browser operations do not have to carry the id.
- The id identifies a bridge connection, not a browser profile or a user.

### AD-10. Approval rules live in `permissions.approvals` with fixed defaults (WP-15 contract)

**Context.** The approval-gates design (§5, §7.2, §8) left the location of the
`approvals` configuration section and its default values as proposals.

**Decision.**

1. **Location.** The approval gate policy is configured in
   `permissions.approvals`, next to `permissions.network`. It is part of the
   PermissionEngine policy, validated at startup and immutable at runtime
   (AD-5 point 2).
2. **Content and defaults.**
   - `rules`: gate rules (AD-5 point 2); default: none, so nothing is gated.
   - `timeoutMs`: approval timeout; default **45 000 ms** (45 s).
   - Maximum approval timeout: **300 000 ms** (300 s). A larger `timeoutMs`
     is a `CONFIG_ERROR` at startup.
   - `maxPending`: maximum number of pending approval requests; default **8**.

**Scope and limits.**

- This is part of the WP-15 contract. It fixes only the location and the
  default values; which operations are gated stays open (§26, question 6).
- Point 2 is amended by AD-12: besides user rules (none by default), the
  built-in `untrusted-content` rule for exposed sessions is active by default
  and can be turned off with `permissions.approvals.untrustedContent: "off"`.

### AD-11. A gated browser command carries an expected browser subject that must match right before the action (WP-15 contract)

**Context.** AD-6 point 2 requires the bound tab and origin to be sent with the
browser command and checked immediately before the action, and AD-9 adds the
connection to the binding. AD-6, AD-8 and AD-9 do not fix what exactly is
compared, how origins are compared, or which error a mismatch produces. This
decision fixes the semantics and the error; internal field names are chosen by
the implementation.

**Decision.**

1. **Expected browser subject.** Every command of a gated `browser.*`
   operation carries an expected browser subject with at least:
   - `tabId`: the concrete tab id resolved by `tabs.resolve` (AD-8);
   - `origin`: the normalized origin bound in the approval subject;
   - `connectionId`: the bridge connection recorded in the approval (AD-9).

   The values are exactly those in the approved subject (covered by its
   digest). `browser.tab_open` targets no existing tab: its expected subject
   has no `tabId`, its `origin` is the normalized origin of the URL it opens,
   and it carries `connectionId`.
2. **Check immediately before the action.**
   - The bridge compares `connectionId` with its current connection before it
     sends the command (AD-9). On a mismatch the command is **not sent**.
   - The extension, as part of the same command and immediately before it
     acts, checks that the current tab id, the current normalized origin of
     that tab and the id of its current connection equal the expected values.
     The current origin is taken from the URL committed in the tab; if a
     navigation to a different origin is pending, the origins do not match.
     For `browser.tab_open` it checks `connectionId` and that the URL to open
     has the expected origin.
   - Any mismatch, a missing tab, or a value that cannot be determined means
     the action is **not performed** and the operation is denied. Nothing is
     retried, re-resolved or re-bound (AD-6 point 4).
3. **Normalized origin.** An origin is the WHATWG URL origin serialization
   (`scheme://host[:port]`: lowercase scheme and host, IDNA/punycode host,
   default port omitted), never a raw or partial URL string. Only `http:` and
   `https:` origins can be bound; opaque origins (`null`) and every other
   scheme never match. Origins are compared by exact string equality of their
   serializations.
4. **Narrow only.** The check only decides whether an already authorized and
   approved operation may still act. Passing it grants no capability, changes
   no permission and replaces neither `authorize()` nor the re-authorization
   after approval (AD-5).
5. **Error.** A mismatch uses the existing error code `PERMISSION_DENIED`; no
   new error code is introduced.
   - Agent: `PERMISSION_DENIED` with
     `details: { operation, missing: [], approval: { requestId, status: "approved" } }`
     (design §10) and a fixed, Core-defined message stating that the browser
     approval binding (tab, origin or connection) no longer holds.
   - Audit: the event after execution has outcome `denied` and
     `error.code: "PERMISSION_DENIED"` (design §11). The mandatory approval
     record (AD-7) stays as written and does not mean execution.
   - Bridge protocol: the extension reports a mismatch with the error code
     `PERMISSION_DENIED`. In browser responses this code is reserved for the
     expected-subject check; the extension uses it for nothing else. Core
     treats it, and its own `connectionId` mismatch, as a denial and never
     passes browser-supplied messages or details to the agent. An extension
     that reports a mismatch falsely can only cause a denial.

**Scope and limits.**

- This is part of the WP-15 contract. Commands of browser operations that no
  gate rule matches carry no expected subject and keep today's behaviour.
- The check binds the origin, not the full URL (AD-6), and does not cover what
  the page does after the action.

### AD-12. Untrusted content marks the session as exposed; an exposed session needs approval for operations with effects (WP-16)

**Context.** WP-16 requires that content from `browser.read` (and later from
external MCP servers) is treated as untrusted, and that shell and write
operations which may be driven by it need explicit approval. Planning WP-16
against the current code showed that this cannot be done per value:

- A tool result goes to the agent as text. The next tool call is new JSON
  composed by the model. The MCP protocol has no field that carries a
  provenance label from one result into a later call, and Core cannot link the
  arguments of a call to an earlier result.
- Linking them by comparing arguments with earlier results would be a hidden
  heuristic that any paraphrase, translation or encoding defeats, and it would
  make Core parse results, which §19 rules out. Returning opaque handles
  instead of content would break the existing tool contracts, and the agent
  would still see the content.
- The design reserved *exposure* for this (`docs/design/approval-gates.md`
  §13.2): Core records that a session has read untrusted content, and gate
  rules match on that fact. `AuthContext` has no session identity yet, the
  rule model has no exposure matcher, and AD-10 says that nothing is gated by
  default.

**Decision.**

1. **Model: session exposure, not value provenance.** Provenance is tracked
   per session as *exposure*: a Core fact with two states, `clean` and
   `exposed`, that changes only from `clean` to `exposed`. It is separate from
   the permission mode, the capability set and the principal, and it never
   grants anything. Core never labels argument values as trusted or untrusted
   by their content: text supplied by the user or the agent is not untrusted
   because it resembles instructions, and content cannot make itself trusted
   by its wording.
2. **Session.** `AuthContext` gets an optional session identifier (additive),
   set only by the transport adapter: for stdio, the server instance (one MCP
   connection); for HTTP, the MCP session, which is bound to its authenticated
   principal. Without a session identifier (embedding, tests), Core treats the
   whole process as one session, so exposure is never lost, only over-applied.
   Tool arguments, `principal.client`, the browser and page content can never
   set or change it.
3. **Sources.** Exposure sources are a Core-owned list of operation names
   whose successful result carries externally controlled content:
   - `browser.page_read`, `browser.screenshot` (text in images is read by
     vision models) and `browser.tabs_list` (tab titles and URLs are set by
     pages; titles of every open tab are returned, up to 10 000 characters
     each, including tabs the agent did not choose to read);
   - `network.request` (otherwise fetching the same page with
     `network_request` would bypass the browser sources).

   The session is marked after `execute()` of a source operation succeeded and
   before its result is returned. Marking depends only on the operation, never
   on the content, so nothing a page or response contains can avoid, undo or
   change it. It does not depend on the audit write. A failed or denied source
   operation does not mark. The list is checked against the known operation
   names (startup and tests). `browser.status` and the results of
   `browser.control` operations (tab id and URL) are not sources.
4. **Gate: the WP-15 approval gate, no second mechanism.** The rule model gets
   a matcher `exposed: boolean` (the session's exposure state), usable in user
   rules too. A built-in rule set with the reserved id `untrusted-content`
   (implemented as one or more ordinary `ApprovalRule`s evaluated by
   `PermissionEngine.approvalRequirement()`) matches an operation in an
   exposed session that requires any of the capabilities `shell.execute`,
   `filesystem.write`, `git.write`, `network.access` or `browser.control`, or
   is `docker.compose_up` or `docker.compose_down`. Such an operation goes
   through the unchanged pipeline: `authorize()` -> approval gate ->
   re-authorization -> mandatory approval record (AD-7) -> execution. The rule
   applies in every permission mode and to every principal kind. Reads
   (`filesystem.read`, `git.read`, Docker read operations, `browser.read`) are
   not gated by it.
5. **Default on, explicit opt-out (amends AD-10 point 2).** The built-in rule
   is active by default. `permissions.approvals.untrustedContent` is
   `"require-approval"` (default) or `"off"`. `crot_status` reports the
   setting. User rules may not use the reserved id (`CONFIG_ERROR`). AD-10
   point 2 now reads: no user rules by default; the built-in `untrusted-content`
   rule is active unless turned off. All other defaults of AD-10 stay.
6. **Headless.** Without an approval provider, an operation matched by the
   rule is denied (AD-5 point 3): after a source operation, the operations of
   point 4 are denied for the rest of the session. The agent gets the existing
   `PERMISSION_DENIED` with the approval details (design §10) and a
   Core-defined message saying that the session has read untrusted content.
   Browser and network access are off by default, so this applies only where
   the user enabled a source.
7. **Lifetime.** Exposure lasts until the session ends. It is kept in memory
   only. No tool, agent request, browser message, page content or
   configuration value can clear it, and an approval does not clear it: every
   matched operation asks again (design invariant I6). A reset by the user
   through an approval provider channel would need a separate decision.
8. **Audit.** Audit events stay as they are (§11 of the design); an operation
   gated by the rule is identified by `approval.rule: "untrusted-content"`.
   Source operations are already audited. Page content is never recorded.
9. **External MCP (prepared, not implemented).** Results of external MCP
   tools will be guard operations (§18) and become exposure sources by adding
   their operation names to the source list. No other mechanism is added.
10. **Precedence and multi-step calls (clarified in WP-16b).**
    - The built-in `untrusted-content` rules are evaluated before user rules.
      When a user rule and `untrusted-content` both match, `untrusted-content`
      is the matching rule: it is the `rule` of the approval subject (shown by
      the UI) and `approval.rule` in the audit log. Whether an operation needs
      approval does not depend on the order (any match gates it).
    - One `network_request` call is evaluated with the session's exposure at
      the start of the call: its `network.resolve` and `network.request`
      steps, including every redirect hop, use that snapshot. A session that
      was exposed before the call therefore needs approval for every hop. Each
      successful hop still marks the session, so every later, separate
      `network_request` call sees the current exposure. The snapshot is
      honoured only for `network.resolve` / `network.request`, only for the
      same session and only until the call returns.

**Scope and limits.**

- This decision is the contract of WP-16 (implementation: WP-16b). It is
  additive except for the amendment of AD-10 point 2.
- Exposure is coarse: one source operation exposes the whole session. This is
  the price of a mark that cannot be removed by transforming text.
- Exposure does not detect injection and does not inspect content. CROT still
  cannot stop an agent from following injected instructions in operations the
  rule does not gate (reads) or that the user approves (§19).
- A new session (a restarted stdio server, a new HTTP session) starts clean
  while the model's context may still hold earlier untrusted content. Core
  cannot see the client's context; this residual risk is accepted.
- File contents, repository data, process output and Docker logs are also
  untrusted (§19) but are not sources: marking them would expose almost every
  session and make approvals meaningless (design T9). Residual risk, accepted.
- Browser workflows that alternate reading and acting ask for approval for
  every action after the first read. Users who need autonomous browsing can
  turn the rule off or write narrower rules; the trade-off is theirs and is
  visible in `crot_status`.
