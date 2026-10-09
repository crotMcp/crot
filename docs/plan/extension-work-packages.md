# CROT — Extension work packages (WP-41…WP-70)

Status: **proposed** cards for the expanded product goal
([`docs/plan/product-reassessment.md`](product-reassessment.md)). Order,
dependencies and status are summarised in
[`CROT_IMPLEMENTATION_ROADMAP.md`](../../CROT_IMPLEMENTATION_ROADMAP.md)
§6.1 and §8. None of these WPs is release-blocking for v1 (OD-23 option (a));
none may block or change the v1 chain.

Common rules: those of
[`crot-agent-work-packages.md`](crot-agent-work-packages.md) and roadmap §6.2
apply. In addition: every new operation goes through the ExecutionGuard,
is listed in `KNOWN_OPERATIONS`, is classified for the untrusted-content
rule (source / effect / read) and has a remote default for WP-31; audit
never contains media contents, transcripts, tokens or response bodies; a WP
whose "Depends" lists an OD starts only after that OD's AD is accepted.

**Research vs implementation.** Research (spikes, reading terms, test
accounts, throwaway prototypes outside `main`, AD drafts) may start before
the AD it informs. Implementation of a contract — a tool schema, a
capability, a persistence format, a protocol, a manifest schema — starts
only after the AD that fixes it is accepted. A WP marked "Depends: —"
must not create or anticipate such a contract (product-reassessment.md §8
lists what each early WP may and may not touch).

**Evidence over claims.** "Supported" (an editor, a service, a scenario)
means a recorded, repeatable scenario run passed, with the product
version/edition, OS and date; a matrix row or a vendor statement is not
support.

Card format: **Goal** · **Problem** · **Depends** · **Scope / not in
scope** · **Requirements** · **Acceptance** · **Tests** · **Risks /
questions** · size.

---

## Phase 5 — Extension foundation

### WP-41 — Extensibility invariant tests

- **Goal:** regression nets that keep every new capability on the one
  pipeline. **Problem:** guard pass-through and AD-12 classification hold
  by review only (extensibility-audit.md G7).
- **Depends:** —. **Scope:** tests only (T1–T5 of the audit); no
  production code. **Not:** new tools.
- **Requirements:** T1 every `TOOLS` entry except `crot_status` denied with
  an empty grant writes one `denied` audit event with a known operation, on
  stdio, loopback HTTP and the relay entry point; T2 static check that tool
  `call`s reference only Core services; T3 `KNOWN_OPERATIONS` prefixes from
  `CAPABILITIES`; T4 exhaustive capability classification table; T5
  full_control grants all capabilities, sandbox defaults unchanged.
- **Acceptance:** tests fail when a test tool bypasses the guard or a new
  effect capability is not in `UNTRUSTED_CONTENT_RULES`; `npm run check`
  passes. **Tests:** the above. **Risks:** none. Size S.

### WP-42 — Workspace image view

- **Goal:** vision-capable agents see frames and thumbnails. **Problem:**
  only browser screenshots return MCP image content (audit G4).
- **Depends:** — (no open contract). **Scope:** one read tool returning an
  image file from the workspace as MCP image content under the existing
  `filesystem.read` capability (no new capability, no job, no component),
  formats PNG/JPEG/WebP detected by signature, a fixed size limit as a
  constant no larger than what browser screenshots already return.
  **Not:** downscaling or any conversion (needs an image engine → OD-16
  component; later via WP-49 frames), video, new capabilities.
- **Requirements:** path rules as `fs_read_file`; audit path and size only;
  same on every transport; the limit is reported to OD-4 as an input, not
  decided by this WP (AD-22 fixes 32 MiB per relay response, so a limit of
  at most 16 MiB fits).
- **Acceptance:** an image in the workspace is returned as image content;
  outside the workspace denied in sandbox mode; oversize refused with a
  clear error; non-image files refused. **Tests:** adapters (image
  encoding), permissions, audit, invariant tests of WP-41.
  **Risks:** large responses through the relay (AD-22 point 11). Size S.

### WP-43 — Component availability and diagnostics

- **Goal:** agents and the tray learn which optional tools/models exist and
  why one is unusable. **Problem:** executables resolved only at call time
  (audit G1).
- **Depends:** OD-16. **Scope:** declared components (initially ffmpeg,
  ffprobe, one ASR engine, `melt`), PATH-only detection, version probe,
  owner-configured model paths, reason codes, `crot_status.components`,
  tray view. **Not:** downloading components.
- **Requirements:** never current directory, never a shell; probe timeouts;
  refreshed on `crot_status`; per-principal reason when L1 refuses remote use.
- **Acceptance:** missing/too old/unusable components reported with codes
  `not_found`, `version_unsupported`, `probe_failed`,
  `confinement_unavailable`; no regression of existing status fields.
  **Tests:** fake executables in PATH, version parsing, remote vs local.
  **Risks:** version string formats. Size S–M.

### WP-44 — Jobs and artifacts

- **Goal:** long work with state, progress, cancel and results.
  **Problem:** only background processes have state; they block Core
  replacement.
- **Depends:** OD-15. **Scope:** Core job registry; `job_status`,
  `job_result`, `job_cancel`, `job_list`; artifacts (workspace paths +
  previews); retention; CoreActivity integration; restart behaviour.
  **Not:** media or service operations themselves.
- **Requirements:** start is one guard operation; status/result/cancel only
  for the same principal and exposure scope; bounded count; progress fields;
  interrupted jobs reported, never resumed silently.
- **Acceptance:** a test job runs across several short requests (stdio and
  relay entry point), reports progress, can be cancelled within 5 s, result
  retrievable once finished, survives tool-call disconnects; preset change
  waits or reports busy as AD-19 point 5. **Tests:** core, adapters,
  service restart. **Risks:** persistence format; relay timeouts (AD-22 point 12: 15 min per exchange).
  Size M.

### WP-45 — Connections and credential vault

- **Goal:** user-created service connections with device-held credentials.
  **Problem:** no place for service credentials (audit G6).
- **Depends:** OD-20, WP-21. **Scope:** connection store (owner-only
  private state), API-key credentials in the OS secret store, CLI and tray
  to add/remove/test, `service_list`, status in `crot_status`.
  **Not:** OAuth (WP-48), requests (WP-46).
- **Requirements:** agents can list but never create, read or change
  connections or credentials; secret names outside `SECRET_NAMES` rotation
  rules; delete removes the secret; failures fail closed. **Token
  isolation:** one secret entry per connection (never shared between
  connections, services or principals); secrets are read only by the
  connector runtime at injection time, never placed in environment
  variables, command lines, child processes, files in the workspace, logs,
  audit, results or relay traffic. **Revocation:** disabling or deleting a
  connection takes effect for the next request and cancels running jobs
  that use it.
- **Acceptance:** a connection is created in the tray, listed for agents
  without secret material, deleted with its secret; audit of control
  actions; a revoked connection fails the next request and its running
  test job with `connection_revoked`; a shell or network tool of the same
  agent cannot obtain the secret (test: environment, process list, workspace
  scan). **Tests:** secrets, control channel, tray controller. **Risks:**
  secret store limits per OS. Size M.

### WP-46 — Connector runtime: requests

- **Goal:** generic, guarded HTTP calls to a connection with credential
  injection. **Depends:** OD-19, WP-45. **Scope:** manifest schema and
  loader, `service_request`, `service_operation` (typed operations),
  capabilities `service.read/write/publish` and `permissions.services`,
  host binding, retries/backoff, rate-limit reporting, exposure source,
  publish gate. **Not:** file-backed bodies, async jobs (WP-47).
- **Requirements:** least privilege — every typed operation declares the
  scopes and effect class it needs; a connection grants a subset of
  operations, and `service_request` (raw) is a separate, narrower grant per
  connection; `service.publish` is a capability of its own, never implied
  by `service.write` or a preset, and each publish action needs an
  approval naming the connection, target account and visibility (standing
  publish grants only if OD-19 allows them).
- **Acceptance:** a fixture REST service added by a manifest only (no
  change in `src/core` or relay) passes: credential injected and never
  returned/audited; other hosts refused; cross-origin redirect strips
  credentials; 429 handled with retry hints; publish operations gated in
  exposed sessions and in both presets; an operation outside the
  connection's granted set is denied before any network call; a write grant
  does not allow a publish operation. **Tests:** local test server,
  permissions, approvals, audit. **Risks:** manifest expressiveness. Size M.

### WP-47 — Connector runtime: files and async operations

- **Goal:** upload from and download to workspace files; service-side async
  jobs. **Depends:** WP-46, WP-44. **Scope:** body from a workspace file
  (streamed), response to a workspace file, generic resumable upload helper
  (configurable protocol variants), polling patterns as jobs. **Not:**
  service-specific code beyond declared protocol variants.
- **Acceptance:** a 2 GB fixture file uploads with resume after an injected
  connection drop; download streams to the workspace atomically; async
  service job polled to completion with progress. **Tests:** test server
  with fault injection. **Risks:** protocol variants per vendor. Size M.

### WP-48 — OAuth connections

- **Goal:** OAuth 2.0 public-client connections (PKCE, loopback redirect)
  with refresh and revocation. **Depends:** WP-45, OD-20. **Scope:**
  authorization flow in the browser from the tray (reusing the WP-28 pairing
  pattern), scope display, refresh on device, revoke (local + provider
  endpoint where offered), expiry status. **Not:** cloud broker (M3).
- **Requirements:** request the minimal scopes of the operations the user
  enables; additional scopes only by a new, user-confirmed authorization
  (incremental consent); granted scopes shown and stored per connection;
  refresh tokens per connection, rotated when the provider rotates them;
  revoke attempts provider revocation and always deletes local tokens.
- **Acceptance:** against a test authorization server: connect, refresh,
  revoke; tokens never visible to agents; state/iss checks as in pairing;
  requested scopes equal the enabled operations' scopes; provider-side
  revocation (refresh fails) moves the connection to `revoked` and stops
  its jobs.
  **Tests:** emulator as in `tests/identity`. **Risks:** per-provider
  quirks. Size M.

## Phase 6 — Media (milestone v1.1)

### WP-49 — Media inspect and frames

- **Goal:** structured inspection, frames and analysis. **Depends:** OD-17,
  WP-43, WP-42, WP-44 (analysis of long files runs as a job). **Scope:** inspect, frames, contact sheet, scene/black/
  frozen/silence detection, loudness measurement (media-and-editors.md §3).
  **Not:** writing media other than image artifacts.
- **Requirements:** CROT-built engine arguments, file-only protocols,
  confinement per OD-17, metadata text as exposure source.
- **Acceptance:** on licence-cleared fixtures (multiple codecs, VFR,
  rotation, multi-audio) results match reference values; frames at given
  timestamps ±1 frame; remote and local identical (per OD-17).
  **Tests:** fixtures in CI (Linux), remote principal tests. **Risks:**
  fixture licensing, CI time. Size M.

### WP-50 — Audio analysis and processing

- **Goal:** extract, normalize, mix, duck, denoise (allowlisted filters).
  **Problem:** no structured audio operations; shell commands give no
  measurable result. **Depends:** WP-49, WP-44. **Scope:** the Audio group
  of media-and-editors.md §3 as jobs. **Not:** TTS, music generation.
- **Requirements:** outputs only to the workspace; filter allowlist; same
  placement as WP-49.
- **Acceptance:** loudness targets ±1 LU, true peak ≤ −1 dBTP, ducking
  amount within ±1 dB, sample-accurate trims. **Tests:** reference
  measurements on fixtures. **Risks:** denoise quality differs by engine.
  Size M.

### WP-51 — Speech to text and subtitles

- **Goal:** local transcription with word timestamps; SRT/VTT.
  **Depends:** WP-49, WP-44, WP-43, OD-16. **Scope:** one local engine
  chosen in the WP (component, user-installed model); language detection;
  exposure source. **Not:** cloud STT (connectors).
- **Acceptance:** WER threshold on the fixture set fixed in the WP; cue
  times ±100 ms; long files as jobs with progress. **Tests:** fixtures,
  exposure marking. **Risks:** model size and licences, CPU time. Size M.

### WP-52 — Edit description v1

- **Goal:** the validated edit format. **Problem:** without one, every
  render is an ad-hoc command line. **Depends:** OD-18, OD-17 (capability
  names). **Scope:** JSON
  Schema (v1 features of media-and-editors.md §3), validation errors with
  paths, timeline summary/explain, duration estimate; the editing model of
  media-and-editors.md §4.1: stable item ids, edit operations (insert,
  remove, trim, move, split, replace, track add/remove/mute, gain and fade
  changes) applied as validated patches, project save as a workspace file
  with revision number, revision history, undo to a revision, diff between
  revisions. **Not:** rendering.
- **Requirements:** versioned; sources resolved by workspace rules; no
  free-form engine options; a patch is atomic (all or nothing) and is
  rejected against a stale revision.
- **Acceptance:** invalid descriptions rejected with precise errors; schema
  published through the tool's input schema; explain output matches the
  fixture timelines; a project saved, reopened and re-explained is
  identical; every operation of the list has a test; undo restores the
  exact earlier revision. **Tests:** schema and validation tests. **Risks:**
  format churn before WP-53. Size S–M.

### WP-53 — Render core

- **Goal:** render v1 features (cuts, order, tracks, volume, fades,
  conforming) to a preset as a job. **Problem:** no deterministic, verifiable
  render path. **Depends:** WP-52, WP-44, WP-49. **Scope:** FFmpeg renderer
  built by CROT, render manifest, proxy preview. **Not:** composition
  features (WP-54).
- **Requirements:** OD-17 placement; outputs written atomically.
- **Acceptance:** media-and-editors.md §4 criteria for time accuracy, A/V
  sync, duration, conformance, reproducibility; cancel ≤ 5 s; no partial
  outputs. **Tests:** golden-output measurements (not byte equality).
  **Risks:** performance on large inputs. Size L.

### WP-54 — Render composition

- **Goal:** titles, image overlays, transitions, speed, subtitles burn-in or
  sidecar, voice-over and ducking, aspect conversion. **Problem:** v1 render
  covers assembly only. **Depends:** WP-53, WP-50, WP-51. **Scope:** v2
  features of media-and-editors.md §3. **Not:** arbitrary effects, colour
  grading. **Requirements:** fonts only from configured/system font
  directories. **Acceptance:** each feature has a measurable check (overlay
  position/time, transition length, subtitle presence). **Tests:** as WP-53.
  **Risks:** font availability and licences. Size M–L.

### WP-55 — Render QC and verification

- **Goal:** `verify` an output against description and preset, with a
  timestamped report. **Problem:** agents cannot check results objectively.
  **Depends:** WP-53, WP-50. **Scope:** the criteria of media-and-editors.md
  §4; every finding names the output time range **and** the timeline item
  id(s) of the edit description that produced it, so an agent can correct
  the project and re-render. **Not:** aesthetic judgement (agent's job,
  using frames).
  **Acceptance:** detects
  injected defects (black segment, clipping, wrong fps, desync of 3 frames,
  missing subtitles) and passes clean renders. **Tests:** defect fixtures.
  **Risks:** thresholds producing false positives. Size M.

### WP-56 — Delivery presets

- **Goal:** presets for YouTube 16:9, Shorts/TikTok 9:16, podcast audio,
  thumbnails (1280×720), web preview. **Problem:** platform specs scattered
  and changing. **Depends:** WP-53. **Scope:** preset data + validation.
  **Not:** platform upload. **Risks:** platform specs change. **Acceptance:**
  renders with each preset pass WP-55; presets documented with sources and
  marked "verify" where platform specs are unconfirmed. Size S.

### WP-57 — Media acceptance suite

- **Goal:** scenarios A (local part) and B (with a stub TTS) end to end for
  local and remote principals, and the autonomous editing loop L1–L4 of
  media-and-editors.md §4.1. **Problem:** single-operation tests do not
  prove an agent can finish a task. **Depends:** WP-49…WP-56. **Scope:**
  scripted agent runs through MCP (no specific AI client). **Acceptance:**
  the scenario definitions of product-reassessment.md §4 and loop scenarios
  L1–L4 pass in CI on Linux; in L3 the injected defects are found by QC and
  fixed by project edits (not by hand-written engine commands) within the
  stated number of iterations; audit and gates as specified. **Tests:** the suite itself.
  **Risks:** CI time; fixture licences. Size M.

## Phase 7 — Integrations (milestone v1.2)

### WP-58 — ElevenLabs connector

- **Goal:** TTS, voices, optional STT/dubbing as async jobs. **Depends:**
  WP-46, WP-47, WP-45; WP-44. **Scope:** manifest + typed operations;
  voice cloning behind explicit approval and a consent record. **First
  step:** verify integration-map.md §1.2 with a test account.
- **Acceptance:** scenario B with the real service on a manual checklist
  and a recorded-fixture CI test; key never visible to the agent; quota
  errors reported. **Risks:** plan-dependent features. Size M.

### WP-59 — YouTube connector

- **Goal:** upload (resumable), metadata, thumbnail, captions, playlists,
  status/processing verification, channel/video read. **Depends:** WP-47,
  WP-48; Google OAuth app setup (external lead time). **First step:**
  verify quotas, verification and private-lock rules (integration-map.md
  §1.1).
- **Acceptance:** scenario A API path to a test channel as private; publish
  to public gated; publication verified per integration-map.md §3.2 — an
  accepted upload is reported as `submitted`, not as published, until
  read-back shows processing finished, the requested privacy status and
  matching metadata/thumbnail/captions; a public video is additionally
  fetched without credentials; quota, processing and rejection errors
  reported with the final state. **Tests:** fixture server in CI; live checklist. **Risks:** app
  verification, quotas. Size M–L.

### WP-60 — TikTok spike

- **Goal:** verified facts: audit, scopes, client secret/PKCE, draft vs
  direct post, UX rules, limits; decision input for OD-20 (M3?).
  **Problem:** TikTok's publishing terms decide whether a connector is
  worth building. **Depends:** — (a developer account). **Scope:** reading
  terms, a sandbox app, test calls outside `main`. **Output:** update of
  integration-map.md §1.3; no product code. **Acceptance:** every "verify"
  item of §1.3 answered with a source and date. **Risks:** audit lead
  time. Size S.

### WP-61 — TikTok connector (conditional)

- **Goal:** draft upload and (if audited) direct post. **Problem:**
  scenario A for 9:16 content. **Depends:** WP-60, WP-47, OD-20 decision for
  TikTok (M2 or M3). **Scope:** manifest + upload protocol variant;
  creator-info query. **Not:** browser automation of TikTok.
  **Acceptance:** draft upload to a test account; direct post only if the
  app is audited; mandatory UX steps surfaced to the user, not faked by the
  agent; result states per integration-map.md §3.2 (a draft in the inbox is
  `submitted`, never reported as published; direct post verified by the
  publish-status query). **Tests:** fixture server; live checklist. **Risks:** policy
  changes. Size M.

### WP-62 — Canva spike

- **Goal:** verified API coverage (designs, assets, exports, autofill,
  editing limits), review requirements, MCP server option. **Problem:** the
  REST surface may not cover design editing. **Depends:** — (developer
  account). **Output:** integration-map.md §1.4 update; no product code.
  **Acceptance:** every "verify" item answered with a source and date.
  **Risks:** enterprise-only features. Size S.

### WP-63 — Canva connector (conditional)

- **Goal:** covers and designs through the official API. **Problem:**
  thumbnails/covers beyond the media pipeline. **Depends:** WP-62, WP-47,
  WP-48. **Scope:** manifest + typed operations; async exports as jobs.
  **Not:** editing inside the Canva editor. **Acceptance:** create a design
  from a preset size, upload an asset from the workspace, export PNG/MP4 to
  the workspace as artifacts (verified by Inspect, not by the API status
  alone); edit URL handed to the user. **Tests:**
  fixture server; live checklist. **Risks:** review requirements. Size M.

### WP-64 — Integration acceptance suite

- **Goal:** scenarios A (full), B and D against fixture servers in CI plus a
  documented live checklist. **Problem:** connectors tested alone do not
  prove the workflows. **Depends:** WP-57, WP-58, WP-59, WP-24…27.
  **Acceptance:** scenario definitions of product-reassessment.md §4 for A,
  B, D; fixture servers also simulate "accepted but failed later",
  "processing never finishes" and "published but not publicly reachable",
  and the suite requires the correct final state for each. **Risks:**
  live-service flakiness (kept out of CI). Size M.

## Phase 8 — Editors and applications (milestone v1.3+)

### WP-65 — Editor integration spike

- **Goal:** verify media-and-editors.md §5 for Kdenlive/Shotcut, Blender,
  DaVinci Resolve, Premiere Pro, Final Cut Pro, CapCut: levels, editions,
  APIs, platforms, licences. **Depends:** stage 1 — none (research, may
  start now); stage 2 — WP-52 (scenario runs from an edit description).
  **Problem:** editor capabilities are unverified claims. **Scope:**
  installed editors on test machines, scripts outside `main`; stage 1:
  levels, editions, APIs, licences; stage 2: run the editor scenario set
  E1–E9 (media-and-editors.md §5.1) per editor and level with throwaway
  scripts. **Output:** updated matrix with evidence (scenario ids passed,
  version, edition, OS, date); pick the bridge target for OD-21. No product
  code. **Acceptance:** every cell of the matrix verified or marked "not
  reachable"; every "expected depth" replaced by the list of scenarios that
  actually passed. **Risks:** licences for
  paid editors. Size M.

### WP-66 — Interchange export

- **Goal:** OTIO, FCPXML, EDL and MLT from an edit description.
  **Problem:** hand-over to editors used by humans. **Depends:** WP-52,
  WP-65 stage 1 (target formats and versions). **Scope:** exporters + loss report. **Not:** import of proprietary
  formats. **Tests:** OTIO round-trip, schema validation of FCPXML.
  **Acceptance:** exports open in the target
  editors (manual checklist recording scenario E7 per target editor,
  version and date) and round-trip through OTIO tooling without loss of v1
  features; unsupported features listed in the result. Size M.

### WP-67 — MLT project adapter (Kdenlive, Shotcut)

- **Goal:** read, modify and save MLT projects; render with `melt`; verify
  with WP-55. **Problem:** first editor integration that works without a
  GUI. **Depends:** WP-65 stage 1, WP-66, WP-43. **Scope:** MLT XML parse/write for
  the supported subset, `melt` render as a job. **Not:** Kdenlive-specific
  effects outside the subset (reported). **Acceptance:** scenarios E1–E9
  (media-and-editors.md §5.1) on fixture projects pass for both
  editors at pinned versions, with results recorded as the support
  statement; the saved projects still open and play in the editors (manual
  check, recorded). **Tests:** fixture projects of
  pinned editor versions. **Risks:** format drift. Size M.

### WP-68 — Application bridge (first editor)

- **Goal:** a CROT-owned bridge inside one editor with a fixed command set.
  **Problem:** editor-native features need the running application.
  **Depends:** OD-21 (decided after WP-65 stage 2). **Scope:** bridge component, IPC, commands
  (open project, list/modify timeline items supported by the API, render,
  status). **Not:** arbitrary script execution. **Acceptance:** the subset
  of E1–E9 declared for the bridge passes against the real editor (pinned
  version, edition, OS) and is the published support statement;
  authenticated IPC; every command a guard operation; owner grant per
  application. **Tests:** contract tests
  with a fake bridge; manual checklist with the editor. **Risks:** API
  changes per editor version. Size L.

### WP-69 — Desktop application control spike

- **Goal:** per-OS feasibility of scoped application control
  (accessibility trees, input to one application, window screenshots) with
  throwaway prototypes outside `main`. **Depends:** —. **Output:** findings
  for OD-22 (permissions on macOS, Wayland/X11 on Linux, UIPI on Windows,
  reliability numbers). **Problem:** "OS-level input" is excluded today and
  its feasibility is unknown. The fixed task set includes editor scenarios
  E3, E6 and E7 (media-and-editors.md §5.1) on one GUI-only editor.
  **Acceptance:** a findings document with a
  success rate on a fixed task set per OS. **Risks:** prototypes leaking
  into product code (forbidden). Size M.

### WP-70 — Application control v1 (conditional)

- **Goal:** scoped control of granted desktop applications. **Problem:**
  GUI-only applications. **Depends:** OD-22 accepted, WP-69. **Tests and
  risks:** defined by the AD. **Scope and acceptance:** defined by
  the AD; at least per-application grant, effects gated, visible indicator,
  kill switch, exposure marking of screenshots and accessibility text, and
  the E1–E9 subset declared for the target application passing in recorded
  runs.
  Size L.
