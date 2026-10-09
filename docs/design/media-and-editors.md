# Media work and video editors — target design and acceptance criteria

Status: **target design, not implemented.** Decisions it depends on are
OD-15…OD-18, OD-21 and OD-22
([`docs/plan/product-reassessment.md`](../plan/product-reassessment.md) §5).
Work packages: WP-49…WP-57 and WP-65…WP-70
([`docs/plan/extension-work-packages.md`](../plan/extension-work-packages.md)).
Statements about third-party editors are from vendor documentation and
public knowledge **at the time of writing and are not verified by CROT**;
WP-65 verifies them.

## 1. Goal

An agent, local or remote, completes a media task on its own: study
material, extract data, plan, edit, render, check and fix, deliver files in
the required formats and continue with publishing. FFmpeg is one engine
behind this, not the interface: the agent works with **operations, an edit
description and verification reports**, not with command lines.

## 2. Principles

1. **Data stays on the device.** Agents get metadata, previews (images,
   short excerpts, waveforms), reports and artifact references; GB-scale
   files never pass through the agent or the relay.
2. **Fixed operations, CROT-built commands.** Every engine invocation is
   built by CROT from validated input (no agent-supplied filtergraphs,
   protocols or scripts); inputs and outputs follow the workspace rules.
3. **Edit description as the hub.** One validated description (OD-18)
   drives CROT's renderer, interchange export and editor bridges.
4. **Verify, don't assume.** Every render can be checked against its
   description and a delivery preset; failures are reported with
   timestamps.
5. **Long work is a job** (OD-15) with progress, cancel and a result.
6. **Untrusted content.** Transcripts, subtitle tracks, OCR text and
   embedded metadata are exposure sources (AD-12).
7. **The shell remains.** `shell.execute` keeps working for anything not
   covered; dedicated operations do not remove it.

## 3. Operation catalogue (proposed; names fixed by OD-17)

| Group | Operations | Capability (proposed) | Result |
| --- | --- | --- | --- |
| Inspect | container, streams, duration, codecs, frame rate (rational), resolution, rotation, colour, audio layout, chapters, embedded subtitles, metadata | `media.read` | JSON (no contents beyond metadata; metadata text is an exposure source) |
| Frames | frame at timestamps, every N seconds, at scene changes; contact sheet; thumbnails candidates | `media.read` (+ write of image artifacts) | images as MCP image content (bounded size) + artifact paths |
| Analysis | scene changes, black/frozen frames, silence, loudness (integrated, range, true peak), clipping, speech segments | `media.read` | timestamped lists |
| Audio | extract track, convert, normalize loudness, trim, fade, mix, duck under speech, denoise (filter allowlist) | `media.process` | audio artifacts |
| Speech | transcribe with word timestamps, language detection, speaker turns (if the engine supports it), subtitles SRT/VTT | `media.read` (exposure source) | transcript JSON + subtitle artifacts |
| Synthesis (local) | local TTS if a component is installed | `media.process` | audio artifact; remote TTS goes through connectors (integration-map.md) |
| Edit | validate an edit description, explain it (timeline summary), estimate output | `media.read` | report |
| Project | create a project, apply edit operations as patches (insert, remove, trim, split, move, replace, track add/remove/mute, gain, fade), save with revision, history, undo, diff | workspace write (`filesystem.write`; exact capability fixed by OD-17/OD-18) | project file + revision id + timeline summary |
| Render | render an edit description to a delivery preset; proxy/preview render | `media.process` (job) | video/audio artifacts + render manifest |
| Verify | compare an output with its description and a preset | `media.read` | QC report |
| Export | OTIO / FCPXML / EDL / MLT from an edit description | `media.process` | project files |

Edit description features, in two steps:

- **v1 (WP-52/53):** sources; clips with in/out points; order on a primary
  video track; additional audio tracks (music, voice-over); per-clip volume,
  fades; audio crossfade; frame-rate and resolution conforming; delivery
  preset.
- **v2 (WP-54):** title/text overlays, image overlays (logos), simple
  transitions (cut, crossfade, dip), speed change, subtitles burned in or as
  sidecar, ducking, aspect conversion (pad, crop, blur-fill) for 9:16.

## 4. Acceptance criteria (proposed; fixed per WP)

| Area | Criterion |
| --- | --- |
| Time accuracy | cut points within ±1 frame of the requested time at the source frame rate when re-encoding; stream-copy mode only at keyframes and reported as such |
| A/V sync | drift ≤ 1 frame (≤ 40 ms at 25 fps) over the whole output |
| Duration | output duration equals the description within ±1 frame |
| Conformance | container, codec, profile, pixel format, resolution, frame rate, audio codec, sample rate and channels equal the preset (checked by Inspect) |
| Loudness | integrated loudness within ±1 LU of the preset target (online video default −14 LUFS, speech/podcast −16 LUFS; configurable), true peak ≤ −1 dBTP |
| Defects | no black or frozen frames longer than a configured threshold unless the description contains them; no audio clipping |
| Subtitles | valid SRT/VTT; cue times within ±100 ms of the word timestamps they come from |
| Transcription | WER measured on a fixed, licence-cleared fixture set per supported language; threshold set in WP-51 for the chosen engine/model and reported in `crot_status` component info |
| Reproducibility | same description + same inputs + same component versions → same duration, frame count and audio sample count; the render manifest records digests and versions |
| Jobs | progress at least every 5 s; cancel stops the engine within 5 s and leaves no partial artifact under the final name |
| Safety | inputs/outputs outside the workspace need `filesystem.full`; no network protocol inputs; audit has paths, sizes and durations only |
| Agents | every operation works identically for a local and a remote principal (subject to OD-17 placement) |

### 4.1 Autonomous editing loop (the product goal, not a pipeline)

Rendering a description once is not editing. The goal is that an agent
completes the whole loop on its own and can repeat it until the result is
right:

1. **Select** fragments from sources using Inspect, Analysis, Speech and
   Frames (candidate list: source id, in/out, reason);
2. **Create** a project (edit description) from the selection;
3. **Change** it with edit operations on stable item ids — clips, order,
   tracks, levels, fades, ducking, titles;
4. **Save** it as a workspace file with a revision (history, undo, diff);
5. **Render** a preview or the delivery preset as a job;
6. **Verify** with QC (findings point to timeline item ids) and with frames
   the agent looks at;
7. **Correct** the project by edit operations and go back to 5.

| Loop step | Criterion |
| --- | --- |
| Select | every selected fragment lies within its source; when cutting speech, no cut point falls inside a word according to the word timestamps (tolerance ±1 frame) |
| Create / change | each operation is validated, atomic and touches only the addressed items (diff shows nothing else); a patch against a stale revision is rejected |
| Tracks and audio | track add/remove/mute reflected in the render; per-item gain within ±0.5 dB, ducking depth within ±1 dB, fades of the stated length ±1 frame |
| Save / reopen | save → reopen (also from another session or principal) → explain gives an identical timeline; undo to revision *n* renders with the same duration and frame count as the earlier render of *n* |
| Render / verify | §4 criteria; QC findings name time range and item ids |
| Correct | a finding can be fixed by edit operations only (no hand-written engine commands) |

Loop acceptance scenarios (CI on Linux, scripted agent through MCP; part of
WP-57):

- **L1 Assemble:** from ≥ 3 raw clips with speech and music, select
  fragments, build and save a project, render, QC passes.
- **L2 Revise:** apply a change request (remove a segment, reorder, replace
  music, lower music by 6 dB, add a voice-over track) to the saved project;
  the diff shows only the requested changes; untouched segments keep their
  timing; QC passes.
- **L3 Detect and correct:** a project with injected defects (black gap
  from a wrong in-point, music masking speech, one clip 3 frames out of
  sync, clipping) fails QC with item ids; the agent fixes it by edit
  operations; QC passes within ≤ 3 render iterations.
- **L4 Resume:** a new session (local, then remote principal) reopens the
  project, continues from the last revision, undoes one revision and
  re-renders identically to the earlier render of that revision.

## 5. Video editors — per-editor integration matrix (to verify in WP-65)

The "reachable levels" and "expected depth" columns are **hypotheses**. An
editor counts as supported only at the levels and for the scenarios of §5.1
that passed in a recorded run; until then it is "not supported".

Integration levels: **F** project files; **C** CLI/headless render;
**S** scripting API (running or headless app); **B** CROT bridge inside the
app (OD-21); **G** GUI control (OD-22); **W** web editor through the
browser contract.

| Editor | Platforms | Reachable levels (claimed, unverified) | Expected depth for an agent | Dependencies / limits | Risks | Recommendation |
| --- | --- | --- | --- | --- | --- | --- |
| Kdenlive | Linux, Windows, macOS | F (MLT XML `.kdenlive`), C (`melt`) | high for cut/arrange/audio/titles via MLT; editor-specific effects partly | MLT version compatibility; no stable public scripting API | project format changes between versions | **first editor** (WP-67): files + `melt`, testable on Linux CI |
| Shotcut | Linux, Windows, macOS | F (MLT XML `.mlt`), C (`melt`) | high (same engine) | as Kdenlive | as Kdenlive | together with Kdenlive (shared MLT adapter) |
| Blender (VSE) | Linux, Windows, macOS | S (Python API, headless `blender -b`), C | high, scriptable end to end | large install; VSE UX unusual for users | arbitrary Python inside Blender if not bounded | candidate for the first bridge (B) because headless |
| DaVinci Resolve | Linux, Windows, macOS | S (Python/Lua API of the running app; external scripting may require the Studio edition — verify), F (import FCPXML/EDL/AAF/OTIO), C (render queue through the API) | medium: assembly, media pool, render queue via API; fine edits mostly via imported timelines | running GUI app; edition/licence; API coverage of editing operations limited (verify) | API changes between versions; app outside L1 | bridge candidate (WP-68) after the spike; interchange first (WP-66) |
| Adobe Premiere Pro | Windows, macOS | B (UXP plugin; ExtendScript/CEP legacy — verify status), F (import FCP XML/OTIO via tools), render through the app/Media Encoder | medium via a CROT UXP plugin | subscription; no headless mode; plugin distribution | API transition (UXP) | later bridge; interchange export supported early |
| Final Cut Pro | macOS | F (FCPXML import/export), limited automation (Apple Events/workflow extensions — verify) | low–medium: build timelines by FCPXML, render by the user or Compressor (verify) | macOS only, paid | limited automation | interchange only (WP-66) |
| CapCut (desktop) | Windows, macOS | G only (no public desktop API known — verify); project format not documented | low without GUI control | OD-22; terms of service | fragile, ToS | not before OD-22; prefer CROT render |
| Web editors (CapCut web, Canva video, Clipchamp …) | browser | W | medium, fragile (canvas UIs) | WP-24…27 | UI changes, bot detection | case by case |

### 5.1 Editor scenario set and support statement

Support for an editor is measured by these scenarios, run per editor, level
(F/C/S/B/G/W), editor version, edition and OS:

| Id | Scenario | Pass condition |
| --- | --- | --- |
| E1 | Open an existing fixture project and report its timeline | items, tracks, in/out and durations equal the fixture's reference |
| E2 | Create a new project from sources or an edit description | the editor opens it; timeline equals the description |
| E3 | Cut, trim, split and move clips | resulting timeline equals the expected one (±1 frame) |
| E4 | Track and audio operations: add/remove/mute tracks, gain, fades | reflected in the editor and in the render |
| E5 | Titles / text overlays (where the level allows) | present at the stated times and positions |
| E6 | Save and reopen in the editor | identical timeline; no repair or missing-media prompts; untouched items preserved |
| E7 | Render/export through the editor or its renderer | output passes WP-55 against the expected description |
| E8 | Request an unsupported operation | reported as unsupported; nothing silently approximated; the project stays valid |
| E9 | Correct after verification: a WP-55 finding on the editor's export is fixed in the editor project and re-exported | the new export passes; only the addressed items changed (the loop of §4.1 inside the editor) |

Support statement (published per editor, replaces the matrix guess):
editor · version · edition · OS · level · scenarios passed · date ·
evidence (test id or recorded checklist). A version not in the statement is
"unverified".

**Level selection rule.** For each editor the integration uses the most
reliable level that reaches the required scenarios: project files (F), CLI
(C), scripting API (S), a CROT bridge (B) or the browser for web editors
(W). GUI control (G) is used only where no other level reaches them, OD-22
is accepted and the editor's terms allow it. Every level is confirmed by
evidence: WP-65 for F/C/S/W, a prototype for B (WP-68) and WP-69 for G.

**The CROT render path is a baseline, not a substitute.** WP-52…56 give
autonomous editing on every OS where the components are installed, without
any editor. They do not replace editor integration: a user who works in
Kdenlive, Resolve or Premiere needs the agent to work in *that* project,
with that editor's features, and to hand the result back (scenario C). So
phase 8 is part of the product goal, and its completion is measured by
E1–E9, not by render quality.

## 6. Order

1. WP-42 image view, WP-43 components, WP-44 jobs (foundation).
2. WP-49 inspect/frames, WP-50 audio, WP-51 speech.
3. OD-18 → WP-52 edit description, WP-53 render core, WP-55 QC, WP-54
   composition, WP-56 presets, WP-57 acceptance.
4. WP-65 editor spike → WP-66 interchange → WP-67 MLT adapter → OD-21 →
   WP-68 bridge; WP-69 spike → OD-22 → WP-70 (only if accepted).
