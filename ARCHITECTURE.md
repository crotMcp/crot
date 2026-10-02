# CROT — Architecture Contract

## 1. Product

**CROT** is a universal local AI-agent bridge.

CROT connects external AI agents and MCP clients to the user's local computer and browser.

The goal is to let an AI agent work as a real developer/operator on the user's machine:
- read and modify local projects;
- execute development commands;
- use Git, Docker and local tools;
- interact with the browser;
- combine computer and browser operations in one workflow.

CROT is **not a Notion-specific product**. Notion is only one possible MCP client.

## 2. Architecture

```text
                    CROT
                      |
          +-----------+-----------+
          |                       |
   CROT Browser            CROT Native Host
    Extension                    |
          |                 +-----+-----+
          |                 |     |     |
          |              Files  Shell  Git/Docker
          |                       |
          +-- Tabs               +-- Processes
          +-- Pages
          +-- DOM
          +-- Browser actions
                      |
                      v
                 CROT Core
                      |
                      v
                  CROT MCP
                      |
          +-----------+-----------+
          |           |           |
        Notion      Claude     Other MCP Clients
```

CROT Core must remain independent of any specific AI client, model, or browser.

## 3. CROT Core

CROT Core is the central product layer. It owns:
- permissions and capabilities;
- workspace configuration;
- execution policy;
- filesystem and process access;
- browser bridge;
- authentication/authorization;
- audit logging;
- configuration;
- future licensing/subscription integration.

MCP is an interface exposed by CROT Core, not the entire product.

## 4. MCP

CROT exposes a standards-compatible MCP interface.

Tools must have explicit schemas and validated inputs. Tool execution must enforce authorization, path validation, timeouts/rate limits where appropriate, and auditable execution.

Remote HTTP MCP must be designed around the current MCP authorization model rather than a permanent static bearer token.

## 5. Local Computer Capabilities

When the user grants them, CROT can provide:
- Filesystem
- Shell
- Processes
- Git
- Docker
- Python
- Node.js
- FFmpeg
- Project tools

CROT must support fully autonomous development; it is not a read-only product.

## 6. Permission Architecture

Permissions are a first-class centrally managed subsystem.

### SANDBOX

The agent operates only inside a user-selected workspace, for example:

```text
/home/user/projects/my-project
```

The agent may have full developer capabilities inside that workspace, while paths and operations outside it are denied.

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

## 7. Browser Extension

The extension provides browser integration:
- tabs;
- pages;
- DOM;
- page context;
- screenshots;
- browser actions;
- browser state.

It communicates with the local CROT Native Host and should not require a public server merely for local communication.

## 8. Native Host

The Native Host is the local OS component that provides:
- filesystem;
- shell;
- processes;
- Git;
- Docker;
- local applications;
- local projects.

The extension communicates with it using browser Native Messaging.

Extension + Native Host must be presented to the user as **one CROT product** and installed through a simple setup flow.

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

Specific service integrations must not be hard-coded into CROT Core unless necessary.

## 10. Installation UX

Target user flow:

```text
Install CROT Extension
        |
        v
Install CROT Host
        |
        v
Select project
        |
        v
Choose permissions
        |
        v
Connect AI Agent
        |
        v
Ready
```

The user should not need to understand MCP, Native Messaging, ports, tunnels, OAuth, or internal architecture.

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

FULL CONTROL is powerful and inherently sensitive; the goal is to make that trust boundary explicit and user-controlled, not to pretend it is risk-free.

## 13. Commercial Product

CROT is architected as a commercial product from the beginning.

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

## 15. Development Principles

Build the smallest working implementation of the final architecture.

Do not:
- build Notion-specific core logic;
- create disposable MCP code;
- duplicate permission systems;
- hard-code browser integrations into the core;
- hard-code commercial services into local execution;
- sacrifice final architecture for the first demo.

## 16. Development Order

Approximate order:

```text
1. Repository and project foundation
2. CROT Core interfaces
3. Permission engine
4. Local filesystem capabilities
5. Shell/process capabilities
6. MCP interface
7. Local MCP connectivity
8. Notion integration as first client
9. Real telegram-stream workflow
10. Native Host
11. Browser Extension
12. Unified browser + PC workflows
13. Installer
14. Authentication/authorization hardening
15. Commercial account/licensing layer
```

The order may change when technically justified, but architectural boundaries must remain intact.

## 17. Non-Negotiable Principle

**CROT is not a Notion MCP.**

CROT is a universal local AI-agent bridge:

> **An installable local bridge that gives AI agents controlled or full access to the user's computer and browser through a standard MCP interface.**

The product must support both:
- safe/controlled automation;
- full-control autonomous development;

with the user explicitly choosing the permission level.
