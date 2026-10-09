# CROT — Architecture extensibility audit

Audit only: no code, contract or roadmap change follows from this document by
itself. Every proposed change below needs its own work package, and changes to
architectural boundaries need an AD first (AGENTS.md "Decision before code").

- **Audited tree:** `main` at `4d574f0` (merge of crot-mcp PR #16, WP-28).
- **Baseline:** `npm run check` on that tree passed (77 test files / 1187
  tests passed, 99 skipped; extension 64 passed). No live identity provider,
  relay, FFmpeg/speech tools or video editors were exercised.
- **Question:** can CROT grow from a remote bridge into an extensible
  execution layer for local and remote AI agents (browser, computer, video and
  audio, video editors, integrations such as YouTube) without redesigning
  Core or the remote-access architecture?

Target capabilities named in this audit (video/audio inspection, FFmpeg
processing, video editors, YouTube publishing, general browser workflows,
additional tools) are **product targets, not existing features**.

## Revision 2 — expanded product goal (what changed)

Revision 1 (sections 1–10 below, unchanged) answered "can capabilities be
added without redesign?" for the v1 product. The expanded goal (CROT as an
execution environment for local and remote agents with full media work,
video editors and external services) keeps its facts but changes these
conclusions. The plan is in
[`docs/plan/product-reassessment.md`](../plan/product-reassessment.md).

| Revision 1 | Revision 2 | Why |
| --- | --- | --- |
| Dedicated media capability "only if demand", decided later (C4) | **Required**; scope grows from inspection to a full pipeline (inspect, audio, speech, edit description, render, verify) — OD-17, OD-18, WP-49…WP-57 | media work is now a mandatory product goal; shell commands give no verifiable result |
| GUI control of editors "out of scope — not recommended" (§1, §5.4 L-d) | **Reassessed** by OD-22 (scoped application control, not remote desktop); stays out of v1; spike WP-69 first | autonomous work in GUI-only applications is a goal; the prohibition was a v1 boundary |
| Credential broker C5 "post-v1, larger" | **Planned** (milestone v1.2) as connections + connector runtime; storage model compared and chosen by OD-20 (device vault default, cloud broker only where unavoidable) | integrations (YouTube, ElevenLabs, TikTok, Canva) are product goals |
| Editor levels L-a…L-e, generic | Replaced by a **per-editor matrix** (docs/design/media-and-editors.md §5) | editors differ; no equal depth promised |
| — | **New gap G9: long-running jobs and artifacts** (only background processes have state; they block Core replacement, `src/service/core-holder.ts`) → OD-15, WP-44 | render, transcription and uploads outlive one request |
| C1, C2, C3 | Unchanged in substance; now WP-41, WP-43 (after OD-16), WP-42 | — |
| Sequence §7 | Superseded by product-reassessment.md §6 (v1 chain unchanged; new milestones v1.1–v1.3) | wider scope |

Unchanged: no rewrite of Core, MCP, relay, identity or permissions; one
catalogue for local and remote agents; text generation stays in the agent;
no service-specific code in Core (§9); browser contract v1 remains the main
enabler of web workflows; tests T1–T8.

## 1. Short answer

**Extend the existing architecture; add one small, targeted extension, and
decide two items by AD before any code.** No Core, MCP, relay, identity or
permission redesign is needed.

- One Core pipeline already serves every agent type: the same tool catalogue
  and the same `invokeTool` → service → `ExecutionGuard` path for stdio,
  loopback HTTP and the relay entry point (§2.1, §2.2).
- Media tools, editor CLIs and project files are usable **today** through the
  existing generic capabilities (`shell.execute`, `process.manage`,
  `filesystem.*`) — with three concrete limits: no availability reporting of
  optional tools (§4 G1), remote agents on macOS/Windows in workspace mode
  cannot run commands until L1 exists there (G3), and agents cannot *see*
  workspace images (G4).
- Browser workflows (research, forms, uploads, YouTube Studio) need no new
  architecture: they need the already decided browser contract v1 (AD-16,
  WP-24…WP-27). This is the highest-value dependency for the target
  workflows.
- Two items are **not** covered by any AD and must not be built ad hoc:
  a dedicated media capability (G3/G5) and CROT-held credentials for external
  HTTP APIs such as the YouTube Data API (G6).
- GUI control of desktop video editors is explicitly out of scope ("Never in
  scope: … OS-level input", roadmap §11; ARCHITECTURE.md §22 "Not a remote
  desktop"). Editors are integrated through their files, CLIs or documented
  scripting interfaces, per editor, with no promise of equal depth (§5.4).

## 2. Current implementation facts

### 2.1 One catalogue, one path for every agent type

| Fact | Evidence |
| --- | --- |
| The MCP tool catalogue is a static list of declarations; each `call` is a one-line delegation to a Core service | `src/adapters/mcp/tools.ts` (`ToolDefinition`, `TOOLS`; header comment "No business logic, path handling or authorization lives here") |
| Every protocol era and transport registers the same `TOOLS` and calls Core through one function | `src/adapters/mcp/server.ts` (`createCrotMcpServer`, session protocols), `src/adapters/mcp/modern.ts` (`createCrotModernMcpServer`, sessionless 2026-07-28), both → `src/adapters/mcp/invoke.ts` (`invokeTool`) |
| Loopback HTTP and the relay entry point use the same servers; only the context resolver differs | `src/adapters/http/server.ts` lines ~643/713 (`httpContextResolver(principal, scope)`); `src/adapters/http/context.ts` (OAuth facts only on the relay entry point, WP-28) |
| Local and remote differ only in verified principal facts (`kind`, account, device, client) | `src/core/auth/principal.ts` (`PrincipalKind`, local principal ~l.134, remote ~l.152) |
| Tests pin "same tools on every transport" | `tests/adapters/mcp.test.ts:48`, `tests/adapters/http.test.ts:222` (tool names equal `TOOLS`) |
| No client-specific code | ARCHITECTURE.md §11; roadmap §6.2 "Never: client-specific logic" |

Consequence for "two agent types": a capability added once as a Core service
plus one `TOOLS` entry is available to local and remote agents alike. No
per-agent implementation exists or is needed.

### 2.2 The execution pipeline

| Fact | Evidence |
| --- | --- |
| Every Core operation is `ExecutionGuard.run(context, OperationDescriptor, execute)`: authorize all capabilities → approval gate (may only narrow) → re-authorize/revalidate → execute → mark exposure → audit | `src/core/execution/guard.ts` (`OperationDescriptor`, `run`, `runGuarded`) |
| One authorization authority with one global policy per Core (mode + granted capabilities), workspace boundary, protected and secret paths, network policy | `src/core/permissions/engine.ts` (`PermissionEngine.authorize`), `src/core/permissions/policy.ts` |
| Capability services call the guard (27 `guard.run` call sites in `src/core/capabilities/**`); nothing outside the capability services calls it | `grep guard.run src` |
| `crot_status` is the only tool that does not run a guard operation (read-only status, not audited) | `tools.ts` `crot_status` → `core.status()` |
| Approval rules match operation names, capabilities, principal kinds, modes and exposure | `src/core/approvals/rules.ts`, `types.ts` (`principalKinds`) |
| Untrusted-content gate: after a source operation, effect capabilities need approval | `src/core/approvals/exposure.ts` (`EXPOSURE_SOURCES`, `UNTRUSTED_CONTENT_RULES`); AD-12 points 3–4, 9 |
| Commands of remote principals are confined (L1) or refused; local principals fall back to unconfined | `src/core/platform/confinement.ts` (`decideConfinement`), `src/core/capabilities/process/service.ts` (`launcherFor`) |

### 2.3 How a capability is defined today (no registry)

There is no runtime registration or discovery mechanism inside CROT. Adding a
capability is a compile-time change in a fixed set of places:

1. `src/core/permissions/capabilities.ts` — `CAPABILITIES`,
   `CAPABILITY_DESCRIPTIONS`, `ENFORCED_CAPABILITIES` (closed `z.enum`).
2. `src/core/approvals/operations.ts` — `KNOWN_OPERATIONS` (gate rules may only
   name these).
3. `src/core/capabilities/<name>/{schemas,service}.ts` — Zod input schemas and
   a service whose methods call `guard.run`.
4. `src/core/crot-core.ts` — constructor field and wiring in `CrotCore.create`
   (shutdown/terminate hooks where the service owns processes).
5. `src/adapters/mcp/tools.ts` — `TOOLS` entries.
6. Where applicable: `EXPOSURE_SOURCES` / `UNTRUSTED_CONTENT_RULES`
   (`exposure.ts`), `SANDBOX_DEFAULT_CAPABILITIES` (`policy.ts`), the AD-16
   point 17 presets, config sections (`src/core/config/schema.ts`, strict).

Discovery for clients is MCP `tools/list`; discovery of state is
`crot_status` (`CrotStatus` in `crot-core.ts`: capabilities granted/enforced,
shells, browser bridge state, confinement, network policy, approvals).

This matches the contract: ARCHITECTURE.md §5 "New local capabilities are
added as Core capability services that go through the ExecutionGuard, with
their own capability names in the PermissionEngine"; §9 "Specific service
integrations must not be hard-coded into CROT Core unless necessary"; §18 is
the designated runtime-extension path (external MCP servers through
connectors outside Core), post-v1 (AD-13).

### 2.4 What a capability can declare today

| Aspect | Today | Evidence |
| --- | --- | --- |
| Inputs | **Yes**: Core-owned Zod schemas, published through `tools/list`; CROT validates (`INVALID_INPUT`) | `ToolDefinition.inputSchema`; `invokeTool` → `parseInput` |
| Outputs | **Partly**: JSON text, or MCP image content (`encode`); no MCP `outputSchema` / `structuredContent`; browser results are Zod-validated internally | `src/adapters/mcp/results.ts` (`toToolResult`, `toImageToolResult`); `browser/schemas.ts` result schemas |
| Required permissions | **At runtime only**: `OperationDescriptor.capability`; for clients only in description text ("Requires git.read") | `tools.ts` descriptions; `guard.ts` |
| Behaviour hints | **Yes**: MCP annotations (`readOnlyHint`, `destructiveHint`, `openWorldHint`) | `tools.ts` |
| Dependencies (external executables, models) | **No** declaration; executables resolved at call time, `NOT_FOUND` if missing | `ProcessLauncher.resolveCommand` (`src/core/platform/types.ts`); Git/Docker resolve `git`/`docker` from PATH at call time |
| Configuration | **Global only**: one strict config schema; a capability gets config by a schema change | `CrotConfigSchema` (`schema.ts`) |
| Availability | **Only for built-in subsystems**: shells, browser bridge, L1 confinement have status with reason codes; no general mechanism | `CrotStatus.platform.shells`, `.browser`, `.confinement` (reason codes in `platform/types.ts`) |

### 2.5 Limits relevant to media and publishing

| Limit | Value | Evidence |
| --- | --- | --- |
| Foreground command timeout | default 120 s, max 1 h; background processes unlimited (`process_start` + `process_read_output`) | `LimitsSchema` (`schema.ts`), `process/schemas.ts` |
| Captured output per stream | 1 MiB (`maxOutputBytes`) | `LimitsSchema` |
| File read per call | 10 MiB, chunked (`offset`/`length`) | `LimitsSchema.maxReadBytes` |
| `network_request` body | ≤ 1 MiB inline (utf8/base64), agent-supplied headers; no body from a file | `network/schemas.ts` (`MAX_NETWORK_REQUEST_BYTES`) |
| Browser screenshot | ≤ 16 MiB, MCP image content | AD-16 point 13; `tools.ts` `encode: toImageToolResult` |
| Browser upload (decided, not implemented) | workspace files only, immutable staging copy, configured max total size | AD-16 point 11; WP-26 |
| L1 (Linux workspace mode) | host FS read-only except workspace; X11/Wayland/session bus/accessibility bus unreachable; host network | `docs/L1.md`; AD-20 |
| Remote principals, workspace mode, no L1 (macOS/Windows today) | `shell.execute`/`process.manage` refused (`CONFINEMENT_UNAVAILABLE`) | `decideConfinement`; WP-23b/c not started |
| CROT secrets | fixed names (`service-token`, `control-token`, `browser-token`, `http-token`, `device-key`); no user/service credentials | `src/service/secrets/types.ts` (`SECRET_NAMES`) |

## 3. Readiness matrix

Legend: **Ready** — works with current interfaces; **Partial** — works with
named limits; **Missing** — needs work (decided WP, small extension, or AD).
"Remote" assumes the relay chain (WP-29/WP-30/WP-31) exists.

| # | Capability | Local agent | Remote agent | Path today / needed | Class |
| --- | --- | --- | --- | --- | --- |
| 1 | Media metadata (ffprobe JSON) | Partial | Partial (Linux L1 or full_control; refused on macOS/Windows workspace mode) | `process_exec ffprobe …`; no availability report (G1) | no arch change; G1 small |
| 2 | Key-frame extraction | Partial | Partial (as 1) | `ffmpeg` writes images into the workspace; agent can read them only as base64 text, not as MCP image content (G4) | G4 small |
| 3 | Audio extraction / analysis (loudness, silence, waveform) | Partial | Partial (as 1) | ffmpeg filters through `process_exec`; output > 1 MiB → write to file | no arch change |
| 4 | Speech transcription | Partial | Partial (as 1) | an installed CLI and model through `process_start`/`process_read_output`; model detection missing (G1); transcript is externally controlled content but not an exposure source (G5) | G1 small; G5 needs AD if a dedicated op is added |
| 5 | FFmpeg processing (transcode, cut, concat, thumbnail) | Ready | Partial (as 1) | `process_exec`/`process_start`, outputs in workspace | no arch change |
| 6a | Video editors: project files (open/text formats) | Ready | Ready (paths in workspace; else `filesystem.full`) | `fs_*` tools; format knowledge stays in the agent | no arch change |
| 6b | Video editors: CLI render/export | Partial | Partial (as 1) | `process_*`; per-editor availability unknown (G1) | no arch change; G1 |
| 6c | Video editors: scripting API of a running application | Missing (case by case) | Missing | needs a running GUI app and local IPC; from L1 host session sockets are denied, TCP loopback works; per-editor spike | per-editor AD/WP; no Core change expected |
| 6d | Video editors: GUI control | Out of scope | Out of scope | "Never in scope: OS-level input" (roadmap §11, §22) | deeper change — not recommended *(rev. 2: reassessed by OD-22 after WP-69; still out of v1)* |
| 6e | Web-based editors | Missing → Ready after WP-24…27 | same | browser contract v1 | decided WPs |
| 7 | Browser research / collect information | Partial (basic `page_read`, CSS selectors) | Partial | snapshot/refs, waits, frames: WP-24 | decided WPs |
| 8 | Edit content, fill forms | Missing (synthetic `click`/`type` only) | Missing | trusted input, refs: WP-24/25 | decided WPs |
| 9 | Upload files / verify outcome | Missing | Missing | `browser_file_upload` WP-26; waits/screenshots WP-24/25 | decided WPs |
| 10 | YouTube publishing via the web UI (Studio) | Missing → Ready after WP-24…27 | same | analysis (1–5) + agent-written title/description/tags/hashtags + thumbnail (5) + upload (9) + verify (7, 9); **no YouTube-specific CROT code** | decided WPs |
| 11 | YouTube publishing via the Data API | Missing | Missing | needs a CROT-held OAuth credential, streaming body from a workspace file (resumable upload) and a gate for "publish" — none exist (G6) | needs AD; larger |
| 12 | Other external HTTP APIs | Partial | Partial | `network_request` with agent-supplied credentials, ≤ 1 MiB bodies, host policy | no arch change; G6 for credentials |
| 13 | External MCP tools (third-party services) | Missing | Missing | §18 external MCP gateway, post-v1 (AD-13) | decided, post-v1 |
| 14 | Additional capabilities over time | Partial | Partial | compile-time Core services (§2.3); runtime extension only through §18 (post-v1) | no arch change |
| 15 | One workflow across files + media + browser + APIs | Partial → Ready after WP-24…27 | Partial → Ready after WP-24…27, WP-30, WP-31 | separate tool calls through one Core; data passes through workspace files; exposure gate applies across the session (§5.5) | no arch change |

## 4. Gaps with evidence

**G1 — No availability reporting for optional external tools and models.**
Executables are resolved only at call time (`ProcessLauncher.resolveCommand`
throws `NOT_FOUND`); `crot_status` reports shells, browser and L1 only. An
agent (local or remote) cannot learn that FFmpeg, ffprobe, a speech model or
an editor CLI is missing, too old, or unusable in its context, except by
failing. *Requirement:* tasks 1–6 must report missing tools clearly. *Size:*
small, additive (status only).

**G2 — Requirements are not machine-readable for clients.** Required
capabilities appear only in description text; `tools/list` lists every tool
whether or not it is granted or available (`server.ts`, `modern.ts`).
*Requirement:* "capabilities declare permissions and availability". *Size:*
small, additive; optional (status can carry it, see C2).

**G3 — Remote agents cannot run media tools on macOS/Windows in workspace
mode.** `decideConfinement` refuses `shell.execute`/`process.manage` for
remote principals without L1, and WP-23b/c are not started (blocked on OD-9).
FFmpeg/transcription through the shell therefore works remotely only on Linux
with L1 or in `full_control`. This is the intended security behaviour
(AD-13, AD-20), not a defect. A dedicated fixed-operation media capability
running in the service (the AD-3 `docker.use` pattern: fixed arguments,
PATH-only, no shell) would remove the limit, but it would run media parsers
unconfined on possibly untrusted files — a confinement decision that needs an
AD, not a code change.

**G4 — Agents cannot view workspace images.** `fs_read_file` returns base64
text (`ReadFileInputSchema`, `toToolResult`); only `browser_screenshot`
returns MCP image content (`toImageToolResult`). Key frames and generated
thumbnails are therefore invisible to vision-capable agents unless opened in
the browser. *Size:* small (reuse `toImageToolResult` under
`filesystem.read`, size-limited).

**G5 — Untrusted media content is not an exposure source.** AD-12 point 3
lists only browser reads and `network.request` as sources; command output and
file reads are not. Speech in a downloaded video, OCR text or subtitle tracks
can carry prompt-injection content. Through `shell.execute` this is the same
residual as any command output today (no change). If a dedicated
transcription/inspection operation is added, its AD must decide whether it is
a source (AD-12 point 9 already prescribes the mechanism: add the operation
name to `EXPOSURE_SOURCES`).

**G6 — No CROT-held credentials for external HTTP services.** `SECRET_NAMES`
is a closed list of CROT's own secrets; `network_request` takes credentials
only from the agent (headers) and bodies only inline (≤ 1 MiB). The
"credentials are never exposed to the agent" rule exists only for external
MCP servers (§18). A YouTube Data API upload (multi-GB resumable upload with
an OAuth token) is therefore not possible through CROT without the agent
holding the user's token. *Requirement:* task 11. *Size:* larger; needs an AD
(credential broker, file-backed request bodies — an AD-4 extension, publish
gate). Not needed for the web-UI path (row 10).

**G7 — Regression nets have blind spots for new capabilities.**
- `tests/core/approval-rules.test.ts` finds operation names with a regex that
  hard-codes the prefixes `(filesystem|process|git|docker|network|browser)`;
  operations of a new capability prefix would escape the
  `KNOWN_OPERATIONS` check silently.
- No test asserts that every `TOOLS` entry (except `crot_status`) runs
  through the guard (audits an event with an operation from
  `KNOWN_OPERATIONS`); today this holds by review only. `CrotCore` exposes
  `platform`, `guard` and `permissions` as public fields, so a tool could call
  the platform directly without a compile-time error.
- No exhaustive classification test ties every capability to the
  untrusted-content rule (effect vs read): a new effect capability not added
  to `UNTRUSTED_CONTENT_RULES` would run in an exposed session without
  approval — a silent weakening of AD-12.

**G8 — Status records were stale on `main` (fixed in this PR).** After the
merge of PR #16 (`4d574f0`), `STATUS.md` still listed WP-28 under "In review"
and the roadmap §6.1 row said "In review … Done on merge"; roadmap §2.1 still
named WP-23a as the last completed WP.

## 5. Findings per target area

### 5.1 Media tools (FFmpeg, frames, audio, speech, metadata)

Usable now through generic capabilities; the recommended order is: report
availability (C2), let agents see images (C3), then decide by AD whether a
dedicated media capability is worth it. A dedicated capability is justified
only by concrete evidence: remote use on macOS/Windows before WP-23b/c (G3),
structured audit of media operations instead of opaque `process.exec`
records, and exposure marking of transcripts (G5). Long jobs use the existing
background pattern (`process_start` + `process_read_output`), which also keeps
relay requests short (§26 question 13).

### 5.2 Browser workflows

The contract is decided (AD-16) and covers every requested scenario:
research and collection (snapshot/refs, frames, waits), editing and forms
(trusted input, keys, selects), uploads (point 11) and verification
(screenshots of background tabs, waits, history). Nothing in the target list
needs a browser change beyond WP-24…WP-27. One input for WP-26: the
"configured maximum total size" of uploads and the immutable staging copy
must be sized for video files (GB-scale; disk use of the copy).

### 5.3 Publishing (YouTube)

Two different paths, which must not be conflated:

| Path | Needs | Status |
| --- | --- | --- |
| Web UI (YouTube Studio in the user's logged-in browser) | media analysis (shell/FFmpeg), text generation (the agent's model, not CROT), thumbnail (FFmpeg/ImageMagick into the workspace), `browser_file_upload`, form input, verification | No new CROT architecture; WP-24…27. No YouTube-specific code in Core (§9) |
| Data API | CROT-held OAuth credential, streamed resumable upload from a workspace file, publish gate, host policy for Google APIs | G6 — needs an AD; overlaps §18 / §26 question 3; not a v1 item |

Upload and publish are effects on an external service: in an exposed session
they are gated (AD-16 point 17 gates `browser.file_upload` in both presets).

### 5.4 Video editors (no equal depth promised)

Editors differ in what they offer; the integration level is chosen per
editor after a spike, and CROT's contract promises only what that editor
supports:

| Level | Mechanism | CROT today | Notes |
| --- | --- | --- | --- |
| L-a Project files | read/write documented or open project/interchange formats in the workspace | Ready (`fs_*`) | format knowledge belongs to the agent or a later dedicated op; proprietary binary formats are not editable |
| L-b CLI | headless render/export, batch tools | Partial (`process_*`; G1, G3) | same limits as FFmpeg |
| L-c Scripting API | API of a running application (local IPC, sockets, embedded interpreters) | Missing, per editor | needs the GUI app running; L1 denies host session sockets and graphical sessions (AD-20 points 1 and 6), TCP loopback works; may require `full_control`; vendor licence/edition constraints to verify per editor |
| L-d GUI automation | OS-level input, screen reading | Out of scope | roadmap §11 "Never in scope"; would reverse AD-13/§22 — not recommended *(rev. 2: reassessed by OD-22 after WP-69; still out of v1)* |
| L-e Web editors | browser contract v1 | after WP-24…27 | same as any web app |

Examples of which editor offers which level are to be verified in the spike;
this audit does not assume any editor's API.

### 5.5 Combined workflows and the exposure gate

A workflow "analyse video → research in the browser → render thumbnail →
upload → verify" runs as separate tool calls through one Core; data passes
through workspace files, never from the browser directly into local
operations (§9, §19). After the first browser read the session is exposed
(AD-12), so later `shell.execute` (FFmpeg) and `browser.control` steps need
approval in the `require-approval` preset. This is intended. Agents can order
local analysis before browsing; the `autonomous-browser` preset (WP-31) is the
designed answer for less prompting. No change recommended.

### 5.6 Agent independence

Nothing in the target capabilities needs client-specific code: tools are
MCP tools with Core schemas; the agent's model writes titles, descriptions,
tags and hashtags; CROT executes and verifies. Text generation must not move
into CROT (it would bind CROT to a model).

## 6. Minimum necessary changes

| ID | Change | Justified by | Size | AD? | Touches relay/WP-29/30? |
| --- | --- | --- | --- | --- | --- |
| C0 | Sync status records after PR #16 (this PR) | G8 | XS | no | no |
| C1 | Regression tests for extensibility invariants (§8 T1–T4) | G7 | S | no (tests only) | no |
| C2 | Optional-tool availability in `crot_status`: declared external tools (name, PATH-only resolution via `ProcessLauncher.resolveCommand`, optional version probe, reason codes such as `not_found`, `version_unsupported`, `probe_failed`, `confinement_unavailable` for the principal kind), refreshed on `crot_status` like `refreshConfinement()`; models as owner-configured paths | G1, G2 | S–M | short AD or AD addendum recommended (new status contract; which tools are declared is product scope) | no |
| C3 | Image view of workspace image files (MCP image content under `filesystem.read`, size-limited, audit without contents) | G4 | S | no new boundary (existing capability and encoder); document in the WP card | no |
| C4 | Decide a dedicated media capability (inspect/frames/audio/transcribe as fixed operations): confined vs in-service like AD-3; exposure source status; remote defaults; audit fields | G3, G5 | AD first, then M | **yes** | no (works through the existing pipeline) |
| C5 | Credential broker + file-backed request bodies for external HTTP APIs (YouTube Data API) | G6 | L | **yes** (extends AD-4/AD-18; relates to §18, §26 q3) | no |
| C6 | Per-editor integration spikes (L-a/L-b first) | §5.4 | S each | per editor if a dedicated op is proposed | no |

Not proposed: a generic plugin framework, runtime loading of capability code,
a second permission or approval mechanism, GUI automation, YouTube-specific
code in Core, any change to identity, relay or the tunnel.

## 7. Recommended sequence (does not block WP-29/30 or WP-24…27)

1. **Unchanged critical path:** OD-4 AD → WP-29 → WP-30 → WP-31 (chain B);
   **WP-24 → WP-25/26/27** in parallel (chain C) — chain C is the main enabler
   of the target workflows (forms, uploads, YouTube Studio, verification).
2. **Inputs to OD-4 (no scope change):** the tunnel/relay message size must
   carry the largest existing tool results (screenshots up to 16 MiB as MCP
   image content; `fs_read_file` chunks up to 10 MiB, base64-encoded); long
   media jobs use the existing background-process polling, not long requests.
3. **C1 tests** — any time; small, no dependency.
4. **C2 + C3** as one small non-release-blocking WP after C1, in parallel with
   chain B/C; touches only Core status, `tools.ts` and tests.
5. **C4 AD** (docs-only) when media use by remote agents is a product goal;
   take WP-31's remote profile into account (new capabilities need remote
   defaults; adding them before WP-31 enlarges WP-31).
6. **C6 editor spikes** — after C2, independent.
7. **C5** — post-v1 or with the §18 gateway decision; the web-UI publishing
   path does not wait for it.

Scope note: none of C2–C6 is in the v1 release-blocking scope (AD-13,
roadmap §6.1). Making any of them release-blocking needs an explicit scope
decision.

## 8. Tests that should protect existing behaviour

| ID | Test | Protects |
| --- | --- | --- |
| T1 | For every `TOOLS` entry except `crot_status`: with a policy that grants nothing, a call with minimal valid input is denied and writes exactly one `denied` audit event whose `operation` is in `KNOWN_OPERATIONS`, for stdio, loopback HTTP and the relay entry point | §2.3 "no path bypasses the pipeline" (G7) |
| T2 | Static check: `src/adapters/**` never references `core.platform`, `core.guard` or `core.permissions` from a tool `call` | adapters stay declarations (G7) |
| T3 | `KNOWN_OPERATIONS` test derives prefixes from `CAPABILITIES` instead of a hard-coded regex | new capability operations are covered (G7) |
| T4 | Exhaustive capability classification: every capability is listed as read, effect or source; every effect capability appears in `UNTRUSTED_CONTENT_RULES`, every source operation in `EXPOSURE_SOURCES` | AD-12 cannot silently weaken |
| T5 | `full_control` grants every capability including new ones; sandbox defaults unchanged; explicit `capabilities` lists unchanged | full-control mode and existing configs |
| T6 | Remote principal without L1: new command-running operations are refused like `shell.execute` (or as their AD decides) | AD-13/AD-20 refusal-only fallback |
| T7 | Availability report never resolves through the current directory, never runs a shell, and is identical for local and remote except for the confinement reason | C2 safety |
| T8 | Audit events of media/upload operations contain paths and sizes only, never frames, transcripts or file contents | §12, AD-16 point 15 |
| Existing | `tests/adapters/{mcp,http,http-modern}.test.ts` (same tools), `tests/core/{approval-gates,session-exposure,permissions,secret-paths,protected-paths}.test.ts`, `tests/service/tray-control.test.ts` (relay with real verifier), `tests/identity/*` | unchanged behaviour |

## 9. Compatibility and regression risks

- **Capability enum growth.** A new capability is granted automatically in
  `full_control` (`defaultCapabilities`) — consistent with full control —
  but not in sandbox mode or explicit lists. Older CROT versions reject a
  config naming an unknown capability (strict schema): downgrade risk.
- **AD-12 weakening** if an effect capability is not added to
  `UNTRUSTED_CONTENT_RULES` (T4).
- **Presets.** AD-16 point 17 lists gated operations explicitly
  (`browser.file_upload`, Docker Compose); publish-like operations added later
  must be reviewed against both presets.
- **Confinement model.** Running media parsers in the service (to remove G3)
  changes who is confined; AD-only.
- **Remote profile (WP-31).** Every new capability needs a remote default;
  adding capabilities before WP-31 enlarges WP-31.
- **Tool count.** Every `TOOLS` entry is listed to every client; a large
  catalogue costs client context and can hit client tool limits — prefer few
  general operations over one tool per editor or service.
- **Relay sizes and duration.** Large image results and long jobs (point 7.2).
- **Upload size.** WP-26's staging copy doubles disk use for large videos.
- **Credentials.** Until C5 exists, any API workflow passes user tokens
  through the agent; documentation must say so.

## 10. Recommendation

**Small targeted extension of the existing architecture.** Keep Core, MCP,
relay, identity and permissions as they are. Next implementation task
candidates, in order: (1) C1 regression tests (no AD, independent of every
chain); (2) C2 + C3 (availability reporting and image view) as one small WP;
(3) the C4 AD when remote media use becomes a product goal. Browser
capability work stays WP-24…WP-27 and the remote chain stays OD-4 → WP-29 →
WP-30 → WP-31; neither is blocked by anything in this audit.
