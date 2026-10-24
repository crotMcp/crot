# CROT architecture — current implementation

This document describes code, not publication readiness. [STATUS.md](STATUS.md) owns the current four-axis status; [roadmap](CROT_IMPLEMENTATION_ROADMAP.md) owns remaining work. Baseline: `80d463b`; normalization is authorized by the curator (N0–N7). The previous architecture narrative is preserved in [history](docs/history/ARCHITECTURE.md), not a competing current specification.

## 1. Product and boundaries

CROT gives compatible local and remote MCP clients controlled access to one user's computer and browser. External MCP gateway, media/editors, jobs/artifacts and connector platform are post-v1 proposals, not implementations. No client-specific bypass is permitted.

## 2. Runtime architecture

```text
stdio MCP → shim ──────────────────────┐
loopback HTTP + local bearer ──────────┼→ CrotService → MCP adapter → CrotCore
OAuth client → CloudRelay/AccountService│                         → ExecutionGuard
             → outbound device tunnel ┘                         → permissions/approval/audit
                                                                 → capabilities → NativeHost / browser bridge
```

`src/service/service.ts` composes one per-user runtime. `src/bin/crot-mcp.ts` is the entrypoint; `src/core/crot-core.ts` composes capability services. Relay routes bounded streams, not local tool execution. AccountService owns cloud commercial metadata, not local Core permissions.

## 3. Execution and module responsibilities

- `src/core/execution/guard.ts`: authorize, approval revalidation, execution and audit.
- `src/core/permissions/`: capability/path/host policies and remote profile narrowing.
- `src/core/capabilities/filesystem/`: guarded file operations and protected paths.
- `src/core/capabilities/process/`: process/shell lifecycle; NativeHost decides confinement readiness.
- `src/core/capabilities/git/`: fixed read/write Git operations with safe configuration/discovery.
- `src/core/capabilities/docker/`: bounded ps/logs/compose operations, not arbitrary Docker API.
- `src/core/capabilities/network/`: guarded HTTP host/IP policy, not all subprocess/container egress.
- `src/native-host/`: platform confinement, leases, OS boundary and mediated Docker.
- `src/adapters/`: protocol/transport translation; no independent permission policy.

## 4. Browser contract (AD-16, AD-32, AD-33)

`src/core/capabilities/browser/` → bridge IPC → `crot-browser-relay` native messaging → `extension/src/` MV3 → fixed CDP commands/bundled page functions. Explicit remote tab selection, per-tab FIFO, connection/document-bound subjects and response-bound download ownership remain mandatory. No raw CDP or remotely supplied JavaScript. Download capture temporarily uses response-stage Fetch interception for the approved document/download; it is not general traffic interception.

## 5. Trust, identity and commercial admission

Remote requests derive principal facts from verified RS256/JWKS tokens, exact issuer/audience and bound device resource; the device independently verifies requests. WorkOS supplies identity; relay uses outbound WSS device tunnels. AD-36 accepts absent authorization-response `iss` for the single pinned issuer, not weaker JWT verification.

`src/account-service/` implements trial/plans, device limits, portal, provider-backed billing and revocation. Free local stdio/loopback do not require cloud entitlement. Remote registration does: activate trial/plan in `/portal` before pairing. Commercial state and registry are single-writer JSON, not multi-instance shared storage.

## 6. Service, secrets and tray

`src/service/` owns lifecycle, secret-store abstraction, local control, exposure and device state. `src/tray/` is a separate owner UI on authenticated control IPC, not a second executor. Workspace screens use a separate ordinary local MCP client through the existing shim and ExecutionGuard; workspace execution stays on the ordinary MCP path. Fixed owner product administration and guarded outbound integration lifecycle are described in AD-40; there is no arbitrary owner tool RPC. See [AD-39/AD-40](docs/CONTROL_CENTER_ARCHITECTURE.md). Its actual actions include Approve/Reject, presets, remote controls, Pair/Unpair and revocation. There is no Add client or general uninstall/purge UI.

The label “Ask for every action” refers to approval-gated effects in exposed sessions, not every read. Capability authorization still runs; local/remote policies differ as specified by AD-12/15/23. Presets do not create a new permission system.

## 7. Platform scope

Architecture targets Linux/macOS/Windows. Qualified CI environments are Ubuntu 22.04/24.04 x64/arm64 L1, macOS arm64 runner and Windows Server 2025 x64 runner, Node 20/22. Broader OS/version support is not inferred. Real Chromium E2E runs on Linux. Generated autostart configurations have automated tests; actual user-service/task installation remains a distinct OS qualification requirement.

## 8. Installation, update and release

`scripts/build-release.mjs` produces compiled, identity-pinned source/runtime artifacts, native source inventory, notices/SBOM/checksums. Node/runtime dependencies and qualified native prerequisites must be provisioned separately. These are not autonomous MSI/DMG/DEB installers.

`scripts/build-rc.mjs` produces a canonical Ed25519 `update-manifest.json`/`.sig` plus `payload/`, consumed by `src/installer/update.ts` and `crot-mcp update`. A trusted public key comes from outside the package. Copied staged files are rehashed before activation. Version replacement retains previous bytes until health success; failed activation restores registration/current. An exclusive update lock prevents concurrent writers; a crash may require offline recovery. See [INSTALL](docs/INSTALL.md) for limitations.

Vendor signing/notarization, GUI installers, store publication, beta and GA remain incomplete/external delivery stages. Repository-test manifests explicitly are not release qualification. Provenance records the source commit/tree and dirty status; CI proof is distinct from source presence.

## 9. Operations and external facts

Metrics are bearer-protected and fixed-cardinality. Private network exposure is operator configuration. Offline restore validates schemas/ownership and stages both files; a runtime second-rename failure rolls back prior bytes. This is not a power-loss-proof two-file database transaction. Relay must be stopped; recovery failure is explicit.

Owner reports staging live at `https://relay-staging.crot.network`, Oracle Linux 9 ARM64 / `158.180.32.253`, Let's Encrypt through Caddy, issuer `https://prestigious-continent-62-staging.authkit.app`, pairing client `client_01M5FJB95CE7KH33Y1SPE5X77Q`. This is owner-supplied deployment evidence, not an automated live qualification in this change. Production and live Stripe remain external gates.

## 10. Evidence and historical decisions

Tests prove scoped scenarios, not universal absence of vulnerabilities. [Security review](docs/security/SECURITY_REVIEW.md) tracks findings; [branch decisions](docs/BRANCH_RECONCILIATION.md) preserves unique-history analysis. Historical acceptance/design/evidence remain immutable records of their baseline. AD-24…29 are research/evolution records superseded for production Windows selection by AD-30; AD-31 governs macOS. Earlier “future/not implemented” statements inside the chronological decisions refer to adoption time, not current status.

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
- Amended by AD-20 for Linux: the L1 boundary of point 4 is made concrete
  (CROT-owned bubblewrap and AppArmor policy, read and write boundary, private
  home layer instead of a tool-cache allowlist, network modes, sandbox
  lifetime, status and reason codes); the Docker-socket rule of point 4 is
  replaced by a mediated Docker endpoint, which resolves the contradiction
  with point 7 (Docker build and pull through the confined shell).

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
     form and the PRM location are fixed by AD-21 points 5 and 6). It is at
     the same time the URL clients connect
     to, the `resource` of the Protected Resource Metadata (RFC 9728) the
     relay serves for it, and the required token audience.
   - Clients request tokens with the resource indicator (RFC 8707) set to that
     URI. A token for another device or another resource is rejected, even if
     it belongs to the same account.
   - Relay and device are one logical resource server for that URI. That the
     relay verifies the token and the device verifies it again is not token
     passthrough; the relay never mints, exchanges or replaces tokens for the
     device.
   - **Identity-provider criteria** (selection: AD-21 point 1, with the
     open RFC 9207 condition recorded there): OAuth 2.1 with PKCE
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
  provider); the exact device URI form (WP-29). Both are decided by AD-21.
- Residual risks, accepted: exposure is shared by all agents behind one
  `clientId`; a user who resets exposure or revokes and re-grants access
  starts that client clean, while the model may still hold earlier untrusted
  content (as in AD-12); the relay sees traffic in transit (AD-13 point 6).
- Amended by AD-21 (roadmap OD-2, OD-3): the identity provider (WorkOS
  AuthKit), the claim model (`sub` → principal id and `accountId`, the
  device id in the provider-signed `aud`, `client_id` → `clientId`), the
  device-side revocation model, the canonical device URI and the PRM
  location. AD-21 clarifies the "custom device claim" of point 5 as the
  device id carried in `aud` and adds the paired-account check to the relay
  admission of point 10; the other points are unchanged.

### AD-16. Browser contract v1: a fixed command set over `chrome.debugger` (CDP) with tab- and document-bound element references, explicit tabs, per-tab serialization and the two approval presets (WP-18)

**Implementation qualification (WP-27).** Core validates remote tab targets
before authorization or any bridge call. Core and extension queue every tab
operation by connection/tab, one running plus sixteen waiting, including reads,
file operations and settle. Approval waits are outside the queue; approved
subjects are checked again at its head. Queued cancellation frees capacity.
The extension drops waiting work on disconnect/tab close. Physical input
visibility and dispatch share only a short delivery critical section, not the
settle/wait phase; other tabs continue concurrently. Core attributes direct opens
and verified `newTabs`/`openerTabId` children to AD-15 exposure scopes, never to
self-reported client names. `openedBy` grants no authority. See
`tests/core/browser-multi-agent.test.ts`, `extension/test/control.test.ts`,
`tests-e2e/browser/wp27.e2e.test.ts` and the WP-24 final engineering gate.

**Context.** AD-14 point 2 makes the browser contract v1 (§7.1) release-blocking
and leaves the technology, the command list and the element-reference model to
this decision; AD-14 point 4 leaves the exact rule set and configuration key of
the two approval presets to it; §26 question 11 lists the open points. The
historical pre-WP-24 implementation (`main` at `93c774f`) worked as follows:

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
     any text that did not ship in the extension, the `Debugger`, `Fetch` (except the four fixed AD-33 response-stage methods),
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
      download directory, selected by AD-33 / OD-8 in WP-26). It
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
   concurrent on-demand starts (refreshed while held); taking over a socket
   file left by a crashed service happens under a takeover lock, and an
   abandoned lock is broken by exactly one process (moved aside and checked). On shutdown the shim endpoint is released
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
   The process environment is not configuration: the service has one (the
   supervisor's, or the starting shim's); everything the configuration depends
   on (file, `CROT_CONFIG`, flags, paths) is resolved into the digest, a
   different state directory is a different service, and the service then
   leaves the inherited working directory. A shim whose PATH, shell or home
   directory differs is told so on stderr (only value digests are exchanged).
6. **Endpoints and authentication.** Two local endpoints in the user's
   private state directory: the shim endpoint and the control endpoint (Unix
   sockets `0600` in the `0700` state directory; Windows named pipes whose
   names derive from the credentials). Each has its own 256-bit credential in
   the secret store behind the `CredentialStore` interface (OS secret storage
   or the owner-only fallback, WP-21, AD-18). Every connection performs a mutual
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
   WP-20 its requests are `ping`, `status` and `shutdown`. It is not an
   authorization mechanism: its credential proves only the same OS user,
   it creates no principal, grant or scope, and policy and approval
   decisions stay in the PermissionEngine and the broker (AD-5). Approval and
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
  (WP-34); tray, approval provider and exposure reset on the control channel
  (WP-22); the tunnel adapter in the service (WP-30).
- Residual risks, accepted: all stdio clients of a user share one
  configuration; an on-demand service inherits the environment of the shim
  that started it; sleep detection is a heuristic and approval deadlines are
  not extended across sleep; on Windows the pipes keep Node's default security
  descriptor (other users cannot open them for writing) and rely on the
  authentication for everything else. Secret storage and the child-process
  environment allowlist were added by WP-21 (AD-18).

> **Текущее применение исторического риска.** Неограниченные процессы пользователя
> по-прежнему вне границы; для confined Linux/квалифицированных Windows детей
> действуют AD-20/AD-30/AD-31 для допущенных Linux/Windows/macOS детей.
> Local full_control, недоступный до допуска L1 и чужие host-процессы остаются вне границы.
> Текст принятого решения ниже не переписан.

### AD-18. CROT secrets live in an OS secret store behind one interface; children of process tools get an allowlisted environment; WP-21 closes leaks through CROT itself, not OS-level access by children (WP-21)

**Context.** After WP-20 the service, control, HTTP and browser-bridge
credentials were owner-only files in the state directory (AD-17 point 6), and
`shell.execute` / `process.manage` passed the whole CROT process environment
(the supervisor's or the starting shim's, AD-17 point 5) to their children.
AD-13 point 8 puts "a protected location for CROT secrets" and "the
child-process environment allowlist" into phase 1. AD-13 point 4 assigns the
protection of CROT's state against commands to L1 confinement (WP-23a/b/c):
an unconfined child runs as the same OS user and can, in principle, reach
everything that user can reach, including the OS secret store. WP-21 therefore
needs an explicit boundary.

**Decision.**

1. **Boundary (variant A).** WP-21 closes every path by which a secret leaves
   through CROT itself: structured CROT tools (filesystem, Git, Docker, HTTP,
   browser), the child-process environment, Core data and `crot_status`, the
   audit log, the service log and diagnostics, the browser and outbound
   requests. It does not protect the OS secret store against a child process
   that uses the OS mechanisms itself as the same user: in `sandbox` mode that
   is a residual risk until L1 (WP-23a/b/c, AD-13 point 4); `full_control`
   stays unconfined by definition (§6, AD-13 point 4). The permission system,
   AD-1…AD-17 and the WP-20 boundaries are not changed.
2. **One secret store, chosen per state directory.** The four secrets
   (`service-token`, `control-token`, `browser-token`, `http-token`) are read
   and written through one `SecretStore` over a backend: macOS Keychain
   (`/usr/bin/security`, service `crot-mcp:<state key>`), Windows DPAPI
   (CryptProtectData, current user, through the bundled FFI already used by the
   Native Host; files `secrets/<name>.dpapi`), Linux Secret Service
   (`secret-tool`, attributes application / state key / secret name; only
   with a session bus), or the documented fallback: owner-only files (`0600`
   in the `0700` state directory, owner-only ACL on Windows). Values are never
   passed in arguments or environment variables of the helper tools (stdin, or
   hex through `security -i`); helper diagnostics are reduced to one line
   without values. `secrets.store` is `auto` (OS store if a round-trip probe
   succeeds, else the file fallback with the reason recorded), `os` (fail
   instead of falling back) or `file`. The choice is recorded in an owner-only
   marker `secrets.json` in the state directory; every reader (shim, control
   client, relay, CLI) follows the marker, and only the service changes it.
   `auto` keeps its first working choice; it does not silently switch later.
3. **Migration: verify, then delete; never an insecure fallback.** When the
   backend changes (including the WP-20 plaintext files), the service copies
   every secret, reads each back and compares it, writes the marker and only
   then deletes the old copies. A failed copy or verification rolls back
   ("Nothing was changed"); an old file that cannot be removed, or that holds
   a different value than the store, is a configuration error, never a
   silent fallback. Invalid values are rejected, never repaired silently.
4. **HTTP token.** By default (`http.auth.storage: "secret-store"`) the HTTP
   token is the `http-token` secret; an existing `http.auth.tokenFile` is
   migrated (imported, verified, then deleted) and the option is then
   ignored. `"token-file"` is the explicit legacy compatibility mode: the token
   stays in the owner-only file (for clients that read it), the service warns
   at start, and the file is a secret path (point 6).
5. **User commands.** `crot-mcp secrets status` (backend, location, fallback
   reason; no values), `crot-mcp secrets show http-token` (the only secret a
   user needs to configure a client), `crot-mcp secrets rotate [<name>|--all]`
   (refused while the service runs; new values are written and verified like a
   migration). Rotating the HTTP token requires updating the HTTP clients; the
   other secrets are used only between CROT's own processes.
6. **Secret paths are denied to all CROT tools.** The secret files of the state
   directory (file fallback or not yet migrated), the DPAPI directory and the
   configured token file are "secret paths": the PermissionEngine refuses
   every capability for a path equal to or inside a secret path, in every
   mode including `full_control`. They, the marker and the secrets lock are
   also protected paths (no writes through CROT tools). `docker.use` refuses any mount, read-only or
   not, of a path that contains or is inside a secret path. Secret values are
   never part of `crot_status`, the audit log, the service log or errors.
7. **Child-process environment allowlist.** Children of `shell.execute` and
   `process.manage` start from an allowlisted copy of the CROT environment:
   paths, home and identity, shell, locale, terminal, temporary directories,
   proxies, toolchain homes, the Docker CLI connection, the Windows system
   variables and the PowerShell module analysis cache location
   (`PSModuleAnalysisCachePath`; case-insensitive on Windows), plus names or prefixes (`NAME*`)
   listed in `environment.allow`. Session bus addresses
   (`DBUS_SESSION_BUS_ADDRESS`) and `PSModulePath` are not on the list. The
   `env` argument sets literal values or removes variables (`null`); it can
   never copy a withheld variable into the child. `crot_status` reports the
   policy, the passed names and the number of withheld variables (no values).
   Git starts from the same allowlisted base and keeps its own rules on top
   (AD-2); Docker keeps its narrower list (AD-3).

**Scope and limits.**

- Implemented by WP-21. It fixes WP-21's boundary within AD-13 points 4 and 8
  and AD-17 point 6; it does not change the architecture. No new npm
  dependency. The `CredentialStore` interface of AD-17 is kept; the shim,
  control client and relay read through it.
- Not part of WP-21: L1 confinement (WP-23), tray (WP-22), device keys
  (WP-28), relay, tunnel and installer.
- Residual risks, accepted:
  - Until L1, an unconfined child in `sandbox` mode runs as the user and can
    use the OS store itself (`security`, Secret Service over a bus address it
    finds or guesses from `XDG_RUNTIME_DIR`, DPAPI) or read the file
    fallback; `full_control` is unconfined by definition.
  - The file fallback stores secrets in plaintext, owner-only; it is chosen
    only when no OS store works (or explicitly) and is reported by
    `secrets status` and `crot_status`.
  - Administrators and root are not protected against.
  - `auto` keeps its first choice: an OS store that becomes available later
    is used only after the user sets `secrets.store: "os"` (which migrates).
  - The allowlist is a default, not a sandbox: values on it (for example
    proxy URLs with credentials) are passed, and `environment.allow` is the
    owner's choice.

> **Текущее применение исторического риска.** Неограниченные процессы пользователя
> по-прежнему вне границы; для confined Linux/квалифицированных Windows детей
> действуют AD-20/AD-30/AD-31 для допущенных Linux/Windows/macOS детей.
> Local full_control, недоступный до допуска L1 и чужие host-процессы остаются вне границы.
> Текст принятого решения ниже не переписан.

### AD-19. Tray v1: a separate UI process on the control channel; the service holds the approval provider and the device-side controls (preset, remote mode, remote full-control opt-in, exposure reset, client revocation) (WP-22, roadmap OD-7)

**Context.** Without an approval provider every gated operation is denied
(AD-5, §21), so a remote workflow that reads a page and then acts cannot work
(AD-13 point 3). WP-22 adds the first product provider and the tray. AD-17
point 7 reserves the control channel for it ("approval and exposure-reset
requests are added by WP-22 on this channel and remain the only path for
them"). Several decisions were still open or assigned elsewhere:

- AD-16 point 17 lets the user choose the preset in the tray but leaves "how
  the supervised service applies it" to WP-31 (roadmap OD-7). Presets are part
  of the immutable policy (AD-5 point 2, AD-10 point 1), and the configuration
  file is part of the configuration digest that all shims share (AD-17
  point 5).
- AD-13 point 5 requires a per-device remote full-control opt-in "implemented
  with the existing `principalKinds` matcher". `principalKinds` exists only in
  approval rules; the PermissionPolicy has one mode for every principal. A
  per-principal mode is therefore not available without a new mechanism.
- AD-15 point 8 and C5 allow a reset of remote exposure only through a user
  action in an approval provider or through revocation. §20 requires that
  revocation ends remote sessions, and AD-15 point 4 makes the device check
  that a grant is not revoked. No identity provider, device binding or tunnel
  exists yet (WP-28…WP-30).
- Until L1 (WP-23), an unconfined child or any other process of the same OS
  user can read the control credential (AD-18, residual risks) and could talk
  to the control channel like the tray.

**Decision.**

1. **Process model and trust boundary.** The tray is a separate Electron
   application. It is only an authenticated client of the control channel
   (AD-17 point 6): its main process reads the control credential through the
   same `CredentialStore` as `crot-mcp service status` and holds the
   connection. It holds no other secret, stores no credential or CROT state of
   its own, and has no access to Core, the PermissionEngine, the broker, the
   audit log or the state files. The CROT service stays a separate process and
   keeps all control logic (§24: "the tray app is a UI; control logic stays in
   Core/service"). The renderer runs with context isolation, the Chromium
   sandbox and without Node integration, loads only files bundled with the
   tray, blocks navigation and new windows, uses a strict content security
   policy and reaches the main process only through a fixed preload API. The
   control credential never reaches the renderer. Electron is used only for
   the tray; packaging, signing and autostart of the tray are WP-34.
2. **Control protocol, extended additively (AD-17 point 7).** The control
   channel keeps its framing, authentication and request/response messages and
   gains methods and service-to-client `event` messages:
   - approvals: `approvals.subscribe` (the connection becomes an approval UI
     and receives a snapshot of pending requests), `approvals.unsubscribe`,
     `approvals.decide { requestId, decision: approve | reject, subjectDigest }`;
     events `approval.requested` and `approval.resolved`;
   - overview: `overview` (service, preset, remote mode, remote full-control
     opt-in, remote clients, active agent contexts, browser connection, L1,
     CDP and pairing availability); event `state.changed`;
   - device controls: `preset.set`, `remote.setMode`, `remote.setFullControl`,
     `remote.resetExposure`, `remote.revokeClient`; `pairing.start`.
   Parameters are validated strictly; a malformed request or an unknown method
   is a protocol violation and closes the connection, as in WP-20. The control
   channel still carries no MCP and no tools, makes no permission decision and
   creates no principal, grant or scope; it remains the only path for these
   requests. No MCP tool, adapter, browser message, relay message or
   configuration value can reach them.
3. **Approval provider in the service, registered dynamically.** The service
   implements one `ApprovalProvider` (`id: "tray"`, channel `local-ui`) that
   fans requests out to every subscribed control connection. It is registered
   with the broker while at least one tray is subscribed and unregistered when
   the last one unsubscribes or disconnects, so the AD-5 lifecycle is
   unchanged: no tray means `unavailable` / `no_provider` at once; losing the
   last tray cancels pending requests (`provider_gone`); timeout and dismissal
   deny. This refines AD-5 point 6: the registration handle is given only to
   the composition root, through a `CrotCore.create` option, and never to an
   adapter, the browser side, a tool or the relay; Core has no public
   registration method. A decision is accepted only from a subscribed
   connection, only for a request that is pending and was presented to it,
   and only with the presented subject digest (`not_pending`,
   `digest_mismatch`, `unknown_request` otherwise). The service never decides
   on its own, never decides on behalf of a request it did not present, and
   offers no "always allow" or batch decision (AD-5 point 3). The first
   terminal transition wins across several trays (AD-5 point 4).
4. **What the user sees.** The tray renders the Core subject as plain text by
   the rules of `docs/design/approval-gates.md` §6.3 (Core order and labels,
   visible control/bidi/zero-width characters, no silent truncation,
   prominent remote principal, outside-workspace paths and `full_control`,
   `client` marked as self-reported). Effects whose value comes from a web
   page (tab URL and title, page text, element names) carry the additive
   `ApprovalEffect.flag` value `page_supplied` and are shown as page-supplied
   (AD-16 point 16). The digest and the audit are unchanged (AD-5 point 7).
5. **Preset changes (decides OD-7).** The preset chosen in the tray is
   device state, not configuration:
   - It is stored in the service's protected private state
     (`service-settings.json`, owner-only, a protected path no CROT tool can
     modify), not in the configuration file. The configuration digest and the
     shim rule of AD-17 point 5 are unchanged; the effective value is the
     stored choice when present, otherwise
     `permissions.approvals.untrustedContent` from the configuration.
     `crot_status` and the tray report the value and its source.
   - It is applied by building a new Core with the new policy and switching
     to it. Each Core's policy stays immutable (AD-5 point 2, AD-10 point 1);
     a preset change behaves like a restart of Core inside the service. The
     switch happens only while Core is idle: no operation in flight, no
     pending approval request and no running background process (AD-17: they
     belong to Core and run until the service stops; records of exited
     background processes are not carried over). Otherwise the change is refused
     with the reason, and nothing changes. The idle check and the switch are
     one atomic step; the old Core is then shut down as in AD-17 point 8. The
     new Core takes over the exposure state of every local and remote scope
     (AD-12, AD-15 point 8) and the browser bridge, so a change never cleans a
     scope. If the new Core cannot be built, the old one stays and the stored
     value is restored.
   - In WP-22 the values the PermissionEngine implements can be chosen:
     `require-approval` (*Ask for every action*) and `off`. The rule set of
     *Autonomous browser* (`autonomous-browser`, AD-16 point 17) is
     implemented by WP-31 and is shown as not yet available.
   - If the stored state cannot be read, the effective value is
     `require-approval` and the error is shown (fail closed).
   - This amends AD-16 point 17 ("decided in WP-31") and AD-10 point 1
     ("validated at startup": validated when a Core is built).
6. **Remote mode.** A per-device switch in the same protected state, **off by
   default** (§22), changed only through the control channel, audited and shown
   in the tray and in `crot_status`; if the state cannot be read it is off.
   While it is off, the relay entry point (the pipeline the tunnel reuses,
   AD-15 C4) refuses every request before MCP or Core work (AD-15 point 9);
   the tunnel (WP-30) opens only while it is on and closes when it is turned
   off. No other authorization is derived from it.
7. **Remote full-control opt-in.** A per-device flag in the same protected
   state, **off by default**, changed or revoked only through the control
   channel, audited and shown in the tray and in `crot_status`. In WP-22 it
   was recorded only. Since WP-31 it takes effect through the remote profile
   of §27 AD-23: it is stored with the device id and account of the pairing
   it was given for, applies only to remote principals of that pairing, never
   to other devices or local principals, and is restored after a restart only
   for that pairing; unpairing ends it. The `principalKinds` matcher of
   approval rules does not suffice for this (AD-13 point 5); AD-23 decides the
   mechanism.
8. **Remote clients, exposure reset and revocation (device side).**
   - The service keeps a list of remote clients seen at the relay entry point,
     keyed by (`accountId`, `deviceId`, `clientId`) — the remote exposure
     scope of AD-15 point 8 — with only these identifiers, first and last seen
     and the revocation time (`remote-clients.json`, protected private state).
     No names, tokens, addresses or other personal data.
   - **Exposure reset:** only through the control channel, for one client;
     the client's persisted exposure becomes `clean`; audited. Refused while
     the exposure state itself failed closed (AD-15 point 8).
   - **Revocation:** only through the control channel. It is persisted, resets
     the client's exposure, aborts its requests in flight (their approval
     requests end `cancelled` / `caller_aborted`), closes its legacy sessions
     and makes the relay entry point refuse every later request of that client
     before MCP or Core work; audited. If the revocation state cannot be read,
     every remote request is refused (fail closed). A remote client can never
     change its own state.
   - Not in WP-22: re-granting a revoked client and revoking tokens or devices
     at the identity provider (WP-28); no identity provider or revocation
     service is built here.
9. **Audit of control actions.** Every preset change, remote-mode change,
   full-control opt-in change, exposure reset and revocation writes a
   `control.*` event to the audit log (actor: the local user through the
   control channel; old and new value or client; outcome). Approval decisions
   stay in the audit event of the gated operation (AD-5 point 7). A change that
   widens what can run without the user (a less restrictive preset, remote
   mode on, full-control opt-in on, an exposure reset) is refused when its
   audit record cannot be written first (as AD-7); a change that narrows it
   (revocation, remote mode off, opt-in off, a stricter preset) is never
   blocked by an audit failure, which is reported.
10. **Status and placeholders.** The tray shows the service state, the active
    agent contexts (stdio connections, HTTP sessions and in-flight sessionless
    requests, remote clients), the connected browser (name, version, extension
    version, connection id; the bridge does not know a profile name), L1
    confinement (not available until WP-23), the CDP browser backend (not
    available until WP-24) and device pairing (requires WP-28; the pairing
    screen and `pairing.start` exist and answer "not available").
    *Since WP-28:* pairing, unpairing and re-grant are available on the
    control channel and in the tray (§27 AD-21 implementation note).

**Scope and limits.**

- Implemented by WP-22. It decides roadmap OD-7, refines AD-5 point 6 and
  amends AD-10 point 1 and AD-16 point 17 as stated in point 5. It keeps
  AD-17 (one service, thin shim, one configuration and its digest, the
  control channel is not an authorization mechanism), AD-18 (secrets; the tray
  is another reader of the control credential through the `CredentialStore`)
  and §20–§22 (remote mode off by default and visible; authorization stays
  local; revocation ends remote sessions on the device). The PermissionEngine,
  the PermissionPolicy, the ExecutionGuard, the broker lifecycle and the
  subject digest are unchanged; Core changes are additive (the
  composition-root handle, an injectable exposure tracker, the
  `page_supplied` flag, control audit events).
- Left to later work packages: L1 confinement and the protection of the
  control credential against same-user processes (WP-23); identity, device
  binding, pairing, re-grant and revocation at the identity provider (WP-28);
  the tunnel honouring remote mode and the client list (WP-30); the
  *Autonomous browser* rule set, the remote permission profile and the
  enforcement of the full-control opt-in (WP-31); tray packaging, signing and
  autostart (WP-34).
- **Residual risk D, accepted.** Until L1 (WP-23), an unconfined process of
  the same OS user (including a child of `shell.execute` in `sandbox` mode)
  can read the control credential and act through the control channel like
  the tray: approve a pending request it can observe, change the preset or
  remote mode, reset exposure. The control channel proves only the same OS
  user (AD-17 point 7), and no substitute authorization mechanism is added.
  What is guaranteed: an MCP tool, a web page, the browser extension and the
  relay cannot reach the control channel or the provider; an approval exists
  only for a pending request with its exact subject digest; negative tests
  prove both. This includes writing the service's protected state files
  (`service-settings.json`, `remote-clients.json`, the device binding)
  directly; such a change takes effect when the service next reads that
  state. The remote full-control opt-in is stored with the device id and
  account of its pairing and applies only to that pairing, which limits a
  forged opt-in to what the user could enable but does not prevent it.
- Other residual risks, accepted: a preset change waits for an idle Core
  (background processes must be stopped first); approval deadlines are still
  not extended across system sleep (AD-17); the remote client list keeps
  account and client identifiers in clear text in the private state directory
  so that the user can recognise them.

### AD-20. Linux command confinement L1: a CROT-owned bubblewrap runtime with a CROT AppArmor policy, a private home layer, the host network and a mediated Docker endpoint; L1 confines without reducing the development baseline (WP-23a; decides the Linux part of roadmap OD-9)

**Context.** AD-13 point 4 requires L1 for the children of `shell.execute`
and `process.manage` in workspace (sandbox) mode and names "Linux bubblewrap
(with the AppArmor profile the installer ships)". It leaves open who owns and
loads that profile although the service never runs as root (AD-17 point 1),
which Linux releases are supported (roadmap OD-9), what "a short allowlist of
tool caches" contains, how abstract Unix sockets and the session bus are kept
from a child that shares the host network, how long the sandbox of a
detached process lives, and what `crot_status` reports. It also contains a
contradiction: point 4 denies confined children the Docker socket, point 7
says Docker build and pull are "usable through confined shell", and AD-3
keeps `shell.execute` as the broader path to Docker. Access to a Docker
daemon carries the daemon's privileges on the host (any host path can be
mounted into a container), so neither hiding the socket (Docker unusable from
the shell) nor passing it (L1 void) is acceptable. Until L1, AD-18 and AD-19
(residual risk D) leave the OS secret store and the control credential
exposed to the children of process tools. CROT is a development environment
for agents: L1 must protect CROT and the host boundary without removing a
development capability CROT already offers.

**Decision.**

1. **Purpose and development baseline.** L1 protects CROT's secrets, state,
   configuration, audit log, control channel and approvals against direct
   access from a confined process, and the host against privilege gained
   through the sandbox itself. It is not L2: it does not hide the user's
   files, and it does not reduce the development environment. With network
   `on` it does not protect against host-local services that a confined
   process reaches over the shared host network (point 14).
   Under L1 a confined command keeps:
   - the read view of the host filesystem that AD-13 allows, including the
     user's home, except the CROT-protected paths of point 6;
   - a normal shell, interpreters and all their descendants;
   - package managers, builds and tests (npm, pip, cargo, Go and comparable
     tools), including tool and toolchain installs into the home, which land
     in the private home layer (point 7);
   - with network `on`, the host network: internet, LAN, localhost services
     of the host, ports published by Docker Compose, and the Unix sockets of
     host development services visible in the read view (point 8);
   - Git through the shell, including the user's SSH and GnuPG agents
     (point 6);
   - Docker, Docker Compose, Buildx and other Docker API clients from the
     shell, on every transport the service's Docker CLI supports, including
     TCP and TCP with TLS (point 9);
   - background development processes (point 10).
   `docker.use` (AD-3) is not a child of `shell.execute` or `process.manage`;
   it keeps running in the service, unchanged, on every transport. Graphical
   desktop sessions are not part of the baseline: AD-13 point 4 already
   excludes "the GUI automation … of the tray app", so X11, Wayland and the
   accessibility bus are not reachable. Browser and headless-browser
   workflows (browser test runners, automation libraries, headless
   Chromium and Firefox) remain supported. Because a confined process cannot
   create a user namespace (point 5), a runtime that would otherwise create
   nested user namespaces for its own sandbox must use its supported
   non-nested mode inside L1 (for example Chromium's `--no-sandbox`, where
   that is the runtime's supported mode); this is a compatibility
   requirement of running inside L1, not a reduction of CROT's
   capabilities, and WP-23a covers it with a smoke test. Where a machine cannot provide this baseline under L1, L1
   is unavailable there with a reason (point 12); L1 is never provided as a
   reduced shell.
2. **Linux v1 platforms (decides the Linux part of roadmap OD-9).** Supported:
   Ubuntu 22.04 LTS and Ubuntu 24.04 LTS, x86_64 and arm64, with each
   release's GA and HWE kernels. Other distributions are not part of the v1
   support promise; the checks of point 12 still run there and decide
   availability, without a support claim. The macOS, Windows and browser
   parts of OD-9 stay open for WP-23b, WP-23c and WP-34.
3. **L1 components, ownership and version matching.**
   - Components: `crot-bwrap` (bubblewrap built by CROT from a pinned upstream
     release whose source digest is recorded), `crot-l1-init` (the CROT helper
     that is the first process of every sandbox, point 10), the CROT AppArmor
     policy (profile `crot-l1-<v>` for `crot-bwrap`, the payload profile
     `crot-l1-payload-<v>` for everything that runs in the sandbox, and
     profile `crot-l1-container-<v>` for containers created through the
     Docker endpoint, point 9) and `manifest.json` (the L1 component version
     `<v>` and the SHA-256 digest of each binary).
   - **Transition (the only production form).** `crot-bwrap` runs under
     no-new-privileges, and AppArmor allows a confined task under
     no-new-privileges only an exec transition that keeps its current
     profile. The payload is therefore a separate top-level profile stacked
     onto `crot-l1-<v>`, in the shape of Ubuntu's own
     `bwrap-userns-restrict` policy: `crot-l1-<v>` grants its file access
     with `file rwlkm /{,**},` and execs with one glob rule,
     `allow pix /** -> &crot-l1-<v>//&crot-l1-payload-<v>,`, plus the
     installer-generated exact-path `ix` rules for host application
     profiles (next item, amendment of WP-23a); the payload
     profile grants `file rwlkmix /{**,},` and includes no abstraction. The
     label of every confined process is the stack
     `crot-l1-<v>//&crot-l1-payload-<v>`. A plain or `cx` transition to a
     child profile, and the other stacked forms of the probe, are not used
     (evidence below the decision).
   - **Host application profiles (amendment, WP-23a).** A stacking exec
     target (`&…`) also attaches every loaded host profile whose attachment
     matches the executed path, so with only the glob rule a program such as
     Google Chrome on Ubuntu 24.04 (host profile `chrome`,
     `flags=(unconfined)` with `userns,`) ran as
     `chrome//&crot-l1-<v>//&crot-l1-payload-<v>` and the payload's
     peer rules denied its own IPC. The installer (`scripts/l1-install.sh`,
     helper `scripts/l1-host-exec.py`; WP-34 package scripts likewise, on
     install, upgrade and when the host's profiles change) therefore adds
     to `crot-l1-<v>` one exact-path rule `allow ix "<path>",` for each
     literal attachment of a host profile that is loaded as `unconfined`,
     has `flags=(unconfined)` and grants `userns,` (a program the host
     already runs unconfined). An exact rule takes precedence over the glob
     rule in the policy compiler, so such a program keeps the label of
     its parent: inside the sandbox the full stack, with the payload's
     rules (no user namespace, peer rules) applied to it; there is no
     transition to any other profile. Enforcing host profiles, globbed
     attachments and paths under `/usr/lib/crot/` get no rule (they stay
     with the glob rule, fail closed). The only change outside the sandbox:
     such a program run directly by `crot-bwrap` keeps `crot-l1-<v>`
     instead of the host's unconfined profile — not more privilege than
     the host already grants it.
   - **Policy ABI per release.** Ubuntu 22.04 (parser 3.0.4) cannot compile
     `abi <abi/4.0>` with `userns,` rules, so the 22.04 policy is written
     for `abi <abi/3.0>` and contains no user-namespace rule; the 24.04
     policy is written for `abi <abi/4.0>` with user-namespace rules.
     Everything else in the policy is the same on both releases.
   - `<v>` is the L1 component version. The service is built with the `<v>`
     it requires. The components are installed in `/usr/lib/crot/l1/<v>/`,
     owned by root and not writable by the user. The profiles attach to these
     exact paths only, never to `/usr/bin/bwrap` or any other system binary.
     A component, manifest or loaded profile of a different `<v>` is a
     mismatch (point 12), never used.
   - WP-23a defines, builds and tests the components and the policy and ships
     an install/remove helper that is run with root for source checkouts and
     CI (developers, CI runners). WP-34 packages the same artifacts for the
     supported releases and architectures, signs them, loads the policy in the
     package scripts on install and upgrade, unloads and removes it on
     removal, and excludes the L1 private storage (point 7) from age-based
     temporary-file cleanup. A new `<v>` is installed side by side; the
     previous `<v>` is removed only after the new one is installed, and a
     running service keeps the `<v>` it was built for until it restarts.
   - No minimum bubblewrap version is a platform requirement, because CROT
     never uses a system bubblewrap. WP-23a pins the upstream release it
     builds and records the bubblewrap options it relies on.
4. **Privilege boundary.** Root is needed only at package time (WP-34) or for
   the developer/CI helper of point 3. The CROT service stays a per-user
   process (AD-17 point 1): it never loads, replaces or removes AppArmor
   profiles and has no setuid component. `crot-bwrap` is not setuid; it uses
   unprivileged user namespaces, which the policy grants to it on systems that
   restrict them (Ubuntu 24.04: `kernel.apparmor_restrict_unprivileged_userns`
   is 1). The service only detects whether the components and the policy are
   present and match (point 12).
5. **AppArmor versus the L1 runtime boundary.** The boundary is the sandbox
   that `crot-bwrap` and `crot-l1-init` build: namespaces, the mount view,
   no-new-privileges and the process model (points 6–10). AppArmor has exactly
   two roles and contains no CROT path policy:
   - **User-namespace permission.** On Ubuntu 24.04 `crot-l1-<v>` grants
     `crot-bwrap` the user namespace that the release otherwise denies, so
     the distribution's restriction stays in force for every other program.
   - **No nested user namespaces.** A confined process cannot create a user
     namespace. On Ubuntu 24.04 the payload profile denies it (`deny
     userns`). On Ubuntu 22.04 AppArmor does not mediate user namespaces for
     this policy (ABI 3.0, point 3); there the control is bubblewrap's
     `--disable-userns`, with which `crot-bwrap` is started on both
     releases (on 24.04 in addition to the profile). Status and documentation never claim AppArmor mediation of
     nested user namespaces on 22.04.
   - **IPC the mount view cannot hide.** The payload profile denies connecting
     and sending to abstract Unix sockets and signalling or tracing processes
     whose peer is not confined by the same payload profile; sockets between
     confined processes work. `crot-l1-container-<v>` applies the same Unix
     socket rule to containers, on top of the rules of Docker's default
     container profile.
   The file rules of both profiles allow all file access: which files a
   confined process can read or write is decided only by the mount view.
   AppArmor never depends on CROT configuration, principal or request, and it
   is not a second authorization system.
6. **Read boundary.** The sandbox sees the host filesystem read-only (AD-13:
   confined commands may read the user's files outside the workspace). The
   following are replaced by empty, inaccessible entries ("CROT-protected
   paths" of L1):
   - CROT's configuration file and directory, the state directory (file
     fallback secrets, the secret marker and lock, shim and control endpoints,
     private state such as `service-settings.json` and `remote-clients.json`,
     the service log), the audit log, and every configured location of these
     (`CROT_CONFIG`, explicit configuration, state and audit paths, the
     legacy `http.auth.tokenFile`), computed from the resolved configuration
     rather than from defaults;
   - the storage of the Secret Service backends that can hold CROT secrets
     (`~/.local/share/keyrings`, `~/.local/share/kwalletd`);
   - `$XDG_RUNTIME_DIR` (`/run/user/<uid>`: session bus, keyring control,
     Wayland, PipeWire, the systemd user manager, rootless Docker and Podman
     sockets, X authority files), replaced by a private directory; only the
     socket named by `SSH_AUTH_SOCK` (already on the AD-18 allowlist) and the
     GnuPG agent sockets are bound in at their paths;
   - the host's `/tmp` and `/var/tmp` (X11 sockets, other processes'
     temporary files), replaced by the private temp (point 7);
   - the Docker, Podman and containerd daemon sockets (the default system
     locations and the socket named by `DOCKER_HOST` or the current Docker
     context) and the TLS client keys of Docker endpoints (`DOCKER_CERT_PATH`,
     the key material of `~/.docker` and of its contexts); Docker is reached
     through the endpoint of point 9;
   - device nodes: a minimal `/dev` plus GPU compute nodes, `/dev/fuse` and
     `/dev/net/tun`; no input, uinput, console, memory or raw storage devices;
   - `/proc` is the sandbox's own (a new PID namespace): host processes, their
     environment, file descriptors and memory are not visible.
   Session bus and Secret Service: on the supported releases the session bus
   is `unix:path=/run/user/<uid>/bus`, hidden by the runtime-directory rule; a
   session bus at an abstract address (other setups) is denied by the payload
   profile in both network modes (point 5, point 8); `DBUS_SESSION_BUS_ADDRESS`
   stays off the allowlist (AD-18 point 7). The system bus stays reachable;
   it holds no CROT secret, and setuid helpers gain nothing under
   no-new-privileges.
7. **Write boundary.**
   - **Workspace:** read-write, the real files.
   - **Private temp:** `/tmp`, `/var/tmp` and `/dev/shm` inside the sandbox
     belong to the sandbox (point 10) and are emptied when it starts.
   - **Private home layer (the CROT-private tool caches).** The home is
     presented as an overlay: the real home is the read-only lower layer and a
     CROT-private directory is the upper layer. Every tool that writes into
     the home (`~/.npm`, `~/.cache/pip`, `~/.cargo/registry`, `~/.cargo/git`,
     the Go module and build caches, `pip --user`, `cargo install`,
     `go install`, `rustup`, `nvm`, global Git configuration,
     `~/.ssh/known_hosts`, and so on) works unchanged, reads the user's
     existing caches, configuration and toolchains, and writes only into
     CROT-private storage. No write reaches the user's real home: executable
     locations such as `~/.cargo/bin`, `~/go/bin` and `~/.local/bin`, shell
     start-up files, autostart entries and the user's real package-manager
     caches are never modified, so a confined command cannot poison anything
     an unconfined process of the user later uses. File systems mounted below
     the home are layered the same way. The workspace and the CROT-protected
     paths are mounted above the layer. This replaces AD-13 point 4's "short
     allowlist of tool caches": no per-tool list and no environment rewriting
     are needed.
   - Everything else is read-only (AD-13 point 4).
   - **L1 private storage** (upper layer and private temp) lives outside the
     home, in `/var/tmp/crot-l1-<uid>/`, one subdirectory per state
     directory. The service creates and verifies it (owned by the user, mode
     `0700`, no symbolic link in the path, a local file system). It is not a
     CROT-protected path and holds no CROT secret. It persists across service
     restarts so caches stay warm; deleting it only discards confined writes
     to the home.
   - Effects, by design: confined writes into the home are visible to later
     confined commands, not to the user's unconfined tools. Changes the user
     makes in the home outside the workspace while a sandbox runs are normally
     visible inside, but overlay semantics guarantee it only after the sandbox
     restarts; the workspace is not layered and is always current.
8. **Network.** The owner configuration `confinement.network` selects `on`
   (default; AD-13 accepts that confined commands use the network) or `off`.
   It is part of the configuration and its digest (AD-17 point 5); agents
   cannot change it.
   - `on`: the sandbox shares the host network namespace, so internet, LAN,
     localhost services of the host and ports published by containers work as
     outside the sandbox; there is no egress list (AD-13 points 6 and 7).
     Abstract Unix sockets outside the sandbox are denied by the payload
     profile (point 5); pathname Unix sockets are reachable where the read
     view shows them.
   - `off`: the sandbox has its own network namespace with loopback only,
     shared by all confined processes of one Core (point 10), so a background
     server and its tests still reach each other on `localhost`. A separate
     network namespace has its own abstract socket namespace, so `off` does
     not depend on AppArmor Unix mediation. The Docker endpoint (point 9) is a
     pathname socket and stays usable; containers get their network from the
     daemon, as with `docker.use`, so `off` is not an egress control for
     containers.
   - Landlock is not required on Linux in v1. Its abstract-socket scoping
     needs Linux 6.12, which neither supported release ships as its GA kernel;
     the AppArmor Unix mediation of the Ubuntu kernels gives the property on
     both releases. WP-23a may add Landlock as defence in depth where the
     kernel offers it; availability never depends on it.
   - Status describes the configured mode. If `on` cannot be established but
     `off` could, L1 is reported unavailable with the reason and `detail`
     says that `off` would be available; CROT never switches the mode itself.
9. **Docker endpoint (Docker from the confined shell).**
   - A confined process never reaches a real daemon endpoint directly
     (point 6). The service provides a Docker API endpoint per Core: a Unix
     socket with the same path inside and outside the sandbox, in the L1
     private storage. In the child, `DOCKER_HOST` names it and `DOCKER_CONTEXT`,
     `DOCKER_TLS_VERIFY` and `DOCKER_CERT_PATH` are removed. The Docker CLI,
     Docker Compose, Buildx/BuildKit, Testcontainers and other Docker API
     clients work through it unchanged, including streaming, attach, exec,
     logs and build sessions (HTTP upgrades and hijacked connections).
   - Upstream, the endpoint reaches the daemon exactly as the service's Docker
     CLI does: the service's `DOCKER_HOST`, current context, TLS material and
     `ssh://` hosts (for example through `docker system dial-stdio`). Every
     transport supported today — local Unix socket, TCP, TCP with TLS, SSH,
     contexts — stays supported; TLS keys and SSH connections stay in the
     service.
   - The endpoint is part of the fixed L1 profile, not a second permission
     system: it has no configuration and no per-request choice and does not
     involve the PermissionEngine; `docker.use` and AD-3 are unchanged. It
     forwards every request and refuses only those that would carry a confined
     process across the L1 boundary through the daemon (HTTP 403 with a CROT
     reason; audited, point 13):
     a. bind mounts and volume driver options that bind host paths: a source
        that is or contains a CROT-protected path is refused; a writable
        source is accepted only inside the workspace or the L1 private
        storage; a read-only source is accepted where the sandbox can read
        it — the same read and write boundary as the sandbox, and the same
        workspace rule for writable mounts that AD-3 applies to `docker.use`
        in sandbox mode;
     b. privileged containers, and added capabilities that act on the host
        kernel or on other namespaces (`ALL`, `SYS_ADMIN`, `SYS_MODULE`,
        `SYS_RAWIO`, `SYS_PTRACE`, `SYS_BOOT`, `DAC_READ_SEARCH`, `MAC_ADMIN`,
        `MAC_OVERRIDE`, `BPF`, `PERFMON`, `SYSLOG`); other capabilities, for
        example `NET_ADMIN`, are accepted;
     c. the host PID, IPC, user and cgroup namespaces; security options that
        turn off the container's confinement (`apparmor=unconfined`,
        `seccomp=unconfined`, `systempaths=unconfined`, `label=disable`);
        device mappings outside the classes of point 6; the BuildKit
        entitlement `security.insecure`; plugin installation;
     d. a bind of a real daemon endpoint; the endpoint's own socket may be
        bound, so containers that drive Docker (for example Testcontainers'
        helper container) go through the same endpoint.
     The host network namespace (`--network host`, BuildKit `network.host`)
     is accepted: containers created through the endpoint on a daemon that
     runs on this host (reached through a local Unix socket or a loopback
     address) and supports AppArmor run under `crot-l1-container-<v>`, which
     denies abstract Unix sockets outside the container. A daemon on another
     host (SSH, TCP, TLS or a context naming another machine) keeps its normal
     behaviour: the endpoint does not set the CROT profile there and never
     refuses a request because that host cannot load it; its host network is
     not this host's. A daemon on this host that the endpoint does not
     recognise as local falls under point 14. Exec, attach, archive (cp)
     and commit on an existing container are accepted when that container's
     configuration passes a–d; containers created outside CROT that do not
     pass can still be listed, inspected and logged. Images, builds, pulls,
     pushes, networks, named volumes, Compose projects and registry logins
     work as outside the sandbox (registry credentials in
     `~/.docker/config.json` stay readable, AD-13).
10. **Sandbox lifetime and process model.**
    - One sandbox per Core. It starts with the first confined launch and ends
      when that Core shuts down (AD-17 point 8, including the Core switch of a
      preset change, AD-19 point 5) or, through die-with-parent, when the
      service dies. All confined `shell.execute` commands and `process.manage`
      processes of that Core run in it and share the private temp, the
      private home layer and, with network `off`, the loopback network.
    - `crot-l1-init` is the sandbox's PID 1. It starts each command on request
      of the service's launcher over a private channel that no confined
      process inherits, and places each command under its own subreaper, so
      the whole tree of a command — including descendants that call `setsid`
      or fork twice — is ended by termination, `process.manage` stop and the
      existing timeouts.
    - Descendants cannot leave: fork and exec, nested shells, interpreters,
      `nohup`, `setsid` and `disown` stay in the sandbox's namespaces and
      AppArmor confinement; the user's systemd manager and session bus are
      unreachable (point 6), so `systemd-run --user` cannot start an
      unconfined unit; setuid programs (`sudo`, `pkexec`, `crontab`, `at`)
      gain no privilege under no-new-privileges. A detached `process.manage`
      process stays confined for its whole lifetime and ends with the sandbox
      at the latest. No binary is blacklisted.
11. **Refusal and failure.** L1 applies to the children of `shell.execute` and
    `process.manage` in workspace (sandbox) mode for every principal when it
    is available; `full_control` stays unconfined (§6, AD-13 point 4).
    - If L1 is unavailable on the machine in the configured network mode,
      these operations of `remote` principals are refused before any process
      starts (`CONFINEMENT_UNAVAILABLE` with the reason code) and the refusal
      is audited; `local` principals keep their existing behaviour (commands
      run as before L1), and `crot_status` and the tray show that L1 is not
      active (AD-13 point 4).
    - If L1 was available but a sandbox cannot be set up or a launch fails for
      a sandbox reason, that operation fails for every principal
      (`CONFINEMENT_FAILED`); it is never retried unconfined. Availability is
      checked again and reported.
    - There is no other refusal condition. The refusals of the Docker
      endpoint (point 9) concern single Docker requests, not L1 availability;
      an absent or unreachable Docker daemon is reported by the Docker client
      as it is outside the sandbox.
    - The refusal is decided in Core's process service before launch, from the
      platform's reported L1 state; the PermissionEngine, approval semantics
      and the tray authorization are unchanged.
12. **Availability checks, reason codes and status.** The checks run when a
    Core is created, after a sandbox failure and before `crot_status` reports.
    The first failing check is the reason. Stable reason codes:
    - `not_implemented` — L1 is not implemented for this OS (macOS until
      WP-23b; Windows availability and owner-provisioned components: AD-30);
    - `userns_unavailable` — unprivileged user namespaces are disabled;
    - `components_missing` — `/usr/lib/crot/l1/<v>/` or one of its components
      is missing;
    - `components_mismatch` — wrong `<v>`, a digest mismatch, or a component
      that is not owned by root or is writable by the user;
    - `apparmor_unavailable` — AppArmor is not enabled where L1 needs it (the
      user-namespace restriction is active, or network `on`);
    - `apparmor_profile_not_loaded` — the policy of `<v>` is not loaded
      (`crot-bwrap` is denied its user namespace, or the sandbox's label is not
      `crot-l1-<v>//&crot-l1-payload-<v>`);
    - `apparmor_unix_mediation_unavailable` — the kernel does not mediate Unix
      sockets (network `on` only);
    - `overlay_unavailable` — the private home layer cannot be mounted;
    - `private_storage_unavailable` — the L1 private storage cannot be created
      or fails verification;
    - `self_test_failed` — the boundary self-test in a fresh sandbox failed. It
      must fail to read a canary in a CROT-protected path, to write outside the
      write boundary, to connect to an abstract canary socket of the service
      (network `on`) and to signal the service, and it must succeed in reading
      the home and writing the workspace, the private temp and the home layer.
    `crot_status.confinement` and the control-protocol
    `overview.confinement` (AD-19 point 10) have the same shape:
    `{ mechanism, available, network, reason, detail }` — `mechanism`
    `"linux-bubblewrap"` or `"none"`, `available` boolean, `network` `"on"` or
    `"off"` (the configured mode), `reason` one of the codes above or `null`
    exactly when available, `detail` one line without secrets or CROT-protected
    paths (for example the missing component, that `off` would be available,
    or, when available, the host-network notes of point 14). The tray shows
    these fields; the codes are stable for diagnostics.
13. **Audit and logs.** `CONFINEMENT_UNAVAILABLE` and `CONFINEMENT_FAILED`
    appear in the audit record of the operation; refusals of the Docker
    endpoint are recorded as `confinement.docker_refused` (request kind and
    reason; no payload, no file contents). Changes of availability go to the
    service log with the reason code. Nothing in L1 status, audit or logs
    contains a secret.
14. **Host-network residual risk (decides §26 question 15, roadmap OD-14).**
    Network `on` is the normal host-network development environment and stays
    as defined in point 8: no private network namespace, no localhost
    forwarding and no other mediated network layer is part of L1. Host-local
    services that accept the user's authority without a CROT-specific
    credential are a documented residual risk of this model, not part of the
    L1 guarantee: a Docker or other container daemon reachable over TCP
    without TLS or otherwise through the host network, an SSH server on this
    host that accepts the user's keys or agent, debugger, inspector,
    dev-server or notebook endpoints without their own authentication, and
    local container engines that put containers in the host network without
    `crot-l1-container-<v>`. A confined command that uses such a service runs
    code outside the sandbox with what that service grants.
    - Their existence never makes L1 unavailable and never causes a refusal
      of network `on` or of any operation.
    - Where CROT can detect such a condition from local, non-secret facts —
      the upstream transport of the Docker endpoint (TCP without TLS to a
      local address), the daemon's reported security options (no AppArmor),
      listening sockets on the host's loopback and local addresses that match
      SSH or well-known debugger and notebook ports, a rootless Podman socket
      — it adds a short note to `detail` (category and port, never addresses
      of other hosts, credentials, tokens or file contents). Detection is
      best effort and makes no connection with the user's credentials; the
      absence of a note is no guarantee.
    - Not affected: the CROT-specific boundary — no access from a confined
      process to CROT's secrets, state, configuration, audit log, control and
      approval channel (points 5–7, 9), no fallback to unconfined execution
      (point 11), no secret in status, audit or logs (point 13). CROT's own
      local endpoints are never such services: the loopback HTTP adapter
      requires the local token, which is a CROT-protected secret, and the
      shim and control endpoints are hidden.

**Scope and limits.**

- Decides the Linux part of roadmap OD-9 and the Linux L1 boundary for
  WP-23a. It amends AD-13 point 4 for Linux: the "short allowlist of tool
  caches" is the private home layer (point 7); the Docker socket rule is
  replaced by the Docker endpoint (point 9), which also resolves the
  contradiction with AD-13 point 7 (Docker build and pull through the
  confined shell). AD-3 (`docker.use`), AD-17 (one per-user service, no root),
  AD-18 (environment allowlist; under L1 the Docker connection variables are
  replaced by the endpoint) and AD-19 are unchanged. AD-13's residual risks
  stay as written: confined commands read user files outside the workspace
  (except the CROT-protected paths) and use the network.
- With L1 active it closes, for confined children, the AD-18 residual risk
  (use of the OS secret store or the file fallback) and residual risk D of
  AD-19 (acting like the tray). It does not cover `full_control`, `local`
  principals on machines without L1, or other processes of the user.
- Decides §26 question 15 (roadmap OD-14) as point 14. The guarantee is: a
  confined process has no direct access to CROT's secrets, state,
  configuration, audit log, control or approval channel, and gains no
  privilege through the sandbox itself. L1 does not claim protection against
  arbitrary host-local services reachable over the shared host network with
  network `on`.
- **Amendment (WP-23a, Ubuntu 24.04 Chrome).** Point 3 gains the
  installer-generated exact-path `ix` rules for host application profiles;
  the glob stacking rule stays the only transition, and the payload's
  `file rwlkmix` is now what the policy ships (before, the payload had a
  second `pix` rule to its own stack, which joined host profiles too).
  Reason: with the stacked transition alone, the installed Google Chrome
  (and any program with a host `flags=(unconfined)` + `userns,` profile)
  could not run inside L1, which breaks the browser baseline of point 1.
  Not changed: no-new-privileges, the payload's user-namespace denial and
  peer rules, the label `crot-l1-<v>//&crot-l1-payload-<v>` of every
  confined process, `full_control`, ExecutionGuard and the Docker endpoint.
  Evidence: the L1 workflow drives the installed browser inside L1 over
  CDP (page, navigation, input, click, DOM, clean exit) and checks that
  every browser process has exactly the L1 label and that no peer denial
  is logged; on runners without a browser (arm64) the check is reported as
  not applicable.
- Residual risks, accepted: the AD-13 risks; the host-local services of
  point 14; a container does whatever its
  image does within the mounts and options a–d allow (as AD-3); files that a
  rootful container writes into the workspace belong to the container's user
  (as AD-3); with a remote daemon the bind rules of point 9 are still applied
  to the paths as written; containers created outside CROT that do not pass
  point 9 cannot be entered from the confined shell; overlay visibility of
  concurrent changes in the home (point 7).
- **Mechanism evidence (WP-23a probe, branch `probe/l1-mechanism`, runs 1–3
  on GitHub-hosted `ubuntu-22.04`, `ubuntu-24.04`, `ubuntu-22.04-arm` and
  `ubuntu-24.04-arm`).** A pinned upstream bubblewrap (v0.11.0) at a
  CROT-style path with one AppArmor profile per transition form:
  - only the Ubuntu/bwrap-style stacked form of point 3 (`ubu`) is an
    enforcing transition that reaches the payload label under
    no-new-privileges on all four jobs. A plain `px` or `cx` transition to a
    child profile (`plain`, `cx`), the other stacked forms (`stack`,
    `stackonly`, `stackpeer`, `stackchild`, `stackcx`) and the diagnostic
    complain-mode variants are not production mechanisms;
  - in the payload: abstract Unix sockets outside the sandbox are refused,
    signals to host processes are refused while signals and sockets between
    confined processes work, `setsid`/`nohup` descendants end with the
    sandbox, and bubblewrap's overlay provides the private home layer;
  - the CROT-style container profile is loaded and enforcing; a
    `--network host` container under it is refused the host's abstract
    socket, while the same container under Docker's default profile reaches
    it;
  - Ubuntu 22.04's parser 3.0.4 cannot compile `abi <abi/4.0>` with
    `userns,` (point 3); profiles that include `abstractions/base` in the
    `crot-bwrap` profile are rejected next to a `px` rule (conflicting exec
    modifiers), which is why that profile includes no abstraction.

### AD-21. Remote identity v1: WorkOS AuthKit is the managed authorization server; account, device and client come only from verified token facts; revocation is decided on the device; one canonical device resource URI with path-inserted Protected Resource Metadata (WP-28 preparation; decides roadmap OD-2 and OD-3)

**Context.** AD-13 points 3 and 6 require a managed third-party identity
provider (no own authorization server; CROT is the resource server),
short-lived tokens bound to account, device and CROT audience, local
verification behind `AccessTokenVerifier`, and revocation. AD-15 fixes the
verification on the device (point 4), the resource and audience rules and the
identity-provider criteria (point 5), the remote principal (point 6), the
exposure triple (point 8) and the relay's and device's responsibilities
(points 10 and 11). AD-19 point 8 adds device-side client revocation. AD-15
left open which token claims carry `clientId` and the device id (WP-28,
roadmap OD-2) and the exact device URI form and PRM location (WP-29, roadmap
OD-3). WP-28 cannot start without both: the verifier, its tests ("a token for
another device") and the pairing flow depend on them.

Requirements the provider must meet, taken only from the existing decisions:

| # | Requirement | Source |
| --- | --- | --- |
| R1 | OAuth 2.1 authorization code flow with PKCE (S256) | AD-15 point 5 |
| R2 | Client ID Metadata Documents (CIMD) for clients that have no prior relationship with CROT | AD-15 point 5; MCP 2026-07-28 |
| R3 | Dynamic Client Registration (DCR) for clients of the older supported versions | AD-15 point 5 |
| R4 | Resource indicators (RFC 8707): the token audience is the requested device resource URI; one URI per device, for any number of devices, without per-device provider configuration; a token for another device or resource is rejected | AD-15 point 5 |
| R5 | Signed JWT access tokens, keys published as JWKS, exact `iss` | AD-15 point 4 |
| R6 | Account, device and client derivable from the verified token; a device claim equal to the local device id | AD-15 points 4 and 6 |
| R7 | Issuer identification in authorization responses (RFC 9207) | AD-15 point 5 |
| R8 | Revocation of grants | AD-15 point 5, §20 |
| R9 | MFA for accounts | AD-15 point 5; AD-13 residual risks |
| R10 | Managed service; Core depends on no provider; the device verifies standard JWTs | AD-13 point 6, §15, §20 |

Evaluation (vendor documentation and live discovery metadata, 2026-10-08):

| Provider | R1 | R2 CIMD | R3 DCR | R4 per-device audience | R5 | R6 | R7 RFC 9207 | R8 | R9 | Result |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| WorkOS AuthKit (WorkOS Connect) | yes (S256 only) | yes (`client_id_metadata_document_supported: true`) | yes | **yes**: one path-wildcard resource indicator covers every device; `aud` is the concrete requested URI; unregistered resources fail with `invalid_target` | yes (RS256, JWKS) | `sub` (user), `client_id`, `sid` (consent); per-resource custom claims not available (one environment-wide JWT template) | **not observed**: not advertised in metadata; error redirects carry no `iss` | delete a user's authorized application; token revocation endpoint | yes (TOTP, can be required) | **selected** |
| Auth0 (Okta Customer Identity) | yes | admin-imported CIMD clients only; an unknown client cannot use CIMD | yes (open DCR) | resource must be a registered API; no wildcard; one API per device, limited to 100 per tenant (100 000 on Enterprise) | yes | per-resource custom claims through Actions | yes (tenant setting) | yes | yes | rejected: R2 and R4 fail for an open client population and any number of devices |
| Descope | yes | yes | yes | one MCP-server resource (and its own issuer) per URL; no wildcard | yes | flows add claims | not established | yes | yes | rejected: R4 (a provider resource and issuer per device) |
| Stytch Connected Apps | yes | not established | yes | audience is the project id, not the resource | yes | not evaluated | not established | yes | yes | rejected: R4 |
| Okta Workforce / custom authorization server | yes | not documented | authenticated registration only | audience fixed per authorization server; no RFC 8707 | yes | yes | not established | yes | yes | rejected: R2, R4 |
| Microsoft Entra ID | yes | no | no registration endpoint | scope-based resources, no RFC 8707 | yes | yes | not advertised | yes | yes | rejected: R2, R3, R4 |
| Amazon Cognito | yes | no | no | registered resource servers only | yes | yes | not established | yes | yes | rejected: R2, R3, R4 |
| Keycloak, Ory Hydra (self-hosted or hosted) | yes | not established | yes | audience lists or mappers; no RFC 8707 resource parameter documented | yes | yes | not evaluated | yes | yes | rejected: R10 (CROT would operate the authorization server) and R4 |

**Decision.**

1. **Identity provider (decides OD-2; amended for AuthKit hosted domains).**
   CROT uses **WorkOS AuthKit** (WorkOS Connect) as its managed OAuth 2.1
   authorization server, one WorkOS environment per CROT cloud environment
   (staging: WP-38; production: WP-39). The canonical issuer may be either
   WorkOS's hosted HTTPS origin (`https://<env-slug>.authkit.app`) or a CROT
   custom authentication domain. A custom domain is not required. The sole
   invariant is that this exact HTTPS origin is pinned in the release
   environment and matches byte-for-byte the authorization-server metadata
   `issuer` and every accepted token's `iss`. It is independent of the relay
   host: for example `https://prestigious-continent-62-staging.authkit.app`
   with `relay-staging.crot.network` is valid. Environment configuration
   (normative for WP-28 and WP-38):
   - CIMD on; DCR on for clients of the older versions (R2, R3);
   - exactly one resource indicator, the path wildcard
     `https://<relay-host>/d/*` of that environment (point 5); no default
     resource indicator, so a request without `resource` yields a token
     with the environment's client id as audience, which every device and
     the relay reject;
   - MFA required for CROT accounts (R9);
   - the shortest access-token lifetime the environment allows, at most
     5 minutes (point 4).
   The provider stays behind `AccessTokenVerifier` and the app-level
   identity client (§20): the device verifies standard JWTs with JWKS and
   needs no provider SDK; Core sees only a `Principal`. Replacing the
   provider is a configuration change (issuer, relay origin) plus re-consent,
   not a change of this model.

   Why the alternatives are worse for CROT: R4 is the deciding requirement.
   AD-15 point 5 gives every device its own resource URI, and only a
   provider that accepts a resource pattern can issue audience-bound tokens
   for any number of devices without creating a provider resource (and, for
   Descope, an issuer) per device at pairing time; Auth0 additionally
   accepts CIMD only for clients an administrator imported, which excludes
   the open client population of AD-14 point 1. Entra ID, Cognito and Okta
   lack CIMD or RFC 8707; self-hosted servers contradict AD-13 point 6.

2. **Claim model (decides the claim part of OD-2).** The verifier sets
   `AuthInfo` from the verified token only; everything else is ignored.

   | Fact | Token source | Rule | Principal / AuthInfo |
   | --- | --- | --- | --- |
   | Issuer | `iss` | equal, byte for byte, to the configured issuer | — |
   | Audience and **device** | `aud` | exactly one value (a string, or an array with one element) equal, byte for byte, to this device's canonical resource URI (point 5). The device id is the `<deviceId>` segment of that URI: `aud` is the device claim of AD-15 point 4, signed by the provider and accepted by it only for the registered pattern | `deviceId` (= the local device id from device binding) |
   | **Account** and stable **subject** | `sub` (the WorkOS user id) | present, non-empty, and equal to the account this device was paired with (stored in the device's protected state at pairing, WP-28) | `id` = `sub` (the stable subject of the grant, AD-15 point 6); `accountId` = `sub` (v1: one account per user; teams are post-v1) |
   | **Client** | `client_id` (RFC 9068) | present and non-empty; the provider sets it to the registration that obtained the grant (the CIMD URL or the DCR client id) | `AuthInfo.clientId` → `clientId` |
   | Validity | `exp`, `iat`, `nbf` | `exp` and `iat` required, `nbf` checked when present, 60 s clock skew; `iat` not more than 15 minutes in the past (point 4) | — |
   | Signature | JOSE header `alg`, `kid` | RS256 only; key from the issuer's JWKS (point 7) | — |

   Trusted for identity are only `iss`, `aud`, `sub`, `client_id` and the
   time claims, after the signature check. Never a security authority:
   `scope` (only `offline_access` is requested, for refresh tokens), `sid`,
   `jti`, `org_id`, roles or any claim of the provider's JWT template,
   `email` and profile claims, the self-reported client name and version
   (`clientInfo`, `_meta`), and any request header (including identity
   headers a relay or client adds). Token contents never grant
   capabilities (AD-15 point 4). `client_id` identifies a registration, not
   the software behind it: DCR is open, so a registration named like a
   known client gets its own `client_id`, and with it its own exposure
   scope, revocation key and tray entry (AD-15 point 12).

3. **Device-side verification order (refines AD-15 point 4).** In this
   order, each failure answering 401 with `WWW-Authenticate` (point 6):
   signature and `alg`; `iss`; `aud`; `exp`, `nbf`, `iat` bound; `sub`
   equals the paired account (an unpaired device accepts no token);
   `client_id` present. Then the grant must not be revoked on this device
   (point 4): a revoked client is refused with 403 before MCP or Core, as
   the relay entry point does since WP-22 (AD-19 point 8), and unreadable
   revocation state refuses every remote request. Steps 3–6 of the AD-15
   point 2 pipeline then
   run unchanged; the principal is `kind: "remote"`, `transport: "relay"`,
   `authMethod: "oauth"`.

4. **Revocation model.**
   - **Revoked** means any of: (a) the user revoked a client on this device
     (AD-19 point 8; key: the triple `accountId`, `deviceId`, `clientId` of
     AD-15 point 8), until
     the user re-grants it on the device (WP-28); (b) the device is no
     longer paired (unpaired in the tray, or removed in the account portal,
     WP-36); (c) the user's authorization of a client was revoked at the
     provider (WorkOS authorized application deleted, refresh token
     revoked); (d) the account is disabled or deleted at the provider.
   - **How CROT learns it.** (a) and (b) are device state, written only by
     the user through the control channel or by unpairing, persisted in
     CROT's protected state and checked on every request; unreadable state
     refuses every remote request (fail closed, as AD-19 point 8). Removing
     a device in the portal also revokes its device credential, so the
     relay refuses its tunnel. (c) and (d) stop the provider from issuing
     or refreshing tokens; already issued access tokens are bearer JWTs
     and end at their expiry: the documented bound is the configured
     lifetime (at most 5 minutes), and at most 15 minutes after `iat`
     whatever the provider issues (the device's own ceiling). Revoking in
     the tray records (a) first and then asks the provider to revoke the
     authorization (best effort; (a) holds without it).
   - **Relation to `AccessTokenVerifier`.** Revocation is part of the
     device's verification (point 3): the verifier reads the device's own
     revocation and pairing state; it performs no per-request call to the
     provider or the relay (no token introspection, which would also need a
     provider client secret on every device). A notice from the CROT cloud
     may add a revocation to the device state (narrowing only); nothing
     outside the user's control channel removes one.
   - The relay may refuse revoked or unpaired devices and clients earlier
     (admission), but no relay answer replaces, relaxes or skips the
     device's checks (AD-15 points 4 and 10).

5. **Canonical device resource URI (decides OD-3).** Each device has
   exactly one resource URI:

   ```text
   https://<relay-host>/d/<deviceId>/mcp
   ```

   - `<relay-host>` is the relay host of the CROT cloud environment (one
     per environment; the production host is fixed with WP-29/WP-39). It is
     pinned in the CROT release configuration, not taken from the relay,
     the user configuration or a request.
   - `<deviceId>` is assigned once at pairing (WP-28): 16 random bytes as
     lowercase RFC 4648 base32 without padding (26 characters,
     `[a-z2-7]`). It is not secret and carries no authority by itself.
   - The URI is lowercase, has no port, query, fragment, trailing slash or
     percent-encoding, and is compared byte for byte (no normalization).
   - It is at the same time: the MCP endpoint clients are configured with
     and connect to; the `resource` value of the PRM; the RFC 8707
     `resource` parameter clients send; the only accepted `aud`; and the
     logical resource of relay and device together (AD-15 point 5). The
     relay routes by the `<deviceId>` path segment.

6. **Protected Resource Metadata (decides OD-3).**
   - Location (RFC 9728 section 3.1, well-known suffix inserted before the
     path): `https://<relay-host>/.well-known/oauth-protected-resource/d/<deviceId>/mcp`.
   - Served by the relay for every paired device (otherwise 404); there is
     no host-wide document at `https://<relay-host>/.well-known/oauth-protected-resource`
     and no authorization server metadata at the relay host.
   - Content: `resource` = the canonical URI (byte for byte, as RFC 9728
     section 3.3 requires clients to check); `authorization_servers` = the
     issuer of point 1; `bearer_methods_supported` = `["header"]`;
     `scopes_supported` = `["offline_access"]`.
   - Every 401 for that URI, whether the relay or the device answers,
     carries `WWW-Authenticate: Bearer resource_metadata="<PRM URL>"` (with
     `error="invalid_token"` when a token was presented). The device builds
     the same URL from its own canonical URI.

7. **Relay and keys.** The relay checks the same token for admission only
   (AD-15 point 10): signature, `iss`, `aud` equal to the canonical URI of
   the routed device, `exp`/`iat`, `sub` equal to the device's paired
   account, entitlement (WP-36), device online and remote mode on. It never
   mints, exchanges or rewrites tokens and forwards `Authorization`
   unchanged. Device and relay fetch the JWKS directly from the issuer
   (from its authorization server metadata, over TLS), never through the
   tunnel, cache it, and refetch on an unknown `kid` at a bounded rate.

8. **Scenarios (acceptance for WP-28 and WP-29).**

   | Scenario | Relay (admission) | Device (authoritative) |
   | --- | --- | --- |
   | Token of the right client for the right device | admitted, routed by `<deviceId>` | accepted; principal `remote` with `id`/`accountId` = `sub`, `deviceId`, `clientId` = `client_id`; exposure scope = the triple |
   | Same account, token for another device | 401: `aud` ≠ this URI | 401: `aud` ≠ own URI |
   | Token for another audience/resource (another server, environment client id, no `resource`) | 401 | 401 |
   | Expired token (or `iat` older than the ceiling) | 401 | 401 `invalid_token`; the client refreshes |
   | Grant revoked on the device | may refuse (if known) | 403 before MCP/Core (AD-19 point 8) |
   | Grant revoked at the provider | no new or refreshed tokens | accepted until expiry (≤ bound of point 4), then 401 |
   | Wrong issuer (other WorkOS environment, other provider) | 401 | 401; no key of that issuer is ever fetched |
   | Wrong device claim: `aud` names another `<deviceId>`, several audiences, or a token of another account for this device's URI | 401 | 401 (`aud` or `sub` check) |
   | Forged or self-reported `clientId` (header, `_meta`, `initialize`) | ignored | ignored; `clientId` only from the signed `client_id`; a changed claim fails the signature |
   | Request through the relay | checks above, forwards unchanged | full verification again; relay identity headers ignored; the local token is refused here, an OAuth token on the loopback endpoint is refused there |

**Scope and limits.**

- Documentation only. WP-28 implements the verifier with this claim model,
  pairing (device id, device credential, paired account), re-grant and
  provider-side revocation; WP-29 serves the PRM and performs the admission
  of point 7; WP-38 and WP-39 configure the environments of point 1. The
  production behaviour of `AccessTokenVerifier` and `Principal` is unchanged
  by this decision (the fields already exist since WP-19).
- It decides roadmap OD-2 and OD-3 and the two open items of AD-15 ("which
  token claim carries `clientId` and the device id"; "the exact device URI
  form"). It clarifies AD-15 point 5: the "custom device claim" is the
  device id carried in the provider-signed `aud`, so no provider-specific
  per-resource claim is needed; the device additionally binds `sub` to the
  paired account. It adds the paired-account check to the relay admission
  of AD-15 point 10 (narrowing only). No other decision changes.
- **R7 disposition.** The selected WorkOS environment does not advertise the
  RFC 9207 authorization-response `iss` parameter. AD-36 accepts this deviation
  for v1 under the single pinned-issuer model. Clients still compare `iss`
  byte-for-byte whenever it is present; device and relay always verify the
  signed JWT `iss` and `aud`. A multi-AS or unpinned-discovery design requires
  a new AD and cannot rely on this exception.
- Residual risks, accepted: the provider does not know which devices an
  account owns (the device and the relay enforce the paired account);
  revocation at the provider takes effect within the bound of point 4; a
  compromise of the provider or of the account allows remote requests
  within the device's permissions and approvals (mitigated by MFA,
  short-lived tokens and revocation, as AD-13); `client_id` of a DCR client
  is not proof of the software behind it.

**Implementation (WP-28).** **[Implemented]** on the device
(`src/identity/`, `src/service/device-binding.ts`, `src/service/identity.ts`;
user docs [`docs/IDENTITY.md`](docs/IDENTITY.md)). Implementation notes,
none of which relaxes this decision:

- *Environment pinning (point 5).* Release builds pin their environment in
  `RELEASE_IDENTITY_ENVIRONMENT`; WP-38 now supplies the explicit pinned artifact
  builder (`docs/STAGING.md`), while plain development builds remain unpinned. Only
  while none is pinned, a development environment may be named by the
  service's environment variable `CROT_IDENTITY_DEV_ENVIRONMENT` (a JSON
  file: issuer, relay host, pairing client); it is never taken from the
  CROT configuration, the relay or a request, and is ignored once a release
  environment is pinned. The binding records the environment of its
  pairing; in any other environment no token is accepted and no tunnel
  credential is given out (fail closed).
- *Verification (points 2, 3).* RS256 only; JWKS from the issuer's RFC 8414
  metadata (its `issuer` must match byte for byte), cached 10 minutes,
  refetch on an unknown `kid` at most every 30 s, the last good set used at
  most 1 hour while the issuer is unreachable. `exp` is checked without
  leeway (stricter than the 60 s skew, which applies to `nbf` and a future
  `iat`). A one-element `aud` array counts as one value. After verification
  admission re-checks that the binding is still paired to the token's
  account and device (unpairing during a key fetch cannot admit a request).
- *Pairing (points 1, 2, 5).* Authorization code flow with PKCE S256 of a
  public native client and a loopback redirect (RFC 8252); `resource` = the
  canonical URI of the device id created for this pairing; the token is
  verified with the checks of point 3 and `client_id` must be the pairing
  client; its `sub` becomes the paired account; tokens are never stored or
  logged. An `iss` in the authorization response must equal the issuer when
  present (AD-36 accepts its absence only for the single pinned issuer). Every pairing assigns a
  **new device id and a new device key**, so nothing of an earlier pairing
  applies after unpair and pair.
- *Device credential (AD-15 point 10).* Ed25519 key, seed in the CROT secret
  store (`device-key`, not rotated by `secrets rotate`); tunnel proofs sign
  `crot-device-tunnel-v1 \0 deviceId \0 relayHost \0 challenge`. The relay
  protocol that uses it is WP-29/WP-30.
- *Revocation (point 4).* (a) re-grant is audited first and persisted before
  it takes effect; tokens with `iat` not after the re-grant's second are
  refused (401 `invalid_token`). (b) unpairing is immediate and removes the
  device key. WP-36 now connects the tray hook to server-only WorkOS session
  revocation for observed verified sid metadata; no sid/credentials/offline
  reports not_available/failed rather than success (AD-34); (c) and (d) keep the bound of point 4.


### AD-22. Relay–device tunnel v1: one outbound WebSocket per device carries multiplexed, unmodified HTTP exchanges with credit-based flow control; every request is bounded in size and time; cancellation and lost responses are explicit; the relay never executes (WP-29/WP-30 preparation; decides roadmap OD-4 and OD-5, §26 question 13)

**Context.** AD-15 point 10 fixes the shape: the relay admits a request,
routes it by device id and forwards method, headers and body **unchanged**
to the device, then streams the response back unchanged; it implements no
MCP and keeps no protocol state (C7). The device runs the request through
its existing HTTP pipeline as `transport: "relay"`, `kind: "remote"` (C4)
and is authoritative for everything (point 11). AD-21 fixes the device URI,
the PRM, the relay admission (point 7) and the device credential. What was
open (roadmap OD-4, OD-5; §26 question 13) is the wire contract between the
two independently deployed components and its time limits. Facts at `main`
`1c8f759` (no code change since `4d574f0`):

- **Device side exists, tunnel does not.** `CrotHttpServer` (`src/adapters/http/server.ts`)
  supports `entryPoint: "relay"` with the OAuth verifier, admission
  (`RemoteAdmission`, remote mode, revocation) and `WWW-Authenticate` with
  the PRM URL; `CrotService.addRemoteEntry`, `remoteVerifier`,
  `tunnelCredential()` are the hooks for WP-30 (`src/service/service.ts`).
  `route()` today checks a loopback `Host` and the path `/mcp`. No relay or
  tunnel code exists.
- **Device credential.** Ed25519, `signTunnelProof` over
  `crot-device-tunnel-v1 \0 deviceId \0 relayHost \0 challenge`, challenge
  16–1024 bytes, reference check `verifyTunnelProof`
  (`src/identity/device-credential.ts`). Nothing registers the public key
  with the cloud yet; the pairing access token is verified and discarded.
- **Request limits on the device.** Body ≤ `http.maxRequestBytes`
  (default 4 MiB); `maxConcurrentRequests` (default 32, max 1024, then 503
  with `Retry-After`); `maxSessions` 16 (`src/core/config/schema.ts`).
- **Largest results.** `browser_screenshot` ≤ 16 MiB of image bytes
  (`BROWSER_SCREENSHOT_MAX_BYTES`), returned base64 in JSON (about
  21.4 MiB); `fs_read_file` ≤ `limits.maxReadBytes` (default 10 MiB,
  configurable without an upper bound, chunked by offset/length); command
  output ≤ 1 MiB per stream; `network_request` response ≤ 1 MiB default.
- **Durations.** Approval wait default 45 s, max 300 s
  (`src/core/approvals/rules.ts`); browser waits ≤ 60 s plus margin
  (AD-16); `process_exec` default 120 s, max 1 h; background processes
  unbounded (`process_start` / `process_read_output`).
- **Cancellation.** The request's `AbortSignal` (AD-15 point 7) cancels a
  pending approval (`broker.request(..., context.signal)`) and stops an
  approved operation **before** `execute()` (`guard.ts`, "it was not
  executed"). Capability services do not observe the signal inside
  `execute()`: a running command, file write or HTTP request continues to
  its own end or timeout.
- **Responses.** The MCP SDK transport answers POSTs with a JSON body or an
  SSE stream scoped to the request; legacy sessions may hold a GET stream.
  CROT issues no server-to-client requests (AD-15 C6) and sends no progress
  notifications.
- **Runtime.** Node ≥ 20 in `package.json`; a WebSocket client is built
  into Node from 22 (the development runtime is 24).

**Decision.**

1. **Model.** The tunnel carries **HTTP exchanges**, not MCP messages. One
   client HTTP request to `https://<relay-host>/d/<deviceId>/mcp` becomes
   one tunnel **stream**: request head and body from relay to device,
   response head and body from device to relay. The relay sees MCP only as
   opaque bytes (it may read `Mcp-Method` for routing and rate limits,
   AD-15 point 10). The device feeds each stream into the existing HTTP
   pipeline (AD-15 point 2, C4); nothing else enters Core. The protocol has
   no frame or field by which the relay can run, authorize, approve or
   modify a CROT operation.

2. **Carrier.** The device opens **one WebSocket (RFC 6455) over TLS** to
   `wss://<relay-host>/.crot/tunnel` on port 443, outbound only (§22).
   - `relay-host` is the host pinned in the device binding / release
     configuration (AD-21 point 5); the TLS server certificate is validated
     against it with the system trust store; TLS 1.2 or later (1.3
     preferred); no certificate pinning in v1 (open question 2).
   - The major protocol version is negotiated as the WebSocket subprotocol
     `crot-tunnel.v<N>` (point 10). Every WebSocket message is **binary**
     and carries exactly **one** frame (point 5). Text messages are a
     protocol error.
   - One active tunnel per device (point 9). Remote mode off on the device
     means no tunnel (AD-19); the device never accepts inbound connections.

3. **Handshake and tunnel authentication** (all on stream 0, before any
   other frame; total time limit 10 s from WebSocket open, else close
   4408):
   1. relay → `CHALLENGE` `{versions, relayHost, challenge}`: `challenge` =
      32 random bytes (base64url), fresh per connection.
   2. The device checks `relayHost` equals its pinned relay host (else close
      4400 and no proof is produced), then sends `HELLO` `{deviceId,
      proof, software, maxStreams, features}`, `proof` =
      `signTunnelProof(key, deviceId, relayHost, challenge)` (base64url),
      `software` = CROT version (informational, logged by the relay for
      compatibility only).
   3. The relay verifies the proof with the public key **registered** for
      `deviceId` (point 4), that the device is entitled (WP-36 hook) and
      not blocked, then sends `READY` `{tunnelId, limits, features}`
      (`tunnelId` is a random id for logs on both sides; `features` = the
      intersection). Failure: close 4401 (proof/unknown device) or 4403
      (not entitled/blocked); no detail beyond the code.
   - Only after `READY` may streams open. The tunnel credential proves which
     device holds the tunnel and **never** authenticates a request
     (AD-15 point 10): every stream still carries the client's own token,
     verified by the relay (admission) and again by the device.

4. **Device registration** (precondition of point 3; the tunnel needs the
   device's public key and paired account at the relay). At the end of a
   successful pairing (WP-28 flow), the device calls
   `POST https://<relay-host>/d/<deviceId>/register` with the pairing access
   token as `Authorization: Bearer` and body `{publicKey}` (the
   `DevicePublicKey` JWK). The relay verifies the token as the device
   verifies its pairing token (AD-21 point 7 and the WP-28 pairing note:
   signature, `iss`, `aud` = this device URI, `exp`/`iat`) **and** that
   `client_id` is the environment's pairing client; a valid token of any
   other client for the same URI is refused (403) — the provider issues
   tokens for any device URI to any account and client (AD-21 residual
   risks), so `aud` alone does not show a pairing. The token is checked
   before the body is read. The relay then records `(deviceId, accountId =
   sub, publicKey, environment, registeredAt)`. A `deviceId` registers once; a second
   registration with a different key or account is refused (409) — every
   pairing has a new device id and key (AD-21 implementation note), so a
   legitimate re-pair never needs it. The first successful registration
   binds the id to its account; residual risk (accepted): someone who
   learns a new device id before the device registered it (seconds after
   the pairing authorization) and completes a pairing grant of their own
   for that URI can take the id first — the legitimate pairing then fails
   with 409 and is repeated with a new id; no request of the victim's
   clients is admitted to the other account (`sub` check, point 3 / AD-21
   point 7). The token is not stored by either side. Pairing succeeds on the device only after registration succeeded
   (else the binding is not written, as for any pairing failure).
   Device side: WP-30 (`src/identity/relay-registration.ts`, called by
   pairing after the pairing token passed the device's own checks).
   **WP-29 completion contract (resolves open question 3):** before this POST,
   the device stores and reads back its private key plus an inactive private
   `device-binding.json.registration` intent. This intent grants no access.
   The final binding is committed only after registration and the existing
   control audit. Failure, cancellation or a lost registration response uses
   signed compensation; if the relay is unreachable the intent/key survive
   restart and are retried before another pairing (fail closed).

   `GET /d/<deviceId>/deregister` issues a random 32-byte, single-use challenge
   valid for 30 s, bound to the exact current registry record (global cache
   at most 1024). `POST` sends `{challenge, proof}`: Ed25519 over
   `crot-device-deregister-v1\0<deviceId>\0<relayHost>\0<challenge bytes>`.
   Tunnel proofs, other keys/hosts/ids, expired/replayed challenges fail.
   Conditional durable removal cannot delete a replacement registration;
   success (204) invalidates routing, closes all device tunnels and makes
   subsequent PRM lookups 404. Already absent is 404 (client cleanup success).
   Neither a pairing token nor private key is transmitted or stored at the relay.
   Local unpair revokes immediately and deletes the key; a captured removal-only
   signer sends best-effort deregistration after tunnel GOAWAY `unpaired`,
   without holding up the local result. Offline unpair can leave a stale relay
   record, never local authority; account-side administration remains WP-36.
   Re-pairing rotates to a fresh device id/key, not an in-place key replacement.

5. **Framing.** Frame = 6-byte header + payload, the WebSocket message
   length delimits it:

   | Bytes | Field |
   | --- | --- |
   | 0 | `type` (u8) |
   | 1 | `flags` (u8; bit 0 `END_STREAM`, other bits must be 0) |
   | 2–5 | `stream` (u32, big endian; 0 = connection) |
   | 6– | payload |

   | Type | Name | Direction | Stream | Payload |
   | --- | --- | --- | --- | --- |
   | 0x01 | `CHALLENGE` | relay → device | 0 | JSON |
   | 0x02 | `HELLO` | device → relay | 0 | JSON |
   | 0x03 | `READY` | relay → device | 0 | JSON |
   | 0x10 | `OPEN` | relay → device | ≥ 1 | JSON request head (point 7) |
   | 0x11 | `RESPONSE` | device → relay | ≥ 1 | JSON response head (point 7) |
   | 0x12 | `DATA` | both | ≥ 1 | body bytes, opaque |
   | 0x13 | `RESET` | both | ≥ 1 | JSON `{code, outcome?}` (point 13) |
   | 0x14 | `WINDOW` | both | any | u32 increment (point 8) |
   | 0x20 | `PING` | both | 0 | 8 opaque bytes |
   | 0x21 | `PONG` | both | 0 | the 8 bytes of the `PING` |
   | 0x22 | `GOAWAY` | both | 0 | JSON `{lastStream, code, retryAfterMs?}` (point 9) |
   | 0x80–0xFF | extension | negotiated | — | ignored unless the feature was negotiated |

   - Limits: `DATA` payload ≤ 64 KiB; JSON payloads ≤ 64 KiB, UTF-8,
     objects; unknown JSON members are ignored and never used for
     authority; a header block must fit in one `OPEN`/`RESPONSE` (no
     continuation frames).
   - **Malformed frames.** A larger frame, an unknown type below 0x80, a
     wrong direction, non-zero reserved flag bits, a `WINDOW` payload that
     is not 4 bytes, a `PING`/`PONG` payload that is not 8 bytes, and
     invalid JSON or content in a **stream-0** frame (`CHALLENGE`,
     `HELLO`, `READY`, `GOAWAY`) are **connection errors** (point 14):
     they leave the connection state unknown. Invalid JSON or content in a
     **stream** head (`OPEN`, `RESPONSE`: not a UTF-8 JSON object, a bad
     header list or status, a limit exceeded inside the head) is a
     **stream error**: the receiver resets that stream with
     `protocol_error`, the connection and other streams continue. A
     `RESET` whose payload cannot be read still ends its stream and counts
     as `internal_error`.
   - Rationale for JSON in head/control frames: rare, small, debuggable,
     extensible by ignored members; bodies stay opaque binary.

6. **Streams and multiplexing.**
   - Only the relay opens streams (`OPEN`), with strictly increasing
     ids starting at 1, never reused within a tunnel connection;
     a lower or repeated id is a connection error.
   - A stream is open until **both** directions ended (`END_STREAM` on the
     last `OPEN`/`DATA` from the relay and on the last `RESPONSE`/`DATA`
     from the device) or either side sent `RESET`. Frames for a closed
     stream id are ignored (they may cross a `RESET`); frames for an id never
     opened are a connection error.
   - **Concurrency.** The device announces `maxStreams` in `HELLO`
     (= `http.maxConcurrentRequests` + `http.maxSessions`, capped at 1024).
     The relay never has more open streams; a client request beyond it is
     answered by the relay with 503 `busy` + `Retry-After: 1` without
     forwarding. The device's own pipeline limits still apply (its 503s are
     ordinary responses). No queueing in the relay in v1.
   - **Response before the request ended.** When the device has sent its
     complete response (`END_STREAM` on its last `RESPONSE`/`DATA`) while
     the relay has not yet sent `END_STREAM` for the request (the client
     is still sending, or body bytes wait for the device's window), the
     exchange is complete: the relay forwards no more request bytes and
     sends `RESET` (`cancel`) for the stream, which closes it on both
     sides. Such a `RESET` never affects the completed request: the device
     ignores it for the operation (its result and audit stand, point 13);
     it only releases the stream's state.
   - **Refusal before dispatch.** The device answers an `OPEN` it does not
     hand to the pipeline (over `maxStreams`, shutting down, remote mode
     just switched off) with `RESET refused`; a refused stream is
     guaranteed not to have reached MCP dispatch (outcome `not_executed`,
     point 13).

7. **Mapping of an HTTP exchange.**
   - `OPEN` `{method, path, headers, deadlineMs}`: `path` is the request
     target unchanged (path and query); `headers` is an ordered list of
     `[name, value]` pairs (names lower-case, duplicates kept) — every
     end-to-end header including `Authorization`, `Host`,
     `MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name`, `Mcp-Param-*`,
     `Mcp-Session-Id`, `Origin`, `Accept`, `Content-Type`,
     `Content-Length`; hop-by-hop headers (`Connection`, `Keep-Alive`,
     `Transfer-Encoding`, `TE`, `Upgrade`, `Proxy-*`) are removed, as any
     HTTP intermediary does. The relay adds **no** header (in particular no
     identity, client-address or forwarding headers); `deadlineMs` is the
     time the relay will wait (point 12). The body follows in `DATA` frames;
     `END_STREAM` on `OPEN` means no body.
   - The device's relay entry point validates before the pipeline: method
     `POST`, `GET` or `DELETE`; `path` exactly `/d/<own deviceId>/mcp`
     (replaces the `/mcp` check); `Host` equal to the pinned relay host
     (replaces the loopback `Host` check); header list well-formed and ≤ 100
     headers; body length equal to `Content-Length` when given. A failure is
     answered as an ordinary HTTP error response (400/404), never reaching
     MCP. Then AD-15 point 2 applies unchanged (version, authentication,
     admission, principal, context, MCP, Core), including the `Origin`
     check.
   - `RESPONSE` `{status, headers}` then `DATA`; JSON and SSE bodies are the
     same to the tunnel. The relay writes them to the client as received
     (no buffering of whole responses, no re-encoding, no transformation of
     SSE).
   - Legacy GET streams and `DELETE` are ordinary streams; a 2026-07-28
     `GET`/`DELETE` gets the device's 405. Sessions (`Mcp-Session-Id`) live
     only on the device and survive tunnel reconnects; open GET streams do
     not.
   - PRM and `register` requests are served by the relay itself and never
     forwarded.

8. **Flow control and backpressure** (credit-based, as HTTP/2; needed
   because a WebSocket gives no per-request backpressure and Node's
   built-in client cannot pause reading).
   - Each direction has a **connection window** (initial 8 MiB) and a
     **stream window** per stream (initial 1 MiB). Only `DATA` payload bytes
     count. A sender never sends beyond either window; exceeding one is a
     connection error `flow_control_error`.
   - The receiver returns credit with `WINDOW` (stream 0 = connection) as it
     **delivers** bytes onward (relay: written to the client socket without
     exceeding its write high-water mark; device: consumed by the HTTP
     pipeline). Increments are 1…2³¹−1; a window above 2³¹−1 is an error.
   - **Slow client.** The relay stops returning credit for that stream; the
     device's response writes then block (Node stream backpressure into the
     MCP transport); other streams continue. If a stream has data pending
     and zero credit for 60 s, the relay resets it (`client_stalled`).
     Waiting for an approval is not a stall (no data pending).
   - Memory at the relay per tunnel is bounded by the connection window it
     grants; at the device by its windows plus `maxRequestBytes`.

9. **Liveness, reconnect, draining.**
   - **Keep-alive:** each side sends `PING` after 20 s without sending any
     frame; the peer answers `PONG` immediately. A side that has received no
     frame for 60 s considers the tunnel dead and closes it (WebSocket close
     1006/4400 as applicable). WebSocket-level ping/pong may also occur and
     do not replace this rule.
   - **Reconnect (device):** exponential backoff with full jitter, base 1 s,
     cap 60 s, reset after a tunnel stayed `READY` for 60 s; immediate
     attempt on network change and wake (WP-30); honour `retryAfterMs` of a
     `GOAWAY` and of close 4429; after 4401/4403/4426 retry at most hourly
     and on a state change (re-pair, update, entitlement), showing the
     reason in `crot_status` and the tray.
   - **One tunnel per device.** A new authenticated tunnel for a device
     replaces the old one: the relay sends `GOAWAY` (`superseded`) on the old
     tunnel and routes new streams to the new one; the old tunnel's
     in-flight streams continue until they end or the drain limit. Frequent
     supersession (more than 10 per hour) is reported to the device as close
     4409 and logged (possible cloned key, open question 4).
   - **`GOAWAY`** (`lastStream`, `code`): the sender accepts no stream above
     `lastStream`; streams up to it continue for at most **60 s** (drain
     limit), then are reset (`shutting_down`). Codes: `shutting_down`
     (relay deploy, device service stop), `superseded`, `remote_disabled`,
     `unpaired`, `protocol_error`. The device sends `GOAWAY`
     (`remote_disabled`/`unpaired`) when the user turns remote mode off or
     unpairs and then aborts its remote requests (AD-19), and closes 1000.
   - **No resumption.** Streams never survive a tunnel connection; nothing is
     replayed after reconnect.

10. **Versioning and compatibility.**
    - **Major version** = subprotocol `crot-tunnel.v<N>` (v1 here). The device
      offers every major it implements; the relay selects the highest it
      supports. A change that an old peer could misread (frame layout,
      semantics of an existing frame/code, limits that would be exceeded) is
      a new major. A relay that supports none of the offered majors accepts
      the upgrade, sends no frame and closes with **4426** and reason
      `unsupported_version;supported=v1[,v2]` (a WebSocket client cannot read
      a refused upgrade's body); the device then reports "update required"
      and retries per point 9. To let standard clients see that close, the
      relay's `101` response then names the **highest
      `crot-tunnel.v<N>` the device offered** in `Sec-WebSocket-Protocol`:
      WebSocket clients (the WHATWG API, Node's built-in client) fail an
      upgrade that selects none of the requested subprotocols before any
      close frame can be read. On such a connection the selected
      subprotocol means nothing; the device acts on the close code only.
      If the device offered no `crot-tunnel.v<N>` at all, the `101` names no
      subprotocol and the relay closes with 4426 the same way.
    - **Minor additions** are negotiated `features` (strings in `HELLO`
      ∩ `READY`): new optional JSON members, extension frame types
      0x80–0xFF, new `RESET`/`GOAWAY` codes that the peer may treat as
      `internal_error`. Unknown features are ignored.
    - **Support window:** the relay supports every major used by a device
      release for at least **12 months** after the first device release with
      its successor, and at least the current and the previous major; the
      relay is deployed before devices start offering a new major. Updates
      themselves are WP-34.
    - The MCP protocol versions (AD-15 point 3) are independent of the tunnel
      version: the relay forwards whatever the device serves.

11. **Size limits and large results.**

    | Limit (v1) | Value | Enforced by | Reason |
    | --- | --- | --- | --- |
    | Request body | 4 MiB | relay (413 before forwarding, `not_executed`), device (`maxRequestBytes`) | equals the device default; a larger device setting does not raise the remote limit |
    | Request header block | 64 KiB | relay (431), device (connection error if a frame exceeds it) | one frame |
    | Response body per stream | **32 MiB** total (JSON or all SSE events) | device (below), relay (reset `response_too_large`) | 16 MiB screenshot ≈ 21.4 MiB base64 + JSON; 10 MiB file read ≈ 13.4 MiB; output 2 × 1 MiB |
    | Frame payload | 64 KiB | both | interleaving, fairness |

    - **Oversize result:** the device does not stream a response that would
      exceed 32 MiB. For a tool result that would, the device returns
      instead, for the same JSON-RPC id, an error result stating that the
      operation **completed** but its result exceeds the relay limit
      (`crot: "RESULT_TOO_LARGE"`, `limit`), so the outcome is explicit.
      Where the device can no longer do that (stream already past the
      limit), it resets with `response_too_large` and the outcome is
      `unknown` (point 13). Preferred place: the device's MCP result layer
      for `transport: "relay"` (WP-30 decides the code location).
    - **Large data never as one unbounded payload.** Data larger than the
      limits is read in bounded pieces through existing tools (e.g.
      `fs_read_file` with `offset`/`length`) or stays on the device as files
      and later artifacts (OD-15/OD-17). Media files, uploads to external
      services and downloads are never relayed through the tunnel in v1. An
      out-of-band transfer channel is not part of v1 and would need its own
      AD.

12. **Timeouts (decides OD-5 and §26 question 13).**
    - **Exchange deadline:** the relay ends every exchange at most
      **15 minutes** after admission (relay configuration, ≥ 60 s; the value
      is sent as `deadlineMs` in `OPEN`, so it can change without a protocol
      version). The device aborts the request's signal at `deadlineMs`
      − 5 s (the existing AD-15 point 7 path) and resets the stream
      (`deadline_exceeded`). The relay answers 504 if no response head was
      sent, else ends the client stream.
    - This covers an approval wait (≤ 300 s), browser waits (≤ 60 s + margin)
      and the default command timeout (120 s). Work longer than the deadline
      uses `process_start` / `process_read_output` in v1 and jobs later
      (OD-15); a remote `process_exec` with a longer timeout is cut at the
      deadline (the command keeps running to its own timeout, its result is
      discarded).
    - **No per-stream idle timeout** in the tunnel (an approval wait sends no
      bytes). The relay's client-facing listener and any load balancer in
      front of it must allow idle client connections for at least the
      deadline (operational requirement of WP-29).
    - **Clients with shorter timeouts:** CROT does not extend them. When such
      a client gives up, it closes the request; the cancellation of point 13
      applies (a pending approval is cancelled and disappears from the
      tray, audited as cancelled). Neither the relay nor the device injects
      keep-alive bytes or progress notifications into responses in v1.
      Measured client timeouts are documented by WP-32.
    - **OD-5 resolution (WP-30).** The device tunnel ends the local
      request 5 s before the exchange deadline (`deadlineMs` − 5 s) and
      resets the stream with `deadline_exceeded`; the relay reports the
      outcome as `unknown`. Long approval waits and bounded browser waits
      run inside the deadline; nothing is retried automatically. The
      actual timeouts of remote MCP clients are measured in WP-32 (open
      question 5), which may revisit the 5 s margin.
    - The deadline also bounds a request body the relay must receive
      before forwarding (a body without `Content-Length` is received
      completely, so the 4 MiB limit is enforced before anything reaches
      the device): not complete in time → 408, `not_executed` (point 13).
    - Handshake 10 s (point 3); liveness 20/60 s (point 9); drain 60 s.

13. **Cancellation, outcomes, retries.**
    - **Client → device.** When the client's HTTP request ends before the
      response completed (connection closed, HTTP/2 `RST_STREAM`, client
      timeout), the relay sends `RESET` (`cancel`). The device ends the
      stream's request exactly as a closed loopback HTTP connection ends it,
      so the request's `AbortSignal` fires (AD-15 point 7): a pending
      approval is cancelled; an approved operation that has not started is
      not executed; a **running** operation is not interrupted in v1 (fact
      above), finishes or times out by itself, is audited with its real
      outcome, and its result is discarded. A legacy
      `notifications/cancelled` is an ordinary request on its own stream.
    - **Cancel after completion:** a `RESET` for a stream that already ended,
      or whose response the device already completed (point 6), is ignored;
      the operation's result and audit stand.
    - **Tunnel loss** (either side, any reason): every open stream is treated
      as cancelled on the device (same path) and as failed at the relay.
    - **Outcome reported to the client** by the relay for exchanges that do
      not end with a complete device response — HTTP status, header
      `CROT-Request-Outcome` and a JSON-RPC error body with `id: null`
      (the relay does not parse the request):

      | Situation | Status | `CROT-Request-Outcome` |
      | --- | --- | --- |
      | refused before forwarding (offline, remote off, busy, too large, not entitled, request body not received within the deadline) | 503 / 413 / 403 / 408 | `not_executed` |
      | device `RESET` `refused` (device guarantees the request did not reach MCP dispatch) | 503 + `Retry-After` | `not_executed` |
      | tunnel lost, device reset (`cancel` excluded), deadline, `response_too_large`, any reset after `OPEN` was delivered, before a response head | 502 / 504 | `unknown` |
      | the same after a response head was sent | client stream aborted (HTTP/1.1 connection closed without the final chunk; HTTP/2 `RST_STREAM`) | — (incomplete = unknown) |

      `unknown` means the device may or may not have executed the
      operation; it is never reported as success or failure. The device
      logs `(tunnelId, stream, requestId, code)` without payload, so the
      user can correlate it with the audit record of the operation (AD-15
      point 7 `requestId`).
    - **No automatic retries** by the relay or the device (the relay cannot
      know whether a request has effects). **No exactly-once guarantee**
      and no de-duplication in v1. A client may safely repeat: anything with
      outcome `not_executed`; tools with `readOnlyHint: true`. Anything else
      with outcome `unknown` should be checked with read-only tools (e.g.
      `fs_stat`, `git_status`, `process_list`) before repeating. Idempotency
      keys for effect operations are a later decision (OD-15/OD-19).
    - `RESET` codes: `cancel`, `refused`, `deadline_exceeded`,
      `response_too_large`, `client_stalled`, `shutting_down`,
      `device_terminated` (the device ended the request, e.g. revocation or
      remote mode off, AD-19), `protocol_error`, `internal_error`.

14. **Validation and safe reactions.**

    | Event | Reaction |
    | --- | --- |
    | TLS/hostname failure (device) | no tunnel; reason in `crot_status`; backoff |
    | `relayHost` in `CHALLENGE` ≠ pinned host | close 4400, no proof produced |
    | bad proof, unregistered device | close 4401; device: retry hourly, show "re-pair" |
    | not entitled / blocked | close 4403 |
    | no common major version | close 4426 (point 10) |
    | handshake not finished in 10 s | close 4408 |
    | malformed frame, frame too large, unknown type < 0x80, wrong direction, reserved flags, invalid JSON on stream 0, bad `WINDOW`/`PING`/`PONG` size, id order violation, flow-control violation, text message | connection error: `GOAWAY` (`protocol_error`), close 4400; all streams reset; device aborts their requests |
    | invalid `OPEN` content (bad JSON, header list, limits) | `RESET` `protocol_error` for that stream; nothing reaches the pipeline |
    | invalid `RESPONSE` content (bad JSON, header list, status) | relay: `RESET` `protocol_error` for that stream; the exchange's outcome is `unknown` (502) |
    | rate limit at handshake | close 4429 with `retryAfterMs` in the reason; counted per device only for handshakes with a valid proof (a failed proof is 4401 and never uses up the device's allowance — the device id is public) |
    | relay deploy / device service stop | `GOAWAY` `shutting_down`, drain ≤ 60 s |

    Close reasons and log lines never contain tokens, headers, bodies or
    paths.

15. **Security invariants.**
    - The relay **cannot execute**: there is no frame that names a tool,
      capability, permission, approval or configuration; it can only open a
      stream that the device treats like any HTTP request from the
      internet. A malicious relay can drop, delay or replay bytes; replay of
      a captured request is limited by the client token's lifetime and
      binding (AD-21) and has the same effect as a client resending it —
      the accepted residual of AD-13 point 6.
    - **Device authority unchanged:** every stream passes AD-15 point 2 and
      point 9 (verification, admission, principal, exposure, ExecutionGuard,
      PermissionEngine, approvals, L1 or its refusal, audit). Nothing in a
      frame is a source of identity; relay-added headers do not exist, and
      the device ignores identity headers anyway (AD-21 point 8).
    - **Secrets:** the device sends the relay only its device id, the proof,
      its version and limits, and the HTTP responses its pipeline produced.
      The device key, the local token, the CROT secrets, external-service
      credentials, audit records and status never travel over the tunnel;
      the pairing token is sent once to `register` (point 4), never over the
      tunnel. The relay sees client requests and responses in transit
      (AD-13 point 6) and must not log or store bodies or headers other than
      method, `Mcp-Method`, status, sizes, durations and codes (AD-15
      point 10).
    - **No weakening of the device:** command confinement, the HTTP pipeline
      checks (except the two replaced in point 7), limits and approvals are
      unchanged. The tunnel adapter opens no port.

16. **Room for progress and jobs (OD-15), without defining them.**
    - Requests and results need not share one long connection: a job start
      and its later status/result calls are separate short exchanges, each
      within the deadline; the tunnel needs no change for that.
    - Progress notifications, if added later, are SSE events in a response
      stream; the tunnel already streams them unchanged and has no idle
      timeout that would drop a quiet stream.
    - Cancellation has defined semantics (point 13); a future job cancel is
      a separate request, not a tunnel feature.
    - Larger transfers or new frame types are added only through a
      negotiated feature or a new major (point 10) and their own AD.

17. **Constraints on the implementation (WP-29, WP-30).**
    - T1: WP-29 implements points 2–3 and 5–15 relay side; WP-30 implements
      them device side, plus registration at pairing (point 4) — a change
      of the WP-28 pairing flow within AD-21.
    - T2: The device adapter reuses the HTTP pipeline (AD-15 C4); the only
      pipeline changes are the two checks replaced in point 7.
    - T3: No new runtime dependency on the device is required on Node ≥ 22
      (built-in WebSocket client); whether the packaged runtime meets this
      is WP-30/WP-34. The relay's stack is free (WP-29).
    - T4: Tests (in addition to AD-15 C8 over a real tunnel): handshake
      (bad proof, wrong relay host, unknown device, version mismatch 4426,
      timeout); framing errors of point 14; stream limit → 503
      `not_executed`; flow control (slow client does not block other
      streams; window violation); keep-alive loss → reconnect; supersession;
      `GOAWAY` drain; 32 MiB limit with the explicit `RESULT_TOO_LARGE`
      outcome and a 16 MiB screenshot passing; 4 MiB request limit;
      cancellation of a pending approval through the relay; cancel after
      completion; tunnel drop mid-request → `unknown`; deadline → 504 /
      reset; no payload or token in relay or device logs; remote off and
      unpair close the tunnel with `GOAWAY`.

**Alternatives considered.**

- *Reverse HTTP/2 over a raw TLS connection* (the device dials, then serves
  HTTP/2; standard multiplexing, flow control, `RST_STREAM`, `GOAWAY`).
  Best semantics, but needs TCP pass-through or a custom ALPN at the relay's
  edge, which common HTTPS load balancers and corporate proxies do not
  offer. Rejected for v1; a later major could adopt it.
- *gRPC bidirectional streaming.* Same edge problem (end-to-end HTTP/2),
  plus a new dependency and schema tooling on the device.
- *HTTP/3 / WebTransport.* UDP is often blocked; immature server and Node
  support.
- *A new WebSocket per request* (control channel + dial-back). No custom
  multiplexing, but a TLS and proof round-trip per request and many
  connections per device; cancellation is simpler, everything else worse.
- *Long polling* (device fetches requests, posts responses). Latency,
  awkward streaming and cancellation.
- *MCP-aware relay* (terminates MCP, sends JSON-RPC messages). Contradicts
  AD-15 point 10 and C7.
- *Relay retries / idempotency layer.* Impossible without parsing bodies;
  would turn the relay into a protocol participant.
- *Longer exchange deadline (≥ 1 h, to match `maxCommandTimeoutMs`).*
  Keeps relay resources and load-balancer idle limits tied up for the rare
  long foreground command; background processes already exist.

**Consequences.**

- WP-29 and WP-30 have one shared, versioned contract; the relay stays a
  router with bounded memory per tunnel.
- Remote results are bounded at 32 MiB per exchange; larger data needs
  chunked reads now and artifacts later.
- Remote foreground work is bounded at 15 minutes per exchange.
- Lost responses are reported as `unknown`, not guessed; effect operations
  are not de-duplicated in v1.
- Cancelling a running operation does not stop it in v1 (Core behaviour;
  WP-30's acceptance is limited accordingly).

**Open questions (need research or another decision).**

1. HTTP proxies and TLS-inspecting middleboxes on the device side: the
   built-in WebSocket client does not use system proxy settings. Whether v1
   needs proxy support is decided in WP-30 after a test on typical
   corporate networks.
2. Certificate pinning of the relay (operational risk of pin rotation vs.
   protection against a mis-issued certificate).
3. **Resolved by WP-29:** fresh signed deregistration and durable inactive
   registration compensation (point 4). Account-side management remains WP-36;
   re-pair uses a new id/key under AD-21, not in-place rotation.
4. Detection of a cloned device key beyond supersession counting.
5. Measured request timeouts of the supported clients (WP-32); whether
   progress notifications during approval waits are worth adding later.
6. Interrupting **running** operations on cancellation (Core signal into
   `execute()`), together with job cancel (OD-15).
7. Remote clients that send `Origin` (browser-based clients): the device's
   `allowedOrigins` check applies unchanged; whether relay URIs need a
   different rule is open.
8. Multi-instance relay routing (which instance holds a tunnel) is internal
   to WP-29 and does not change this protocol.

**Scope and limits.**

- Documentation only. It decides roadmap OD-4 and OD-5 and §26 question 13.
  It refines AD-15 points 7 and 10 (cancellation path through the tunnel,
  hop-by-hop headers, the two replaced checks of C4) and uses AD-21 points
  5–7 and the WP-28 device credential unchanged; it adds device
  registration at pairing (point 4) within AD-21.
- It does not decide per-principal permissions: AD-13 point 5 (remote
  workspace mode, full control only as opt-in) cannot be enforced by the
  current single policy per Core; that needs its own decision before WP-31
  (§26 question 25).
- It does not define jobs, artifacts, progress or out-of-band transfers
  (OD-15, OD-17).

**Implementation (WP-29).** **[Implemented]** — relay side (`src/tunnel/`,
`src/cloud-relay/`, `src/bin/crot-cloud-relay.ts`), operator guide
[`docs/RELAY.md`](docs/RELAY.md), criterion evidence
[`docs/design/relay-wp29-completion.md`](docs/design/relay-wp29-completion.md).
Registration/PRM/admission, routing, handshake, framing, streams, credit flow,
liveness/draining, deadlines and explicit outcomes remain unchanged.

- Configurable sliding-window rates: client/device 120/600 requests per minute;
  registration 10 per account/minute, after verified pairing-client authentication.
  Concurrency reserves slots **before** reading unknown-length bodies: defaults
  client 4, device 32, global 64 (device bounded by advertised maxStreams).
  Client fairness also caps at half the tunnel stream budget (minimum 1) and
  half the connection credit in stream windows (4), reserving headroom for peers.
  Request rate excess returns 429, concurrency excess 503; both carry
  `Retry-After: 1` and `CROT-Request-Outcome: not_executed` before tunnel OPEN.
- Source peer-address limits default to 64 TCP connections and 8 pending
  handshakes; the global 256 pending cap remains. Spoofed forwarded headers
  never change source identity. Behind a load balancer this is a shared peer
  quota; deployment must also enforce real source quotas at the edge.
- Rate state is cardinality-bounded (default 10,000 keys per counter), expires
  on reuse and fails closed on exhaustion. Chunked buffering remains 4 MiB
  per admitted exchange with release on abort/finish; admission and credit
  byte counts are observable as aggregates, without identities/payloads.
- Fresh signed deregistration, conditional durable registry deletion, in-flight
  handshake revocation and durable pairing compensation implement point 4.
- Real socket load/regression tests: four unread slow streams from one client
  plus 48 data-bearing exchanges from eight others; credit window and cleanup
  assertions. This is deterministic isolation qualification, not an RSS/capacity
  benchmark or evidence of a deployed production service.
- WP-36 replaced the historical entitlement stub with real AccountService
  admission (AD-34). Later packages remain explicit: single-instance
  file registry/multi-instance WP-39, public staging WP-38 and real-client/timeouts
  WP-32; no CORS/OPTIONS or in-place key replacement is added here.

**Implementation (WP-30).** **[Implemented]** — device side
(`src/service/remote-tunnel.ts`, `src/identity/relay-registration.ts`),
[`docs/DEVICE_TUNNEL.md`](docs/DEVICE_TUNNEL.md). Outbound authenticated tunnel,
unchanged relay entry pipeline, streams/limits/credit, liveness/reconnect,
deadline and cancellation without replay are implemented. WP-29 completion
adds verified pre-registration persistence, recoverable signed compensation
and best-effort unpair deregistration after local revocation/GOAWAY. Measured
remote-client timeouts remain WP-32 (open question 5).

### AD-23. Per-principal permission profile: one PermissionEngine resolves exactly one profile per request; remote principals get a narrowed profile; remote full control is bound to its pairing and persists across restarts (WP-31; decides §26 question 25)

**Context.** Before WP-31 the PermissionEngine held one policy (mode,
grants, untrusted-content preset) per Core, and `authorize` did not look at
the principal. The `principalKinds` matcher exists only in approval rules,
which can add an approval gate but cannot change grants or the mode.
AD-13 point 5 (remote principals get workspace mode; full control only by
explicit per-device opt-in) and AD-19 point 7 could therefore not be
enforced (§26 question 25).

**Decision.**

1. **One engine, one profile per request.** The PermissionEngine stays the
   only authorization mechanism. It holds immutable profiles and resolves
   exactly one per request from facts Core already verifies:
   `principal.kind`, and for `remote` the verified `deviceId` and `accountId`
   (AD-21). No second engine, no new rule language, no approval bypass.
2. **Profile contents.** A profile holds the mode, the grants and the
   untrusted-content preset. Protected paths, secret paths and the network
   policy stay global and apply to every profile.
3. **Local profile.** The configured policy and preset, unchanged by WP-31.
4. **Remote default profile.** Workspace (`sandbox`) mode; grants are the
   capabilities with an explicitly decided remote default
   (`REMOTE_DEFAULT_CAPABILITIES`: every current capability except
   `filesystem.full`) intersected with the configured grants and never include
   `filesystem.full`; untrusted-content protection is always on. It never
   grants more than the local configuration; local `full_control` does not
   widen it. A capability added later is denied to remote principals until
   its remote default is decided.
5. **Presets.** `require-approval` (default) keeps the approval behaviour of
   AD-16. `autonomous-browser` (AD-16 point 17) allows browser control
   without repeated approval; local file uploads, shell, filesystem write,
   Git write, network and Docker Compose stay gated. `off` applies to local
   principals only; remote principals then get `require-approval`.
6. **Remote full control.** Applies only to remote principals whose verified
   `deviceId` and `accountId` equal the binding of the opt-in. The opt-in is
   set only by the user on the control channel (AD-19 point 7) and stored
   with the device id and account of the pairing it was given for. It
   persists across service restarts: at startup it is restored when the
   settings are readable and valid, the device is paired with a usable
   binding, and both ids match the current pairing; otherwise no full
   control applies and the reason is reported. Unpairing ends it; a new
   pairing has a new device id (AD-21 point 5), so an earlier opt-in never
   applies to it. An opt-in stored without a binding (recorded before WP-31)
   does not apply and is reported as needing to be turned on again.
   Granularity is per device, not per client. It never applies to other
   devices or to local principals.
7. **Commands under remote full control.** Remote `shell.execute` always
   needs approval (built-in rule `remote-full-control`, which presets cannot
   remove). Remote `shell` and `process` operations need L1 confinement and
   are refused with `CONFINEMENT_UNAVAILABLE` before admission where it is
   unavailable (AD-20); no mode or preset bypasses this. WP-23b/c remain
   separate work packages.
8. **Uploads.** `autonomous-browser` gates local file uploads by the
   operation `browser.file_upload` (rule `autonomous-browser-upload`). WP-26 implements the actual operation and verifies both upload and download
   end to end in an exposed `autonomous-browser` session: no provider denies
   both; neither executes while approval is pending; matching subject approval
   permits execution. Download remains gated through `filesystem.write`.
9. **Who can change it.** Only the user through the authenticated control
   channel (AD-17, AD-19). No MCP tool, browser page, relay request or tunnel
   frame reaches a setter, and approvals stay with the approval provider for
   the presented subject digest (AD-19).
10. **Applying a change.** The service persists the change, builds a new Core
    with the new profiles and switches only while the current Core is idle
    (AD-19 point 5); exposure is carried over. While busy the change is
    refused with the reason and the previous behaviour stays. If the new Core
    cannot be built, the previous settings are restored and the previous Core
    stays. Stored settings alone never grant full control: it applies only
    while the binding check of point 6 passes.
11. **Fail closed.** Missing, unreadable, malformed or unknown settings, or
    an unusable binding, give the remote default profile with
    `require-approval` and no full control; they never widen access.
12. **Reporting.** `crot_status`, the control overview and the tray show the
    effective preset and its source, the remote profile, the remote mode,
    the opt-in (recorded and in effect, with the reason when not in effect)
    and the restrictions.

**Alternatives rejected.** Two engines selected outside the engine (an
authorization decision outside the engine); approval rules only (cannot
grant full control or change the mode); one Core per principal kind
(duplicates exposure, audit and browser state); the opt-in in the
configuration file (writable by tools); resetting the opt-in at every
restart (worse UX without a stronger guarantee than the binding of
point 6 against the same OS user, see AD-19 residual risk D).

**Residual risk.** AD-19 residual risk D, including direct writes of the
protected state files by an unconfined process of the same OS user.

**Implementation status (documentation reconciliation at e23b7b9).** WP-31
**Done, merged** as PR #21 (`9ce0574`). Points 1–7 and 9–12 are implemented
and covered by tests. Point 8 was subsequently verified by WP-26 production MCP → Core → extension
Chromium tests, including no-provider denial and approval-bound execution.
No numbered decision clause is changed by this status correction.

> **Контекст истории.** AD-24…AD-28 — исторические эксперименты, не production backend. Отрицательные результаты и ограничения ниже сохранены; действующее Windows L1 — AD-30.

### AD-24. Owned noninteractive Win32 desktop for the Windows unique write-filter implementation slice (WP-23c; not OD-6/OD-9 acceptance)

**Context / necessity.** Native source `8e6a01d` traces a unique-SID
WRITE_RESTRICTED Low actor failing in user32.dll initialization before JavaScript
on Windows Node 20 and 22. No filesystem attempt or global write denial was
reached. Adding Everyone/Builtin Users/logon SIDs would change the global write
boundary, and changing an existing user's window-station/desktop ACL would widen
an unrelated resource. Neither is an acceptable compatibility workaround.

**Decision before implementation.** Provision a new random-name noninteractive
window station and desktop with an explicit owner/System/unique-restricting-SID
DACL and Low mandatory label. Only new CROT-owned user objects are changed. A
fixed trusted helper performs its process/thread desktop association in its own
process, never on the Core/service/tray thread and never executing user code.
The actor starts suspended with this explicit desktop; existing restricted-token,
three-handle stdio allowlist, empty Job verification/assignment and resume order
remain in force. User code is never first executed with a weaker token.

The helper accepts only validated host-generated names and SIDs, reports bounded
readiness, and supports only shutdown. It is not an exec/filesystem/permission
broker and is not exposed by RPC. It runs under a host-owned kill-on-close Job;
its failure ends dependent actor runs. All actor trees stop before normal helper
teardown; abrupt helper/host shutdown and repeated teardown require native gates.
The helper restores its own borrowed original station/desktop before closing
owned handles and never closes borrowed handles. No switch of the interactive
input desktop, broad window-station grant, hook permission across accounts,
registry/IFEO change or user security-descriptor change is allowed.

**Scope / qualification.** This authorizes the necessary new user-object trust
boundary for implementation, not a conclusion that user32 failure is wholly
explained or the Windows L1 mechanism is accepted. Ordinary Node/cmd/WinPS,
normal/hidden and ignored-stdio descendants, owner-only project reads, unrelated
Low writes/ACL mutation, actual protected state/IPC/Docker, lifecycle and a
transparent same-backing filesystem still must pass through the production
interfaces. No available=true registration or weaker retry is allowed before
all mandatory properties qualify. OD-6/OD-9, Windows 11 standard-user and native
ARM64 qualification remain open; no v1 platform target is removed. Filesystem
view/driver selection is not made by this decision.

**Implementation status.** In progress, native qualification pending. Existing
ExecutionGuard/PermissionEngine, exposure, full-control/local semantics,
Linux/macOS confinement and WP-25/26/27 are unchanged.

AD-24 helper containment clarification: the fixed helper itself uses the owned
native suspended launch/explicit handle allowlist and verified fresh Job path,
not the general host launcher's post-start assignment/fallback. Its duplicate
source token uses the existing mic-only construction without Low lowering;
only the fixed helper module is executed at source integrity, never actor code.
The actor still uses the unique write-only Low token. No missing helper Job or
helper setup failure retries through an uncontained host process. Cleanup
failures retain owners for retry rather than falsely claiming release.

AD-24 owned-console clarification (decision before implementation): the fixed
production cmd UTF-8 provider requires a console for chcp, while the native
NO_WINDOW path has none. Actor processes on the already verified NEW private,
noninteractive desktop may therefore receive a NEW hidden console at restricted
creation, before ResumeThread and after verified Job assignment. The explicit
three-handle stdio allowlist remains; no host console attach, host desktop ACL
change, visible/input-desktop switch or weaker token retry is permitted. Console
objects use the actor token's private default descriptor; no console handles
from CROT are passed. Without an owned desktop this mode is rejected. Read-back
of kernel owner/DACL/Low label precedes readiness. Ordinary console/shell and
normal/hidden/ignored-stdio descendants still require native proof, not an
assumption that console allocation fixes other loader failures.

### AD-25. Owned Base Named Object isolation prefix for the Windows strong-token implementation slice (WP-23c; qualification required)

**Decision before code.** Ordinary runtime initialization needs process-local
Win32 named objects. The unique WRITE_RESTRICTED Low token must not gain a
common/logon restricting SID or rights to the ambient BaseNamedObjects namespace.
Use the native BNO-isolation process attribute with a new cryptographically
random, CROT-generated prefix, only through the existing suspended/Job-owned
launcher. The prefix is an internal branded capability, not RPC/CommandSpec
input, a caller-selected object path or a permission policy. No service token,
existing object, device or user workspace descriptor is changed.

The extended-startup attribute is additive to the EXACT existing stdio handle
allowlist. Unsupported attributes or mismatched bounded kernel TokenBnoIsolation
read-back fail the launch before ResumeThread; no retry without isolation and no
extra resume. A child token opened for read-back has explicit ownership and
failed closes block subsequent verification/allocation until cleanup succeeds.
Existing token restrictions, Low integrity, private desktop and empty Job
verification/assignment remain mandatory and unchanged.

**Scope/status.** Implement this component and qualify it with the real ordinary
Node20/22/cmd/WinPS and descendant/global-denial gates; keep the legacy MIC-only
component tests intact. BNO is not transparent filesystem confinement or network
isolation. Kernel directory descriptors, inherited namespace behavior, aliases,
concurrency, resource lifetime and all protected IPC/state boundaries still need
native qualification before production activation. An API description or a
matching token prefix is not that acceptance. No kernel namespace ACL is weakened
as a compatibility fallback. This decision adds no broker/permission system.

**Implementation status:** in progress. Production CommandConfinement remains
none/not_implemented, remote launch fail-closed, OD-6/OD-9 OPEN, PR27 Draft/open.
Windows ARM64/Windows11/standard-user qualification and every eight-criterion
acceptance requirement remain independent and mandatory.

### AD-26. Windows CROT-owned service state: owner-only DACL and Medium no-read-up label before content

**Decision before implementation.** Bootstrap must not create service credentials
with an inherited-ACL provider and later treat NativeHost's owner-only DACL as
protection from the same-user Low actor. For actual Windows service/shim/secret
operations use a dedicated private-file provider: protected owner-only DACL and
Medium NW+NR mandatory label, installed and kernel-read-back verified on empty
new files before content. Missing native support/failed verification is an error,
never an inherited-ACL downgrade. POSIX behavior and the generic platform provider
are unchanged; no activation of Windows CommandConfinement follows.

Only files explicitly owned/used as CROT state and newly CROT-created private
directories are provisioned. Existing arbitrary directories are NOT relabeled or
recursively rewritten. Exact known old state files are hardened before service
secret initialization; no recursive scan of user files or external config path.
Handle-relative no-reparse ancestor pinning and file-type/single-link validation
precede mutation; handles remain pinned through set/read-back. No caller handle,
remote path authority, ambient device/namespace ACL or user workspace SD changes.
Failed native releases retain exact owners and block allocation until cleanup.

The service's Core audit/bridge/state writers must use the same trusted provider
rather than silently switch back to weaker private-file protection. This changes
private-state provisioning, not ExecutionGuard/PermissionEngine, permissions,
exposure or local/full-control semantics. Same-user Medium owner controls remain
usable. Low service/shim execution or an unsupported state storage layout must
fail explicitly, not expose credentials.

**Qualification/status:** implementation in progress. Native actual-service
fixtures need trusted reads/control followed by ready-actor read/write/control
attempts; no canary/credential bytes in evidence. Existing-file migration, atomic
write failure, aliases, resource lifetime and native supported-user/arch matrix
remain mandatory. This does NOT by itself protect every external config path,
Docker/network endpoint or create a transparent workspace. OD-6/OD-9 and WP-23c
acceptance stay OPEN; no production L1 backend registration.


**AD-26 native correction after e0cdb06:** the first actual service gate fails at
parent descriptor encoding and managed-service regressions are explicitly red.
LABEL_SECURITY_INFORMATION is a *query/install* selector. To serialize the
returned descriptor's mandatory-label ACE, request SACL_SECURITY_INFORMATION
in ConvertSecurityDescriptorToStringSecurityDescriptorW (no second SACL query
and no new privilege). Apply the same correction to AD-24 owned-object label
comparison; earlier0x15 serialization did not independently qualify the label.
For an absent parent SACL, verify absence with GetSecurityDescriptorSacl before
using the Windows implicit Medium/NW policy; do not serialize an empty selection
or treat a failed encoding as absence. Target descriptor comparisons always
include DACL+SACL. Native requalification is required; no weaker fallback.

> **Контекст истории.** AD-24…AD-28 — исторические эксперименты, не production backend. Отрицательные результаты и ограничения ниже сохранены; действующее Windows L1 — AD-30.

### AD-27. Native same-backing workspace projection component (WP-23c; not L1 acceptance)

**Decision before code.** Implement an actual Windows filesystem projection,
not more RPC filesystem verbs. The implementation slice uses the signed Dokan
2.3.1 driver and its dynamically linked LGPL-3.0 user-mode DLL, plus a CROT-owned
native host helper. WinFsp's FLOSS/commercial licensing is not silently imposed
on this UNLICENSED repository. No driver is installed by the production service;
installation/version/architecture/signature are explicit provisioning prerequisites.
Native CI qualification may provision the pinned signed installer on its disposable
Windows runner. No test-signing, security disabling, ambient ACL changes or
unsigned driver fallback. ARM64 remains required, independently unqualified.

The helper receives only trusted host configuration once over owned stdin: a
local original root, a NEW CROT-owned mount, owner/restricting SID, the exact
owned Job's query name and fixed protected relative roots. No arbitrary filesystem
RPC, client-chosen host path, external handle or execution verb exists. Read,
write and metadata callbacks are rooted in held no-reparse native directory
handles; original content is read/written directly, never copied/synchronized.
Existing user-file SDs are never installed, relabeled or weakened. Projected
security exists only on the new volume and new CROT-owned mount objects.

A unique restricting SID is not authentication: another same-user process can
construct a restricted token with a chosen SID. Each create must verify the
kernel requestor token, exact owner/Low/unique restriction and a held process's
membership in this exact kill-on-close Job. Compare requestor/process token IDs;
PID reuse or a fabricated SID alone grants nothing. A query-only Job reference
held by the helper is released on shutdown/host-stdin EOF; actor teardown and
helper/volume teardown are one owned run lifetime. Never broaden the existing
actor empty-Job, stdio handle-list or resume gates. No view on unavailable driver,
failed binding/mount/self-test/cleanup; no weaker retry or available=true.

The first slice deliberately rejects streams, reparse points, hard-linked files,
security changes, existing-destination replacement and ambiguous object names.
Backing-file opens are exclusive until close, and parent handles prohibit delete
sharing. These conservative restrictions are NOT the required complete Windows
sharing/atomic-replace/concurrent-alias contract. They must not be papered over
as full ordinary-tool compatibility. The WRITE_RESTRICTED Low actor is retained:
projection does not by itself solve NUL/device/startup or all IPC/network gates.

**Status:** implementation/qualification in progress. Native Node/cmd/WinPS,
host-immediate original content, unchanged SDs, Job/alias/negative/lifetime proof
remain mandatory. This component is not an accepted OD-6/OD-9 selection or a
production CommandConfinement registration. WP-23c and all unfulfilled criteria
remain OPEN; no permission/full-control semantics are changed.

**AD-27 control-plane correction (before enabling any data-write workaround):**
Pinned Dokan2.3.1 sys/init.c DokanSetVolumeSecurity installs DACL only, not
LABEL/SACL from the supplied descriptor. The configured device descriptor is
for the raw disk/control device, not a substitute for projected file security.
Its FSCTL_GET_ACCESS_TOKEN / event-control requests are FILE_ANY_ACCESS and raw
DCB dispatch bypasses CROT's filesystem create callback/Job check. Never infer
an installed Low label from supplied SDDL or lower the raw device label merely
to make writes pass. No original/global/shared device ACL is changed.

Before READY, a fixed native self-test must construct/read back the same unique
WRITE_RESTRICTED Low profile and impersonate it only for zero-access/read-only
opens of this exact newly owned raw disk endpoint. It never requests a token,
consumes/mutates events or targets another mount. Unexpected open success or an
unverifiable result refuses readiness and unmounts; it is a FAILED prerequisite,
not actor-denial or successful filesystem evidence. Restoring the source thread
identity is mandatory; inability to revert terminates the helper fail-closed.
Secure atomic separation of raw control from Low data and concurrent/other-Job
attacks remains a critical acceptance blocker until native proof exists. This
component is not an approved OD-6 mechanism or production confinement backend.

> **Контекст истории.** AD-24…AD-28 — исторические эксперименты, не production backend. Отрицательные результаты и ограничения ниже сохранены; действующее Windows L1 — AD-30.

### AD-28. Zero-fee commercial Windows L1 candidate qualification (WP-23c)

**Decision before code.** Third-party license fees must be $0. Dokan's official
MIT/LGPL components permit commercial use subject to the exact component
obligations; proprietary CROT is not automatically excluded. Distribution needs
license/notices, corresponding library source and LGPL combined-work/relinking,
modification/reverse-engineering and installation-information compliance as
applicable. This is an engineering constraint, not a blanket legal clearance.
WinFsp's paid proprietary route is not selected. No dependencies are relicensed.

Stock signed Dokan remains **unqualified**: AD-27's actual raw zero-access open
succeeds. Network mode is not a security fix: upstream volume network dispatch
forwards to the same disk control dispatcher. Neither a hidden name, device
DACL, supplied-but-uninstalled label nor a user-mode callback authenticates
FILE_ANY_ACCESS control. A driver fix would need atomic controller-open/file
object authentication across every control alias and lifetime, plus separately
qualified production Microsoft signing. An upstream binary signature does not
cover a local fork. No test-signing, Secure Boot disabling, paid license or
unbudgeted signing purchase is authorized.

First qualify a public Windows OS-only containment candidate: zero-capability
AppContainer and LPAC. Add an experimental fixed native child, not a production
actor or alternate backend. Derive a unique package SID using the public
DeriveAppContainerSidFromAppContainerName API; do not register persistent
profiles. Create only a new private executable directory/file, grant that exact
package RX there, never change original workspace/parent/global/device ACLs.
Use public SECURITY_CAPABILITIES and LPAC ALL_APPLICATION_PACKAGES_OPT_OUT
process attributes. Create suspended with an exact owned kill-on-close Job
assigned at creation; read back package SID, zero capabilities, Low IL, LPAC
state and Job membership before resume. No capability/regular-profile fallback.

The child performs harmless zero/read opens on **only our newly owned Dokan
raw endpoint**, through both Win32 GLOBALROOT and absolute NtCreateFile paths.
Owner positive controls establish both paths exist. No IOCTL, token request,
event mutation, arbitrary command, inherited handle or foreign mount access.
A fixed exit signature proves child entry; startup failure, namespace absence,
timeout and cleanup failure are distinct from access denial. Diagnostic output
contains fixed bounded status codes only, not paths/SIDs/secret bytes. The
existing AD-27 mandatory control gate still rejects READY on the old profile;
no experimental result may bypass it or count as filesystem acceptance.

This first experiment deliberately grants **no package access to the device**.
Even denial would NOT prove separation after real data access is granted, tool
compatibility, whole-system network/write isolation or standard-user/ARM64
qualification. Any positive result requires those further mandatory native
gates before mechanism selection. Production remains none/not_implemented,
remote fail-closed, WP-23c and OD-6/OD-9 OPEN; preserve existing PS/RPC gates.

**AD-28 native positive-control correction:** `673edb6` builds both executables
but absolute NtCreateFile with literal zero DesiredAccess fails even for the
owner (`owner-nt-zero`) on both runtimes. That is a failed experiment prerequisite,
not AppContainer denial. Match Win32 CreateFile's minimum metadata access
(FILE_READ_ATTRIBUTES | SYNCHRONIZE, non-directory/overlapped open) in the
absolute-NT probe, explicitly name that result `ntMetadata`, and preserve the
exact bounded failing NTSTATUS when an owner NT control fails. This minimum
handle would still carry FILE_ANY_ACCESS controls; no IOCTL is invoked. Keep
both namespaces' positive controls mandatory and all existing actor gates.

**AD-28 supported-bootstrap amendment (before implementation):** `9faa901`
passes all owner Win32/NT controls and owned executable preparation, but both
profiles fail CreateProcess before child entry. Microsoft's documented public
launch sequence creates a profile for a NEW moniker; DeriveAppContainerSid is
for deriving an existing identity and is not itself profile provisioning.
Replace the profileless experiment with **fresh CreateAppContainerProfile /
DeleteAppContainerProfile ownership**, not a retry with fewer capabilities,
looser LPAC/token/Job checks or an existing/shared profile. Names remain unique
and <=64 characters. ERROR_ALREADY_EXISTS is failure: never adopt/delete it.
Only S_OK grants ownership. Record exact names in a fixed retained owner table
before creation, mark owned only after success; delete only exact owned profiles
after their Jobs settle and all process/token handles close. Failed deletion
retains the owner, blocks fresh allocation, retries at helper teardown and
reports cleanup failure rather than qualified evidence. No original/parent/
global ACL is altered by CROT. Public OS profile APIs create their own new
per-user/per-package objects with the platform's isolation policy.

This amended fixture is disposable hosted-native CI only, not production:
profile cleanup on abrupt helper/host death and durable crash recovery are
**unqualified**. A future backend must implement/verify that ownership/recovery
contract before shipping. Normal API deletion is not crash-lifetime proof.
Native literal-zero NT opens with the correct non-directory options, all data
access grants/aliases and actual runtime/global/network gates also remain
mandatory before any safe mechanism selection; metadata denial alone is not
full control-plane isolation proof. Reference: Microsoft Learn,
`/windows/win32/secauthz/implementing-an-appcontainer` and
`/windows/win32/api/userenv/nf-userenv-createappcontainerprofile`.

**AD-28 LPAC query ABI correction (before code):** `d43f96b` proves the failure
is the generic null/zero-length GetTokenInformation probe for SDK class46
(TokenIsLessPrivilegedAppContainer), ERROR_INVALID_PARAMETER87 on both profiles
and runtimes. Keep the LPAC predicate mandatory. Query its fixed ULONG payload
using the documented user-mode NtQueryInformationToken read-only API on the
already owned TOKEN_QUERY handle, require success and exact returned size, and
verify the same Boolean before resume AND again in the child. Missing export,
unsupported class, wrong length, mismatch or native error remains a failure;
never default to regular AppContainer or infer LPAC from requested attributes.
No NtCreateLowBoxToken/undocumented creation, capability grant or security
policy downgrade is introduced. Reference: Microsoft WDK ZwQueryInformationToken
(user-mode name NtQueryInformationToken), public SDK TOKEN_INFORMATION_CLASS;
ULONG width is4 bytes. This corrects a query ABI, not confinement acceptance.

**AD-28 least-access probe coverage (before code):** metadata access denial is
not proof that an ANY_ACCESS endpoint cannot be opened. Extend the diagnostic
child to separately attempt absolute NtCreateFile with literal DesiredAccess0
and FILE_NON_DIRECTORY_FILE0x40, alongside the existing metadata/read opens.
Report the owner's same literal-zero result separately; unsupported/absent
owner results are not positive controls or denial evidence. Expand the fixed
packet (v2) to carry all five open classifications and NUL without merging
outcomes or losing startup/cleanup stages. Keep the original WRITE_RESTRICTED
Low pre-READY gate and no-IOCTL rule unchanged. All results remain diagnostic,
not a production-availability predicate or proof of untested aliases/data grants.

**AD-28 effective LPAC verification (before code):** `4804e32` proves that the
fixed-size native query also fails with STATUS_INVALID_INFO_CLASS0xc0000003
on both hosted Windows runtimes. The SDK enum alone is not an implemented
query contract on those hosts. Do not infer LPAC from a requested attribute or
silently default to ordinary AppContainer. Replace the unusable prerequisite
with an explicit effective-access predicate using public DuplicateTokenEx and
AccessCheck, before resume and again in the child. In-memory descriptors only:
user-only must deny, user+exact package must allow; user+ALL_APPLICATION_PACKAGES
must allow ordinary AppContainer and deny LPAC, with user+ALL_RESTRICTED_APPLICATION_PACKAGES
allowing LPAC. All checks must successfully execute; inconclusive/error is failure.
This verifies the documented access-check distinction, not the unsupported token
flag query. No descriptor is applied to a real object, and no shared SID is added
to any token or granted on any filesystem/device object. Private duplicated
impersonation tokens are closed; failures remain prerequisites, never denials.
Reference: Microsoft TOKEN_INFORMATION_CLASS LPAC semantics, AccessCheck and
DuplicateTokenEx. Original raw-device gate and all eight criteria remain mandatory.

> **Контекст истории.** AD-29 — история выбора и компонентных этапов. Его старые open/unavailable статусы и первоначальная матрица не заменяют текущую квалификацию AD-30; принятые ограничения не снимаются.

### AD-29 — Windows L1 без сторонних драйверов; решения OD-6 и OD-9

Решение куратора, продолжение после a6eb17d. Изменения границ записаны до кода.
AD-27/AD-28 остаются историей экспериментов, а не выбранным механизмом выпуска.
Dokan/WinFsp не входят в поставку, подготовку хоста, CI или доверенную базу CROT v1.
OD-6 закрыт выбором встроенного **AppContainer без сетевых capabilities + Job Object**
(вариант Б); это выбор механизма, не заявление о завершённой квалификации WP-23c.
LPAC не является неявным fallback: разрешение ALL_APPLICATION_PACKAGES на NUL
не даёт того же доступа LPAC. Недоступность обязательного свойства — отказ до запуска.

**OD-9, матрица целевых платформ v1.** Linux остаётся по AD-20. Windows 11:
x64 и ARM64; Windows Server 2022/2025: x64; Node 20 и 22 на каждой реально
поставляемой комбинации. Microsoft требует x64 для Server 2022/2025: ARM64
Server не объявляется существующей/проверенной платформой. ARM64 Windows 11
обязателен, не вычёркивается из v1. Добавление реально выпущенного ARM64 Server
потребует отдельной квалификации, а не переноса результата x64. Обычный пользователь
и повышенный процесс проверяются независимо. Матрица — обязательство приёмки,
не автоматическое available=true на непроверенных машинах.
macOS: актуальная и две предшествующие основные версии на поставляемых Apple
сочетаниях Intel x64 и Apple Silicon arm64 (на момент решения: 27, 26, 15).
Не обещаем архитектуру, которую Apple не выпускает для конкретной версии.
Механизм WP-23b — Seatbelt, секреты — Keychain по AD-13; решение платформенной
зависимости OD-9 разблокирует начало WP-23b, но не закрывает сам пакет.
Браузерная часть OD-9 остаётся отдельной открытой частью.
Источники: Microsoft Learn `/windows-server/get-started/hardware-requirements`;
Apple Support `/109033`. Фактические версии/архитектуры фиксируются в evidence.

**Токен и запуск.** Новый уникальный AppContainer SID принадлежит одному Core;
профиль создаётся только как новый, чужие/существующие профили не усыновляются.
Нулевые capabilities, фактические AppContainer/SID/IL/Job проверяются до ResumeThread;
Job — без breakaway, с kill-on-close; наследуются только принадлежащие запуску
концы байтовых каналов. Существующие ExecutionGuard/PermissionEngine, Core,
аудит, надзор, stdout/stderr/backpressure и остановка дерева сохраняются.
Факт старта фиксированного C++ child не подменяет запуск Node20/22/cmd/WinPS.
Сетевая политика требует самостоятельной реализации и доказательства: нулевые
capabilities не объявляются выполнением режима network=on.

**Штатный NUL и подготовка хоста.** Явный административный скрипт
`scripts/l1-install-win.ps1` добавляет только GRGW для ALL_APPLICATION_PACKAGES
на `\Device\Null`, сохраняя владельца, существующие ACE и метку целостности.
Это одобренное исключение для пустого устройства, не разрешение на папки,
диски, другие устройства или глобальные namespace. Проверка — чтение/запись
самого NUL из готового AppContainer. Windows может сбрасывать политику при
перезагрузке: проверять при каждом self-test, не обещать бессрочную настройку.
Сервис не повышает свои права, не исправляет хост молча, не меняет ACL NUL на
каждом запуске. Нельзя назначать Everyone/Users, заменять весь DACL либо снижать IL.

**Три дерева записи и срок владения ACE.** Доверенный сервис выдаёт точному
SID Core наследуемое Modify (OI|CI|M) только на выбранный workspace.root,
приватный temp и приватные кэши инструментов. Владелец и существующие права
пользователя сохраняются; менять ACL workspace теперь явно разрешено.
Управляемые ACE — точные отдельные записи с журналом владения/восстановления,
не снимок DACL, который можно слепо вернуть поверх правок пользователя.
На остановке сначала прекращается/дожидается всё дерево Job, затем снимаются
только собственные ACE, включая унаследованные записи. Повторный запуск,
параллельные Core, crash/recovery и частичная ошибка требуют явной модели
владения; сбой очистки не считается успехом. Переходы reparse/hardlink и уже
открытые дескрипторы не закрываются одним наследуемым ACE: они обязательны
в отрицательных тестах. За пределами трёх деревьев нельзя предполагать отсутствие
пакетных или общих AppContainer grants — нужен self-test и доказательство границы.

**Чтение и запись защищённых ресурсов.** Все реальные расположения состояния,
%LOCALAPPDATA%\CROT, %APPDATA%\CROT, secrets, ключ устройства, конфиг,
audit.jsonl, service-settings.json, remote-clients.json и каналы шима/трея
защищаются через PrivateFileProtection: owner-only DACL и явный запрет доступа
для SID AppContainer, установленный до открытия/выдачи данных. Защищённые пути
внутри workspace имеют приоритет над наследуемым разрешением Modify; external
config/audit не забываются. Нужны реальные попытки actor/descendants чтения,
записи, изменения DACL и подключения к управляющим каналам после owner-controls.
Одного отсутствия переменных окружения или токена IPC недостаточно.

**Почему не выбираем вариант А без доказательств.** S-1-5-12 в списке restricting
SIDs расширяет доступ ко всем объектам с соответствующими разрешениями, не только
к NUL. WRITE_RESTRICTED не ограничивает чтение; deny для SID только в restricting
списке нельзя считать запретом чтения без нативного доказательства. Вариант А
не становится production fallback после ошибки AppContainer.

**Приёмка и поставка.** Все три ОС остаются обязательными для v1, без урезания
инструментов разработчика. WP-34 включает явную подготовку Windows L1; Linux
подготовка по AD-20 не меняется. Нельзя объявлять WP-23c выполненным, пока все
восемь критериев не пройдены, включая исходные файлы workspace, среды/stdio/
потомков, CROT-6A, Docker, сеть и полную матрицу. До этого production Windows
остаётся unavailable; remote sandbox отказывает, а PR27 остаётся Draft/open.

**Сопутствующее исправление singleton сервиса.** Для POSIX все попытки bind,
проверка/удаление старого сокета и установка 0600 должны проходить под одним
endpoint-lock. Иначе первичный bind обходит защиту stale-recovery. Конкуренты
не должны получать exit1 из-за окна между созданием/ограничением сокета.
Отдельный коммит и детерминированный regression-test; исторический сбой не
приписывается этой причине без доказательств воспроизведения исходного сбоя.


**Квалификационное уточнение AD-29 после a6eb17d.** На исходном коммите
7596791 оба Windows Node 20/22 получили GENERIC_WRITE по внешнему hardlink на
разрешённый workspace-файл; независимый внешний файл при этом закрыт.
Это не секретная запись, а успешное открытие/закрытие дескриптора с опасным правом.
ACE относится к файловому объекту, а не одному пути. Следовательно, выбор
AppContainer + трёх наследуемых ACE пока не закрывает строгую границу по путям.
Достаточность решения OD-6 требует пересмотра; production остаётся unavailable,
без fallback. Отказ unsafe-workspace до выдачи ACE потребует отдельного решения
о допустимых входных условиях и не подменяет отрицательный runtime-тест.
Нельзя молча отказаться от hardlink/reparse/гонок или разрешить внешнюю запись.
Платформенная часть OD-9 и разблокировка WP-23b остаются в силе.
Текущие коммиты, восемь критериев и полные доказательства:
`docs/design/windows-l1-native-os.md`, `docs/evidence/windows-l1-native-os/`.


**Решение куратора OD-6: продолжение AD-29 без виртуализации (после 6da4386).**
Windows Sandbox, Hyper-V и HCS не являются допустимым backend v1. Остаётся
AppContainer + Job с установленными на хосте инструментами; Windows Home
не исключается из матрицы. Сторонние драйверы по-прежнему запрещены.

**Файлы с внешними жёсткими ссылками.** Сам workspace не отклоняется из-за
наличия hardlink. После выдачи Modify и до запуска actor доверенная подготовка
перечисляет файлы без переходов reparse, проверяет NumberOfLinks и полное
перечисление имён. На общий файловый объект с хотя бы одним внешним именем
добавляется явный запрещающий ACE точному SID песочницы для GENERIC_WRITE,
DELETE, WRITE_DAC, WRITE_OWNER, FILE_WRITE_DATA, FILE_APPEND_DATA,
FILE_WRITE_ATTRIBUTES и FILE_WRITE_EA. Запись через внутреннее имя этого же
объекта также запрещена — это явно одобренное исключение, не отказ workspace.
Обычные файлы остаются доступны. Нужны настоящие runtime-открытия обоих имён,
отрицательное создание внешней ссылки и проверка сохранности исходных байтов.
Политика на момент подготовки сама по себе не доказывает отсутствие гонок:
смена имён/ссылок, открытые дескрипторы, reparse и параллельные изменения
остаются обязательными отдельными проверками до доступности production.

**Только чтение каталогов-предков.** Разрешается точный ненаследуемый ACE
для SID данного Core с маской FILE_TRAVERSE | FILE_READ_ATTRIBUTES |
FILE_READ_EA | FILE_LIST_DIRECTORY | SYNCHRONIZE (0x1000a9), только самому
каталогу. Никаких WRITE/DELETE/WRITE_DAC/WRITE_OWNER, OI/CI либо общих SID.
Защищённые пути CROT не получают такой grant; их deny остаётся приоритетным.
Применять по закреплённым дескрипторам, без распространения изменения по
чужому дереву. Проверять каждый опасный доступ отдельно и отсутствие
наследования в посторонние дочерние объекты. Нехватка прав доверенной службы
не разрешает скрытое повышение привилегий или ослабление DACL.

**Точное восстановление.** До первой модификации сохраняются исходные DACL
и управляющие биты SD, а также идентичность объекта. Снимаются собственные ACE;
чужие конкурентные изменения нельзя затирать снимком. Для изолированной
квалификационной фикстуры разрешена проверенная реставрация исходных байтов
после проверки неизменности всех чужих ACE. Для общих предков необходима
проверка текущего DACL перед обратной записью; несовпадение — ошибка, а не
успешная очистка. Владелец, группа и SACL/IL не меняются. API, автоматически
распространяющий ACE, не применяется к предкам: SetSecurityInfo на handle,
открытом MAXIMUM_ALLOWED, документированно не распространяет ACE потомкам.
Сначала остановить всё дерево Job, затем удалить deny/allow и восстановить
контрольные биты; проверить результат чтением SD, не только return-code.

**Порядок подключения.** Сначала доказать эти три исправления на Windows
Node 20/22; затем полный CROT-6A настоящего сервиса: пять чтений, пять записей
и отказ управляющего IPC. Только после проверки остальных критериев, сети,
Docker, жизненного цикла и матрицы разрешена регистрация доступного
CommandConfinement. Успешная SDK-фикстура не включает production сама по себе.


**Уточнение реализации после нативной проверки 932be34.** MAXIMUM_ALLOWED
запрашивает DELETE и конфликтует с существующими дескрипторами корня тома
(ERROR_SHARING_VIOLATION). Нельзя обходить это распространением ACL по диску.
Для ненаследуемых grants допускается документированный непередающий
SetFileSecurityW, несмотря на obsolete-статус API: нужны минимальные права
READ_CONTROL/WRITE_DAC и закреплённые объекты. Точное обратное применение
исходного DACL/control допускается тем же handle-based SetKernelObjectSecurity,
который уже используется PrivateFileProtection; это узкое восстановление,
не изменение владельца, SACL, метки либо выдача дополнительных прав.
Microsoft не рекомендует этот API для файлов; поэтому обязательны точное
чтение результата, проверка чужих ACE до восстановления и отдельная нативная
квалификация. До доказательства cleanup не считается успешным.

Одобренная куратором альтернатива для внешне связанных файлов: защищённый
DACL без наследуемого Modify песочницы, с явным запретом конкретных пишущих
битов и ненаследуемым чтением точному package SID. GENERIC_WRITE-запрос
содержит эти пишущие биты после отображения; READ_CONTROL/SYNCHRONIZE
сами по себе запрещать не нужно, иначе ломается обычное чтение. Владельческие
права сохраняются, внутреннее и внешнее имена закрыты на запись одновременно.
Это всё ещё требует нативного доказательства и не закрывает гонки автоматически.


**Уточнение снимков по разрешению куратора и проверке bc9a1c0.** Для точного
сравнения обе стороны читают одинаковые OWNER/GROUP/DACL/LABEL секции; исходный
снимок получают до открытия объекта на изменение. Входной запрос восстановления
AUTO_INHERITED включает AUTO_INHERIT_REQ, но успех определяется независимым
чтением исходного DACL/control, а не кодом API. Ненаследуемые изменения предков
в текущей квалификационной реализации выполняются прямой handle-based записью;
владелец, группа и SACL не переписываются. На обоих Node достигнуто только 8/10,
потому производственная доступность по-прежнему запрещена. Для hardlink
принадлежность дереву сравнивают по идентичности каталога (том и file index),
не отождествляя разные регистрозависимые каталоги строковым case-folding.
Полная матрица регистрозависимых путей и все гонки требуют отдельной проверки.


**Проверенное уточнение очистки и реального сервиса: abe8e40 / 595ea79.**
После разрешения куратора очистка workspace удаляет только ACE свежего SID
на узлах с сохранённым снимком или фактически присутствующим SID; чужие ACE
сверяются с фактически установленным состоянием. Исходные снимки восстанавливаются
по handles напрямую, без повторного распространения наследования. Для приватных
temp/cache рекурсивная перезапись запрещена, восстанавливаются корневые grants.
На обоих Node20/22 получены независимые исходные SD 10/10 и cleanup=true.
595ea79 проверяет настоящий CrotService с owner-only PrivateFileProtection:
пять чтений, пять записей и настоящий управляющий канал под AppContainer
получают EPERM; состояние неизменно, владелец сохраняет аутентифицированный доступ.
Это не регистрация производственного CommandConfinement. Текущий контроллер
ещё требует квалификации переименования существовавших узлов, полной матрицы ОС,
обычного пользователя, гонок, сети/Docker и восстановления после аварии.
Готовность и production availability не объявляются при этих открытых вопросах.
Доказательства: docs/evidence/windows-l1-workspace-service/.


**Квалифицированное уточнение обычных узлов workspace: bd96740 / a36a701.**
FILE_SHARE_DELETE разрешён только обычным внутренним узлам без внешних hardlink;
корень, предки, CROT-protected пути и внешне связанные файлы сохраняют отдельный
read/list guard без DELETE sharing на весь срок аренды. Метаданные сами по себе
не обеспечивали эффективного запрета подмены; это исправлено в 5d4791d.
Контроль на Windows Node20/22 даёт пять фактических ERROR_SHARING_VIOLATION.
NTFS не позволяет переименовать каталог с открытым дочерним файлом даже при
DELETE sharing: конечные owner-контроли без изменения ACL доказывают отказ=5
при открытом файле и успех=0 после его закрытия. Поэтому только обычные single-link
файлы хранят исходный снимок и файловую идентичность без живого file handle на время
акторов. После полного Job drain они открываются через OpenFileById по исходному
NTFS ID, не по старому пути. Проверяются том, file index, тип, время создания;
новый handle принимается только после этих проверок. Несовпадение, отсутствие
объекта или изменение чужих ACE/control означает отказ очистки, не перезапись
подменённого объекта. Владельца/группу/SACL не переписывают. Обычные каталоги
остаются открытыми с DELETE sharing; защищённые объекты никогда не переходят
на этот режим. temp/cache не подвергаются рекурсивной перезаписи ACL.
На обоих Node: запись и переименование существовавшего файла и его каталога,
исходные SD 13/13, cleanup=true и настоящий CROT-6A 5+5+канал EPERM.
394c1e8 добавляет реальный выбранный AppContainer-компонент NativeProcessLauncher,
но не регистрирует весь CommandConfinement: обязательный тест detached-потомка
не получает возврат из синхронного spawn. a36a701 сохраняет конечные pipe-контроли
и строгий неуспешный гейт, не расширяя ACL общего пространства каналов.
На Node20/22 создание обычного и libuv pipe namespace возвращает Win32=5 даже
с явным DACL собственного нового экземпляра; LOCAL создаётся/закрывается с кодом 0.
Изменение частного DACL не решает этот namespace-конфликт. Безопасное частное
пространство имён для неизменённых инструментов требует отдельного доказательства.
Вложенные multi-link деревья, все гонки, аварийная очистка, полная матрица,
сеть/Docker и производственная интеграция остаются открытыми. Нулевые capabilities
не объявляются network=on; общего обхода защиты или виртуализации нет.
Доказательства: docs/evidence/windows-l1-internal-rename/; восемь критериев:
docs/design/windows-l1-curator-appcontainer.md. WP-23c не принят; PR27 Draft.

**Продолжение AD-29 после 3f094a1: разрешённая квалификация NPFS.**
ProcessDeviceMap и его привилегированный NtSetInformationProcess исключены из
пути запуска; проверка токена до ResumeThread и доказанная очистка при
прерывании до ResumeThread сохраняются. По разрешению куратора сначала
проверяется ненаследуемый ACE только свежего package SID на корне NPFS с
маской FILE_CREATE_PIPE_INSTANCE | FILE_READ_ATTRIBUTES | SYNCHRONIZE
(0x00100084), без FILE_READ_DATA/FILE_WRITE_DATA. Это эксперимент, не
производственная доступность. Чужие DACL каналов, deny CROT, Job и capabilities
не ослабляются. Если NPFS отвергает не-LOCAL имена независимо от DACL,
следующий разрешённый вариант — пользовательское перенаправление только
префиксов libuv в LOCAL. Граница безопасности остаётся в ядре.

**Продолжение AD-29: вариант А.2 после d7436af, одобрено куратором.**
Обращения к DACL корня NPFS исключаются. Пользовательская DLL совместимости
перехватывает ANSI и Unicode CreateNamedPipe/CreateFile и перенаправляет
только `\\?\pipe\uv\` и `\\.\pipe\uv\` в
`\\.\pipe\LOCAL\uv\`; реальные управляющие каналы CROT и docker_engine
не перенаправляются. DLL находится вне workspace в принадлежащем L1 каталоге,
доступном package SID на RX, не на запись. Для загрузки до точки входа и
перехвата Win32 API используются закреплённые исходники Microsoft Detours
v4.0.1 (MIT), без драйверов и виртуализации. Загрузка производится только в
приостановленный, проверенный AppContainer-процесс внутри Job; потомки
получают ту же DLL до возобновления. Ошибка внедрения не допускает обычный
незащищённый запуск. Прослойка — совместимость, не граница безопасности:
ею остаются AppContainer, Job и DACL; обход прослойки актором не расширяет
его права ядра. Никакие успешные прогоны SDK не включают production до
проверки восстановления аренды, сети, Docker и обязательной матрицы.

**Продолжение AD-29: долговечный протокол аренды и восстановление.**
До первой записи ACL доверенный контроллер фиксирует в защищённом, находящемся
вне workspace журнале полную неизменяемую транзакцию: свежий профиль/SID,
идентичности объектов NTFS (том, file ID, время создания), исходные и
запланированные дескрипторы. Намерение создания каждого Job фиксируется до
его создания и до ResumeThread. Запись считается завершённой только после
FlushFileBuffers/fsync. Исключительная блокировка принадлежит дескриптору ОС,
а не PID/возрасту файла; после аварии её можно открыть заново, но нельзя
«украсть» у живого владельца. Контрольные суммы выявляют повреждения, а не
заменяют owner-only DACL и проверку отсутствия reparse/hardlink.

Восстановление сначала доказывает остановку всех акторов, затем открывает
сохранённые объекты по идентичности, удерживает их до завершения проверки
всей транзакции и принимает только исходный либо точно запланированный SD.
Изменённые чужие права, пропавшая/переиспользованная идентичность, повреждённый
или обрезанный журнал — отказ с сохранением журнала, без запуска нового
sandbox и без восстановления по старому pathname. Снимаются только ACE
собственного SID с новых объектов workspace; temp/cache не обходятся этим
проходом. Профиль удаляется последним, после проверки восстановления всех
дескрипторов. Каждый этап повторяем после аварии; журнал закрывается только
после успешного удаления профиля. Нативный адаптер обязан обеспечить эти
проверки, запрет наследования handles и собственную модель свежести профиля.
Сам протокол и его тестовые адаптеры не являются production backend, проверкой
ядра либо основанием для available=true. Регистрация Windows backend остаётся
заблокированной до нативного подключения и всей приёмки AD-29.

**Продолжение AD-29: network=on/off, разрешено куратором 16.10.2026.**
Режим off сохраняет ноль сетевых capabilities и отсутствие loopback-исключения.
Режим on допускает только стандартные SID InternetClient (S-1-15-3-1),
InternetClientServer (S-1-15-3-2), PrivateNetworkClientServer (S-1-15-3-3).
Их точный набор и атрибут SE_GROUP_ENABLED проверяются в приостановленном
токене до ResumeThread; лишний/пропавший SID означает отказ запуска.
Исключение loopback создаётся только для свежего принадлежащего CROT package
SID после долговечной записи сетевого режима в WAL; старый журнал без режима
означает off. Владелец сети удерживает профиль, а живые Job — владельца сети.
После полного drain удаляется только запись этого SID, затем профиль.
При аварии намерение в WAL достаточно для повторяемого удаления записи;
ошибка очистки не допускает closed/новых запусков. Снимок общего списка не
восстанавливается. Системный CheckNetIsolation вызывается по абсолютному пути,
без shell/UAC/повышения прав и только с -a/-d -p=SID; чужие записи до/после
проверяются, неоднозначная конкурентная смена означает отказ, не откат всего
списка. Компонент сети не объявляет production backend готовым; native recovery,
служебный lifecycle, Docker и полный предикат готовности остаются обязательными.
Сетевой on не снимает DACL CROT, не меняет настоящие service/control/Docker pipes,
не раскрывает http-token и не отключает проверку HTTP-аутентификации.

**Продолжение AD-29: положительное доказательство drain и владельца профиля.**
Нативный recovery-компонент перечисляет WTS-процессы всех сеансов, отбирает
SID того же пользователя и проверяет TokenUser/TokenIsAppContainer/точный
AppContainerSid на удержанном process handle. Только совпавший package SID
может быть завершён; токен повторно проверяется на handle завершения.
Неизвестный SID, отказ полной инвентаризации/запроса либо неоднозначный wait —
ошибка. Исчезнувший PID требует нового прохода, а не признания аренды пустой.
Требуются два полных пустых прохода; живой контроллер должен присутствовать
в инвентаре, чтобы пустой/усечённый ответ не стал ложным доказательством.
Все сеансы могут требовать подготовленного административного контекста;
автоматического повышения прав нет. Новые admissions должны быть остановлены
владельцем аренды; до вызова обязательна долговечная квитанция свежего профиля.

In-memory владелец профиля выдаётся только после S_OK создания, закреплён
неподделываемой внутри типового интерфейса ссылкой и неизменяемой identity.
Структурная копия с чужим SID не принимается сетевым/launch-компонентом.
Это не замена durable receipt после аварии, profile-intent протоколу,
самопроверке установки и полной производственной регистрации.
OD-9 Windows part и OD-6 остаются открытыми до такого целостного подключения.

**Продолжение AD-29: Windows host-path boundary медиируемого Docker.**

Общая политика запросов Docker использует отдельный Windows adapter, а не
POSIX isAbsolute/split(':'). Drive-aware Binds, bind/npipe/inspect, local volume
options и Swarm проверяют лексическую и native-resolved границы; context keys
защищены независимо от writable. Неизвестные daemon-to-host отображения
(UNC/device/Volume GUID/WSL/Desktop) отказывают до подтверждения их идентичности.
Разрешение точного собственного LOCAL endpoint не является доказательством
владения каналом: оно обязательно обеспечивается native владельцем и DACL.
Request-policy/Unix mock proxy tests не заменяют нативную квалификацию transport,
защиту прямого docker_engine и аудит сервиса. Полный recovery/service/backend
и поставка остаются открытыми; OD-6 и Windows part OD-9 этим не закрываются.


### AD-30. Производственный Windows L1 — OD-6 и Windows-часть OD-9 закрыты

Квалификация `8fe6ba5`: [CI 11/11](https://github.com/mysteriumpersonae/crot-mcp/actions/runs/39042379906), Windows Server 2025 x64, Node 20/22.

1. Встроенный AppContainer + Job Object + DACL выбран окончательно: без
   виртуализации, сторонних драйверов, ProcessDeviceMap и изменения корня NPFS.
2. LOCAL-прослойка только для libuv, вне workspace; цепочки Node и Job tree kill
   квалифицированы. Настоящие CROT/Docker pipe не переписываются.
3. NTFS ID/WAL/полный preflight/guards сохраняют чужие ACE; workspace остаётся
   настоящим. Многоссылочные файлы read-only. Новые узлы теряют только свой SID.
4. Долговечное владение свежим профилем, actor drain по Job/реальному SID,
   loopback cleanup и profile deletion подключены к CrotService/Core lifecycle.
   Неоднозначные/повреждённые доказательства не удаляются.
5. Секреты/WAL — owner-only Medium/NWNR; компоненты — Medium/NW;
   изменяемый одноразовый runtime — owner-only Low/NW строго в своём корне.
   Метки пользовательского workspace не понижаются.
6. network=off: ноль capabilities/нет loopback; on: три стандартные capabilities
   и только своё временное loopback. HTTP-token/CROT-6A защищены. AD-20.14,
   включая остаточный риск Docker TCP без TLS, сохранён без запрета сети.
7. LOCAL Docker endpoint с owner+lease-SID DACL и фиксированным DOCKER_HOST
   использует общую политику a–d, native host-path guards, HTTP403/audit.
   Неквалифицированные UNC/WSL/daemon mappings не объявляются поддержанными;
   CI проверяет native transport с контролируемым upstream, не real daemon.
8. Проверенная SHA-256 поставка и настоящий self_test обязательны до
   windows-appcontainer/available=true/reason=null в status/overview.
   Missing/mismatch/private-storage/self-test причины стабильны; remote
   UNAVAILABLE и post-admission FAILED не дают неизолированного повтора.
9. Локальный full_control остаётся неограниченным (AD-13, AD-23).
10. Единственное machine-wide владение исключает наложение ACL аренд разных
    сервисов/stateDir. Это явное ограничение, не общесистемный AppContainer ACE.
11. OD-6 закрыт. Windows-часть OD-9: Server2025 x64 Node20/22 квалифицированы;
    Win11/ARM64/Server2022/неподготовленные конфигурации честно unavailable.
    macOS и браузерная часть OD-9 этим не закрываются; упаковка/подпись — WP-34.
12. WP-23c Done. Политика поставки, ошибки, остаточные риски и квалификация
    удаления stale NTFS ID описаны в docs/L1.md; восемь критериев и компактные
    доказательства — docs/design/windows-l1-curator-appcontainer.md и
    docs/evidence/windows-l1-production/qualification.json.

AD-24…AD-29 сохраняются как история исследования; прежние записи unavailable
не отменяют это текущее решение и не объявляются старыми production-прогонами.


### AD-31 — macOS L1: Seatbelt и медиируемый Docker (WP-23b)

**Действующее решение WP-23b.** Нативная квалификация и ограничения —
[macOS report](docs/design/macos-l1-production.md). История отрицательных проб сохранена там;
OD-6/Windows OD-9 и AD-30 этим не пересматриваются.

1. Платформенная цель OD-9 остаётся по AD-29: актуальная и две предшествующие
   основные версии macOS на реально поставляемых Intel x64/Apple Silicon arm64,
   Node 20/22. CI-проверка одной комбинации не квалифицирует отсутствующие.
2. Механизм — встроенный `/usr/bin/sandbox-exec` и фиксированный SBPL Core/Native
   Host. Нет kext, VM, изменения глобальных прав или отката к запуску вне L1.
   Seatbelt API deprecated: отсутствие/изменение семантики даёт unavailable,
   не неявный выбор другого механизма.
3. Разрешено чтение хоста, кроме CROT protected paths, Keychain, Docker endpoint
   и ключей контекстов. Mach IPC — deny-by-default: нет доступа securityd,
   launchservices/launchd для выполнения от имени несандбоксированного сервиса.
4. Запись — только канонический workspace, приватные temp/home/cache аренды
   и минимальные псевдоустройства. Пути канонизуются с разрешением существующих
   родителей, SBPL-строки экранируются; профиль не принимает пользовательский код.
   HOME/temp/cache приватны и эфемерны на время Core, это не APFS overlay и
   не обещание сохранения пользовательских конфигураций/кэшей между сервисами.
5. Потомки наследуют Seatbelt. Прямые setpgid/setsid запрещены, но Darwin
   posix_spawn(SETSID) меняет сессию внутри ядра и обходит такой syscall-фильтр.
   Поэтому остановка не опирается на PPID/группу: отдельная случайная пара
   policy probes команды проверяется ядром через sandbox_check/libproc;
   стартовый self_test проверяет отказ как sandbox_init, так и прямого
   sandbox_apply заранее скомпилированного deny-all профиля: при возможности
   скрыть идентичность готовность не выдаётся. Тотальный запрет __mac_syscall
   отклонён: общий syscall нужен также AMFI/dyld для загрузки @rpath библиотек. Trusted bootstrap не запускает пользовательский код до
   ACK NativeHost после проверки kernel identity. Отдельный доверенный guardian
   вне песочницы получает только приватный, не наследуемый командами канал;
   EOF при SIGKILL владельца запускает тот же drain и очистку приватного temp.
   При остановке владельцы
   замораживаются до устойчивого обхода и завершаются; PID/UID/start-time и
   профиль перепроверяются непосредственно перед сигналом. Это не атомарный
   pidfd: остаточное окно PID reuse не объявляется отсутствующим. Нативные тесты
   detached/reparented потомков и отсутствия воздействий на чужой Core обязательны.
6. network=on разрешает IP internet/LAN/localhost. network=off разрешает только
   loopback (общий сетевой стек хоста, не отдельная сеть песочницы) и собственный
   Unix Docker endpoint. CROT/Docker/агентские Unix-сокеты не разрешаются общим
   сетевым правилом. HTTP-адаптер сохраняет проверку недоступного http-token.
7. Docker — общий проверенный фильтр AD-20.9 a–d, HTTP 403 и аудит отказов;
   upstream-контекст и секреты остаются в сервисе. Прямой endpoint запрещён.
8. Самопроверка обязательна до available=true: чтение канарейки, внешняя запись
   и control IPC запрещены, запись workspace/temp разрешена. До готовности
   remote получает CONFINEMENT_UNAVAILABLE; после допуска ошибка механизма —
   CONFINEMENT_FAILED без fallback. full_control не ограничивается.
9. Завершённость WP-23b и фактическая матрица квалификации записываются только
   после native CI Node20/22. Поставка/подпись, неподтверждённые комбинации и
   остаточные риски не объявляются закрытыми из-за одного merge.

10. Файловый preflight обязателен: до допуска и каждого запуска проверяются
    protected paths и разрешённые корни. Защищённый regular file с nlink>1
    делает границу недоказуемой (self_test_failed до допуска / FAILED после),
    а workspace hardlink с неизвестным/внешним именем получает только чтение.
    Если все имена inode учтены внутри writable-корней, обычные Cargo/git
    артефакты остаются изменяемыми. Смена UID/GID запрещена; runtime владельца,
    Node и зависимостей — только чтение. Нет мутаций пользовательских ACL.
11. Реализация WP-23b Done; решение macOS-части OD-9 закрыто AD-31.
    Подтверждённый native runner: macOS 26.6.2 arm64, Node20/22. macOS15/27 и
    Intel не выдаются за реально пройденные CI: целевая матрица AD-29 сохранена,
    обязательный per-host self_test и predicates не заменяются отметкой о merge.
    Подпись/пакеты WP-34, расширенная release-квалификация и браузерная часть
    OD-9 не закрываются этим пакетом.

macOS loopback при network=off также принадлежит хосту: неаутентифицированный
localhost endpoint выполнения может стать обходным исполнителем вне Seatbelt.
Это остаточный риск модели доступного localhost, а не доступ к CROT без токена;
status.detail предупреждает об общей host IP/loopback authority.


### AD-32 — WP-25: completion of the existing AD-16 browser contract

Implements AD-16 dialogs, file chooser interception, CDP background screenshots and CROT tab groups; no synthetic-input fallback or new agent execution surface. Browser minimum versions: Chrome/Edge/Brave Chromium 120+, on the supported OS matrix (OD-9 browser decision). This target is not a claim that every branded browser/OS combination was manually tested.

A bounded, content-free browser notice may report debugger availability or successful timeout dismissal of a dialog. It cannot request a Core operation, grant permission, contain page text or choose an audit actor. Core validates it, limits its rate, associates the current connection, and records timeout dismissals as browser audit records. This narrowly extends the request/response transport for the audit required by AD-16.9, not for browser-initiated operations. A user-triggered dialog response still passes ExecutionGuard and the existing tab/origin/connection approval binding.

Closing a tab can itself open beforeunload: return `closed:false` and the
pending type, rather than silently confirming or waiting for the transport
timeout. `closed:true` retains its existing meaning. Snapshot of a pending
dialog reports its metadata and empty frames/elements, without querying the
blocked page. This is an additive result clarification of AD-16.9.

Availability is observed, not guessed: status starts `available:false` /
`not_probed`, is true after successful attachment and false /
`debugger_unavailable` after attachment refusal. A status read never attaches
an untargeted tab. `browser_status`, control overview and tray share this fact.
Automated evidence and outstanding headed/branded-browser qualification are
separate in `docs/design/browser-wp25.md`; WP-24 acceptance is not closed here.

### AD-33 — WP-26 / OD-8: response-bound ownership capability, not URL correlation

**Decision before implementation.** Authorized by the curator to amend AD-16
points 3 and 12 without weakening unrelated-download isolation. This selects
the hand-over design. Production implementation and qualification are recorded
below, separately from the initial spike.

1. A capture has one explicit tab and a bounded lifetime. The extension arms
   only that tab and its verified child debugger sessions. Fixed built-in code
   uses response-stage `Fetch.enable`, `Fetch.continueResponse`,
   `Fetch.continueRequest` (unchanged continuation) and `Fetch.disable`.
   These methods are added to the compiled allowlist for this implementation
   only; there is no generic interception/header API for agents or pages.
   Browser/Runtime domains, response-body extraction, request replay and
   profile-wide download behavior remain prohibited.
2. Before continuing an eligible HTTP(S) download response, the extension
   inserts a fresh cryptographically unpredictable, single-use ownership
   capability into its Content-Disposition filename. This is a deliberately
   injected identifier, not a guess from the server's filename. It is bound
   to this command, its connection, frame/session and intercepted request.
   Each response has a distinct capability; no token is reused or sent to the
   server, exposed in agent results or recorded in audit. The original
   disposition, effective filename suffix and browser danger checks must be
   preserved; malformed or unsupported dispositions fail closed rather than
   manufacture a benign extension. Bytes, cookies, redirects, HTTP method and
   POST data are not fetched again or replaced.
3. An item is owned only when both the target-tab CDP download event and the
   downloads filename callback carry that exact capability. Event order may
   differ: the filename callback can be held for the bounded capture deadline.
   URL, order, elapsed time and uniqueness of a URL candidate are never
   ownership evidence. An item without the capability receives an unchanged
   filename suggestion and is never read, renamed, moved, canceled or exposed.
   A second event bearing a consumed capability is an error, not a new owner.
4. Only the proved item may receive Core's unguessable staging destination.
   Its dangerous suffix is preserved also in staging. Core constructs and
   validates the expected location from its own nonce and bounded validated
   metadata; it never opens an arbitrary browser-reported path. Both the exact
   CDP GUID and the exact downloads id must report successful completion and
   the item must be safe before hand-over. Failures, cancellation, timeouts,
   ambiguity or danger never publish bytes into the workspace. Cleanup is
   restricted to the proved item's private staging location.
5. Core retains the existing ExecutionGuard, both required capabilities,
   protected/secret path checks, approval binding and audit policy. Uploads
   use immutable private copies, not workspace source paths. Download publish
   uses verified regular-file descriptors, no-follow/reparse checks, exact
   byte counts, destination-parent revalidation and atomic installation with
   no replacement unless overwrite was authorized. An unsupported platform
   primitive fails closed; lstat alone is not a race-proof open.
6. Capture remains limited to downloads attributable to the selected tab's
   frame tree during the command. No unmarked item is used as a fallback.
   In particular blob/data/browser-internal downloads, a newly opened tab or
   a browser/version that cannot carry the capability are not captured by
   this mechanism and fail without touching their items. This limitation
   must be explicit in tool documentation and negative tests; HTTP(S) click
   and URL triggers must both pass real-browser acceptance.
7. Acceptance includes adversarial event orders, simultaneous identical URL
   and filename downloads in another tab, target OOP frames, redirects,
   disposition parsing/suffix preservation, interrupted/dangerous downloads,
   workspace/path substitution and both real autonomous-browser approval
   gates. A successful isolated spike is not production E2E qualification.

Initial local feasibility witness: Chrome for Testing 153.0.8010.12 on Linux,
headless, isolated throw-away profile, unchanged native download behavior.
A target response was marked via chrome.debugger Fetch.continueResponse; its
capability appeared in Page.downloadWillBegin and onDeterminingFilename.
A concurrent other-tab download of the identical URL and original filename
remained unmarked and received no filename override. This is one witness,
not evidence for the entire browser/OS/version matrix or the full package.


**WP-26 implementation and qualification.** Both production tools now run through
MCP → BrowserService → ExecutionGuard → native bridge → extension. OD-8 is
**Decided (AD-33)**. Upload uses `DOM.setFileInputFiles` by document-bound ref or
intercepted chooser, 1–16 files / 64 MiB total per command; staged copies are
read-only and retained until top-level document replacement, tab close or Core
shutdown. Content-free release notices carry only a Core-issued random token
and are accepted only from the issuing connection. Dead-process leases are
reclaimed on next staging initialization; live processes' leases are untouched.

Download capture is serialized extension-wide, at most 16 queued requests,
20 s default / 60 s maximum absolute deadline, 64 MiB bound. Target HTTP(S)
responses with one supported ASCII Content-Disposition filename are marked;
bytes/session/redirect chain are not replayed. CDP frame/session/GUID and
filename callback must prove the same capability before any override. Both
completion streams and native `danger:safe` are required. Core ACK, failure
and a bounded lost-ACK timer reclaim only the proved item's browser file.
Publication uses a verified regular single-link file, `O_NOFOLLOW`, byte count,
descriptor/handle-relative destination, flush and atomic installation
(no overwrite by default, explicit replacement only). Results/audit omit content, ownership tokens,
private staging paths and browser-suggested download names. Audit paths are
workspace-relative; failures use content-free summaries.

**Native file-transfer host contract (WP-26 cross-platform qualification):**
- Linux: `O_NOFOLLOW`, `fstat/lstat` identity and `/proc/self/fd`-anchored
  destination; fsync + link/rename installs atomically.
- macOS: `O_NOFOLLOW`, `fstat/lstat` identity and `fcntl(F_GETPATH)` verify the
  authorized source and held parent. Native `openat`, `linkat`, `renameat`,
  `unlinkat` operate relative to that descriptor; `/dev/fd` path emulation is
  not used. Parent identity/workspace membership is revalidated before install.
- Windows (64-bit local drive paths): use the existing native private-state
  owner-only DACL/MIC policy, not chmod or inherited-public ACL assertions.
  `CreateFileW(FILE_FLAG_OPEN_REPARSE_POINT)` pins and verifies every ancestor,
  with read/write sharing but **no delete sharing**, preventing ancestor
  replacement/junction redirection. File handles reject reparse/nonregular
  entries and hardlinks, and volume/file index/size match `lstat`. Source
  handles also deny writes while copying. Empty output files receive verified
  private ACLs before bytes; reopened handles must match the created identity.
  `NtSetInformationFile(FileRenameInformation)` installs from the owned open
  temporary handle relative to the pinned destination parent; no pathname
  MoveFile race, no overwrite unless explicitly requested.

`tests/core/browser-files-integration.test.ts` exercises actual BrowserService,
ExecutionGuard and host filesystem with a controlled BrowserConnection; it and
BrowserFiles unit tests run with **no OS skips** through `npm test` in all six
existing `ci.yml` jobs (Linux/macOS/Windows × Node 20/22). This qualifies the
Core file contour, not a real Chromium extension run on Windows/macOS. Browser
≥120 remains the product target, not a claim every branded/version/OS
combination was tested. Core's
owner-only `browser.downloadsDirectory` must match the profile's actual
default directory (default `~/Downloads`). No profile-wide behavior changes.
Unsupported disposition syntax, blob/data/internal sources, new-tab downloads
and newly created/unverified frame sessions never fall back to URL guessing.

Production tests: `tests/core/browser-files.test.ts`,
`tests/core/browser-files-integration.test.ts`,
`extension/test/download-capture.test.ts`, ownership ledger tests and
`tests-e2e/browser/wp26.e2e.test.ts`. Real Chromium covers ref/chooser upload,
lazy reads after source mutation, document/tab cleanup, protected/secret/outside
paths, click/URL downloads, OOP frames, same-URL foreign-first isolation, atomic
publication, overwrite refusal, interrupted cleanup and both actual AD-23.8
approval gates. Unsafe native classification is an explicitly labeled fault
injection on real Chromium plus unit event tests, not malware-scanner
qualification. Package completion does not close WP-24 owner acceptance,
WP-27 multi-agent work, full browser/OS qualification or release gates.

### AD-34 — WP-36: commercial admission, compatibility and diagnostics (OD-11/12/13)

**Approved and implemented in WP-36 (PR #36).** Local/Free is offline,
accountless and unlimited by commercial state. No entitlement enters Core,
ExecutionGuard or PermissionEngine. Only the relay and AccountService enforce
remote admission. Plans: free=0 devices/no remote; trial=14 days/2 devices;
pro=5; team=20. Only active, unexpired subscriptions enable remote access;
past_due/canceled/expired fail closed. No grace period or automatic trial:
one explicit authenticated trial per account, never renewed by re-pairing.
AccountService has an atomic durable repository interface, account-wide
registration serialization, permanent revoked-device tombstones, fixed-schema
metadata and change notifications. Expiry is checked on every admission and by
an active-tunnel timer. A subscription downgrade/expiry ends current remote
admission; local operations continue unchanged. The relay never sends MCP
bodies, URLs, file paths or browser data to AccountService.

BillingProvider is cloud-only. The first concrete adapter is Stripe hosted
checkout and raw-body timestamped HMAC-SHA256 subscription webhooks; provider
price IDs and secrets are operator configuration, never device configuration.
Webhook event IDs are idempotent; serialized authoritative provider reads
resolve reordered events to current state, retired subscription ids cannot
reactivate or change account owners;
unknown/ambiguous events cannot grant access. No card data enters CROT. Portal
APIs require verified owner OAuth tokens with a distinct account audience and
client allowlist; device-scoped MCP tokens are not portal credentials. Provider
revocation is a bounded, best-effort cloud operation with server-only WorkOS
credentials. A distinct, one-use Ed25519 device-management challenge binds the
exact operation and client ID; neither tunnel nor deregistration proof can be
replayed for it. Local revocation/unpair always take effect before network work.
Tray entitlement state is informational, stale/offline is labeled unknown and
never grants a local capability.

OD-11: tunnel majors use crot-tunnel.vN, with each released major supported for
at least 12 months. Unsupported majors close 4426, "update required". Browser
hello major mismatch reports update required without crashing CROT. Optional
operator minimum software versions are relay admission rules only (HELLO / HTTP),
not authorization or trustworthy evidence of client identity. Store/app versions
may differ while their protocol major is compatible. Tray/service control uses
its existing explicit protocol handshake. Removal of a supported major requires
an explicit release-policy change after its support window, not an automatic
build-version comparison.

OD-12: device telemetry is none by default; no automatic crash/diagnostic upload
is introduced. Any future diagnostic export requires explicit local user action
and a fixed secret/path-free schema. Relay/account logs are allowlisted operational
metadata only; no bearer, payment secret/signature, raw webhook, HTTP body,
workspace path or tab URL. Billing provider identities, legal entity, residency
and jurisdiction must be configured/reviewed for deployment (WP-37/WP-39), not
invented by this implementation. These operational/legal gates do not reopen the
approved plan/admission contract.


### AD-35 — Native-messaging extension identity allowlist (decides OD-10)

**Approved and implemented by WP-34/WP-35 repository delivery.** The native
messaging manifest produced by `crot-mcp browser install` and every OS installer
uses only the immutable release catalog in
`src/cli/release-extension-ids.ts`: Chrome Web Store, Microsoft Edge Add-ons
and the deterministic local/RC identity. Duplicate IDs are canonicalized. A
store-assigned change requires a reviewed source/release change and full tests.
No user, agent, page, MCP request, remote configuration or CLI argument can add
an `allowed_origins` entry. The extension signing key and store credentials are
operator secrets; they are never accepted by CROT at runtime or committed.

The current three channels intentionally share the ID derived from the public
MV3 manifest key, `bllcepanlhojbddfbbpegmnokpaakool`. If a store assigns a
different ID, publication is blocked until the release catalog and signed
desktop build are updated together.

### AD-36 — Accept absent RFC 9207 authorization-response `iss` for the single pinned WorkOS issuer in v1

**Approved for WP-33; closes the AD-21 R7 condition for Gate G4.** On
2026-10-21 the live staging authorization-server metadata at
`https://prestigious-continent-62-staging.authkit.app/.well-known/oauth-authorization-server`
identified that exact issuer and did not publish
`authorization_response_iss_parameter_supported`. CROT accepts that provider
deviation for v1; it does not claim that WorkOS emits RFC 9207 `iss`.

The exception is safe only within all of these invariants:

1. A release contains exactly one HTTPS issuer origin for its environment. It
   is pinned configuration, never selected from a request, relay, token or
   runtime discovery result. Issuer and relay host may be different domains.
2. Authorization metadata must byte-match the configured issuer. JWKS is
   fetched only through that pinned metadata; a token naming another issuer is
   rejected before a foreign JWKS is fetched.
3. Relay and device verify RS256, byte-exact JWT `iss`, the one canonical
   device-resource `aud`, account binding and time claims. The device repeats
   the check and remains authoritative.
4. Pairing and account-portal callbacks compare authorization-response `iss`
   byte-for-byte when the parameter is present. Absence alone is accepted only
   because the client uses one pinned authorization server.
5. CROT has no multi-authorization-server chooser, dynamic issuer routing or
   fallback issuer. Adding one reopens the mix-up threat and requires RFC 9207
   support or a replacement AD with equivalent binding.

RFC 9207 prevents authorization-server mix-up at clients that can use several
servers. Under the v1 topology an attacker cannot redirect CROT to another AS:
the authorization endpoint, token issuer, metadata and JWKS chain are anchored
to one release-pinned origin, while a forged or foreign JWT fails signature,
`iss` and `aud`. This is a bounded interoperability decision, not a weakening
of token verification and not permission to ignore an `iss` value that is
actually returned.

### AD-37 — First-party product surfaces and card-backed trial admission

The Control Center, browser popup/onboarding and account website share the static
Obsidian tokens and capability catalog in `src/ui/theme.ts`. These are presentation
surfaces, not additional policy engines. AD-19 remains authoritative: no renderer
network, external code, arbitrary shell commands or renderer-selected URLs. Owner
UI actions use the existing authenticated control path and main-process URL/action
allowlists. Approval subjects remain complete and escaped; ordinary diagnostics
are collapsed rather than removed from the owner's inspection surface.

Free local execution remains independent of accounts and billing. The public
`POST /account/trial` route initiates hosted Stripe Checkout with card collection
and a seven-day subscription trial. A redirect does not grant entitlement. Only
a verified webhook followed by a fixed-provider subscription read may activate
the cloud trial, with a matching account marker, Pro price, seven-day interval
and collected payment method. Trial supports two remote devices. Hosted billing
portal sessions verify the subscription/account binding before creation.

This change does not qualify a unified native installer, live payments, vendor
signing or cross-platform L1 availability. The legacy trusted in-process trial
provisioning helper remains for existing fixtures and is not exposed by owner
HTTP; removing it requires a separate fixture migration. See
`docs/FLAGSHIP_IMPLEMENTATION.md` for the actual evidence and outstanding gates.


### AD-38 — Fixed owner UI launch channel and Linux desktop compatibility

The extension may now request one additional, non-tool operation: open/focus the
owner's Control Center. This is not a general extension-initiated Core operation.
Only the exact packaged popup/welcome URLs (optional local fragment, no query)
can send the background message. Content scripts and other origins/pages cannot.
The native `ui_open` frame contains only a bounded request id: no command, path,
URL or tool arguments. Both directions reject extra keys. The authenticated
browser bridge caps UI requests at 20 per minute and throttles launches to one per two seconds and invokes a fixed
first-party Electron launcher. A boolean acknowledgement means the OS accepted
launch, not proof that a window rendered. Extension pending requests are bounded
to one, time out after five seconds and fail on disconnect. Core permissions,
approval decisions and browser command authorization remain unchanged.

The owner UI alone can open its actual workspace folder or copy an MCP config
constructed by Electron main with absolute executable/entry/workspace paths and
service launch flags. Renderer IPC cannot provide paths, config bytes or URLs.
Default stdio `crot-mcp` behavior is unchanged. Explicit `crot-mcp app` / npm start
registers the native host, starts/reuses the service and launches Control Center.
First use without a configured workspace writes an owner-private desktop config
with the current directory and browser bridge enabled; existing policies are not
silently replaced. New desktop services use managed, not on-demand, lifecycle.
The desktop bootstrap uses the existing authenticated service-start lock and waits
for the service welcome before launching Electron. A newly started managed service
is detached with its private log; it and the UI outlive the launcher/terminal.
The default stdio shim still starts an on-demand service.

**Explicit exception to AD-19:** at the owner's request the Linux launcher passes
`--no-sandbox` before Electron bootstrap, and main also appends the switch. This
removes Chromium's process sandbox on Linux; do not describe the renderer as OS
sandboxed there. Context isolation, Node denial, permission denial, CSP, navigation
blocking and no renderer network remain. It does not disable L1 tool confinement
or OS security controls. Restoring an OS-sandboxed desktop distribution remains a
release-hardening gate. No blanket GPU-sandbox flag is added.

This decision does not add privileged L1 installation from the service. Existing
AD-20 installation separation is retained pending a qualified, consented installer
helper. A repair guide is not a working one-click installer. Likewise, a packaged
setup guide is not a downloadable signed release. These remain open acceptance
criteria, not successful checks.

### AD-41 — Reference-driven desktop onboarding and verified plan handoff

The owner requested a fixed light desktop surface with three first-launch stages:
authentication, plan selection and Home. Window defaults are 1280 × 820 and the
minimum is 1180 × 780. Old fragments and saved local-mode preferences cannot skip
this sequence. Only five destinations appear in primary navigation; all existing
tool routes remain reachable through contextual navigation. Window scrollbars
are forbidden; long tool and approval contents retain bounded internal scrolling
so security subjects are never clipped to satisfy a screenshot.

Account authentication is not Relay registration. Pairing reports a presentation-only
signal after all JWT, issuer, audience, time and native-client checks, before Relay
registration. Service retains only a short expiry (not token/profile); owner overview
exposes a boolean. This admits the tariff screen for a Free account even when Relay
refuses device registration. It grants no binding, principal, entitlement or capabilities.
The signal expires within ten minutes and never later than the verified token.
Existing paired devices may explicitly continue through the welcome screen.

`ui.startTrial` accepts no renderer parameters and opens only the configured first-party
HTTPS portal with a fixed trial intent. The portal carries this intent through its
existing state/PKCE verification, then invokes the existing card-backed trial route.
Checkout opening does not activate Pro. An unpaired device must complete explicit
subscription verification/pairing; Home admission for Trial waits for paired-device
state plus current verified commercial entitlement. Free admission remains local
and does not cancel an existing paid subscription. No renderer network is added.

The shared public catalog advertises USD 3/month and seven trial days. Cloud Checkout
verifies the configured Stripe Pro price is active USD 300 cents/month before creating
a session, failing closed on stale pricing. No live Stripe price or deployed config
is changed by this source patch. Existing verified subscriptions are not rewritten.
Advertised local feature tiers are presentation, not a new local Core policy engine;
this change does not revoke existing local projects or connectors based on billing.

### AD-42 — Owner-requested Control Center design system and navigation

Owner directive dated 2026-10-24 supersedes **only the presentation clauses** of
AD-41: five primary destinations, fixed-light theme and 1180 × 780 minimum geometry.
Control Center now exposes ten primary destinations: Home, Unified Chat, Agents &
Tokens, Projects, Connectors, Accounts, Permissions, Browser, Journal and Settings.
Existing Files/Terminal/Git/Docker/Tasks/external-MCP routes remain contextual.
The desktop minimum is 960 × 640; below 1100px the sidebar collapses to 72px.
Narrow browser-fixture rendering is tested but does not qualify a mobile native app.

Canonical owner light/dark tokens live in `assets/brand/tokens.css`. Build-time
assets embed local OFL Inter/JetBrains Mono (Latin/Cyrillic) and static Lucide node
arrays. A synchronous external head script restores Light/Dark/System before CSS;
System tracks OS changes. CSP adds only `font-src data:` for build-time embedded
fonts; renderer network, inline scripts, eval and arbitrary privileged APIs stay
forbidden. The public portal and extension retain their independent existing theme;
the extension's app icons now derive from the same mascot master.

Auth → Plans → Home and AD-41's verified entitlement/pairing gate remain unchanged.
Owner pricing stays USD 3/month, seven trial days: the attached commercial review's
annual-pricing proposal is not a pricing authorization. Local L1 availability is
not subscription-gated. Subscription labels derive from service state, not a
static Pro badge. No UI preference authorizes an operation.

Chat generation, streaming, attachments, publication, arbitrary provider OAuth,
Bearer token minting/rotation and provider-side revocation are **not added** by this
visual change. Unsupported actions are disabled/explained. Accounts reads the same
service-owned connector registry; credentials are configured only in Connectors.
The Relay field is masked; copying remains a fixed main-process action. Existing
OAuth identities are not replaced with an invented full-access Bearer token.
PermissionEngine, ExecutionGuard, browser scope and L1 remain authoritative; no
second policy, unsafe new default or renderer-only security toggle is introduced.

`docs/design/SPEC.md` records the directive and attached review;
`docs/design/IMPLEMENTATION.md` records resolved conflicts and remaining gaps.
Raster references remain immutable evidence (including obsolete illustrated
endpoints); they are never executable configuration. The newly supplied official
endpoint is `https://mcp.crot.networking`. Source changes do not migrate deployed
DNS, TLS certificates, configured OAuth issuer/audience or provider callbacks.

### AD-43 — Functional Stage A: owner runtime policy and emergency brake

The owner authorizes extending CrotService/Core and replacing obsolete tests,
with Stage A required before B/C. This branch is a **partial Stage A working
slice**, not acceptance of the entire directive. Scoped credentials, native
project discovery/secret-file confinement, provider chat/tool execution and
project-wide approval decisions remain unimplemented here.

The final owner correction supersedes the domain sentence in AD-42: the official
domain remains `crot.network`, MCP at `mcp.crot.network`. Do not migrate production
configuration, DNS, issuer/audience or OAuth callbacks to `crot.networking`.

1. Runtime `allow / ask / deny` configuration is consumed by the existing
   PermissionEngine, never a second authorizer. Rules select an exact Core
   operation or capability; any matching deny wins. Strict Mode adds an ask gate
   to otherwise authorized operations. Allow does **not** override capability,
   workspace, service-secret, network, exposure, remote or configured mandatory
   approval ceilings. Post-approval reauthorization reads the current policy.
2. Owner-only authenticated product RPCs expose `security.status`,
   `security.setPolicy` and `security.kill`. Policy is validated, persisted in
   protected product state and audited before publication to the running engine;
   a failed audit does not publish a widening. Policy is restored on service
   startup and shared across workspace/preset Core replacement.
3. Emergency stop latches synchronously before awaiting work. It cancels pending
   approvals, force-signals process trees (including Git/Docker commands), aborts
   network/browser work, aborts product tasks, closes loopback HTTP and Relay
   sessions, and refuses new shim admission. The owner control channel and audit
   sink remain available. Calls are idempotent; cleanup/audit failure is reported,
   never represented as complete success. Header and tray invoke this real RPC.
4. The latch cannot be cleared by changing a permission, workspace or preset.
   Explicit service restart is required to resume. It is a process-lifetime brake,
   not persistent disablement across restart. It cannot undo an already committed
   filesystem write, browser action or external side effect, nor stop processes
   CROT did not start. Force-signalling is immediate; cleanup/reaping is bounded
   by the existing process/guard shutdown limits, not a zero-latency guarantee.
5. This slice does not yet implement project-scoped grants, application-secret
   globs at the L1 boundary, scoped agent tokens, provider chat, model discovery,
   attachments, streaming or the full Stage A connect/task/approve/audit UI flow.
   PR #5 must not be presented as complete Stage A until these gates and CI pass.


### AD-44 — Named loopback credentials and scoped-resource invalidation (Stage A)

This supersedes only the named-token and native-folder-selection gaps in AD-43;
Stage A as a whole remains incomplete. Relay continues to require its existing
verified OAuth device/account identity. Named bearer credentials are **loopback
only**, not a replacement for Relay OAuth or a new full-access credential.

1. An owner-only registry issues independent 256-bit random tokens with client
   names, explicit non-empty `files / terminal / browser` scopes and a bounded
   TTL (60 seconds through 365 days). Only SHA-256 hashes and metadata persist in
   protected service-secret storage. Plaintext is returned once over owner IPC,
   displayed in a masked transient dialog, and cleared on closing; it is never
   included in token listings, audit records, logs or localStorage. Rotation
   retains scopes and the original expiration; old generations cannot resume.
2. The HTTP verifier builds an immutable verified ID/generation/scope binding;
   MCP arguments and self-reported client names cannot set it. Session ownership
   includes that binding. The one PermissionEngine intersects scopes with the
   configured capability ceilings. Files permits filesystem read/write, terminal
   permits shell/process and dedicated Git operations, browser permits browser
   read/control. Unmapped capabilities, Docker, direct network APIs and
   filesystem.full are denied. Scoped principals always use the sandbox profile,
   and arbitrary process execution **requires available L1**, without local
   unconfined fallback even when the owner uses full_control. Scopes describe
   Core capabilities, not a promise that an allowed shell command has no effects
   within its configured L1 workspace/network boundary.
3. ExecutionGuard's existing narrowing hook rechecks authoritative token validity
   before execution and after approval. Every authenticated HTTP request updates
   last-use metadata. Expiry is checked at authentication and authorization;
   a 250 ms sweep cancels already running work, subject to event-loop scheduling
   and OS reaping (not a zero-latency guarantee). Revocation/rotation immediately
   invalidate the generation in memory, close its HTTP responses and legacy
   sessions, cancel its product task controllers and terminate its background
   process trees. Pending startup rechecks cancellation after launch, so a late
   process ID cannot orphan a revoked client's process.
4. `ProcessService.cancelToken` is a service lifecycle resource teardown, analogous
   to shutdown, not an MCP tool or a way to execute arbitrary operations. It
   matches the credential captured at the originally authorized process start,
   never UI-supplied display names. Strict Mode cannot block teardown by asking
   for another approval. Other token generations/agents' resources are untouched.
5. Issuance/rotation persist an inactive credential and audit before activating
   it; interrupted or unaudited credentials cannot authenticate on restart.
   Revocation persists a tombstone. Storage or resource-cleanup failure latches
   the runtime fail-closed and is reported as failure, not successful revocation.
   A failed disk write cannot be claimed as durable revocation across restart.
   The old bootstrap local token remains an explicitly privileged compatibility
   credential; named-token rotation does not silently rotate that credential.
6. The Projects Open Folder action uses a fixed Electron main-process native
   directory picker. The renderer supplies no path/options to that action. A
   cancelled dialog changes nothing; selected directories still pass canonical
   project registration and idle workspace-switch checks. Native GUI interaction
   requires separate OS smoke verification; a Chromium fixture is not that proof.

Application-secret globs at the L1 boundary, stack/port discovery, provider chat,
attachments/streaming/tool calls and project-persistent approval grants remain
Stage A acceptance gates. Domain remains `crot.network` / `mcp.crot.network`.

### AD-45 — Guarded provider streaming and transient owner chat (Stage A)

This supersedes AD-43/44's unimplemented-chat description only. It does not close
project grants, project discovery or application-secret L1 enforcement gates.

1. The existing Core NetworkService accepts an optional trusted in-process stream
   observer. No MCP/IPC schema accepts callbacks. DNS pinning, destination policy,
   redirect rules, response limits, cancellation and audit remain on the same
   ExecutionGuard path. Observer errors close the response; cancellation wins even
   when delivered during the final data callback. Chat disables redirects, so
   provider credentials cannot follow a redirect to a different destination.
2. Owner-only provider configuration uses the encrypted product vault for keys;
   listings expose only credential presence. Actual model inventories and bounded
   SSE responses use Core HTTP, never renderer fetch or fabricated model lists.
   OpenAI and OpenAI-compatible Local HTTP use chat/completions; Anthropic uses
   messages and paginated model discovery. Explicit endpoint selection permits
   HTTP, including non-loopback destinations if Core policy allows them; the owner
   must use HTTPS when transport confidentiality is required. Platform fixtures
   are not qualification of the live vendors, models or a local model server.
3. Owner chat is a local principal, not a remote scoped credential. Its multi-step
   generation holds the CoreHolder idle-switch barrier and a cancellable product
   task. Individual calls still use current Core permission checks. Stop aborts
   HTTP and pending approval; emergency stop closes the chat runtime. Subtasks
   from owner-chat cannot persist prompt/attachment/tool arguments as retry replay
   data. Keys, prompts and raw upstream parse errors are not audit descriptions.
4. Conversations are transient, bounded to eight sessions, one active generation,
   eight tool rounds, sixteen explicitly selected tools, 1 MiB per SSE response
   and a bounded display/result transfer. Attachments are at most four / 96 KB
   decoded, strict UTF-8 text or type-checked PNG/JPEG/WebP data. Selecting a
   provider consents to transmitting the message, attachments and enabled tool
   results to it; it does not authorize a network destination or a Core action.
5. The decoder accepts split UTF-8 and CRLF frames but requires dispatched frames
   and provider completion before invoking any tool. Unknown/unselected tools
   return an error without execution. Actual invocations use canonical MCP tool
   definitions and invokeTool, with the same validation, authorization, exposure
   state, broker approvals and audit as external clients. Upstream JSON/decoder
   failures are converted to generic errors before reaching network/task audit.
6. Renderer polling displays streamed text and tool-call blocks as plain text,
   never provider-supplied HTML. The shared broker queue appears inline and in the
   header; this slice still offers only one-time approve/reject. Persistent
   project grants and the complete native GUI acceptance journey remain open.

### AD-46 — Digest-bound owner project grants in the existing runtime policy

1. A project grant remembers one exact Core operation for the canonical workspace
   bound by the Core that presented the request, not a UI-supplied path or project
   ID. Workspace is part of the immutable approval subject and its digest. The
   subscribed owner tray must present that digest and a still-pending ticket.
   The UI explicitly labels this grant as applying to every agent in that project.
2. PermissionEngine alone interprets grants. They suppress only the runtime `ask`
   gate for the matching workspace/operation and in-workspace paths. Strict Mode,
   runtime deny, capability ceilings, token scopes, workspace/secrets/network
   checks, configured mandatory gates and exposure/remote gates still apply.
   Full-control outside-workspace subjects cannot be remembered for a project.
   Process scopes retain their existing L1/full-control semantics; a project
   grant is not a new kernel sandbox or a restriction on arbitrary command I/O.
3. The existing protected two-phase runtime-policy transaction serializes grants,
   revocations and owner policy changes. It stages the prior policy, writes audit,
   rechecks/consumes the exact ticket synchronously, then commits before publishing
   the future grant in memory. Expired/cancelled/digest-mismatched requests or audit
   failures cannot publish a grant. An interrupted staged snapshot restores the
   prior policy on restart. Audit records describe the attempted policy transition;
   a later cancelled ticket/failed disk commit is not a successfully active grant.
4. The consumed ticket still approves only its original operation, with normal
   post-approval reauthorization, target revalidation and mandatory approval audit.
   If final policy persistence fails, that one-time decision may already have run;
   the future project grant is rolled back and failure is reported. Rollback
   persistence failure latches the runtime stopped. Revocation removes the exact
   workspace/operation pair without replacing unrelated current owner rules.
5. Header and inline chat use the same tray controller and broker; renderer cannot
   manufacture the subject digest. Pending Strict Mode/mandatory requests have no
   remember-project action. Runtime settings list persisted grants and support
   explicit revocation. Legacy policy updates that omit grants preserve them;
   explicitly supplying an empty grant list clears them.

### AD-47. Bounded owner project inspection through Core

The fixed owner RPC `projects.inspect` accepts no path, command or project ID.
It holds CoreHolder's idle-switch barrier for its entire multi-step workflow;
ProductRuntime correlates a cancellable, non-replayable `$project.inspect` task.
The Core reads only `package.json`, `pyproject.toml` and `Dockerfile` through
FileSystemService and the existing ExecutionGuard. Runtime deny, Strict Mode,
mandatory approvals, workspace and protected-path ceilings remain effective.
No package scripts, imports, package managers, Docker builds or commands found
in a manifest are executed. JSON is bounded to 64 KiB (and the configured Core
read limit), parse errors are generic, and only a fixed dependency-name/stack
allowlist is returned. Python/Docker detection means manifest presence, not a
claim that TOML is valid or an interpreter/image is installed. Symlink manifests
are not followed; non-files and oversized files are explicitly reported.

Port observation is a separate guarded `process.project_ports` operation with
`process.manage` and the active resolved workspace path. The Linux implementation
observes `/proc` TCP LISTEN sockets in the service network namespace and matches
socket descriptors to same-user processes whose canonical cwd is inside that
workspace. It never reads environment variables, command lines or process memory.
PID start time and cwd are rechecked before publishing. PID/FD/project-process
counts, table sizes and elapsed scan time are bounded; the owner response contains
at most 512 unique listeners and reports partial if truncated. Inaccessible, oversized
or truncated observations report partial/unavailable, never "all ports free".
This is a point-in-time association, not proof of future port availability,
exclusive project ownership, network authorization or discovery of another
network namespace. No network connection or remote host scan is made.

The current native port observer is Linux-only. Other OSes return an explicit
unavailable state, not fabricated listeners. Native macOS/Windows observation
and qualification remain acceptance work. The renderer displays the actual
manifest evidence and observer status after an explicit Inspect project action;
there is no hidden script execution on navigation or automatic widening of
network permissions. These observations do not implement the outstanding L1
application-secret filename policy.


### AD-48. Prepare compositor routing before trusted pointer input

A real Chromium regression exposed a scroll/OOPIF routing race: DOM geometry and
hit tests already located a button in a cross-origin shadow iframe, but the first
pointerdown still reached its parent iframe element and pointerup reached the
button. No click was generated. A broad pointer-count delivery probe incorrectly
accepted that partial input as click completion. Test-only isolated-world event
evidence reproduces the different trusted down/up recipients; it is never shipped
or used as a privileged production page-reading API.

After ordinary enabled/visibility/coverage checks, actionablePoint now sends a
move only, gives compositor routing a bounded 100 ms preparation interval, and
rechecks position, enabled state and coverage before any press. A moved, disabled
or covered target is refused, not clicked at its former coordinates. This is
preparation, not a retry of input; a possibly delivered press is never repeated.
Click delivery requires a trusted activation (click/auxclick/contextmenu/dblclick),
not merely pointer events split across documents. Drag retains the pointer-event
probe. A failed delivery no longer claims nothing changed: it warns that partial
input may have happened and asks for inspection before any decision to retry.
Existing navigation/document replacement uncertainty is unchanged. The probe is
not an assertion that a site's business operation succeeded.

The real regression checks trusted pointerdown, pointerup and click on the actual
shadow-frame button in addition to its server event. Unit tests separately
serialize and execute the isolated-world probe, reject fake/untrusted clicks and
split pointer-only completion, revalidate hover-induced layout/coverage/disabled
changes, and assert that failure never replays a press.


### AD-49. Native owner folder choice and acknowledged workspace switching

The fixed ui.pickProjectFolder owner action opens Electron's actual OS directory
chooser; the renderer supplies no path or dialog configuration. One picker is
admitted at a time, including registration and selection. Cancellation, multiple
paths, relative paths and NUL-containing paths do not mutate the registry. The
service still canonicalizes/registers the directory and enforces its idle Core
switch barrier. The action reports success only after projects.open and
projects.select both acknowledge the same service-issued project id. Errors
release the picker lock, not Core restrictions. A failed select can leave an
owner-registered directory in the registry; it does not change the active project
or falsely report a successful switch.

The Linux qualification launches the shipped, non-smoke Electron app against a
real CrotService. X11 input cancels one actual GTK chooser, then chooses a folder
with spaces via the native Open button. It checks unchanged registry/Core after
cancel, selected Core root, refreshed shipped UI and real audit events. It never
stubs the dialog, returns a fabricated native choice, or adds a renderer bypass.
An isolated GTK setting stabilizes the test desktop's control layout. This is
Linux GUI evidence, not macOS/Windows dialog or application-secret L1 qualification.
The standalone qualification requires Xvfb, xdotool and Electron's GUI libraries;
it refuses unsupported hosts rather than silently passing.

### AD-50. Keep a guarded inspection response across UI replacement, never replay it

A full browser regression exposed a workspace-view refresh replacing the DOM
while an explicitly requested project inspection was pending. The old callback
correctly refused to write to detached nodes, but the replacement page lost the
request/result. Merely retrying the test or repeating the Core request on every
render would hide the race and repeat guarded operations.

The renderer now keeps one bounded inspection promise/result for the exact
selected project id and canonical workspace. Replacement views subscribe to that
same promise or render its completed point-in-time result. Response workspace
must match the captured workspace; detached or superseded consumers cannot paint.
A project switch discards the snapshot. Rendering, language changes and navigation
never request another inspection; an explicit Inspect project or error Retry can.
Pending clicks share the admitted request. The cache is presentation state only,
not permission state, authorization, a background scan or proof that ports are free.

The shipped-UI/real-service test withholds an actual inspection response, forces
a language-driven rerender, releases the response and checks the result. It then
navigates away/back without another request, switches workspaces and checks cache
invalidation, and verifies that a subsequent explicit inspection makes exactly
one new request. No production IPC method or authorization path is added.


### AD-51. Native same-owner project TCP observation, not cwd inference

The process.project_ports guard remains the sole authorization entry. NativeHost
now supplies an optional read-only Platform observer on macOS/Windows. Core's
Linux /proc implementation remains the fallback; no renderer/native direct RPC,
actor-selected command, debug privilege or network probe is added.

Darwin uses fixed /usr/sbin/lsof NUL field output for TCP listeners/current
working directory, and libproc proc_pidinfo(PROC_PIDTBSDINFO) for effective UID
and microsecond kernel creation identity. No shell, PATH lookup, environment or
command-line inspection is used. Windows uses GetExtendedTcpTable owner-PID
listener rows, a read-only process handle, equal owner-token SIDs and kernel
creation FILETIME. It admits only a native 64-bit process ABI; bounded
ReadProcessMemory follows PBI.PebBaseAddress, PEB.ProcessParameters and the
CurrentDirectory UNICODE_STRING only. Executable location and .NET WorkingDirectory
are not guesses for the real cwd. WOW64/emulated or inaccessible processes remain
unobserved/partial. Windows libraries other than kernel32 KnownDLL are loaded
from GetSystemDirectoryW, not the project directory or actor PATH.

The shared observer canonicalizes cwd, excludes outside/sibling-prefix roots,
intersects a second listener table, then rechecks creation identity and cwd before
publishing. Limits are 128 listener PIDs, 512 unique returned listeners, bounded
native tables/output, and a three-second observation deadline/cancellation signal.
Errors and incompleteness report partial/unavailable, never fabricated free ports.
This is point-in-time evidence, not a permission decision, live guarantee or L1
secret protection. Foreign/unreadable process metadata is never returned to UI.

Pure parser/identity, PID reuse, changed cwd, closed listener, cap, cancellation
and guard-before-platform tests run on every host. The existing actual listener
integration is enabled on macOS/Windows as well as Linux and exercises the real
native bindings directly before the guarded Core result. Linux tests do not
qualify the other OS ABIs; a green native CI run is still required before claiming
the macOS/Windows observer qualified. General project-secret L1 enforcement and
complete Stage A acceptance remain separate gates.

### AD-52. Project secret-file mandatory policy and macOS native candidate

`permissions.projectSecrets.allow` is an immutable, bounded list of exact
project-relative secret files bound to an absolute canonical workspace. It is
not a recursive directory grant, runtime `allow`, project-operation approval or
capability override. The shared PermissionEngine denies `.env`, `.env.*`,
`*.pem`, `*.key` (including case variants and sensitive directory components)
unless that exact file was opted in by the owner configuration. Symlink grants
are refused rather than silently granting a different target. Existing CROT
service-secret protection still takes precedence. Ordinary filesystem tool
requests use the same guard and audit; no second execution authorizer exists.
Core pathname checks do not protect arbitrary child processes or hardlink aliases
and must never be described as L1 protection.

The macOS candidate adds a fixed, escaped, workspace-anchored Seatbelt filename
rule, including files created after admission. Exact literal exceptions do not
allow a subtree. Existing sensitive symlink targets are protected and ambiguous
pre-existing secret hardlinks refuse admission; actor-created link/linkat calls
are denied by inherited kernel policy. Trusted host processes must not create
new public hardlink aliases to secret inodes while an actor is running: pathname
policies are not inode information-flow control. This limitation is explicit,
not a watcher-based security claim. Hardlink denial also changes toolchain
compatibility and is subject to the existing actual-macOS toolchain tests.

A Docker daemon is outside Seatbelt and reads the original host tree. The macOS
mediated endpoint therefore refuses host bind sources other than the mediated endpoint socket,
including read-only project binds, rather than exposing future secrets through a container. The
positive mediated daemon byte stream remains supported. An exact secret-file
opt-in does not restore directory bind mounts.

This slice supplies configuration opt-in and a fresh sandbox after old sandbox
drain; it does not yet supply live owner IPC/UI grant/revoke. Linux and Windows
backends do not yet implement this general project-secret filename policy.
Their existing L1 status must not be interpreted as qualification of this new
requirement. Static masks, preflight scans and UI filters are insufficient for
future-file protection. The added macOS native tests must pass on actual macOS
before its kernel rule is qualified. Until remaining native backends, live
owner controls and their acceptance tests exist, Stage A and PR #5 remain WIP.


### AD-53. Owner secret-file grant/revoke and immutable Core retirement

Authenticated owner product RPCs `security.secretFiles.status` and
`security.secretFiles.set` expose the exact workspace-bound AD-52 policy. The
renderer confirms each grant/revoke and warns that current tasks and chat
will stop. The Core path policy is not protection for unconfined commands;
Linux/Windows general secret-file L1 remains incomplete. These controls do not
weaken capability, CROT-secret, native confinement or mandatory approval gates.

The existing ControlCenter serialization owns the transition. After schema,
exact-current-workspace and canonical-path validation, an exclusive CoreHolder
lease blocks new adapter/workflow admission. ExecutionGuard retirement is
irreversible, including held references to the old capability services. A
protected atomic pending record is written before cancellation. Product chat,
server clients and tasks are interrupted; the old Core cancels approvals,
terminates processes (including actors with already-open secret descriptors),
closes native confinement and drains operations. A nonzero activity count or
any drain failure refuses acknowledgement. Only then is a new immutable Core
built with the explicit policy, audited, committed to the owner state file and
installed. No second authorizer or renderer execution path is introduced.

`project-secret-access.json` is protected service state, unreadable/unwritable
through agent capabilities. A crash with a pending record recovers deny-all,
not the previous grant or a half-published widening. Missing state uses the
owner configuration baseline; malformed/non-private/non-regular state refuses
startup. If the initial protected write itself fails, existing durable state
cannot be assumed changed: the live service halts and reports failure, never
successful revocation. All other transition failures likewise latch the service
halted and keep admission closed; no rollback revives an old actor. An owner
must repair the failure before restarting. A completed revocation cannot
retrieve bytes already disclosed to an actor; its guarantee is stopping old
work and denying subsequent access under the replacement policy.

Tests cover exact scope, old-reference retirement, pending recovery, protected
write/build/audit/commit/drain failures, a real service actor holding an open
secret descriptor, restart persistence, and the shipped renderer's explicit
confirmation/cancel/grant/revoke path through a real service. These are separate
from native backend qualification and do not close Stage A's remaining gates.


### AD-54. Actual native folder-dialog qualification, not a renderer substitute

The existing Linux Electron/GTK fixture is generalized with test-only native
control drivers. All hosts launch the shipped Electron entry against a real
isolated CrotService and exercise the unchanged `showOpenDialog` →
ProjectFolderPicker → projects.open/select path. Cancellation must preserve the
registry and Core; a folder containing spaces must become the real Core root,
be visible in the shipped renderer and have both audit records. No dialog
return value, IPC response or service acknowledgement is mocked.

Linux retains X11/GTK keyboard and native-window control. macOS inspects the
visible NSOpenPanel in the test Electron main process through AppKit, navigates
its real directory URL and invokes its native cancel/OK actions. It does not
use System Events, change TCC permissions or bypass an external accessibility
requirement. Windows UIAutomation is restricted to the chooser window owned by
the test Electron PID and exact title. ValuePattern edits its real folder field
and InvokePattern uses the native Cancel/Select controls; no registry policies,
security settings or provider values are changed. The real service result must
still equal the fixture directory after the native callback.

The macOS/Windows fixture runs as a mandatory test on those hosts in the
existing Node/OS matrix; Linux's existing actual GTK qualification remains a
separate command. Host-inapplicable execution is explicit, not qualification.
A successful Linux run and static review cannot prove the AppKit/Windows driver
works. Actual native CI must pass before closing either acceptance gate.
