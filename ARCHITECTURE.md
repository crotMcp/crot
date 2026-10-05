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
>
> The v1 implementation roadmap (phases, order, dependencies, status) is
> `CROT_IMPLEMENTATION_ROADMAP.md`; the individual work packages
> (WP-17…WP-37) are in `docs/plan/crot-agent-work-packages.md`. `AGENTS.md`
> lists what a new contributor or agent reads first.

## 1. Product

**CROT** is an installable, commercial, local AI-agent bridge and MCP gateway.

CROT combines the user's computer, the user's browser and external
MCP-compatible services into one controlled environment for AI agents.

The product has three parts:

| Part | What the agent gets | Status |
| --- | --- | --- |
| Local computer | files, processes, shell, Git, Docker and further local capabilities | **[Implemented]** files, processes, shell, Git read (`git.read`), local Git write (`git.write`) and dedicated Docker operations (`docker.use`, see §5) |
| User's browser | the user's real browser session through the browser bridge and extension | **[Implemented]** Chromium browsers |
| External MCP services | tools of external MCP-compatible servers, reached through CROT | **[Target]** (§18), **post-v1** (§27 AD-13) |

**v1 goal (§27 AD-13, AD-14).** CROT v1, the first commercial release, is
this chain:

```text
remote MCP client (any compatible type)
  -> internet / CROT Cloud Relay
  -> local CROT on the user's device
  -> the user's computer (project files, commands, Git, Docker)
     + the user's real browser, its tabs and the web services the user is logged in to
```

A remote agent must be able to carry out **real multi-step tasks** in the
user's browser — navigate, find and operate controls, fill in forms, answer
dialogs, upload and download files, work across tabs and pop-ups — combined
with work on the local project, not only read pages and perform a few simple
actions. Remote access (§22) and the browser contract v1 (§7.1) are
release-blocking: v1 does not ship without them. Concrete clients (Notion,
Claude, Cursor and others) are only compatibility examples, not a basis of the
architecture (§11). Remote access is a different function from the external
MCP gateway (CROT as an MCP client of external servers, §18), which is post-v1
and is not mixed with v1 work.

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

CROT is **not specific to any MCP client**. No client is a design basis.

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
  MCP clients on the same machine (any MCP client: stdio or loopback HTTP)
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
3. **External MCP operation** [Target, post-v1, AD-13]: agent -> CROT MCP -> external-MCP
   capability -> ExecutionGuard / PermissionEngine -> MCP client connector ->
   external MCP server -> result treated as untrusted data -> audit (§18).
4. **Remote operation** [Target, mandatory in v1, AD-13]: remote agent/client -> CROT Cloud Relay
   (client authentication, routing to the bound device) -> outbound tunnel ->
   local CROT remote-transport adapter -> token re-verification -> Principal
   (`kind: remote`, account, device and client ids) -> request-scoped
   execution context -> the same paths 1–3 (§22). The remote MCP request
   contract (sessionless requests, principal kinds by entry point, exposure
   scopes, resource and audience, relay and device responsibilities) is §27
   AD-15.
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
| CROT Browser Extension | user's browser | fixed browser commands | **[Implemented]** (Chromium), basic command set; browser contract v1 decided (§27 AD-16), implementation **[Target, v1]** (§7.1) |
| MCP client connectors / external MCP gateway | device, outside Core | connections to external MCP servers | **[Target]**, post-v1 (AD-13) |
| Confirmation mechanism | Core interface + UI provider | explicit user approval of sensitive operations | **[Partial]**: mechanism implemented (WP-15); tray provider **[Target, v1]** |
| CROT local service (sidecar) | device, background | one long-running `crot-mcp` service per user; stdio clients attach through a thin shim; authenticated local control channel | **[Implemented]** (WP-20, §27 AD-17); autostart/installer registration **[Target]** (WP-34) |
| CROT Tray app | device | user UI | **[Target]**, v1 |
| Installer / packages | device | Linux, Windows, macOS installation | **[Target]**, v1 |
| CROT Cloud Relay | cloud | secure connection between remote clients and device | **[Target]**, v1 (AD-13) |
| Identity provider (third party) | cloud | user authentication, tokens | **[Target]**, v1 |
| Account & Commercial service | cloud | accounts, subscriptions, plans, licensing, entitlements, device limits | **[Target]** (v1: entitlements checked at the relay only, AD-13) |
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
- **[Target, mandatory in v1]** remote exposure with MCP authorization: remote
  MCP clients reach the local CROT through the Cloud Relay (§20, §22, §27 AD-13).
- **[Target, post-v1]** CROT as **MCP client** of external MCP servers (§18,
  §27 AD-13). A different function from remote exposure.

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
The command set implemented today is basic (`docs/BROWSER_EXTENSION.md`); the
browser contract v1 (§7.1) is **[Target]** and release-blocking (§27 AD-14);
its normative contract is §27 AD-16.

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

### 7.1 Browser contract v1

**[Target, v1, release-blocking]** (§27 AD-14). **Contract decided in §27
AD-16 (WP-18):** the page backend is `chrome.debugger` (Chrome DevTools
Protocol) used only through a fixed, extension-built command surface; AD-16
fixes the command list, element references and their invalidation, tab
identity and explicit `tabId`, per-tab sequencing, dialogs, files, screenshots,
isolation, approvals and the two presets. This section lists the requirements;
AD-16 is the normative contract that implements them.

Implemented today (`docs/BROWSER_EXTENSION.md`): `browser_status`,
`browser_tabs_list`, `browser_page_read` (`innerText` / `outerHTML`),
`browser_screenshot` (active tab only), `browser_tab_open`, `browser_navigate`,
`browser_tab_activate`, `browser_tab_close`, `browser_click`
(`element.click()`, synthetic) and `browser_type` (text fields only), all
addressing elements with `querySelector` in the main frame. This supports
"open and read" and simple actions, not multi-step tasks.

Required for v1:

1. **Page model for agents.** A compact snapshot of a tab's interactive
   elements (role, accessible name, state, value, position) with element
   references, so that the agent does not have to derive CSS selectors from
   up to 10 MiB of HTML. Actions accept an element reference (selectors stay
   available). A reference is valid only in one tab and one document and
   becomes invalid after navigation or document replacement (a stale reference
   is an error, never a guess). The snapshot is an exposure source (AD-12
   point 3).
2. **Input.** Click, double click, context click, hover, scroll, drag and drop;
   text input into any editable element; keys and shortcuts (Enter, Tab,
   Escape, arrows, Ctrl/Cmd combinations); selecting options in native and
   custom drop-down lists; checkboxes and radio buttons. Input must be accepted
   by web applications that ignore synthetic events (trusted browser input
   events; still not OS-level input, §22).
3. **Frames and shadow DOM.** Elements inside frames (including cross-origin
   frames) and open shadow roots can be read and addressed.
4. **Waiting and history.** Wait for an element or state, for navigation and
   load; back, forward, reload.
5. **Dialogs.** `alert`, `confirm`, `prompt` and `beforeunload` are reported to
   the agent and answered by an explicit command; they never block a tab
   indefinitely.
6. **Files.** Upload a workspace file into a file input (requires
   `filesystem.read` and `browser.control`; the path is checked by the
   workspace rules like any file read) and download into the workspace
   (requires `filesystem.write` and `browser.control`). Example: publishing a
   video from the local project through a web service (§9).
7. **Tabs and windows.** `tabs_list` reports `openerTabId`, so the agent finds
   tabs and pop-ups (for example OAuth windows) opened by its own actions;
   screenshots of background tabs without activating them (the user keeps the
   focus); remote principals must name an explicit `tabId` for page operations
   and never act on "the active tab" implicitly; tabs opened by agents are
   visible to the user (for example a "CROT" tab group).
8. **Concurrency.** Commands to one tab are serialized; several agents do not
   interfere with each other or with the user's own tabs; there is one bridge
   owner (the supervised service, §24).

Invariants that stay unchanged for every new command:

- every command is a fixed Core operation through `BrowserService` and the
  ExecutionGuard, gated by `browser.read` / `browser.control` (plus the file
  capabilities of point 6);
- no host- or agent-supplied code runs in the browser (no `eval`, no
  agent-controlled `Runtime.evaluate`), even if CDP is chosen;
- approval binding of AD-6, AD-8, AD-9 and AD-11 (tab, origin,
  `connectionId`, expected browser subject) applies to every new control
  command; new read commands are added to the exposure source list (AD-12);
- audit never records page content, screenshots, typed text or file contents;
- page content is untrusted input (§19).

Browser profile and session: in v1 the extension connects one browser profile
(the one it is installed in); the tray shows which profile is connected. After a
browser restart the extension gets a new `connectionId` and earlier `tabId`s are
invalid; this is intended (AD-9).

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

The local building blocks are implemented (§5); the browser offers only a
basic command set today. Real multi-step browser tasks, including the upload
example above, need the browser contract v1 (§7.1), which is release-blocking
(§27 AD-14). Combined workflows run as separate tool calls through the same
Core. Data read from the browser never
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
Connect AI Agent (local, or any remote MCP client through the Cloud Relay
with an account; both in v1, §22, §27 AD-13)
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

Any MCP-compatible client — local (stdio, loopback HTTP) or remote (through the
Cloud Relay, §22) — uses the same tools and the same Core pipeline. No client is
a design basis: there is no client-specific code in Core, the adapters or the
relay. Compatibility follows from implementing the MCP specification
(transport, authorization, supported protocol versions; §27 AD-14, AD-15).

Concrete clients (for example Notion, Claude, Cursor) are compatibility test
targets of the v1 acceptance suite (§14), not integrations or milestones.

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

## 14. v1 Acceptance Milestone

> Replaced by §27 AD-14. The earlier milestone (one specific client -> CROT MCP
> -> one specific local project) is withdrawn: it tied the milestone to one
> client and one project.

The v1 milestone is the client-independent end-to-end acceptance suite
(work package WP-32, `docs/plan/crot-agent-work-packages.md`):

1. **Automated:** an MCP SDK client -> Cloud Relay -> local CROT -> a fixture
   project (files, commands under command confinement L1, Git, Docker) -> a
   real Chromium with the CROT extension, running a multi-step scenario across
   several tabs (navigation, a form, a dialog, a file upload and a download,
   §7.1).
2. **Manual compatibility run:** at least four different remote MCP clients
   (for example Notion, Claude, Cursor and one more) over every supported MCP
   protocol version (AD-15).

The agent must be able to perform real development and browser work.

The MVP must be part of the final architecture, not disposable prototype code.

## 15. Development Principles

Build the smallest working implementation of the final architecture.

Do not:
- build client-specific logic (for any MCP client) into Core, the adapters or the relay;
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
8. (withdrawn) client-specific first integration  [Superseded by §14 / WP-32, AD-14]
9. (withdrawn) project-specific first workflow    [Superseded by §14 / WP-32, AD-14]
10. Native Host                                   [Implemented]
11. Browser Extension                             [Implemented]
12. Unified browser + PC workflows                [Partial: building blocks implemented]
13. Installer                                     [Target, §24]
14. Authentication/authorization hardening        [Target, §20]
15. Commercial account/licensing layer            [Target, §23]
```

Further target work. The v1 scope is fixed by §27 AD-13 and AD-14: items
13–18, 20, 24 and 25 are required for v1 (remote access and the browser
contract v1 are mandatory in v1); item 19 and item 23 are post-v1. Item
numbers are kept stable because other documents refer to them; the v1 work
packages, their order and dependencies are in
`CROT_IMPLEMENTATION_ROADMAP.md`.

```text
16. User confirmations                            [Partial: mechanism WP-15; tray provider v1, §21]
17. Identity, accounts and device binding         [Target, v1, §20]
18. Remote mode and CROT Cloud Relay              [Target, v1 (mandatory), §22]
19. External MCP gateway (CROT as MCP client)     [Target, post-v1, §18]
20. Tray app and supervised local service         [Partial: service, shim and control channel implemented (WP-20, §27 AD-17); tray and autostart Target, v1, §24]
21. Dedicated Git/Docker capabilities             [Partial: git.read (WP-10, §27 AD-1), git.write (WP-11, §27 AD-2) and docker.use (WP-12, §27 AD-3) implemented; Git network operations Target, §5]
22. Network access for CROT requests               [Implemented: network.access (WP-13, §27 AD-4)]
23. OS-level egress control for processes/Docker  [Target, post-v1, §27 AD-4]
24. Command confinement L1 (Linux, macOS, Windows) [Target, v1, §27 AD-13]
25. Browser contract v1                           [Target, v1, §7.1, §27 AD-14; contract AD-16]
```

The order may change when technically justified, but architectural boundaries must remain intact.

## 17. Non-Negotiable Principle

**CROT is not an MCP server for one particular client.**

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

**[Target]** — not implemented; **post-v1** (§27 AD-13). This is CROT as an
MCP *client* of external servers. It is not remote access (remote MCP clients
reaching the local CROT, §22), which is mandatory in v1.

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
| Browser | Core | bridge, relay, extension, browser, web pages | token-authenticated IPC, browser cannot initiate, fixed commands, result validation; page content untrusted | **[Implemented]** (basic commands; the browser contract v1, §7.1, keeps the same enforcement) |
| External MCP | Core | external servers, their tools and data | §18 | **[Target]** (post-v1, AD-13) |
| Remote access | local CROT | relay, remote clients, network | §22, §27 AD-13 (incl. command confinement L1) | **[Target]** (mandatory in v1) |
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

**Presets (v1, §27 AD-14).** Approval policy in v1 is chosen from fixed
presets, built only from the existing matchers (`principalKinds`, `exposed`,
capabilities, operations); there is no rule editor:

- **Ask for every action** (default): the `untrusted-content` rule as in AD-12.
- **Autonomous browser**: `browser.control` operations in an exposed session
  run without approval; `shell.execute`, `filesystem.write`, `git.write`,
  `network.access` and `docker.compose_up` / `docker.compose_down` still
  require approval.

Without such a preset, remote multi-step browser tasks are not possible unless
the user is at the device. The exact rule set and its configuration key are
fixed in §27 AD-16 point 17: `permissions.approvals.untrustedContent` is
`"require-approval"` (*Ask for every action*, default), `"autonomous-browser"`
or `"off"`; *Autonomous browser* also keeps `browser.file_upload` gated,
because it sends local files to a web page.

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

**[Target]** — not implemented; **mandatory in v1** (§27 AD-13). Today HTTP
binds to loopback only. Remote MCP clients and agents of any compatible type
connect to CROT and, through it, use the local computer and the user's browser
with the same tools, permissions, confirmations, exposure and audit as local
clients.

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
- **Explicit and visible.** Remote mode ships in v1. On each device it stays
  off until the user enables it (a per-device security control of a mandatory
  feature, not an optional feature), is visible in the tray while active, and
  can be stopped/revoked at any time.
- **Not a remote desktop.** Remote mode exposes only the CROT tool set under
  the same permissions — no screen streaming, no OS-level input, no hidden
  access.
- **Separate trust boundary.** Remote principals are distinguishable from
  local ones in authorization and audit (`kind: remote`). Since WP-19
  (AD-15 point 6) loopback HTTP principals are `local` and only the relay
  entry point produces `remote` principals **[Implemented]** (the tunnel
  itself is WP-30).
- **Session and exposure.** MCP 2026-07-28 removed the `initialize` handshake
  and protocol sessions, and with older versions a client can always open a
  new session. Exposure of remote principals (AD-12) is therefore keyed by the
  token grant (account, device, client), not by an MCP session, and is reset
  only by an explicit user action or revocation. The HTTP pipeline accepts
  stateless requests as well as session-based ones (AD-15, §27 AD-14).
  **[Implemented]** in WP-19 (sessionless 2026-07-28 and legacy sessions on
  one endpoint, persisted remote exposure); reset and revocation: WP-22.
- **Standard MCP authorization.** The device's MCP endpoint at the relay
  publishes Protected Resource Metadata (RFC 9728); tokens are requested with
  a resource indicator (RFC 8707) and are audience-bound to CROT; the identity
  provider supports CIMD and DCR with PKCE. The device verifies the same token
  again as part of the same logical resource server (AD-15).
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

**[Partial]** — the local service, the stdio shim and the authenticated
control channel are implemented (WP-20, §27 AD-17); tray, installer and
autostart are not. Today CROT is run from a source checkout with CLI commands
(`crot-mcp`, `crot-mcp service run|status|stop`), and the extension is loaded
unpacked.

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
| Browser bridge, relay, extension (Chromium), basic commands | **[Implemented]** |
| Browser contract v1 (element references, real input, frames, dialogs, files, tabs, concurrency; §7.1) | Contract decided (AD-16, WP-18: CDP); implementation **[Target]** (v1: WP-24…WP-27) |
| Remote MCP request contract (principal kinds, execution context, exposure scope, sessionless MCP) | Contract decided (AD-15, WP-17); request pipeline **[Implemented]** (WP-19: sessionless 2026-07-28, supported versions, principal kinds by entry point, exposure scopes, persisted remote exposure); verifier, relay, tunnel **[Target]** (v1: WP-28…WP-30) |
| External MCP gateway / MCP client | **[Target]** (post-v1, AD-13) |
| User confirmations | **[Partial]** (mechanism implemented: WP-15, §27 AD-5…AD-11; no approval provider yet; tray provider and presets v1, AD-14) |
| Untrusted-content exposure (prompt-injection mitigation) | **[Implemented]** (WP-16b, §27 AD-12) |
| OAuth/OIDC identity, accounts, device binding | **[Target]** (v1, AD-13) |
| Remote mode, Cloud Relay | **[Target]** (mandatory in v1, AD-13) |
| Command confinement L1 (Linux, macOS, Windows) | **[Target]** (v1, AD-13) |
| Commercial layer: subscriptions, plans, licensing, entitlements | **[Target]** (v1: entitlements at the relay only, AD-13) |
| Supervised local service, thin stdio shim, local control channel | **[Implemented]** (WP-20, §27 AD-17) |
| Installer, tray app, autostart of the service | **[Target]** (v1, AD-13) |

## 26. Open Architectural Questions

These need explicit decisions before the corresponding work packages.

1. **First milestone vs remote mode.** *Decided in §27 AD-13 (remote mode is
   mandatory in v1); the client-specific first milestone is withdrawn by
   AD-14 and replaced by the client-independent acceptance suite (§14).*
2. **Single service vs per-client processes.** *Decided in §27 AD-13: one
   supervised service; stdio clients attach through a thin shim. How it runs
   and how the shim attaches is decided in §27 AD-17 (WP-20): one per-user
   service (never a system service), started on demand by the shim or by an
   OS supervisor, authenticated shim and control endpoints; implemented.*
   Before WP-20 each stdio MCP client started its own `crot-mcp`, and only one
   instance could own the browser bridge (`in_use`).
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
   built-in `untrusted-content` rule for exposed sessions; §27 AD-14 adds two
   v1 presets (§21), whose exact rule set and configuration key are fixed in
   AD-16 point 17. The general list of gated operations remains open.
7. **Relay encryption model.** *Decided for v1 in §27 AD-13: TLS terminates
   at the relay, no payload storage or logging; end-to-end encryption post-v1.*
   Whether traffic is end-to-end encrypted between
   client and device or TLS terminates at the relay (the relay then sees
   traffic in transit, even though it never stores it).
8. **Licensing offline.** *Decided in §27 AD-13: no local feature is
   licensed; entitlements are checked only by the relay.* Whether any local feature is paid and, if so, how
   entitlements are checked offline without making local mode depend on the
   network.
9. **Local HTTP credentials.** *Decided in §27 AD-13: the local token stays
   for local clients; device credentials are used for remote mode.* Whether the static local token is replaced by
   device credentials for local HTTP clients too, or only for remote mode.
10. **Remote session contract.** *Decided in §27 AD-15 (WP-17): sessionless
    request model, entry-point-based principal kinds, request-scoped execution
    context, exposure scopes (remote: account, device, client; persistent),
    supported versions 2026-07-28, 2025-11-25 and 2025-06-18, resource and
    audience rules, relay and device responsibilities.* Remaining details are
    assigned to WP-28 (token claims) and WP-29 (device URI form), and to
    questions 12 and 13. The SDK line was settled in WP-19: SDK v1 for stdio
    and the legacy session versions, SDK v2 (`@modelcontextprotocol/server`)
    for sessionless 2026-07-28 requests, until a full move to SDK v2.
11. **Browser technology and command set.** *Decided in §27 AD-16 (WP-18):
    `chrome.debugger` (CDP) through a fixed command surface; command list,
    document-bound element references, explicit `tabId` for remote
    principals, per-tab sequencing, preset rule set
    (`permissions.approvals.untrustedContent`), store justification of
    `debugger`, `downloads` and `tabGroups`. Remaining details are assigned
    to WP-24…WP-27 and WP-35.* Originally: `chrome.debugger` (CDP) versus
    `chrome.scripting`; the final command list and element-reference model;
    the rule set of the approval presets; explicit `tabId` for remote
    principals; the store-review justification of extension permissions.
12. **Transport matcher.** *Opened by §27 AD-15; still open after WP-19.*
    Since loopback HTTP principals are `local` (AD-15 point 6, WP-19), approval
    rules can no longer
    tell loopback HTTP clients from stdio clients. Decide whether a
    `transports` matcher is added (additive, like `exposed` in AD-12). Not
    required for v1.
13. **Long-running gated requests through the relay.** *Opened by §27 AD-15;
    still open after WP-19 (locally a gated request waits within its HTTP
    request and is cancelled when the request closes).*
    A gated operation waits for its approval (up to 300 s, AD-10) within one
    request (AD-15 point 3). Decide the relay and tunnel timeouts and the
    behaviour towards clients with shorter timeouts; whether the Tasks
    extension or Multi Round-Trip Requests are used later is post-v1. To be
    settled in WP-29 / WP-30. AD-16 adds bounded browser waits (at most 60 s
    plus a margin) that run within one request as well.
14. **Tab scope for remote agents.** *Opened by §27 AD-16.* In v1 every agent
    context with `browser.control` may act on every `http(s)` tab of the
    connected profile; `openedBy` in the tab list is information only.
    Decide whether a policy matcher limits remote contexts to tabs they
    opened (additive, like `exposed`). Not required for v1.

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
  AD-16 point 17 adds the value `"autonomous-browser"` (the *Autonomous
  browser* preset).

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
- Points 2 and 7 are amended by AD-15 for remote principals and for
  sessionless loopback HTTP requests: exposure is recorded per exposure scope;
  remote scopes are keyed by account, device and client, persist across
  restarts and are reset only by the user. stdio and legacy local sessions
  keep this decision unchanged.
- Point 3 is amended by AD-16: `browser.snapshot` is an exposure source.
  Point 5 is amended by AD-16 point 17: `untrustedContent` also accepts
  `"autonomous-browser"`, which keeps the rule set of point 4 without
  `browser.control` but with `browser.file_upload`.
- Browser workflows that alternate reading and acting ask for approval for
  every action after the first read. Users who need autonomous browsing can
  turn the rule off or write narrower rules; the trade-off is theirs and is
  visible in `crot_status`.

### AD-13. CROT v1 scope: remote MCP clients reach the local computer and browser through CROT (mandatory); the external MCP gateway is post-v1

**Context.** CROT's purpose is: remote agents and platforms (Notion and other
MCP clients) -> CROT -> the user's local computer -> the local project and the
local browser tabs. Notion's agents and similar clients run in the cloud and
reach MCP servers only over the internet; they cannot reach a loopback
endpoint. Earlier wording in this document (§10 "remote optional", §16 "order
to be set", §26 question 1) left open whether remote access is part of the
first release. The document also uses "remote" and "external MCP" close to
each other although they are different functions. This decision fixes the v1
scope and removes that ambiguity.

**Decision.**

1. **Remote access is mandatory in v1.** CROT v1, the first commercial
   release, **must** accept connections from remote MCP clients and agents
   (Notion and other MCP clients) and give them access, through CROT, to the
   user's local computer (workspace files, shell and processes, Git, Docker)
   and the user's browser (tabs, reading, browser control). It is
   release-blocking: v1 does not ship without it. It is not optional, not
   experimental, not an add-on and not post-release. Remote clients use the
   same tool set and the same Core pipeline as local clients: ExecutionGuard,
   PermissionEngine, approval gates (§21), session exposure (AD-12) and audit.
   That remote mode is enabled per device by the user (§22) is a security
   control of this mandatory feature, not a reason to treat the feature as
   optional.
2. **Two different functions.**
   - **Function A — remote access** (CROT as MCP *server* for remote
     clients): remote MCP client -> CROT Cloud Relay -> local CROT -> local
     computer and browser (§2.3 path 4, §22). **Mandatory in v1.**
   - **Function B — external MCP gateway** (CROT as MCP *client* of external
     MCP servers): agent -> CROT -> external MCP servers (§2.3 path 3, §18).
     **Post-v1.** Nothing in function A depends on function B, and function A
     is never deferred or reduced because function B is deferred.
   In this document "remote access" / "remote mode" always means function A;
   "external MCP gateway" always means function B.
3. **Release-blocking components of function A (v1).**
   - CROT Cloud Relay: the device opens an outbound tunnel; the relay
     authenticates clients and routes to the bound device, and never stores
     or logs payloads; plus the device-side remote-transport adapter
     (adapter level, Core unchanged).
   - MCP authorization (OAuth) for remote MCP clients, so that Notion and
     other clients can connect with a standard flow.
   - Account and device binding (§20): a managed third-party identity
     provider, device pairing from the tray, short-lived tokens bound to
     account, device and CROT audience, verified locally through the
     `AccessTokenVerifier` seam, revocation. `Principal` carries account and
     device ids; credentials never reach Core or the audit log.
   - One supervised local service (§24) that owns remote sessions and the
     browser bridge; stdio clients attach through a thin shim.
   - Tray app with the approval provider (§21) on an authenticated local
     channel, remote mode on/off and the active remote session visible.
     Without a provider, approval rules and the `untrusted-content` rule only
     deny, which would break remote workflows that read the browser and then
     act.
   - Command confinement L1 (point 4) on Linux, macOS and Windows.
   - Remote permission profile (point 5).
   - Session exposure through the relay: one MCP session of a remote client
     is one CROT session bound to its principal (AD-12 point 2).
   - Installer, signed packages, updates, registration of the native host,
     the published extension (§24), and entitlements checked by the relay
     (§23).
4. **Command confinement L1 (v1, all three OS).** Child processes of
   `shell.execute` and `process.manage` in workspace (sandbox) mode run
   confined by a fixed, Core-defined profile through the Platform / Native
   Host layer:
   - no read or write access to CROT's state (local token, device key,
     control-channel credentials), configuration and audit log;
   - writes only to the workspace, a private temporary directory and a short
     allowlist of tool caches;
   - no access to the Docker socket and to the GUI automation or control
     channel of the tray app (an agent must not approve its own requests).
   Mechanisms: Linux bubblewrap (with the AppArmor profile the installer
   ships), macOS Seatbelt (CROT secrets in the Keychain), Windows Job Object
   plus a restricted / low-integrity token for children (to be confirmed by a
   spike first). L1 is required for v1 on every supported OS; it is not
   replaced by turning remote shell off. Only as a runtime safety fallback,
   on a machine where the mechanism is unavailable (for example an
   unsupported OS version), CROT refuses shell and process operations of
   remote principals there and reports the reason in `crot_status`.
   Full control mode is unconfined by definition (§6).
5. **Remote permission profile.** Remote sessions default to workspace mode
   with the `untrusted-content` rule on. Full control for remote principals is
   available in v1 as an explicit per-device opt-in, visible in the tray,
   audited and revocable. Implemented with the existing `principalKinds`
   matcher; no new mechanism.
6. **v1 simplifications that keep function A complete.**
   - No own authorization server: a managed identity provider; CROT is the
     resource server.
   - Relay v1 terminates TLS, never stores or logs payloads, does not parse
     MCP beyond routing; end-to-end encryption is post-v1 (§26 question 7).
   - No local licensing: no local feature is paid or checked; entitlements
     are checked only by the relay (§26 question 8; §23 unchanged).
   - The static local token stays for local clients; device credentials are
     for remote mode (§26 question 9).
   - Confinement uses one fixed profile; network for confined commands is
     on/off only.
   - Approval policy: built-in rules and a few presets, no rule editor.
   - Chromium-based browsers only.
7. **Post-v1 (none of this is part of function A).** External MCP gateway
   (function B, §18); OS-level egress allowlists (§16 item 23); confinement
   level L2 (read-deny of common user secrets) on Windows; relay end-to-end
   encryption; Firefox/Safari; team features; a rule editor; dedicated Git
   network and Docker build/pull capabilities (usable through confined shell).
8. **v1 order.** Phase 0: this decision. Phase 1 (local foundation):
   supervised service with stdio shim and local control channel; tray v1 with
   the approval provider; child-process environment allowlist and a protected
   location for CROT secrets. Phase 2 (in parallel with phase 3): command
   confinement L1 on Linux, macOS and Windows. Phase 3 (remote access):
   identity and device binding; Cloud Relay and the device tunnel adapter
   with MCP authorization; remote permission profile and end-to-end tests
   "Notion -> relay -> CROT -> project + browser" plus at least two other
   MCP clients; external security review. Phase 4 (commercial):
   installers, signing, updates, extension publication; entitlements at the
   relay; hardening, documentation and legal. Phases 1–4 are all v1;
   function A is complete only when phases 1–3 are done, and v1 is released
   only after phase 4.

**Scope and limits.**

- This decision fixes the release scope; each component still needs its own
  work package and, where boundaries change, its own decision.
- It resolves §26 questions 1, 2, 7, 8 and 9 and partially question 3
  (remote principals get the profile of point 5; capability naming for the
  external MCP gateway stays open with function B).
- Residual risks of function A in v1, accepted and to be stated to users:
  confined commands can still read user files outside the workspace (except
  CROT's state) and use the network (no egress allowlist in v1); browser
  actions run in the user's real sessions and depend on the user's approvals;
  dependency install scripts run inside L1; full control for remote
  principals is remote code execution on the whole machine by the user's
  explicit choice; the relay sees traffic in transit (TLS termination); a
  compromised account is mitigated by the identity provider's MFA,
  short-lived device-bound tokens and revocation.
- Amended by AD-14: the browser contract v1 (§7.1) is added to the
  release-blocking components of point 3; the point 3 bullet "one MCP session
  of a remote client is one CROT session" is replaced by the exposure key of
  AD-14 point 3; the presets of point 6 are made concrete (AD-14 point 4); the
  order and the client-specific end-to-end test of point 8 are replaced by
  AD-14 points 5 and 6.

### AD-14. v1 scope after the Remote MCP v1 review: the browser contract v1 is release-blocking, acceptance is client-independent, and the remote session contract is decided before implementation

**Context.** A review of `main` at `0f0634c` against the v1 goal of AD-13
found that the local part is largely ready, but no link of the remote chain
exists yet and several parts of this document contradict each other or the
current MCP specification:

- **Browser.** The bridge works end to end, but its ten tools (tab list, open,
  navigate, activate, close; page read as `innerText` / `outerHTML`; screenshot
  of the active tab; `element.click()`; typing into text fields; elements found
  with `querySelector` in the main frame) support "open and read" and simple
  actions, not real multi-step tasks. AD-13 point 3 does not list any browser
  work as release-blocking.
- **Principal kind.** HTTP principals always get `kind: "remote"`
  (`src/adapters/http/context.ts`), also on loopback. AD-13 point 5 builds the
  remote profile on `principalKinds: ["remote"]`, so local HTTP clients would
  get the remote profile and real remote clients would not be distinguishable
  from local HTTP clients.
- **Sessions.** AD-12 point 2 and AD-13 point 3 bind exposure to the MCP
  session. MCP 2026-07-28 removes the `initialize` handshake, `Mcp-Session-Id`
  and protocol sessions. The current HTTP pipeline creates a session only
  through `initialize` and rejects other requests without one, so clients
  speaking only 2026-07-28 cannot use CROT at all; with older versions a
  remote client can open a new session and start with clean exposure.
- **Autonomy.** The `untrusted-content` rule is on by default and approvals
  are given only in the tray, so after the first page read every browser
  action waits for the user at the device. AD-13 point 6 mentions "a few
  presets" without defining them.
- **Order.** AD-13 point 8 tests client compatibility (OAuth with DCR or CIMD,
  streaming through the tunnel) only in phase 3, although the relay is the
  longest and riskiest branch.
- **Client-centric milestones.** §11, §14 and §16 defined the first milestone
  around one specific client and one specific local project.

**Decision.**

1. **Goal.** v1 is: any compatible remote MCP client -> internet / CROT Cloud
   Relay -> local CROT -> the user's computer and the user's real browser,
   tabs and web services, with real multi-step browser tasks (§1). Concrete
   clients are compatibility examples; no client-specific milestone, code or
   test is a basis of the architecture (§11, §14). The external MCP gateway
   (function B of AD-13) stays post-v1 and separate.
2. **The browser contract v1 is release-blocking.** It is added to the
   release-blocking components of AD-13 point 3. Its requirements are fixed
   in §7.1. The technology (`chrome.debugger` / CDP or `chrome.scripting`) and
   the exact command list are decided in AD-16 after the spike WP-18. The
   invariants of §7 and of AD-6, AD-8, AD-9, AD-11 and AD-12 are unchanged and
   apply to every new command.
3. **The remote session contract is decided before code (AD-15).** Before
   WP-19, WP-20 and WP-28…WP-30 start, AD-15 (WP-17) decides the details
   under these constraints:
   - loopback HTTP principals are `kind: "local"`; principals that arrive
     through the relay are `kind: "remote"`. AD-15 states the migration of
     existing rules that use `principalKinds: ["remote"]` for loopback HTTP
     clients;
   - exposure of a remote principal is keyed by its token grant (account,
     device, client id). A new MCP session, a repeated `initialize` or a
     stateless request does not reset it; only an explicit user action through
     the approval provider or revocation of the grant resets it. This amends
     AD-12 points 2 and 7 for remote principals and replaces the AD-13 point 3
     bullet "one MCP session of a remote client is one CROT session". Local
     principals keep the AD-12 behaviour;
   - the HTTP pipeline accepts stateless 2026-07-28 requests in addition to
     the session-based versions; AD-15 fixes the supported protocol versions
     (at least 2025-06-18, 2025-11-25 and 2026-07-28) and the SDK version;
   - MCP authorization follows the specification: Protected Resource Metadata
     (RFC 9728) per device URL at the relay, resource indicators (RFC 8707),
     audience-bound JWT access tokens, an identity provider with CIMD and DCR
     and PKCE; no token issued for another resource is accepted or forwarded.
     The device re-verifies the same token as part of the same logical
     resource server;
   - AD-15 also fixes the relay–device tunnel shape (outbound, multiplexed,
     streaming responses, routing without parsing bodies) and the
     identity-provider selection criteria.
   AD-15 may choose details; weakening these constraints needs a new decision.
4. **Approval presets.** The "few presets" of AD-13 point 6 are two v1
   presets built only from the existing matchers (§21): *ask for every action*
   (default) and *autonomous browser* (`browser.control` without approval in
   an exposed session; shell, file writes, `git.write`, `network.access` and
   Docker compose operations still need approval). They are chosen in the
   tray, apply per device and are reported by `crot_status`. The exact rule set
   and configuration key are fixed in AD-16.
5. **Client-independent acceptance.** The end-to-end test "a specific client
   -> relay -> CROT -> project + browser" of AD-13 point 8 is replaced by the
   acceptance suite of §14 (WP-32): an automated SDK-client run through the
   relay to a fixture project and a real Chromium, and a manual run with at
   least four different remote MCP clients over all supported protocol
   versions.
6. **Order (amends AD-13 point 8).**
   - Phase 0 (documents and a spike): AD-15 (WP-17) and, in parallel, the
     browser spike with AD-16 (WP-18).
   - Phase 1 (local foundation): principal and session fixes (WP-19),
     supervised service with stdio shim and control channel (WP-20), secret
     storage and environment allowlist (WP-21), tray with the approval provider
     (WP-22).
   - Phase 2 (command confinement L1, WP-23a/b/c) and phase 2B (browser v1,
     WP-24…WP-27) run in parallel with phase 1 and phase 3.
   - Phase 3 (remote access): identity and device binding (WP-28) and the
     Cloud Relay (WP-29) start right after AD-15, in parallel with phase 1;
     then the device tunnel adapter (WP-30), the remote profile and presets
     (WP-31), the acceptance suite (WP-32) and an external security review
     (WP-33).
   - Phase 4 (commercial release): installers, signing and updates (WP-34),
     extension publication (WP-35, submitted early), accounts, plans and the
     relay entitlement check (WP-36), hardening, documentation and legal
     (WP-37).
   Phases 1–4 are all v1. The work packages, dependencies, sizes and
   definitions of done are in `docs/plan/`.
7. **Unchanged.** Everything implemented stays as it is: Core,
   ExecutionGuard, PermissionEngine, the approval mechanism, the exposure
   mechanism, the browser bridge protocol and all existing tools. AD-13 points
   1, 2, 4, 5 and 7 and the simplifications of point 6 stay in force.

**Scope and limits.**

- Documentation only; no code is changed by this decision. Point 3 is decided
  by AD-15 (WP-17). Behaviour changes
  (principal kind, exposure key, stateless HTTP) are made in WP-19 according
  to AD-15; browser changes in WP-24…WP-27 according to AD-16.
- It answers §26 question 6 partially (presets) and opens §26 questions 10
  (→ AD-15) and 11 (→ AD-16). Point 2 (technology, command list) and point 4
  (rule set and key of the presets) are decided by AD-16.
- Accepted residual risk: the *autonomous browser* preset lets an agent that
  read injected page content act in the user's logged-in browser sessions
  without asking; it is an explicit user choice, visible in the tray and in
  `crot_status`, and does not extend to shell, file writes, Git writes,
  network requests or Docker.

### AD-15. Remote MCP request contract v1: every request gets a request-scoped execution context from verified facts; no MCP session is required; exposure belongs to an exposure scope, not to a transport session (WP-17)

**Context.** AD-14 point 3 requires this decision before WP-19, WP-20 and
WP-28…WP-30 and fixes its constraints. The current implementation (`main` at
`72b3b25`) works as follows:

- **Principal.** `principalFromAuthInfo` (`src/adapters/http/context.ts`)
  returns `kind: "remote"` for every HTTP request, including loopback; the id
  is `AuthInfo.extra.subject` (local token: `local-token:<fingerprint>`).
  stdio uses `localPrincipal` (`local-user`, `kind: "local"`).
  `Principal.client` is the self-reported MCP client info and is never used
  for authorization (`src/core/auth/principal.ts`).
- **Execution context.** Core receives an `AuthContext` per tool call:
  `principal`, optional `session` (`SessionRef`), `requestId` (the JSON-RPC
  id) and `signal`. It is built by the adapter's `ContextResolver`
  (`src/adapters/mcp/context.ts`, `server.ts`).
- **Session and exposure.** `createCrotMcpServer` creates one `SessionRef` per
  `McpServer` instance. stdio has one instance per connection; HTTP creates
  one instance per MCP session in `CrotHttpServer.openSession`.
  `ExposureTracker` (`src/core/approvals/exposure.ts`) keeps exposure in memory
  in a `WeakSet<SessionRef>`; a context without a session falls back to one
  process-wide session.
- **HTTP pipeline.** `CrotHttpServer.route` (`src/adapters/http/server.ts`)
  checks Host (loopback only), path `/mcp`, Origin, method (POST, GET,
  DELETE), the bearer token, body size and JSON. A request without
  `Mcp-Session-Id` is accepted only if it is `initialize`, otherwise it is
  rejected with 400. A session is usable only by the `clientId` that opened it;
  sessions are limited (`maxSessions`) and expire when idle.
- **Authentication seam.** `AccessTokenVerifier` returns the SDK's `AuthInfo`
  or rejects; the token itself never reaches Core.
- **SDK.** `@modelcontextprotocol/sdk` `^1.31.0` (the v1 line).

MCP 2026-07-28 changes the transport underneath this design:

- the `initialize` / `initialized` handshake and `Mcp-Session-Id` are removed;
  protocol version, client info and client capabilities travel in `_meta` of
  every request;
- every POST carries `MCP-Protocol-Version` (which must match `_meta`),
  `Mcp-Method` and, for `tools/call`, `Mcp-Name`; a server that processes the
  body must reject header–body mismatches (`HeaderMismatch`, `-32020`) and
  unsupported versions (`UnsupportedProtocolVersionError`, 400);
- the GET stream is removed (GET and DELETE answer 405); a response is a
  single JSON object or an SSE stream scoped to that request;
- server-to-client requests may only be issued while a client request is
  being processed;
- Dynamic Client Registration is deprecated in favour of Client ID Metadata
  Documents, and issuer identification (RFC 9207) is expected.

Legacy versions (2025-06-18, 2025-11-25) still use `initialize` and
`Mcp-Session-Id`, and a client can open a new session at any time. Keying
exposure by the MCP session is therefore either impossible (2026-07-28) or
bypassable (legacy versions).

**Decision.**

1. **Terms (normative).**
   - **MCP request** — one JSON-RPC request or notification: one HTTP POST, or
     one stdio message.
   - **Transport session** — the stdio connection, or the protocol session of
     legacy versions (`Mcp-Session-Id`). It is a transport mechanism for
     correlating messages and limiting resources. It carries no authority and
     is never the key of security state for remote principals.
   - **Authentication result** — the facts a verifier established from a
     credential presented with the request.
   - **Principal** — who the request runs for. It is derived only from the
     authentication result and the entry point the request arrived on.
   - **Execution context** — the Core `AuthContext` of one request: principal,
     exposure scope, request id and cancellation signal. It is built by the
     adapter for every request.
   - **Exposure scope** — the key under which AD-12 exposure is recorded. It
     generalizes today's `SessionRef`.
   - **Entry point** — where a request enters CROT: stdio, the loopback HTTP
     endpoint, or the relay tunnel (WP-30).

2. **Request pipeline (normative, all entry points).** Each request passes
   these steps in this order, and none of them may be skipped:
   1. **Transport validation:** method, path, Host and Origin (loopback),
      body size, JSON, a supported protocol version, and, for 2026-07-28, the
      `MCP-Protocol-Version`, `Mcp-Method` and `Mcp-Name` headers matching
      the body;
   2. **Authentication** (point 4);
   3. **Principal derivation** (point 6);
   4. **Execution context construction** (point 7);
   5. **MCP dispatch** through the handlers of `createCrotMcpServer`;
   6. **Core pipeline:** ExecutionGuard (input validation, path resolution) ->
      `PermissionEngine.authorize()` -> approval gate (user rules, the
      `untrusted-content` rule using the context's exposure scope, the remote
      profile of WP-31) -> re-authorization and revalidation -> mandatory
      approval audit record (AD-7) -> `execute()` -> exposure marking (AD-12
      point 3) -> audit.

   A request that fails any of steps 1–4 is answered by the adapter and never
   reaches the MCP server or Core. For stdio, steps 1 and 2 are given by the
   transport: the parent process is the local user.

3. **No session is required.**
   - Every request is processed from the request itself and the entry point.
     Processing never requires an earlier `initialize`, an `Mcp-Session-Id` or
     any state from earlier requests. This is the base model for every entry
     point that speaks 2026-07-28.
   - **2026-07-28:** CROT does not mint, echo or require session ids; it
     ignores a received `Mcp-Session-Id` and `Last-Event-ID`; it answers GET
     and DELETE with 405; it serves `server/discover`. Client info and client
     capabilities in `_meta` are informational, like `Principal.client` today.
   - **Legacy versions (2025-06-18, 2025-11-25):** supported for
     compatibility. `initialize` and `Mcp-Session-Id` remain transport
     mechanics only: sessions stay bound to the principal that opened them
     (the existing owner check), limited and expiring. Every request of a
     session is still fully authenticated. For remote principals a session
     never defines the principal, authorization or the exposure scope.
   - **Supported versions in v1:** 2026-07-28, 2025-11-25 and 2025-06-18.
     Requests without `MCP-Protocol-Version` (versions before 2025-06-18) and
     the HTTP+SSE transport of 2024-11-05 are not supported and are rejected
     as the specification prescribes. Adding or removing a version is a change
     of this list, not of the contract.
   - CROT tools need neither a protocol session nor server-to-client requests
     (elicitation, sampling, roots). CROT issues no server-to-client requests
     in v1. In particular, approvals are **never** requested through MCP
     elicitation or any other path of the remote request: the approval channel
     stays independent of the request path (AD-5, design §4.1 I4, §13.3).
   - A gated operation waits for its approval within its own request. The
     response may be streamed as an SSE stream scoped to that request. The
     Tasks extension and Multi Round-Trip Requests are not used in v1.

4. **Authentication and authorization boundary.**
   - Authentication establishes the principal and nothing else. Token
     contents (scopes, roles, claims) never grant capabilities, permission
     modes, paths, network destinations or approvals. Authorization is decided
     only by the PermissionEngine and the approval gates from the device's
     local configuration (AD-5 I1, AD-13 point 1).
   - **Credential per entry point.** The loopback HTTP endpoint accepts only
     the local token (AD-13 point 6). The relay tunnel accepts only OAuth
     access tokens issued for this device (point 5); the local token is never
     accepted through the tunnel. stdio has no credential.
   - **Remote token verification on the device** (behind
     `AccessTokenVerifier`; implementation WP-28): a JWT signed by the
     configured issuer (JWKS) with matching `iss`; `aud` equal to this
     device's resource URI (point 5); valid `exp` and `nbf`; a device claim
     equal to the local device id from device binding; the grant is not
     revoked. Any failure returns 401 with `WWW-Authenticate` that points to
     the Protected Resource Metadata.
   - The relay's check of the same token (point 10) only admits and routes the
     request. It never replaces the device's verification.
   - Credentials never reach Core, the audit log, logs, the browser, child
     processes or outbound requests, and they are never forwarded to any other
     service.

5. **Resource and audience.**
   - Each device has exactly one canonical **resource URI**, its MCP endpoint
     at the relay (form `https://<relay-host>/d/<deviceId>/mcp`; the exact
     form is fixed in WP-29). It is at the same time the URL clients connect
     to, the `resource` of the Protected Resource Metadata (RFC 9728) the
     relay serves for it, and the required token audience.
   - Clients request tokens with the resource indicator (RFC 8707) set to that
     URI. A token for another device or another resource is rejected, even if
     it belongs to the same account.
   - Relay and device are one logical resource server for that URI. That the
     relay verifies the token and the device verifies it again is not token
     passthrough; the relay never mints, exchanges or replaces tokens for the
     device.
   - **Identity-provider criteria** (selection in WP-28): OAuth 2.1 with PKCE
     (S256); CIMD, plus DCR for clients of older versions (DCR is deprecated
     in 2026-07-28 but still used); resource indicators (RFC 8707);
     audience-bound JWT access tokens with a custom device claim; issuer
     identification (RFC 9207); revocation of grants; MFA for accounts.

6. **Principal and `local` / `remote`.**
   - The principal kind is set only by the entry point, never by token
     contents, client info, headers or tool arguments:

     | Entry point | `kind` | `id` | `transport` | `authMethod` |
     | --- | --- | --- | --- | --- |
     | stdio | `local` | `local-user` | `stdio` | — |
     | loopback HTTP + local token | `local` (changed in WP-19; before: `remote`) | `local-token:<fingerprint>` | `http` | `local-token` |
     | relay tunnel + OAuth token | `remote` | stable subject of the grant | `relay` | `oauth` |

   - A `remote` principal additionally carries the verified `accountId`,
     `deviceId` and `clientId` (the client identifier from the token, not the
     self-reported client name). This is an additive change of `Principal`.
     `client` stays self-reported and informational.
   - **`local`** means that the request comes from the user's own machine
     through a channel only local programs can reach. **`remote`** means that
     it arrives from the internet through the relay. Rules with
     `principalKinds`, the remote permission profile (AD-13 point 5, WP-31),
     command confinement fallbacks (AD-13 point 4) and audit distinguish
     exactly these two.
   - **Migration.** After WP-19, rules with `principalKinds: ["remote"]` no
     longer match loopback HTTP clients (for example the `remote-writes`
     example in README). There is no compatibility alias. WP-19 documents the
     change in README; until a transport matcher exists (§26 question 12),
     loopback HTTP clients can be gated only together with stdio
     (`principalKinds: ["local"]`).

7. **Execution context.**
   - The adapter builds the execution context for **every request** from
     steps 2–3 and the entry point. It is immutable and is not taken over from
     an earlier request; only the exposure state behind its scope is shared.
   - It contains the principal, the exposure scope (point 8), a request id and
     the cancellation signal. No transport object (session, socket, tunnel
     stream) reaches Core as an authority.
   - The request id is unique per CROT process: the adapter generates it and
     may record the JSON-RPC id next to it. It correlates audit events only.
   - The signal is aborted when the request's HTTP response or stream closes,
     the tunnel stream closes, the stdio connection closes, or a legacy
     `notifications/cancelled` arrives. A pending approval is then cancelled
     (existing behaviour).
   - The difference between a transport session and the execution context:
     the transport session may correlate several requests for transport
     purposes. The execution context belongs to one request and determines,
     together with the PermissionEngine, everything Core does.

8. **Exposure and its lifecycle.**
   - Exposure (AD-12) is recorded per **exposure scope**, which the adapter
     derives from the entry point and the principal:

     | Entry point / version | Exposure scope |
     | --- | --- |
     | stdio | the connection (unchanged, AD-12) |
     | loopback HTTP, legacy session | the MCP session (unchanged, AD-12) |
     | loopback HTTP, 2026-07-28 (sessionless) | the local-token principal for the lifetime of the CROT process |
     | relay tunnel, any version | the triple (`accountId`, `deviceId`, `clientId`) |

   - For remote principals the scope does not depend on sessions, protocol
     versions or individual tokens. Opening a new session, sending
     `initialize` again, refreshing or re-issuing a token, or reconnecting the
     tunnel does not create a clean scope.
   - The state changes only from `clean` to `exposed`. Sources and the gate
     are unchanged (AD-12 points 3–6).
   - **Reset (remote scopes only):** exclusively (a) an explicit user action
     in an approval provider ("reset exposure" for one client on this
     device), recorded in the audit log, or (b) revocation of the client's
     access to the device, also a user action. No tool, request, token claim,
     relay message, browser message or configuration value can reset it.
   - **Persistence (remote scopes):** remote exposure survives CROT restarts.
     It is stored in CROT's private state (a protected path). If the stored
     state cannot be read, every remote scope is treated as exposed (fail
     closed). Local scopes stay in memory as in AD-12.
   - Accepted over-application: all agents that a platform runs behind one
     `clientId` for the same account share one scope.

9. **Mandatory security boundaries before local execution.** No remote request
   reaches an OS resource, the browser or the network without passing, in
   addition to point 2:
   - the PermissionEngine (mode, capabilities, workspace boundary, protected
     paths, network policy) and the approval gates, with the exposure of its
     scope;
   - the ExecutionGuard (validation, path resolution, re-authorization,
     revalidation, mandatory audit, AD-7);
   - command confinement L1 for shell and process operations of `remote`
     principals, or their refusal where L1 is unavailable (AD-13 point 4);
   - the browser approval binding (AD-6, AD-8, AD-9, AD-11).

   There is no shortcut for "trusted" relays, clients or accounts. When remote
   mode is off on the device, the tunnel is closed and no remote request is
   processed.

10. **Responsibilities of the Cloud Relay.**
    - **Must:** terminate TLS; serve the Protected Resource Metadata and 401
      challenges for each device URI; check the token (signature, `iss`,
      `aud`, expiry) and the device's entitlement (WP-36) before admitting a
      request; route by the device id in the path to that device's tunnel;
      forward the request unchanged (method, all headers including
      `Authorization`, `MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name`,
      `Mcp-Param-*`, `Mcp-Session-Id`, and the body); stream the response back
      unchanged; enforce size and rate limits; refuse requests for offline
      devices or devices with remote mode off.
    - **Must not:** authorize CROT operations; parse, change or store bodies;
      log payloads; keep MCP sessions or protocol state; approve or present
      approvals; mint or exchange tokens for the device; assert identity to the
      device through its own headers (the device takes identity only from the
      token and ignores any identity headers added by the relay). It may route
      or rate-limit by `Mcp-Method` only for versions with header–body
      validation (2026-07-28); the device performs that validation.
    - The tunnel is authenticated with the device credential (WP-28). This
      credential proves to the relay which device holds the tunnel. It never
      authenticates a request: every request carries its own client token.

11. **Responsibilities of the local CROT.** Everything authoritative: full
    token verification (point 4), principal (point 6), execution context
    (point 7), exposure (point 8), authorization, approvals, confinement and
    audit (point 9); the device credential and the outbound tunnel; turning
    remote mode on and off (user action in the tray). The local CROT trusts
    nothing the relay asserts beyond delivering bytes.

12. **Client independence.** The contract contains no client-specific
    behaviour. Self-reported client info is informational. The verified
    `clientId` is used only for the exposure scope and for audit.
    Compatibility follows from the MCP specification and the supported
    version list (point 3), verified by WP-32.

13. **Constraints on the implementation (WP-19, WP-20, WP-22, WP-28…WP-31).**
    - C1: Core interfaces change only additively: the exposure scope replaces
      `SessionRef` as the key of `ExposureTracker`, with stdio and legacy
      local sessions mapped as before, and `Principal` gets the remote
      fields. The PermissionEngine, the ExecutionGuard, the approval broker
      and the tools are not changed by this decision.
    - C2: No code path builds an execution context without authentication
      (except stdio), and none takes `kind`, ids or the exposure scope from
      request content.
    - C3: The HTTP pipeline accepts 2026-07-28 sessionless requests and legacy
      session-based requests on the same endpoint and distinguishes them by
      the protocol version, as the specification's backward-compatibility
      rules describe.
    - C4: The tunnel entry point (WP-30) reuses that pipeline and differs only
      in: no loopback Host check, OAuth verifier instead of the local token,
      `transport: "relay"` and `kind: "remote"`.
    - C5: Remote exposure is persistent and fails closed (point 8); its reset
      exists only on the approval-provider channel (WP-22).
    - C6: No server-to-client requests and no approvals through MCP
      (point 3).
    - C7: The relay implements point 10 and nothing more; it contains no
      CROT authorization logic and no MCP implementation (AD-13 point 6).
    - C8: Tests cover: a sessionless client; repeated `initialize` and new
      sessions not clearing remote exposure; header–body mismatch; unsupported
      versions; a token for another device; the local token rejected on the
      tunnel; unchanged stdio behaviour.

**Scope and limits.**

- This decision is the contract of WP-17. It is documentation only;
  implementation follows in WP-19 (principal kind, exposure scope and
  persistence, sessionless HTTP), WP-22 (exposure reset and revocation UI),
  WP-28 (verifier, remote principal fields, identity provider), WP-29 (relay)
  and WP-30 (tunnel entry point).
- It amends AD-12 points 2 and 7 for remote principals and for sessionless
  loopback HTTP requests (point 8). For stdio and legacy local sessions AD-12
  is unchanged. It decides AD-14 point 3 within its constraints and does not
  change AD-13.
- It resolves §26 question 10. Left open: §26 questions 12 (transport matcher)
  and 13 (long-running gated requests through the relay); the choice between
  the SDK v1 line and SDK v2 for 2026-07-28 support (WP-19; settled there:
  SDK v1 for stdio and legacy sessions, SDK v2 for 2026-07-28); which token claim
  carries `clientId` and the device id (WP-28, depends on the identity
  provider); the exact device URI form (WP-29).
- Residual risks, accepted: exposure is shared by all agents behind one
  `clientId`; a user who resets exposure or revokes and re-grants access
  starts that client clean, while the model may still hold earlier untrusted
  content (as in AD-12); the relay sees traffic in transit (AD-13 point 6).

### AD-16. Browser contract v1: a fixed command set over `chrome.debugger` (CDP) with tab- and document-bound element references, explicit tabs, per-tab serialization and the two approval presets (WP-18)

**Context.** AD-14 point 2 makes the browser contract v1 (§7.1) release-blocking
and leaves the technology, the command list and the element-reference model to
this decision; AD-14 point 4 leaves the exact rule set and configuration key of
the two approval presets to it; §26 question 11 lists the open points. The
current implementation (`main` at `93c774f`) works as follows:

- **Commands.** Ten tools (`docs/BROWSER_EXTENSION.md`). Page functions run
  through `chrome.scripting.executeScript` in the extension's isolated world of
  the main frame only and find elements with `document.querySelector`.
  `browser_click` calls `element.click()`; `browser_type` sets values through
  the native setter and dispatches `input` / `change`. `browser_screenshot`
  uses `captureVisibleTab` and refuses every tab that is not visible.
- **Targeting.** `tabId` is optional everywhere; without it the extension acts
  on the active tab of the last focused window (AD-8). `tabs.list` reports no
  `openerTabId`.
- **Concurrency.** `BrowserService` sends requests as they come (bridge limit
  16 pending, extension limit 32 in flight); nothing orders commands to one
  tab.
- **Binding and approvals.** Gated operations are bound to tab, normalized
  origin and `connectionId` and re-checked by the extension right before the
  action (AD-6, AD-8, AD-9, AD-11). Exposure sources are `browser.page_read`,
  `browser.screenshot`, `browser.tabs_list` and `network.request` (AD-12).
- **Permissions.** `nativeMessaging`, `tabs`, `scripting`, `alarms`, host
  permissions `<all_urls>`; no `debugger`, `downloads` or `tabGroups`.

**Spike (WP-18).** A throwaway MV3 extension (not merged) was driven only
through its service worker, so the harness itself never handled pages or
dialogs. Environment: Chrome for Testing 153 on Linux, `--headless=new`, two
local origins (`http://127.0.0.1:<p1>` with a cross-origin iframe from
`http://localhost:<p2>`, which Chrome ran as an out-of-process frame), an open
shadow root, a file input, a `confirm()` and a download link. Findings:

| Requirement (§7.1) | `chrome.scripting` | `chrome.debugger` (CDP 1.3) |
| --- | --- | --- |
| Click, Enter, text input | works, but every event has `isTrusted: false` | `Input.dispatchMouseEvent`, `Input.dispatchKeyEvent`, `Input.insertText`: `isTrusted: true` |
| Open shadow DOM | reachable through `shadowRoot` (synthetic events) | `DOM.getDocument({ pierce: true })` and the accessibility tree reach it; trusted click |
| Cross-origin frame | reachable with `allFrames` / `frameIds` (synthetic events) | a mouse event at the frame's coordinates on the top-level target reaches the OOPIF, trusted; `Target.setAutoAttach({ flatten: true })` yields a child session whose accessibility tree lists the frame's elements |
| Page model | only through own page functions | `Accessibility.getFullAXTree` gives role, name and `backendDOMNodeId` per element |
| File upload | only by building a `File` from bytes sent over native messaging (`isTrusted: false` `change`) | `DOM.setFileInputFiles` with a local path; the page sees the file and a trusted `change` |
| `confirm()` | **blocks**: the injecting call does not return and every later injection into the tab hangs | `Page.javascriptDialogOpening` reports type and message; `Page.handleJavaScriptDialog` answers it |
| Background-tab screenshot | `captureVisibleTab` only captures the visible tab | `Page.captureScreenshot` captured a tab that was not active, without activating it |
| Download into a chosen directory | not possible | `Browser.setDownloadBehavior` does not exist for extensions and `Page.setDownloadBehavior` is refused ("Cannot access browser-level commands"); `Page.downloadWillBegin` / `downloadProgress` attribute a download to the frame that started it; `chrome.downloads` reports the file in the default download directory |
| Stale element | — | after a navigation a `backendNodeId` taken before it **still resolved** to a node of the new document; `DOM.resolveNode` refused it ("does not belong to the document"); the top frame's `loaderId` changed |
| Code execution | page functions only | `Runtime.evaluate` with arbitrary text is available to the extension and must therefore be excluded by the contract |

Not covered by the spike: real third-party sites (the work environment had no
internet access), headed mode and the debugger infobar, Windows and macOS,
Edge and Brave, input into background tabs, `beforeunload`, HTTP
authentication and permission prompts. These are open items for WP-24…WP-26
(see Scope and limits).

**Decision.**

1. **Contract, not implementation (normative scope).** This decision fixes the
   observable behaviour that a consumer of the browser capability (any MCP
   client, local or remote) can rely on: tool and operation names, parameters
   and results at the level of fields and meaning, capabilities, approval and
   exposure behaviour, error codes, ordering, isolation and limits. It does not
   depend on any MCP client, on Notion, Telegram, `telegram-stream` or any
   other product; every rule is stated in terms of tabs, documents, frames,
   elements and CROT facts. Point 19 lists what is left to the
   implementation.

2. **Terms (normative).**
   - **Browser connection** — one accepted bridge connection with its
     `connectionId` (AD-9). It ends when the extension disconnects, the browser
     restarts or CROT restarts.
   - **Tab identity** — the pair (`connectionId`, `tabId`). A `tabId` is
     meaningful only within its connection; after a reconnect every earlier
     `tabId`, reference and pending dialog is invalid (§7.1, AD-9). Agents see
     only `tabId`; the connection is checked by Core.
   - **Document** — one loaded document of one frame. A new document starts
     with every cross-document navigation of that frame (link, form,
     `navigate`, reload, back/forward that loads a document, including
     restores from the back/forward cache). Same-document navigations
     (`pushState`, `replaceState`, fragment changes) do not start a new
     document.
   - **Frame** — the top-level frame of a tab or a child frame (`iframe`,
     `frame`) at any depth, same- or cross-origin.
   - **Element reference (`ref`)** — an opaque string issued by
     `browser_snapshot` that denotes one element of one document of one frame
     of one tab of one connection (point 5).
   - **Command** — one browser tool call (one guard operation, possibly
     several bridge requests).
   - **Agent context** — the exposure scope of the request (AD-15 point 8):
     the stdio connection, the legacy session, the local-token principal or
     the remote triple (`accountId`, `deviceId`, `clientId`).

3. **Technology: `chrome.debugger` (CDP) as the page backend of v1.**
   - The extension performs page reading for the snapshot, all page input,
     frame and shadow-DOM access, dialogs, file inputs, background screenshots
     and download attribution through `chrome.debugger` (protocol 1.3).
     Rationale (spike): `chrome.scripting` cannot produce trusted input,
     blocks on `alert` / `confirm` / `prompt`, cannot set files from disk and
     cannot capture background tabs; one mechanism covers all of §7.1 point
     2–7.
   - `chrome.tabs`, `chrome.windows` and `chrome.tabGroups` stay the tab-level
     backend; `chrome.downloads` handles downloads (point 12), because CDP
     download control is not available to extensions.
   - `chrome.scripting` stays only for the existing built-in page functions of
     `browser_page_read` and of the legacy selector forms of `browser_click` /
     `browser_type` (point 20); new commands do not use it.
   - **Fixed CDP surface.** The extension sends only CDP methods from a fixed,
     Core-reviewed allowlist compiled into the extension, with parameters it
     builds itself from validated command parameters. The allowlist covers the
     domains `Accessibility`, `DOM` (read, box model, focus, scroll into view,
     `setFileInputFiles`, `resolveNode` / `describeNode`), `DOMSnapshot`,
     `Input`, `Page` (lifecycle, navigation history, dialogs, file chooser
     interception, `captureScreenshot`, frame tree, download events), `Target`
     (auto-attach to child frames only) and event-only use of `Network` for
     load-state counting (no bodies, headers or cookies). Forbidden in every
     case: `Runtime.evaluate`, `Runtime.compileScript`,
     `Runtime.callFunctionOn` or `Page.addScriptToEvaluateOnNewDocument` with
     any text that did not ship in the extension, the `Debugger`, `Fetch`,
     `Storage`, `Browser`, `SystemInfo` and `Emulation` permission and
     override methods, `Network.getCookies` / `getResponseBody` /
     interception, `Target.createTarget`, `Target.createBrowserContext` and
     attaching to anything other than `http:` / `https:` pages of the
     connected profile and their frames. The only page-world code is the
     extension's built-in functions (§7 rule: no host- or agent-supplied code
     in the browser).
   - **Attach lifecycle.** The extension attaches to a tab on the first
     command that needs CDP and detaches when the tab closes, when the
     connection ends or after an idle period. It never attaches to tabs no
     command targeted. While attached, the browser shows its own "debugging
     this browser" notice; CROT never suppresses it (no
     `--silent-debugger-extension-api`, no policy changes by the installer).
     If the user or the browser detaches the debugger, commands in flight fail
     with `OPERATION_FAILED`, every reference of the tab becomes stale and the
     next command re-attaches.
   - **No fallback that weakens the contract.** If `chrome.debugger` is
     unavailable (for example blocked by enterprise policy), `browser_status`
     reports it and the commands that need CDP fail with `OPERATION_FAILED`
     and a fixed message. They never fall back to synthetic events or to
     another tab.
   - **Extension permissions (store justification).** Added: `debugger`
     (trusted input, frames, dialogs, file inputs and background screenshots
     for agent-driven browsing that the user enabled in CROT; no network
     interception, no code from outside the extension), `downloads` (saving a
     file the agent asked for into the user's project) and `tabGroups` (making
     agent tabs visible as a "CROT" group). Unchanged: `nativeMessaging`,
     `tabs`, `scripting`, `alarms`, `<all_urls>`, `"incognito": "not_allowed"`,
     no content scripts, no `externally_connectable`, no web-accessible
     resources.

4. **Tabs, explicit `tabId` and `openerTabId`.**
   - **Explicit tab for remote principals.** For principals of
     `kind: "remote"` (AD-15 point 6) every command that targets a tab (all
     page commands, `navigate`, `history`, `tab_activate`, `tab_close`,
     dialogs, files, screenshots, snapshot, wait) requires `tabId`. A missing
     `tabId` is `INVALID_INPUT` during input validation, before authorization;
     no "active tab" is ever resolved for a remote principal. This is input
     validation of a Core fact (principal kind), not a second permission
     system.
   - **Explicit tab for every reference command.** Commands that take a `ref`
     require `tabId` for every principal; a `ref` from another tab is
     `BROWSER_STALE_REF`. For local principals the existing tools keep the
     optional `tabId` with the AD-8 default.
   - **`browser_tabs_list`** reports per tab, in addition to today's fields:
     `openerTabId` (the tab whose page or CROT command opened it, as the
     browser reports it, also for pop-up windows; absent when unknown or the
     opener is closed), `groupedByCrot` (in a CROT tab group), `openedBy`
     (`"this-context"`, `"crot"` or `"other"`: whether a CROT command of the
     calling agent context, of another context, or nobody known to CROT
     opened it; this is information, not authority), `discarded`, and
     `dialog` (the pending dialog of point 9, if any). Tab titles and URLs
     stay untrusted, and the operation stays an exposure source.
   - **New tabs in results.** Every control command reports `newTabs`: the
     tabs (id and URL) that were created with the target tab as opener while
     the command and its settle phase (point 7) ran. This lets an agent follow
     pop-ups and OAuth windows its own action opened without scanning all
     tabs.
   - **Visibility.** Tabs opened by `browser_tab_open` are added to a tab group
     named "CROT" in their window (created when needed); tabs opened from a
     CROT-grouped tab are added to the same group when the browser allows it
     (pop-up windows cannot be grouped and are reported through
     `openerTabId`). Group membership is a visibility aid. The user may move
     tabs in or out; it never grants or limits access.
   - **Focus.** No command activates a tab or focuses a window except
     `browser_tab_activate` and `browser_tab_open` with `active: true`. Reads,
     input, waits, dialogs, files and screenshots work on background tabs and
     leave the user's focus where it is.

5. **Page model: snapshot and element references.**
   - **`browser_snapshot`** (`browser.read`) returns for one tab: `tabId`,
     `url`, `title`, the frame list (`frameRef`, parent, `url`, normalized
     origin, `restricted` for frames CROT cannot read) and the interactive
     and landmark elements of all frames in document order, each with `ref`,
     `frameRef`, `role`, accessible `name`, `value` (bounded), states
     (`disabled`, `checked`, `selected`, `expanded`, `pressed`, `focused`,
     `readonly`, `required`, `editable`), `bounds` in CSS pixels of the
     top-level viewport and `inViewport`. Optional parameters: `frameRef`
     (one frame only), `includeText` (adds visible text nodes, bounded) and
     `maxElements`. Results are bounded (element count, string lengths, total
     bytes) and report `truncated`.
   - **Secrets.** The snapshot never returns the value of password fields;
     they report `hasValue` only.
   - **References.** A `ref` is created by the extension, is unique within its
     connection, and is valid only for its (connection, tab, frame, document).
     The same element keeps the same `ref` across snapshots of the same
     document. A `ref` is not a secret and not an authority: it only names an
     element; every command with a `ref` is authorized and approved like any
     other.
   - **Invalidation.** A `ref` becomes stale, permanently, when its document is
     replaced (point 2), when its element is removed from the document, when
     its frame is detached, when the tab closes, when the debugger is detached
     from the tab, or when the connection changes.
   - **Check before acting.** Immediately before acting on a `ref`, as part of
     the same command, the extension verifies that the `ref` belongs to the
     named tab, that its frame still shows the same document (not only the
     same node id; the spike showed node ids resolving into a new document)
     and that the element is still connected. Otherwise the command fails with
     `BROWSER_STALE_REF` and does nothing. CROT never re-resolves a stale
     `ref` by role, name, text, position or selector, never retries with
     another element, and never acts on "the closest match". The agent takes a
     new snapshot.
   - **Selectors.** Commands that accept a `ref` also accept
     `{ selector, frameRef? }` (CSS, light DOM of one frame document, first
     match). A selector is resolved at execution time and is not a reference;
     it gives no staleness guarantee beyond the tab binding.
   - **Exposure.** `browser.snapshot` is an exposure source (AD-12 point 3,
     §7.1 point 1).

6. **Input.** All input is CDP input of the browser (trusted DOM events), not
   OS-level input (§22). Commands (all `browser.control`):
   - `browser_click` — target (`ref` or selector), `button`
     (`left` / `right` / `middle`), `clickCount` (1 or 2), `modifiers`; double
     and context click are `clickCount: 2` and `button: "right"`.
   - `browser_hover`, `browser_scroll` (an element into view, or the page or
     a scroll container by `deltaX` / `deltaY`), `browser_drag` (from one
     target to another target or to an offset).
   - `browser_type` — target, `text` (at most 100 000 characters), `clear`,
     optional `submit` (press Enter afterwards); inserts text as browser input
     into any editable element (inputs, textareas, `contenteditable`).
   - `browser_press_key` — optional target to focus first, `keys`: one key or
     a combination in a fixed notation (`Enter`, `Tab`, `Escape`, arrows,
     `Home`, `End`, `PageUp`, `PageDown`, `Backspace`, `Delete`, `F1`–`F12`,
     printable characters, modifiers `Shift`, `Control`, `Alt`, `Meta` and
     `ControlOrMeta` for the platform's shortcut modifier); a sequence of at
     most 32 combinations.
   - `browser_select_option` — a native `select` by option values or labels;
     custom drop-down lists are operated with click, keys and snapshot.
   - `browser_set_checked` — checkbox, radio button or switch: acts only when
     the state differs and reports the resulting state.
   - **Actionability.** Before pointer input the extension scrolls the element
     into view, requires a non-empty box, an enabled element and a hit test at
     the click point that lands on the element or its descendant. Otherwise
     the command fails with `INVALID_INPUT` (with a fixed reason such as
     "obscured", "disabled", "not visible") and nothing is dispatched. There
     is no "force" option.
   - Input to an element inside a frame or a shadow root is dispatched at its
     top-level viewport coordinates (spike: trusted, reaches cross-origin
     frames).
   - Typed text and key sequences are never audited (length and key count
     only) and are shown in approvals only as length (existing
     `secret_size_only` flag).

7. **Results, navigation, waiting and history.**
   - **Control results.** Every control command answers, after its settle
     phase, with `tabId`, the committed `url`, `navigated` (a new top-level
     document was committed), `newTabs` (point 4) and `dialog` (`{ type }`
     only, when a dialog is pending; point 9). The settle phase ends when no
     top-level navigation started by the action is pending (it then waits for
     the load state of `waitUntil`) or after a short fixed quiet period. The
     result never contains page text.
   - **Navigation.** `browser_navigate` and `browser_tab_open` keep their
     tools and gain `waitUntil` (`commit`, `domcontentloaded`, `load`
     (default), `networkidle`) and `timeoutMs`. `browser_history` performs
     `back`, `forward` or `reload` with the same waiting parameters. Only
     `http:` / `https:` URLs; a navigation of a tab to another origin is
     allowed (it is `browser.control`) and the approval binding is checked
     against the origin before the action (AD-6, AD-11).
   - **Waiting.** `browser_wait` (`browser.read`) waits on one tab for exactly
     one condition: a `ref` or selector becoming `visible`, `hidden`,
     `enabled` or `detached`; a text appearing or disappearing; the URL
     matching a given URL prefix; a load state; a new document (navigation);
     or a new tab opened from this tab. It answers `{ satisfied: true, url }`
     or fails with `TIMEOUT`. It returns no page content and is not an
     exposure source.
   - **Timeouts.** Every waiting parameter is bounded: `timeoutMs` at most
     60 000 ms (default 20 000 ms, as today's load wait). Core's request
     timeout for such a command is its `timeoutMs` plus a fixed margin, so a
     wait never outlives the request. How long gated requests may stay open
     through the relay remains §26 question 13.
   - **No hidden retries.** CROT never repeats an action. A command that
     failed may or may not have had an effect (for example a click whose
     result timed out); the agent observes the page again.

8. **Per-tab sequencing (normative).**
   - Commands that target a tab enter a FIFO queue of that tab identity in
     Core (`BrowserService`) after authorization, after the approval gate
     (an approval wait never holds the tab) and immediately before their first
     bridge request. They run one at a time in queue order; a command
     completes, including its settle phase, before the next one starts, so
     the next command observes its effects. The extension serializes commands
     per tab as well (defence in depth); its order never differs from Core's.
   - Commands to different tabs, and tab-less commands (`browser_status`,
     `browser_tabs_list`, `browser_tab_open`), run concurrently.
   - The queue per tab is bounded (16); a command that does not fit fails with
     `RESOURCE_BUSY`. A command cancelled before it started leaves the queue
     without effect; one cancelled while running ends at its next safe point
     and its effect is unknown.
   - The AD-6 / AD-11 binding of a gated command is checked when it reaches
     the front of the queue, immediately before the action, not when it was
     enqueued.
   - The user may use the same tab at the same time. CROT does not lock tabs.
     A user action that replaces the document or changes the origin makes
     references stale and bindings fail; it never makes CROT act on another
     document.

9. **Dialogs and choosers.**
   - When a tab that CROT is attached to opens `alert`, `confirm`, `prompt` or
     a `beforeunload` dialog, the extension records it as the tab's pending
     dialog: `type`, `message` (bounded), `defaultPrompt`. At most one dialog
     is pending per tab.
   - Control results report only `dialog: { type }`; the message (page
     content) is returned by `browser_snapshot` and `browser_tabs_list`, which
     are exposure sources.
   - `browser_dialog_handle` (`browser.control`, bound like every control
     command) answers it: `accept` (`true` / `false`) and, for `prompt`,
     `promptText`. A `beforeunload` accept leaves the page.
   - While a dialog is pending, other page commands on that tab fail at once
     with `BROWSER_DIALOG_OPEN`; `browser_snapshot`, `browser_tabs_list`,
     `browser_dialog_handle` and `browser_tab_close` still work. No command
     hangs on a dialog.
   - **Never indefinitely.** A dialog that is not handled within the dialog
     timeout (fixed, 60 s) is dismissed (`accept: false`; for `beforeunload`
     the page stays) and the dismissal is audited. Dismissing is the safe
     answer: it never confirms an action.
   - **File choosers.** While attached, the extension intercepts file chooser
     requests, so no OS file dialog opens. A pending chooser is reported like
     a dialog (`type: "file_chooser"`) and is answered only by
     `browser_file_upload` or dismissed.
   - Dialogs in tabs CROT is not attached to are not touched. HTTP
     authentication prompts, permission prompts (camera, location,
     notifications), print and external-protocol dialogs are not handled in v1:
     a command that runs into one ends with `TIMEOUT` or `OPERATION_FAILED`.

10. **Frames and shadow DOM.**
    - The snapshot covers the top-level frame and all child frames, including
      cross-origin and out-of-process frames, up to a fixed depth; every
      element carries its `frameRef`, and every frame its URL and normalized
      origin. Frames whose document is not `http:` / `https:` (or is blocked
      by the browser) are listed as `restricted` without content;
      `about:blank` and `srcdoc` frames count as their parent's origin.
    - Elements in **open** shadow roots are part of the snapshot and
      addressable by `ref` (guaranteed). Elements in closed shadow roots may
      appear because the snapshot follows the accessibility tree; this is not
      guaranteed. Selectors do not pierce shadow roots.
    - **Binding.** The AD-6 / AD-11 binding stays the tab and its top-level
      origin. For a command whose target is in a child frame, the approval
      subject additionally shows the frame's origin (and the element's role
      and name, point 16), and the audit records it. Because a `ref` is valid
      only for one document, the frame cannot change origin between approval
      and action without the command failing.

11. **File upload.**
    - `browser_file_upload` (`browser.control` + `filesystem.read`) sets one or
      more workspace files on a file input (`ref`) or answers a pending file
      chooser. Paths are resolved and checked by the ExecutionGuard exactly as
      for `filesystem.read_file` (workspace boundary in sandbox mode,
      protected paths, symlink resolution); the operation needs both
      capabilities.
    - The browser never receives the agent's path. Core places an immutable
      copy of each resolved file in a CROT-private staging directory and gives
      the browser that path (spike: `DOM.setFileInputFiles` takes a path). The
      copy is kept until the tab's document is replaced, the tab closes, or
      CROT restarts, because the page reads the file lazily. This closes the
      race in which a path checked in the workspace is swapped for another
      file before the browser reads it.
    - Limits: a fixed maximum number of files per command and a configured
      maximum total size; the result reports names and sizes. Audit records
      workspace-relative paths and sizes, never contents.
    - Upload sends local data to a web page. It is therefore gated in both
      presets in an exposed context (point 17).

12. **File download.**
    - `browser_download` (`browser.control` + `filesystem.write`) saves exactly
      one download into the workspace: `tabId`, a trigger (a target to click,
      or an `http:` / `https:` URL that the browser downloads with the
      profile's session), `savePath` (a workspace path checked like
      `filesystem.write_file`), `overwrite` (default `false`) and `timeoutMs`.
    - Only the download that starts in that tab (any of its frames) during the
      command is captured; it is attributed through the browser's download
      events, never by guessing from file names or times. Downloads not
      started by a CROT command are never moved, read or reported.
    - The file appears at `savePath` atomically and only when the download
      completed; partial, interrupted or browser-flagged dangerous downloads
      leave nothing in the workspace and fail the command. The result reports
      size and MIME type, not contents and not the page-suggested file name.
    - Core takes the file over from the browser only from a staging location
      it created for this command (an unguessable name in the browser's
      download directory, or a stream over the bridge; chosen in WP-26). It
      never reads a path just because the browser reported it: the file must be
      a regular file at the expected staging location, opened without
      following symlinks; the staging copy is removed afterwards.
    - Downloads need `filesystem.write` and are therefore gated in both
      presets in an exposed context.

13. **Screenshots and background observation.**
    - `browser_screenshot` captures any `http:` / `https:` tab, also when it is
      in the background, without activating it or focusing its window
      (replaces today's `INVALID_INPUT` for non-visible tabs; additive for
      agents). Options: format and quality as today, `ref` (clip to one
      element) and `fullPage`. The result adds the viewport size and the
      device pixel ratio, so that images map to snapshot `bounds`. Limit
      16 MiB as today. It stays an exposure source.
    - Discarded tabs (`discarded: true`) are not reloaded implicitly; page
      commands on them fail with `INVALID_INPUT` until the agent navigates or
      reloads.
    - Snapshot, read, wait, dialogs, files and screenshots never change the
      visible state of the browser except through the debugger notice
      (point 3).

14. **Isolation between agent contexts.**
    - All agent contexts share the one connected browser profile with the
      user (cookies, logins, storage): CROT does not partition the profile in
      v1 (accepted, AD-13 residual risks). Isolation is about not interfering:
      explicit tab identity (point 4), per-tab serialization (point 8),
      document-bound references (point 5) and no focus changes (point 4).
    - Exposure from a browser read marks only the agent context that made the
      read (AD-12, AD-15). Approvals stay per operation (AD-5) and are never
      shared between contexts.
    - `openedBy` (point 4) lets an agent tell its own tabs from the user's and
      other agents' tabs. It is not an access restriction: with
      `browser.control`, every context may act on every `http:` / `https:` tab
      of the profile, as today. Restricting remote contexts to the tabs they
      opened would be a new policy matcher and is left to §26 question 14.
    - Pending dialogs, file choosers and downloads belong to their tab; their
      details are returned only to the command that handles or captures them
      and through the exposure sources.

15. **Security invariants (unchanged and extended).**
    - Every command is a fixed Core operation through `BrowserService` and the
      ExecutionGuard; the PermissionEngine is the only authority; the bridge,
      the relay and the extension stay dumb transports; the browser side never
      initiates operations (§7).
    - No host- or agent-supplied code runs in the browser; CDP is used only
      through the fixed surface of point 3. Selectors, keys, text and URLs are
      data.
    - Every result is validated against Core's schemas and bounds; browser
      error codes pass only through Core's allowlist, extended by
      `BROWSER_STALE_REF` and `BROWSER_DIALOG_OPEN` (both reported by the
      extension, both mean "nothing was done"). `PERMISSION_DENIED` from the
      extension stays reserved for the expected-subject check (AD-11).
    - Page content, accessible names, values, dialog messages, tab titles and
      URLs are untrusted input (§19); tool descriptions say so. Nothing a page
      contains triggers a command.
    - Audit records operation, tab id, top-level and frame origins, `ref`
      (opaque), element role, input kind, text length and key count, file
      paths and sizes for uploads and downloads. It never records page
      content, accessible names, values, typed text, dialog messages,
      screenshots or file contents, and never full URLs.
    - Restricted pages stay restricted (`chrome:`, extension pages, the web
      store, `file:`, other schemes; incognito not allowed).
    - Typing into password fields is allowed (logins are a v1 workflow), but
      their values are never returned.

16. **Approval model.**
    - Every new command with effects is a `browser.control` operation and is
      bound by AD-6, AD-8, AD-9 and AD-11 (tab, normalized top-level origin,
      `connectionId`; `tabs.resolve` before the approval request). For
      `browser_download` with a URL trigger the URL's origin is shown as an
      effect; the binding remains the tab.
    - The approval subject of a target command contains the `ref` (or
      selector), the element's role, its accessible name marked as
      page-supplied text, and the frame origin when the target is in a child
      frame. The digest covers them. Together with the document check of
      point 5 this binds the approval to the element the user saw described:
      a different element, document or origin fails without acting.
    - `browser_snapshot` and `browser_wait` are `browser.read`;
      `browser_snapshot` is an exposure source, `browser_wait` is not.
    - A gated command waits for its approval within its own request (AD-15
      point 3) and enters the tab queue only after the approval (point 8).

17. **The two approval presets (rule set and configuration key; decides AD-14
    point 4).**
    - **Key.** The existing `permissions.approvals.untrustedContent` gets a
      third value. The values are:
      - `"require-approval"` — preset **Ask for every action** (default,
        unchanged AD-12 rules);
      - `"autonomous-browser"` — preset **Autonomous browser**;
      - `"off"` — no built-in rule (unchanged).
      `crot_status` reports the value. The built-in rules keep the reserved id
      `untrusted-content` in both presets, so the approval subject and the
      audit name them the same way; `crot_status` tells the preset.
    - **Ask for every action** — in an exposed context, any operation that
      requires `shell.execute`, `filesystem.write`, `git.write`,
      `network.access` or `browser.control`, and the operations
      `docker.compose_up` and `docker.compose_down`. Every new browser control
      command is covered through `browser.control`.
    - **Autonomous browser** — in an exposed context, any operation that
      requires `shell.execute`, `filesystem.write`, `git.write` or
      `network.access`, and the operations `docker.compose_up`,
      `docker.compose_down` and `browser.file_upload`. All other
      `browser.control` operations (navigation, input, dialogs, tab
      management) run without approval. `browser.download` stays gated
      through `filesystem.write`; `browser.file_upload` is gated explicitly
      because it moves local data to a web page and its `filesystem.read`
      capability alone would not match.
    - Both presets are ordinary `ApprovalRule`s with the `exposed` matcher,
      evaluated before user rules (AD-12 point 10); user rules still add gates
      (any match gates). They apply to every principal kind, per device.
    - The preset is chosen by the user in the tray (WP-22) and is part of the
      immutable policy (AD-5 point 2, AD-10): changing it is a configuration
      change applied by the user through the local control channel, never by a
      tool, an agent, a page or the relay. How the supervised service applies
      it (reload or restart) is decided in WP-31.
    - The residual risk of AD-14 point 4 is unchanged: with *Autonomous
      browser* an agent that read injected content can act in the user's
      logged-in sessions without asking; it cannot upload files, download into
      the workspace, run commands, write files or Git, or make network
      requests without approval.

18. **What a multi-step browser task can rely on (summary of guarantees).**
    - G1 Observe: a structured snapshot of every frame, with references,
      without reading HTML; screenshots of any tab.
    - G2 Act: trusted input on a named element of a named tab; nothing is
      done when the element, document, tab, origin or connection is not the
      one named or approved.
    - G3 Follow: every control result tells whether a new document was
      committed, which tabs the action opened and whether a dialog is pending;
      `browser_wait` covers everything that happens later.
    - G4 Order: commands to one tab run in order, each after the previous
      one's effects settled.
    - G5 Never stuck: every command ends within its bounded timeout; dialogs
      never block a tab indefinitely; no OS dialogs open.
    - G6 Files: workspace files can be uploaded and downloads saved into the
      workspace, under the workspace rules.
    - G7 No guessing: stale references, missing tabs and binding mismatches
      are errors; CROT never retries, re-resolves or re-targets.
    - G8 Same security everywhere: the same tools, permissions, approvals,
      exposure and audit for local and remote principals; remote principals
      always name the tab.

19. **Boundary between this contract and its implementation.**
    - **Fixed here:** points 1–18 and the command table of point 20 (names,
      operations, capabilities, parameters and results at field level, error
      codes, exposure sources, ordering, limits stated here), the choice of
      CDP and its fixed surface, the presets and their key.
    - **Left to WP-24…WP-27 (must not weaken points 1–18):** the bridge
      message format and internal field names; the `ref` string format; which
      accessibility roles count as interactive; the exact numeric limits not
      stated here (element count, string lengths, staging lifetime details,
      upload size default and its configuration key); key-to-CDP mapping; the
      attach idle timeout; the download hand-over mechanism of point 12; how
      Core and the extension share the per-tab queue state; zod schemas and
      tool descriptions.
    - **Tests the implementation must provide (E2E on real Chromium, plus unit
      tests):** a multi-step form flow by references; stale references after
      navigation, reload, element removal and debugger detach; trusted events
      (`isTrusted`) for click, keys and text; a cross-origin frame and an open
      shadow root; `alert`, `confirm`, `prompt`, `beforeunload` and the dialog
      timeout; a file chooser; upload of a workspace fixture and denial of a
      path outside the workspace in sandbox mode; a download into the
      workspace and a refused overwrite; a background screenshot without a
      focus change; `openerTabId` and `newTabs` for a pop-up; per-tab ordering
      with two concurrent agents; `INVALID_INPUT` for a remote principal
      without `tabId`; both presets; that a forbidden CDP method cannot be
      sent; audit without content. Real third-party sites (at least three) are
      exercised manually in WP-24 and recorded, as the spike could not.

20. **Command list v1 (normative).**

    | Tool | Operation | Capabilities | Exposure source | Notes |
    | --- | --- | --- | --- | --- |
    | `browser_status` | `browser.status` | `browser.read` | no | adds CDP availability |
    | `browser_tabs_list` | `browser.tabs_list` | `browser.read` | yes | adds `openerTabId`, `groupedByCrot`, `openedBy`, `discarded`, `dialog` |
    | `browser_snapshot` | `browser.snapshot` | `browser.read` | yes | new (point 5) |
    | `browser_page_read` | `browser.page_read` | `browser.read` | yes | unchanged |
    | `browser_screenshot` | `browser.screenshot` | `browser.read` | yes | background tabs, `ref`, `fullPage` |
    | `browser_wait` | `browser.wait` | `browser.read` | no | new (point 7) |
    | `browser_tab_open` | `browser.tab_open` | `browser.control` | no | `waitUntil`, `timeoutMs`; CROT tab group |
    | `browser_navigate` | `browser.navigate` | `browser.control` | no | `waitUntil`, `timeoutMs` |
    | `browser_history` | `browser.history` | `browser.control` | no | new: back, forward, reload |
    | `browser_tab_activate` | `browser.tab_activate` | `browser.control` | no | unchanged |
    | `browser_tab_close` | `browser.tab_close` | `browser.control` | no | unchanged |
    | `browser_click` | `browser.click` | `browser.control` | no | `ref` or selector, button, count, modifiers; trusted |
    | `browser_hover` | `browser.hover` | `browser.control` | no | new |
    | `browser_scroll` | `browser.scroll` | `browser.control` | no | new |
    | `browser_drag` | `browser.drag` | `browser.control` | no | new |
    | `browser_type` | `browser.type` | `browser.control` | no | `ref` or selector, any editable element, `submit`; trusted |
    | `browser_press_key` | `browser.press_key` | `browser.control` | no | new |
    | `browser_select_option` | `browser.select_option` | `browser.control` | no | new |
    | `browser_set_checked` | `browser.set_checked` | `browser.control` | no | new |
    | `browser_dialog_handle` | `browser.dialog_handle` | `browser.control` | no | new (point 9) |
    | `browser_file_upload` | `browser.file_upload` | `browser.control`, `filesystem.read` | no | new (point 11) |
    | `browser_download` | `browser.download` | `browser.control`, `filesystem.write` | no | new (point 12) |

    - New operation names are added to `KNOWN_OPERATIONS`; `browser.snapshot`
      is added to `EXPOSURE_SOURCES` (amends AD-12 point 3).
    - **Compatibility of existing tools.** Every existing tool keeps its name,
      operation, capability and current parameters. `browser_click` and
      `browser_type` called with exactly today's parameters keep today's
      behaviour and `chrome.scripting` backend and are documented as legacy;
      the `ref` forms, `frameRef` and every new parameter use CDP. Behaviour changes visible to agents:
      `browser_screenshot` no longer refuses background tabs; remote principals
      must pass `tabId` (they do not exist before WP-30); results gain fields.
    - Tools are client-independent: they need neither MCP sessions nor
      server-to-client requests (AD-15 point 3).

**Scope and limits.**

- This decision is the contract of WP-18. It is documentation only; no
  product code changes. Implementation: WP-24 (CDP backend, snapshot and
  references, trusted input, frames and shadow DOM, waiting, history,
  `openerTabId`, `newTabs`), WP-25 (dialogs and file choosers, background
  screenshots, debugger lifecycle and status, CROT tab group), WP-26 (upload
  and download), WP-27 (per-tab queue, explicit `tabId` for remote
  principals, `openedBy`), WP-22 and WP-31 (preset selection and rule set),
  WP-35 (store justification of `debugger`, `downloads`, `tabGroups`).
- It resolves §26 question 11 and decides AD-14 point 4 (presets). It amends
  AD-12 point 3 (new source `browser.snapshot`) and AD-12 point 5 / AD-10
  point 2 (third value of `untrustedContent`). AD-6, AD-8, AD-9, AD-11, AD-13,
  AD-14 and AD-15 are unchanged and apply to every new command; it is
  consistent with AD-15 (explicit `tabId` keyed on `kind: "remote"`, waits
  within one request, exposure per agent context, no server-to-client
  requests).
- Open for the implementation work packages: behaviour of input into and
  screenshots of background tabs in headed browsers on real sites
  (focus-dependent widgets, throttled or occluded rendering); the debugger
  notice in headed Chrome, Edge and Brave on all three OS; enterprise
  policies that block `chrome.debugger`; acceptance of the `debugger`
  permission by the stores (WP-35); the download hand-over mechanism; HTTP
  authentication and permission prompts (post-v1 unless a v1 scenario needs
  them); validation on at least three real sites.
- Residual risks, accepted: the browser shows a debugging notice while CROT
  is attached; agents share the user's profile and sessions; page-supplied
  names in approval subjects can be misleading (they are marked as page
  text, and the binding still prevents acting on another element, document or
  origin); `chrome.debugger` gives the extension powerful access, which is
  limited only by the extension's fixed CDP surface and code review.

### AD-17. One CROT service per OS user; stdio clients attach through a thin shim; an authenticated owner-only control channel (WP-20, roadmap OD-1)

**Context.** AD-13 point 3 (§26 question 2) decides one supervised local
service with a thin stdio shim but not how it runs per OS, and the roadmap
(`CROT_IMPLEMENTATION_ROADMAP.md` §3.4, OD-1) asks, before WP-20: per-user or
system service; launchd / systemd user unit / the Windows per-user mechanism;
and what the shim does when the service is not running. Before WP-20 every
stdio MCP client started its own `crot-mcp` with its own Core; only the first
owned the browser bridge, the others stayed `in_use` (§26 question 2). The
owner-only control channel, the browser-bridge ownership and the secrets
(WP-21) all assume that the service runs as the user. The tray (WP-22), the
tunnel (WP-30) and the installer (WP-34) build on this decision.

**Decision.**

1. **Per-user service, never a system service (OD-1).** The CROT service is a
   `crot-mcp` process running as the user, one per OS user. It owns the Native
   Host, the browser bridge, Core (PermissionEngine, ExecutionGuard, approval
   broker, audit), the loopback HTTP adapter and, later, the device tunnel
   (WP-30). A system service (root / LocalSystem) is excluded: it would hold
   more privileges than the user, could not own the user's browser bridge and
   private files, and would need its own cross-user authorization.
2. **Two launch modes.** *Managed*: `crot-mcp service run [options]` (and
   `crot-mcp --http`) runs in the foreground and keeps running; it is what OS
   supervisors start at login and restart after a failure — a systemd user
   unit (`Restart=on-failure`) on Linux, a LaunchAgent (`KeepAlive` on
   unsuccessful exit) on macOS, a per-user Task Scheduler logon task with
   restart on failure on Windows. Installing these is WP-34. *On demand*: when
   a stdio shim finds no running service it starts one itself (detached, same
   arguments and environment, output to `<state>/service.log`) and connects;
   an on-demand service stops shortly after its last stdio client
   disconnected. The shim therefore never fails merely because the service is
   not running (OD-1, second question); it fails with a clear error only when
   the service cannot be started or reached, or runs another configuration.
3. **Singleton.** Exclusive ownership of the shim endpoint is the singleton:
   a service that cannot obtain it exits before touching the browser bridge or
   Core (on demand: silently; managed: with an error). A start lock serialises
   concurrent on-demand starts. On shutdown the shim endpoint is released
   last, after the bridge, so a successor never finds the bridge owned.
4. **Thin shim.** In stdio mode `crot-mcp` is a shim: it forwards stdin lines
   unchanged to the service, writes the service's MCP output to stdout and the
   service's diagnostics to stderr, and keeps the observable stdio behaviour
   (same messages and line limit, same shutdown triggers and messages). It has
   no Core, no permissions, no policy and no credential other than the shim
   channel credential. Each shim connection is one MCP connection with its own
   McpServer in the service and therefore its own exposure scope (AD-12,
   AD-15 point 8); the shim never reconnects silently, because a new
   connection would be a new, clean scope — if the service dies, the shim
   exits with status 1 and the MCP client restarts it.
5. **One configuration per service.** A service runs one configuration. A
   shim presents a digest of its effective configuration (configuration file,
   parsed settings except `http`, CROT version); a different digest is refused
   with an explanation while the service is in use; an idle on-demand service
   steps aside for it. Configuration is never taken from the shim's messages.
6. **Endpoints and authentication.** Two local endpoints in the user's
   private state directory: the shim endpoint and the control endpoint (Unix
   sockets `0600` in the `0700` state directory; Windows named pipes whose
   names derive from the credentials). Each has its own 256-bit credential in
   a private file (WP-21 moves them to OS secret storage behind the same
   `CredentialStore` interface). Every connection performs a mutual
   challenge–response (HMAC-SHA-256 over fresh nonces of both sides, channel
   label bound in), then every message carries a per-direction sequence number
   and an HMAC under a per-connection key. Other OS users are stopped by the
   OS; peers without the credential, with a wrong credential, or replaying,
   reordering or modifying frames are rejected and disconnected. Credentials
   are never sent, logged, audited, given to Core, the browser or child
   processes, or passed in arguments or environment variables; the credential
   files and the service log are protected paths.
7. **Control channel.** The control channel is for the user's own tools
   (`crot-mcp service status|stop`; later the tray and its ApprovalProvider,
   WP-22). It carries no MCP and no tools and makes no permission decision; in
   WP-20 its requests are `ping`, `status` and `shutdown`. Approval and
   exposure-reset requests (AD-15 C5) are added by WP-22 on this channel and
   remain the only path for them.
8. **Lifecycle.** Graceful shutdown keeps AD-7: endpoints and connections,
   HTTP, then Core (terminates process trees, drains the guard so operations in
   flight write their audit records, closes the audit log), bridge, Native
   Host, shim endpoint; the existing deadline and emergency kill stay. Health
   is reported by `crot_status` (`service`) and the control channel. Sleep and
   wake are detected from wall-clock jumps; the service then re-checks its
   endpoints (re-creating a missing socket file, stopping if another process
   took it). Persisted remote exposure survives restarts and still fails
   closed.
9. **Sessionless concurrency.** 2026-07-28 requests are limited by
   `http.maxConcurrentRequests` (default 32) in flight; excess requests get
   HTTP 503 (`-32000`, `Retry-After: 1`) before any MCP or Core work.

**Scope and limits.**

- Implemented by WP-20. It decides roadmap OD-1 and the shim behaviour of
  §26 question 2 within AD-13 point 3; AD-1…AD-16 are unchanged. Core changes
  are additive (`crot_status.service`, read-only host information); the
  PermissionEngine, the ExecutionGuard, the approval broker and the tools are
  not changed. The §24 boundaries are kept: the service is the "CROT local
  service (sidecar)", the control channel the tray's "authenticated local
  control channel".
- Background processes belong to the service: all clients of the service see
  them, and they keep running after the client that started them
  disconnected, until the service stops (before WP-20 they ended with that
  client's process). Per-client process ownership is a follow-up.
- Left to later work packages: autostart registration and supervisor files
  (WP-34); OS secret storage and the child-process environment allowlist
  (WP-21); tray, approval provider and exposure reset on the control channel
  (WP-22); the tunnel adapter in the service (WP-30).
- Residual risks, accepted: all stdio clients of a user share one
  configuration; an on-demand service inherits the environment of the shim
  that started it; sleep detection is a heuristic and approval deadlines are
  not extended across sleep; on Windows the pipes keep Node's default security
  descriptor (other users cannot open them for writing) and rely on the
  authentication for everything else; in `full_control` mode an agent can read
  the credential files (as the HTTP and bridge tokens) until WP-21.
