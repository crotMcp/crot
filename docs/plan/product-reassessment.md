# CROT — Product reassessment: expanded goal, decisions and order of work

Status: **proposal** (documentation only). Nothing here is implemented. It
changes no accepted AD; every boundary change is listed as an open decision
(OD-15…OD-23) that needs an AD in ARCHITECTURE.md §27 before its work
packages start (AGENTS.md "Decision before code").

- **Audited tree:** `main` at `4d574f0` (WP-28 merged, crot-mcp PR #16) plus
  the open documentation PR #17 (`docs/design/extensibility-audit.md`), on
  which this change builds. Open PRs at the time of writing: #17 only.
- **Companion documents:**
  - [`docs/design/extensibility-audit.md`](../design/extensibility-audit.md) —
    code facts and gaps (revision 2 lists what changed);
  - [`docs/design/media-and-editors.md`](../design/media-and-editors.md) —
    media operations, quality criteria, per-editor integration matrix;
  - [`docs/design/integration-map.md`](../design/integration-map.md) —
    YouTube, ElevenLabs, TikTok, Canva, other APIs; credential models;
    connector contract;
  - [`docs/plan/extension-work-packages.md`](extension-work-packages.md) —
    cards WP-41…WP-70;
  - [`CROT_IMPLEMENTATION_ROADMAP.md`](../../CROT_IMPLEMENTATION_ROADMAP.md)
    §2.7, §4.2, §6.1, §8 — summary rows, dependencies, critical path.

## 1. Conclusion

The current architecture fits the expanded goal **without a rewrite of
Core, MCP, Cloud Relay, identity or permissions**. The expanded goal adds
four things the contracts do not cover yet, and each is a bounded addition
behind the existing ExecutionGuard / PermissionEngine / audit pipeline.
The one Core, the one permission check and the one execution environment
stay the foundation for every transport and every new capability; no
addition gets its own permission path, its own executor or Core code per
service or editor (WP-41 makes this a regression test):

1. **Long-running jobs and artifacts** (render, transcription, uploads):
   today only background processes have state (`process_start` /
   `process_read_output`), and they block a Core replacement
   (`src/service/core-holder.ts`, AD-19 point 5). → OD-15.
2. **Dedicated media operations** (inspect, frames, audio, speech, render
   from an edit description, verification) instead of free-form shell
   commands — needed for reliable autonomous editing, structured audit,
   exposure marking of transcripts and remote use. → OD-16, OD-17, OD-18.
3. **External service connections** (credentials held outside the agent,
   per-connection grants, file-backed uploads, async status) — today
   `network_request` takes credentials from the agent and bodies ≤ 1 MiB
   inline. → OD-19, OD-20.
4. **Application integration** beyond files and CLIs (editor scripting
   bridges, and possibly scoped desktop application control, which the
   roadmap today lists as "never in scope"). → OD-21, OD-22.

Remote access stays the product's key advantage and its v1 chain is
unchanged: none of the additions moves execution into the relay; media and
service traffic stay on the device; the agent orchestrates through tool
calls. Recommended release staging (OD-23): **v1 = remote access + browser
contract v1 as decided (AD-13/AD-14)**, with the cheap extension foundation
built in parallel (WP-41, WP-42 now; WP-43, WP-44 after OD-16/OD-15 ADs;
§8); media (v1.1), integrations (v1.2) and
editors/application control (v1.3+) follow as separate milestones that never
block v1.

## 2. State of the work (separated)

### 2.1 Implemented and tested (on `main`)

Core pipeline (ExecutionGuard → PermissionEngine → approvals → audit),
filesystem, shell/process (foreground and background), `git.read`,
`git.write`, `docker.use`, `network.access` with host policy, basic browser
commands (Chromium), approval gates and the untrusted-content exposure rule
(AD-12), stdio and loopback HTTP including sessionless MCP 2026-07-28
(AD-15), the supervised service with shim and control channel (AD-17), OS
secret storage and child environment allowlist (AD-18), tray v1 (AD-19), L1
on Ubuntu 22.04/24.04 (AD-20), the device side of identity and device
binding (AD-21, WP-28). `npm run check` on `4d574f0`: 1187 tests passed,
99 skipped; extension 64 passed.

### 2.2 Stated, but not confirmed by an implementation or a test

| Statement | Where | Fact |
| --- | --- | --- |
| "Python, Node.js, FFmpeg, project tools — usable through `shell.execute`" | ARCHITECTURE.md §5 | plausible, but **no test exercises FFmpeg/ffprobe** (no reference in `tests/`); remote use on macOS/Windows in workspace mode is refused until L1 exists there |
| "content workflows such as preparing and publishing a video through a web service" | ARCHITECTURE.md §9 | **not possible yet**: needs browser upload (WP-26) and trusted input (WP-24) |
| Identity works with WorkOS AuthKit | `docs/IDENTITY.md` | tested **only against an in-process emulator**; no live environment (WP-38) |
| "CROT combines … external MCP-compatible services" | ARCHITECTURE.md §1, §17 | target, post-v1 (§18, AD-13) |

### 2.3 Planned (roadmap v1 work packages)

WP-24…WP-27 (browser contract v1), OD-4 → WP-29, WP-30, WP-31, WP-38,
WP-32, WP-33 (remote chain), WP-23b/c (L1 macOS/Windows, blocked by OD-9),
WP-34…WP-37, WP-39, WP-40, WP-19b.

### 2.4 New requirements not covered by architecture or contracts

Media operations with quality criteria; edit descriptions and rendering;
speech-to-text and text-to-speech; video-editor projects and applications;
external service connections (YouTube, ElevenLabs, TikTok, Canva, others)
with consent, scopes and revocation; publishing gates; long-running jobs
with progress and results; availability of optional tools and models;
images and previews for vision-capable agents.

### 2.5 Limits that need a separate decision

| Limit | Source | Decision |
| --- | --- | --- |
| "Never in scope: remote desktop, screen streaming, OS-level input" | roadmap §11; ARCHITECTURE.md §22 "Not a remote desktop"; AD-13 point 4 | OD-22 reassesses **application control** (not remote desktop) |
| Graphical sessions unreachable from L1 | AD-20 points 1, 6 | OD-21/OD-22: editors run outside L1; grant model needed |
| Remote commands refused without L1 (macOS/Windows) | AD-13, AD-20 point 11, `decideConfinement` | OD-17 (placement of media operations); raises priority of OD-9 / WP-23b/c |
| External MCP gateway post-v1 | AD-13 point 7 | OD-19 decides its relation to connectors; stays post-v1 |
| MCP Tasks extension post-v1 | roadmap §11 | OD-15: jobs at tool level, client-independent |
| No provider client secret on devices | AD-21 point 4 (identity) | OD-20 applies the same reasoning to service OAuth |
| Closed capability vocabulary | `src/core/permissions/capabilities.ts` | OD-17, OD-19: new capability names; per-connection grants as policy data, not new enum values per service |

## 3. How the parts relate

| Relation | Finding | Consequence |
| --- | --- | --- |
| Transport/relay ↔ long jobs | relay requests should stay short (§26 q13); renders and uploads take minutes to hours | jobs (OD-15) make every call short; OD-4 must fix message size ≥ the largest tool result (16 MiB screenshots, 10 MiB file chunks base64) |
| Relay ↔ media data | media files are GB-scale | **data stays on the device**: agents get metadata, previews and artifact references; uploads go device → service. Relay unchanged |
| Local ↔ remote execution | one catalogue and one path (`invokeTool`), principal kind differs | new capabilities need remote defaults in WP-31's profile; remote media on macOS/Windows depends on WP-23b/c or on OD-17 placement |
| Browser ↔ integrations | publishing and design services often have features only in their web UI | every integration has an API path and a browser path; the browser contract v1 (WP-24…27) is a prerequisite for scenario D and the fallback of A |
| Media ↔ editors | editors need the same inspection, render and verification | the CROT edit description (OD-18) is the hub: rendered by CROT, exported to editors by interchange formats, applied through bridges |
| Integrations ↔ authorization | service tokens are user credentials | stored on the device (OD-20), injected by CROT, never returned to the agent, never through the relay |
| Extensibility ↔ Core | adding a capability is a compile-time change in ~6 places (audit §2.3) | acceptable for first-party media/connector runtime; **new services become data** (connector manifests, OD-19), not Core code |

## 4. End-to-end scenarios

Each scenario lists required capabilities, blockers, dependencies and a
definition of ready. "Ready" means: runs end-to-end from a local **and** a
remote agent through the same tools, with audit and gates as specified.

### Scenario A — create and publish a video

- **Steps:** inspect sources → extract frames/audio/speech → plan structure
  (agent) → edit description → render → QC and fix → thumbnail → metadata
  (agent) → publish (API or browser) → verify status.
- **Capabilities:** media inspect/frames (WP-49), audio (WP-50), speech
  (WP-51), edit spec + render (WP-52…54), QC (WP-55), presets (WP-56),
  image view (WP-42), jobs (WP-44), YouTube connector (WP-59) **or**
  browser upload (WP-24…26), publish gate (OD-19).
- **Blockers today:** no jobs; no structured media operations; no service
  credentials; no browser upload.
- **Ready when:** a fixture project (≥ 3 clips, music, speech) becomes a
  rendered 16:9 video that passes WP-55 QC; a thumbnail 1280×720 is
  produced; the video is uploaded as **private** to a test channel (API
  path) or through YouTube Studio (browser path); the agent reports the
  publication state of integration-map.md §3.2 (`submitted` →
  `processing` → `published` → `verified`, never "published" on the upload
  response alone) with read-back of metadata, thumbnail and captions;
  publishing to public needed the user's approval and is verified by an
  anonymous fetch; the editing part passes loop scenarios L1–L3 of
  media-and-editors.md §4.1; audit shows every step without contents.

### Scenario B — audio and voice-over

- **Steps:** analyse audio (loudness, silence, speech) → transcribe → edit
  text (agent) → synthesize speech (ElevenLabs or a local TTS) → align and
  mix with video (ducking) → verify.
- **Capabilities:** WP-50, WP-51, ElevenLabs connector (WP-58) on the
  connector runtime (WP-45…47), render with voice-over track (WP-54), QC
  (WP-55).
- **Blockers today:** no TTS path without the agent holding an API key; no
  alignment/mixing operations.
- **Ready when:** a 60 s fixture gets a synthesized voice-over whose segment
  starts are within ±100 ms of the planned times, music ducked by a
  configured amount under speech, integrated loudness within ±1 LU of the
  target, and the TTS call was made with a device-held credential that the
  agent never saw.

### Scenario C — work in a video editor

- **Steps:** open or create a project → change it (cuts, order, tracks,
  titles) → save → render/export → verify the export.
- **Capabilities (per editor, see media-and-editors.md §4):** MLT projects
  (Kdenlive/Shotcut) through files + `melt` (WP-67); interchange export to
  Resolve/Premiere/Final Cut (WP-66); a scripting bridge for one editor
  (WP-68, OD-21); GUI control only if OD-22 accepts it (WP-70).
- **Blockers today:** no project adapters; graphical sessions not reachable
  from L1; no bridge contract.
- **Ready when (per supported editor, at its documented level):** the
  editor scenarios E1–E8 of media-and-editors.md §5.1 that the level
  promises pass in a recorded run (editor version, edition, OS, date), the
  export passes WP-55 against the edit description, and unsupported
  operations are reported, never silently approximated. An editor without
  such a record is not supported, whatever the matrix says.

### Scenario D — browser and external services

- **Steps:** research → collect material into the workspace → edit content
  in a web app → fill forms → upload → verify completion; combine with API
  calls and local media.
- **Capabilities:** WP-24…27; connector runtime (WP-46/47) for APIs;
  exposure/gates (AD-12, AD-16 point 17).
- **Blockers today:** browser contract v1 not implemented.
- **Ready when:** WP-32's browser acceptance scenarios pass, plus one mixed
  scenario (download → local processing → upload through a form → API read
  back of the result).

### Scenario E — extend the system with a new API service

- **Contract that must make this a non-Core change (OD-19):** a connector
  manifest (service id, base URL and allowed hosts, auth scheme, scopes,
  rate-limit hints, optional typed operations with JSON Schemas and an
  effect class read/write/publish) + a user-created connection with a
  device-held credential. The generic tools (`service_*`) run every call
  through the ExecutionGuard with one capability set and per-connection
  policy; results are exposure sources.
- **Exceptions that still need code (and possibly an AD):** a new auth
  scheme (e.g. request signing), a new upload protocol, streaming protocols
  (WebSocket, gRPC), services that require a confidential client (cloud
  broker, OD-20), services reachable only through their web UI (browser
  path) or only through a desktop app (OD-21/22).
- **Ready when:** a fixture REST service (local test server) is added by a
  manifest only — no change in `src/core` or the relay — and passes the
  connector contract tests (auth injection, host binding, no credential in
  results or audit, rate-limit and retry behaviour, async job polling).

## 5. Open decisions (each needs an AD before its WPs)

Format: question · options · trade-offs · security and operations ·
recommended direction · dependent WPs. The recommendation is a direction for
the AD author, not a decision.

### OD-4 (existing) — relay–device tunnel protocol: additional inputs

Unchanged scope; add: message size ≥ largest tool result; no media payloads
through the relay by design; long work is a job (OD-15), so the tunnel does
not need multi-hour requests. Depends: — · Blocks: WP-29.

### OD-15 — Long-running jobs and artifacts

- **Question:** how does an agent start, observe, cancel and collect the
  result of work that outlives one request (render, transcription, upload,
  service-side async jobs)?
- **Options:** (a) keep only background processes; (b) a Core job registry
  with tool-level `job_status` / `job_result` / `job_cancel`, results as
  workspace artifacts with previews; (c) the MCP Tasks extension.
- **Trade-offs:** (a) no structure, no service jobs; (b) client-independent,
  works through any relay, needs persistence rules; (c) not supported by all
  clients, post-v1 in the roadmap.
- **Security/operations:** a job is one guard operation (authorized and
  audited at start; cancel/result are guard operations of the same
  principal/scope); approval happens before start, not mid-job; jobs count
  as Core activity (AD-19 point 5); bounded number and retention; what
  survives a service restart (recommend: state survives as "interrupted",
  never resumed silently).
- **Recommended:** (b), with an optional later mapping to MCP Tasks.
- **Dependent:** WP-44 → WP-47, WP-50…WP-55, WP-57…WP-59.

### OD-16 — Optional components: declaration, detection, provisioning

- **Question:** how are external executables (FFmpeg, ffprobe, ASR engines,
  `melt`, Blender, editor CLIs) and model files declared, found, versioned
  and reported; who installs them?
- **Options:** (a) PATH lookup at call time (today); (b) declared components
  with PATH-only detection, version probe and reason codes in `crot_status`,
  installed by the user; (c) (b) plus CROT-managed downloads with pinned
  checksums (supply chain, WP-34).
- **Trade-offs:** (a) failures only at call time; (b) small, predictable;
  (c) better UX, larger supply-chain surface and licence questions (FFmpeg
  builds with GPL/non-free codecs, model licences).
- **Security/operations:** never resolve from the current directory, never
  run a shell; model paths only from owner configuration; component
  versions in audit details.
- **Recommended:** (b) now; (c) decided separately with WP-34.
- **Dependent:** WP-43, WP-49…WP-51, WP-65…WP-68.

### OD-17 — Media capability

- **Question:** capability names, fixed operation set, where media tools
  run, which results are exposure sources, remote defaults.
- **Options for placement:** (a) only through `shell.execute` (today);
  (b) dedicated fixed operations launched through the L1 launcher when
  available, refused for remote principals without L1 (like shell);
  (c) dedicated fixed operations run in the service like `docker.use`
  (AD-3), unconfined, on any OS.
- **Trade-offs:** (a) no structure or verification; (b) safest, but remote
  media on macOS/Windows waits for WP-23b/c; (c) works everywhere, but runs
  media parsers on possibly hostile files outside any sandbox.
- **Security/operations:** CROT builds every FFmpeg argument list (no
  agent-supplied filtergraphs or protocols; `-protocol_whitelist file`;
  inputs and outputs resolved by workspace rules); transcripts, OCR and
  subtitle tracks are exposure sources (AD-12 point 9 mechanism); effects
  (writing outputs) are `filesystem.write`-equivalent and gated in exposed
  sessions; resource limits (time, output size, concurrency); audit records
  paths, sizes, durations, never contents.
- **Recommended:** two capabilities, `media.read` (inspect, frames,
  analysis, transcription) and `media.process` (extract, transform, render,
  synthesize locally); placement (b); revisit (c) only with an explicit owner
  opt-in after a security review.
- **Dependent:** WP-49…WP-57; affects WP-31 (remote defaults).

### OD-18 — Edit description and render engine

- **Question:** the format an agent writes to describe an edit, and what
  renders it.
- **Options:** (a) OpenTimelineIO (OTIO) subset + CROT effects schema;
  (b) CROT JSON edit spec with export to OTIO/FCPXML/MLT; (c) MLT XML as the
  native format; renderer FFmpeg filtergraph (built by CROT) or MLT `melt`.
- **Trade-offs:** OTIO is an interchange standard but has no render
  semantics for effects; a CROT spec can be validated strictly and rendered
  deterministically; MLT renders well but ties CROT to one framework.
- **Editing model (part of the decision):** the description is a saved,
  versioned project, not a one-shot render input — stable item ids, edit
  operations as atomic patches against a revision, history/undo/diff, and
  QC findings that reference item ids, so the full loop of
  media-and-editors.md §4.1 (select → create → change → save → render →
  verify → correct) works without hand-written engine commands.
- **Security/operations:** spec is data; only validated, allowlisted
  operations; render manifest (inputs' digests, toolchain versions) for
  reproducibility.
- **Recommended:** (b) with a strict JSON Schema, FFmpeg as the first
  renderer, exports to OTIO/FCPXML/MLT (WP-66); decide after a short spike.
- **Dependent:** WP-52…WP-56, WP-66, WP-67.

### OD-19 — Service integration contract (connectors)

- **Question:** how CROT talks to external APIs without per-service Core
  code; how grants and gates look; relation to the external MCP gateway (§18).
- **Options:** (a) agent-driven `network_request` (today); (b) declarative
  connector manifests + generic `service_*` tools + per-connection policy;
  (c) per-service code adapters in Core; (d) external MCP servers of vendors
  through §18.
- **Trade-offs:** (a) credentials pass through the agent; (b) one runtime,
  services as data, needs a careful manifest schema; (c) contradicts §9;
  (d) least CROT work where a vendor server exists, but tool semantics are
  untrusted and coverage varies.
- **Security/operations:** connections are created only by the user
  (tray/CLI), never by an agent; requests only to the connection's hosts;
  credentials injected by CROT, never returned; responses are exposure
  sources; quotas, retries with backoff and idempotency keys; audit records
  connection, operation, status, sizes. Least privilege: scopes and effect
  class declared per operation, a connection grants a subset, raw requests
  are a separate grant. Publish control: `service.publish` is never implied
  by write, a preset or `full_control`; every publish action is approved
  with connection, account, item and visibility named (standing grants: to
  decide here). Publication is reported as states
  (`submitted`/`processing`/`published`/`verified`/`failed`) established by
  read-back, never from the API response alone (integration-map.md §3.1,
  §3.2).
- **Recommended:** (b) as the primary path; (d) stays post-v1 and plugs into
  the same grants when built; capabilities `service.read`, `service.write`,
  `service.publish` plus `permissions.services` per connection (decides part
  of §26 question 3).
- **Dependent:** WP-46, WP-47, WP-58…WP-64.

### OD-20 — Credentials for external services

- **Question:** where service credentials live and who owns the OAuth apps.
- **Options:** M1 agent-held; M2 device vault (OS secret store, AD-18) with
  public-client OAuth (PKCE) and API keys; M3 CROT cloud broker holding
  refresh tokens/client secrets; M4 vendor MCP servers (their own auth);
  M5 user-owned OAuth app credentials in the device vault; M6 the user's
  browser session (browser path). Details: integration-map.md §2.
- **Trade-offs:** M2 keeps tokens on the device and out of the relay, but
  cannot serve services that require a confidential client; M3 serves them
  but makes CROT's cloud a high-value store of user tokens and the
  responsible app owner; M5 avoids CROT verification but is poor UX; M6
  needs no API approval but is fragile and may conflict with terms.
- **Security/operations:** consent per connection and scope (minimal scopes,
  incremental consent); one secret per connection, readable only by the
  connector runtime (never in environment, child processes, workspace,
  audit, results, logs or the relay, so the agent's shell cannot reach it);
  revocation in the tray takes effect on the next request and cancels
  running jobs (local delete + provider revocation where offered); provider
  revocation detected on refresh; device removal removes its connections;
  refresh on the device.
- **Recommended:** M2 as default, M5 as an advanced option, M6 as fallback;
  M3 only per service where a confidential client is unavoidable, with its
  own security review (likely TikTok; verify Canva).
- **Dependent:** WP-45, WP-48, WP-58…WP-63.

### OD-21 — Application bridges (editors)

- **Question:** how CROT drives an application that offers a scripting API
  only inside the running app (e.g. Resolve, Premiere UXP, Blender).
- **Options:** (a) the agent runs vendor scripts through the shell;
  (b) a CROT-owned bridge (plugin/script inside the app) with a fixed command
  set over authenticated local IPC — the browser-extension pattern;
  (c) GUI control (OD-22).
- **Trade-offs:** (a) arbitrary code in the app, no structure; (b) bounded
  and auditable, one bridge per editor; (c) generic but fragile.
- **Security/operations:** bridge authenticates like the browser bridge
  (token in the secret store); commands are guard operations
  (`app.use` or editor-specific operation names); apps run outside L1 → only
  with an explicit owner grant per application.
- **Recommended:** (b) for one editor chosen by the spike WP-65.
- **Dependent:** WP-68.

### OD-22 — Desktop application control (reassessing "OS-level input")

- **Question:** should CROT control desktop applications that offer no API
  (GUI automation), and on what terms?
- **Why reassess:** the expanded goal requires autonomous work in
  applications; some editors and publishing tools have no usable API. The
  existing prohibition was set for v1 (no remote desktop, no hidden access)
  and is kept for v1.
- **Options:** (a) keep the prohibition; (b) scoped application control:
  per-application grant, accessibility tree (UI Automation / AX / AT-SPI) as
  the primary model, input only to the granted application's windows,
  screenshots of those windows only (exposure source), approval for effects,
  visible indicator and kill switch, no screen streaming; (c) full desktop
  control — rejected (it is a remote desktop).
- **Trade-offs:** (b) enables GUI-only apps but is per-OS work with real
  limits (macOS privacy permissions, Wayland input restrictions, Windows
  UIPI); fragile against UI changes.
- **Security/operations:** OS input can reach other windows if focus moves;
  typed secrets; cannot be confined by L1; needs explicit opt-in for remote
  principals.
- **Recommended:** keep (a) for v1; spike WP-69; decide (b) by AD after the
  spike, post-v1.
- **Dependent:** WP-70.

### OD-23 — Release staging (product decision)

- **Question:** which of the new capabilities are release-blocking for v1.
- **Options:** (a) v1 unchanged, new work as v1.1/v1.2/v1.3 milestones;
  (b) add media (phase 6) to v1; (c) add media and integrations to v1.
- **Trade-offs:** (b)/(c) delay the remote-access release by several
  L-sized chains and add new security review scope (WP-33).
- **Recommended:** (a); start phase 5 now in parallel because it de-risks
  OD-4 and WP-31.

## 6. Order of work

### 6.1 Critical paths

- **v1 (unchanged, critical):** OD-4 → WP-29 → WP-30 → WP-31 → WP-32 →
  WP-33 → WP-40 (with WP-38, WP-34, WP-36, WP-39 around it).
- **Browser (raised priority, parallel):** WP-24 → WP-25 / WP-26 / WP-27.
  Prerequisite of scenario D and the browser path of A.
- **L1 macOS/Windows:** OD-9 → WP-23b / WP-23c — now also a prerequisite of
  remote media on those OS (OD-17 (b)).
- **Media milestone (v1.1):** WP-41, WP-42 (no open contract, start now);
  OD-16 → WP-43; OD-15 → WP-44; OD-17 + WP-42 + WP-43 → WP-49 → WP-50,
  WP-51 (+WP-44); OD-18 → WP-52 → WP-53 → WP-55 → WP-54, WP-56 → WP-57.
- **Integrations milestone (v1.2):** OD-19, OD-20 → WP-45 → WP-46 → WP-47 →
  WP-58 (ElevenLabs; simplest auth) → WP-48 → WP-59 (YouTube) → WP-64;
  WP-60/WP-62 spikes any time → WP-61/WP-63 if feasible.
- **Editors and applications (v1.3+):** WP-65 stage 1 (research, now);
  WP-52 → WP-65 stage 2 (scenario runs) → WP-66 → WP-67; OD-21 → WP-68;
  WP-69 spike → OD-22 → WP-70.

### 6.2 Parallelism

Foundation WP-41 and WP-42 depend on no open contract (see §8) and can
start now next to OD-4 and WP-24. AD drafting for OD-15…OD-20 is documentation work and runs in
parallel with WP-29. Service spikes (WP-60, WP-62) and the editor spike
(WP-65) need test accounts and installed applications, not code in `src/`.

### 6.3 What must come before complex integrations

WP-41 (invariant tests), WP-43 (availability), WP-44 (jobs), WP-45/46
(connections and runtime) and the remote defaults of new capabilities in
WP-31. Without them every integration would invent its own credential
handling, polling and error reporting.

### 6.4 Research and prototypes

WP-60 (TikTok), WP-62 (Canva), WP-65 (editors), WP-69 (desktop control), a
short OD-18 spike (edit spec + FFmpeg render of 3 operations), and live
verification of YouTube upload limits and app-verification requirements as
part of WP-59's first step.

## 7. Risks and unknowns

| Risk / unknown | Impact | How it is resolved |
| --- | --- | --- |
| Vendor API facts in integration-map.md are from vendor documentation, **not verified by CROT** | wrong scope of connectors | spike/first step of each connector WP with a test account |
| App verification / audits (Google OAuth verification and YouTube API audit; TikTok Direct Post audit; Canva public integration review) | publishing may be restricted to private/draft until approved; lead time | start applications early; CROT acts as app owner only under M3/M2-with-CROT-client-id (OD-20) |
| API quotas (e.g. YouTube upload cost) | few uploads per day per project | quota reporting in connector status; M5 (user-owned project) option |
| Hostile media files (parser vulnerabilities) | code execution in media tools | OD-17 placement (b): confined; pinned/updated components |
| Prompt injection through speech, subtitles, OCR, service responses | agent manipulation | exposure sources (AD-12) |
| GUI automation fragility and OS restrictions | low reliability | spike before AD; not in v1 |
| Disk use (staging copies, renders, proxies) | full disks | artifact retention limits (OD-15), WP-26 size limits |
| Licences (FFmpeg builds, ASR/TTS models, editor licences, voice cloning consent) | legal | OD-16 (user-installed first), WP-37, consent gate for voice cloning |
| Scope growth delays v1 | late remote release | OD-23 (a): new milestones never block v1 |
| API success taken as publication (processing failure, policy rejection, wrong visibility) | false "published" reports to user and agent | publication states and read-back verification (integration-map.md §3.2) in every publishing connector's acceptance |
| Editor "support" claimed from documentation or a matrix row | users rely on integrations that do not work | support only by recorded E1–E8 runs (media-and-editors.md §5.1) |
| Implementation starts ahead of an AD (e.g. job or capability shapes invented in an early WP) | contracts fixed by accident, rework | research vs implementation rule (extension-work-packages.md); §8 start gates |
| Token leakage through the agent's own tools (shell, network) | credential theft by a manipulated agent | per-connection secrets readable only by the connector runtime (integration-map.md §3.1); WP-45 tests |

## 8. Ready to issue

Rule: research may start before the AD it informs; implementation of a
contract (tool schema, capability, persistence format, protocol, manifest
schema) only after that AD is accepted.

| Item | Kind | Open contracts it touches | May start now | Must wait for |
| --- | --- | --- | --- | --- |
| WP-41 invariant tests | implementation (tests only) | none — tests existing guard, operations and capability tables | yes | — (new capabilities later extend its tables) |
| WP-42 workspace image view | implementation | none if kept to: existing `filesystem.read`, no new capability, no job, no component, no downscale, fixed size constant | yes, within these limits | downscale/conversion → OD-16 + WP-49; size limit is an input to OD-4, not decided here |
| WP-43 components | implementation | OD-16 (declaration, reason codes, status fields) | no | OD-16 AD |
| WP-44 jobs | implementation | OD-15 (tool names, persistence, retention) | no | OD-15 AD |
| WP-49 media inspect | implementation | OD-17 (capabilities, placement) | no | OD-17 AD, WP-42, WP-43 |
| WP-45…48 connections/runtime | implementation | OD-19, OD-20 | no | OD-19/OD-20 ADs |
| OD-18 spike | research (throwaway outside `main`) | informs OD-18 | yes | — |
| WP-60 TikTok, WP-62 Canva | research | inform OD-20 (M3) and WP-61/63 | yes (developer accounts) | — |
| WP-65 stage 1 editors | research | informs OD-21 | yes | stage 2 waits for WP-52 |
| WP-69 desktop control | research (throwaway outside `main`) | informs OD-22 | yes | — |

- **Implementation that may start now:** WP-41, WP-42 (within the limits
  above).
- **Research that may start now:** WP-60, WP-62, WP-65 stage 1, WP-69, the
  OD-18 spike; AD drafting for OD-15…OD-20, OD-23.
- **Decisions to accept first:** OD-4 (with the inputs above) for WP-29;
  OD-15, OD-16, OD-17 before any media implementation (WP-43, WP-44,
  WP-49); OD-19, OD-20 before any connector implementation; OD-23 to confirm
  staging.
