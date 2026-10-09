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

## 5. Video editors — per-editor integration matrix (to verify in WP-65)

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

Achievable result without any editor: the CROT render path (WP-52…56) gives
fully autonomous editing on every OS where its components are installed.
Editors add project hand-over to humans (interchange), editor-native
features (bridges) and GUI-only tools (OD-22).

## 6. Order

1. WP-42 image view, WP-43 components, WP-44 jobs (foundation).
2. WP-49 inspect/frames, WP-50 audio, WP-51 speech.
3. OD-18 → WP-52 edit description, WP-53 render core, WP-55 QC, WP-54
   composition, WP-56 presets, WP-57 acceptance.
4. WP-65 editor spike → WP-66 interchange → WP-67 MLT adapter → OD-21 →
   WP-68 bridge; WP-69 spike → OD-22 → WP-70 (only if accepted).
