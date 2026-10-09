# External service integrations — capability map, credentials, connector contract

Status: **target design, not implemented.** Decisions: OD-19 (connector
contract) and OD-20 (credentials)
([`docs/plan/product-reassessment.md`](../plan/product-reassessment.md) §5).
Work packages: WP-45…WP-48, WP-58…WP-64.

**Confidence.** Every vendor statement below comes from the vendor's public
documentation or general public knowledge at the time of writing. **None of
it has been verified by CROT** (no accounts, no calls). Items marked
"verify" are known to vary by plan, region, app review or date. Each
connector WP starts by confirming them with a test account and records the
result here.

## 1. Service map

Columns: API path (official interfaces), browser path (web UI through the
browser contract v1), what needs extra authorization, approval or review,
and the recommended CROT path.

### 1.1 YouTube

| Area | API path (YouTube Data API v3, YouTube Analytics API) | Browser path (YouTube Studio) | Extra authorization / review | CROT path |
| --- | --- | --- | --- | --- |
| Channel and video analysis | read channel, videos, playlists, comments; analytics reports (Analytics API) | Studio analytics pages | OAuth scopes (read-only scopes); analytics scope separate | API |
| Upload | `videos.insert`, resumable upload, large files | Studio upload dialog (file upload, WP-26) | `youtube.upload` scope (sensitive → Google OAuth verification); uploads by unaudited API projects may be locked to private (verify); upload quota cost high relative to the default daily quota (verify current numbers) | API first; browser fallback |
| Metadata | title, description, tags, category, language, privacy, scheduled publish time, made-for-kids flag, licence, embeddable; hashtags are part of title/description (no separate field) | all Studio fields | — | API |
| Thumbnail | `thumbnails.set` (size/format limits; custom thumbnails need a verified channel — verify) | Studio thumbnail upload | channel verification | API; image produced by media pipeline or Canva |
| Captions | `captions.insert/update` | Studio subtitles editor | `youtube.force-ssl` scope (verify) | API; subtitles from WP-51 |
| Playlists | create/update, add items | Studio | — | API |
| Publish and verify | `videos.update` (privacy), `videos.list` with status/processing details | Studio content list | — | API; status polling as a job |
| Features not in the API (e.g. end screens, cards, some monetization and test-and-compare settings — verify) | not available | Studio | — | browser path |

### 1.2 ElevenLabs

| Area | API path | Browser path | Extra authorization / review | CROT path |
| --- | --- | --- | --- | --- |
| Text to speech | TTS with model and voice settings, output formats/sample rates (some plan-gated — verify), streaming, timestamps/alignment output (verify per model) | web app | API key (workspace; scoped keys — verify); character quota and concurrency by plan | API |
| Voices | list/get voices, voice library; instant/professional voice cloning | web app | cloning requires the speaker's consent and plan features (verify); legal policy | API; cloning behind an explicit approval and consent record |
| Speech to text | transcription API (verify models/languages) | web app | quota | API or local ASR (WP-51) |
| Dubbing, speech-to-speech, sound effects, audio isolation | async/sync endpoints (verify availability per plan) | web app | quota | API; async via jobs (WP-44/47) |

### 1.3 TikTok

| Area | API path (Login Kit, Content Posting API, Display API) | Browser path (TikTok web upload / Studio) | Extra authorization / review | CROT path |
| --- | --- | --- | --- | --- |
| Upload as draft | Content Posting API "upload" to the creator's inbox; the user finishes the post in the TikTok app (verify) | web upload | `video.upload` scope; app registration | API (draft) |
| Direct post | Content Posting API "direct post" with privacy, comment/duet/stitch settings; requires querying creator info first and a user-facing confirmation UX (verify the mandatory UX rules) | web upload | `video.publish` scope **requires app audit**; unaudited clients may post private-only and to a limited number of users (verify) | API after audit; until then draft upload |
| Media transfer | file upload in chunks or pull from a verified URL domain (verify) | — | domain verification for pull | file upload from the device |
| Read own videos | Display API | web | scopes | API |
| Auth | OAuth with a client key and a **client secret** for the token exchange (verify whether PKCE without a secret is offered for desktop apps) | browser session | if a secret is required: device cannot hold it (same reasoning as AD-21 point 4) → cloud broker M3 | OD-20 per-service decision |
| Platform limits | rate limits, video length/size/format limits, posting caps per creator (verify) | bot detection; terms on automation (verify) | — | presets (WP-56) + connector checks |

### 1.4 Canva

| Area | API path (Canva Connect APIs) | Browser path (Canva editor) | Extra authorization / review | CROT path |
| --- | --- | --- | --- | --- |
| Designs | create (blank/preset sizes), list, get; return an edit URL for the user | editor | OAuth (authorization code with PKCE; client secret usage — verify); public integrations require Canva review | API |
| Assets | upload assets (async job), list | editor | — | API (upload from workspace) |
| Export | export designs as PNG/JPG/PDF/MP4/GIF etc. (async job) | download | — | API → artifacts (thumbnails, covers) |
| Templates / autofill | brand templates and autofill (may be limited to enterprise plans — verify) | editor | plan | API where available |
| Editing design content | element-level editing is limited in the REST API (verify); Canva Apps SDK runs inside the editor and is a different model | editor (canvas UI; hard for the browser page model) | Apps SDK app review | API for create/fill/export; editor edits only by user or later |
| Vendor MCP server | Canva offers an MCP server (verify scope and auth) | — | — | candidate for §18 gateway (post-v1) |

### 1.5 Other API services

Covered by the connector contract (§3) when they speak HTTPS with a
standard auth scheme (API key, bearer token, OAuth 2.0 with PKCE). Need
code (and possibly an AD): custom request signing, non-HTTP protocols,
confidential-client OAuth (broker), streaming protocols, services without
an API (browser path) or desktop-only tools (OD-21/OD-22).

## 2. Credential models (input to OD-20)

| Model | Where the secret lives | Works for | Security | Operations | Verdict |
| --- | --- | --- | --- | --- | --- |
| M1 agent-held | agent context, possibly the agent vendor's logs | anything | token exposed to the model, the client and its cloud; no CROT revocation | none | allowed only as today's `network_request`; not the product path |
| M2 device vault | OS secret store (AD-18), injected by CROT | API keys; OAuth public clients (PKCE, loopback redirect like WP-28 pairing) | tokens never leave the device, never through the relay | refresh on device; per-device consent | **default** |
| M3 cloud broker | CROT account service (WP-36) holds refresh tokens/client secrets, issues short-lived tokens to the device | confidential-client services | CROT cloud becomes a high-value store; CROT is the responsible app owner; privacy/legal | needs cloud availability; per-service security review | only where unavoidable |
| M4 vendor MCP server | vendor | services with an MCP server | tool semantics and results untrusted (§18) | depends on §18 gateway (post-v1) | later alternative |
| M5 user-owned app credentials | device vault (user's own client id/secret) | power users; avoids CROT app review | secret on device is the user's own risk | poor UX; quotas per user project | advanced option |
| M6 browser session | user's browser profile | services with web UI | no token handling; UI actions gated (AD-16) | fragile, may conflict with terms | fallback |

## 3. Connector contract (input to OD-19)

- **Connection** (created by the user in tray/CLI, never by an agent):
  service id, label, credential reference (M2/M3/M5), granted scopes,
  allowed hosts, base URL, status (`connected`, `expired`, `revoked`,
  `error` + reason). Listed by `service_list` and in `crot_status`.
- **Manifest** (data, shipped with CROT or added by the owner): auth scheme,
  hosts, scopes and their meaning, rate-limit hints, retryable status codes,
  optional typed operations (JSON Schema input, request template, effect
  class `read` / `write` / `publish`, async pattern).
- **Generic tools:** `service_list`, `service_request` (connection, method,
  path, query, JSON body or body from a workspace file, response to a
  workspace file, idempotency key), `service_operation` (typed operation),
  job tools for async work (OD-15).
- **Guarantees:** requests only to the connection's hosts; credentials
  injected by CROT and stripped on cross-origin redirects (as
  `network.access` does today); credentials never in results, audit, logs
  or the relay; responses are exposure sources; `publish`-class operations
  gated in both presets by default; retries only for idempotent requests or
  with idempotency keys; quota and rate-limit errors reported with retry
  hints.
- **Audit:** connection id, operation, HTTP status, sizes, duration, job id;
  never bodies or tokens.
- **Relay:** unchanged; all connector traffic leaves from the device.

### 3.1 Credential isolation, revocation, least privilege, publish control

- **Isolation:** one secret per connection — never shared between
  connections, services, devices or principals. Only the connector runtime
  reads it, at injection time. It never appears in environment variables,
  command lines, child processes, workspace files, logs, audit, results or
  relay traffic, so `shell.execute` or `network_request` of the same agent
  cannot reach it. A remote principal never receives anything from which
  the secret can be derived.
- **Revocation:** the user can disable or delete a connection at any time
  (tray/CLI). It takes effect on the next request, cancels running jobs that
  use it, attempts provider-side revocation where offered and always deletes
  local tokens. Provider-side revocation or expiry (refresh fails) moves the
  connection to `revoked`/`expired` and stops its jobs. Removing a device
  from the account must remove its connections too (to be fixed in OD-20).
- **Least privilege:** the manifest declares scopes and effect class per
  operation. OAuth requests only the scopes of the operations the user
  enables, with more scopes only through a new user-confirmed authorization.
  A connection grants a subset of operations. Raw `service_request` is a
  separate, narrower grant per connection, limited to the manifest's hosts
  and paths.
- **Publish control:** `service.publish` is its own capability, never
  implied by `service.write`, a preset or `full_control`. Each publish
  action (making content visible to others: public/unlisted video, post,
  scheduled publication, sending) needs an approval that names the
  connection, target account/channel, item and visibility. Standing publish
  grants exist only if OD-19 allows them, and then per connection with an
  expiry. Exposed sessions (AD-12) always require the approval. Changing
  visibility of existing content is also a publish action.

### 3.2 Publication result and verification

A successful API response means the service **accepted a request**, not
that content is published and reachable. Connector results therefore use
explicit states:

| State | Meaning | How it is established |
| --- | --- | --- |
| `submitted` | request accepted (upload finished, draft created, post queued) | API response |
| `processing` | service still processing | status read-back (polled as a job) |
| `published` | service reports the requested visibility | status read-back: visibility/privacy, processing finished, no rejection |
| `verified` | content is reachable as intended and matches | read-back of metadata, thumbnail, captions equals the request; for public content a fetch **without credentials** succeeds; for private content an anonymous fetch fails |
| `failed` / `rejected` | processing failed, policy rejection, quota, timeout | error or status read-back, with the service's reason |

Acceptance rules for every publishing connector (WP-59, WP-61, WP-63,
WP-64):

- the agent and the user are told the actual state; `submitted` is never
  reported as published;
- verification has a timeout and ends in `verified`, `failed`/`rejected` or
  an explicit "still processing" result, never in silence;
- drafts that the user must finish in the vendor's app (TikTok inbox) stay
  `submitted` with a hand-over note;
- fixture servers cover "accepted but later failed", "processing never
  finishes", "published but not publicly reachable" and "metadata differs";
- audit records state changes, not bodies.

## 4. Per-service order

1. ElevenLabs (API key, M2) — proves the runtime, async jobs and audio
   artifacts (WP-58).
2. YouTube (OAuth PKCE, M2; app verification lead time) — scenario A
   (WP-59).
3. TikTok — spike first (WP-60): audit status, client-secret requirement →
   M3 decision.
4. Canva — spike first (WP-62): API coverage, review, MCP server option.
