# WP-32 automatic acceptance and WP-38 repository delivery

## Scope and release boundary

This change implements the automatic, client-independent WP-32 acceptance suite
and WP-38 repository deliverables. It does **not** assert a deployed public relay,
a live WorkOS tenant, a real entitlement service, or compatibility acceptance by
four external cloud clients. Those remain operational/manual release gates.
No paid hosting, public DNS, live credentials or client-specific production code
are required for these automated tests.

## What actually runs

`tests/remote-acceptance/harness.ts` starts a real HTTPS authorization server,
real HTTPS CloudRelay, actual WSS DeviceTunnel and actual CrotService. The only
emulated product is the identity provider: an AuthKit-like OAuth authorization
server. Its metadata, authorization code, PKCE S256 token exchange and JWKS are
served over sockets. Device pairing completes through the authenticated control
channel and its real loopback callback. Remote clients use SDK OAuth discovery,
PRM and RFC 8707 resource indicators. No test constructs a remote Core AuthContext
or substitutes an in-memory MCP transport, tunnel, guard or approval broker.

A one-day, test-only self-signed certificate is generated with OpenSSL inside the
throw-away fixture. Canonical issuer/relay HTTPS authorities are preserved;
only their DNS routing points at loopback ports. Trust is explicit and temporary;
TLS certificate and hostname verification are never disabled. The WSS trust root
is restored during teardown. This is **not** a live WorkOS qualification.

The real-browser matrix uses the unpacked production extension, installed native
messaging host and CrotService's own bridge. Each row performs navigation,
snapshot, trusted ref input/select/checkbox/click, dialog, related pop-up,
workspace upload and a real browser download with byte-for-byte verification,
filesystem writes/reads and Git read/add/commit/branch creation. A second verified
OAuth principal accesses the common tab: `openedBy` differs and concurrent clicks
are observed in FIFO order. The initial tab is in the CROT group. Approval
responses travel over an authenticated ControlClient connection.

### Protocol and preset matrix

| Negotiated revision | SDK | require-approval | autonomous-browser |
| --- | --- | --- | --- |
| 2026-07-28 | `@modelcontextprotocol/client` 2.3, pinned modern/sessionless | Same complete remote scenario | Same complete remote scenario |
| 2025-11-25 | `@modelcontextprotocol/sdk` 1.31 | Same complete remote scenario | Same complete remote scenario |
| 2025-06-18 | `@modelcontextprotocol/sdk` 1.31 | Same complete remote scenario | Same complete remote scenario |

The 1.x SDK has no legacy revision-pinning option. A **test-only** fetch adapter
changes only the advertised `initialize.params.protocolVersion`. The real SDK
still negotiates, manages legacy sessions, sends tool calls, and enforces its
timeouts. No production protocol behavior is patched for a client.

After snapshot exposure, require-approval asks for browser control; autonomous
browser control does not ask again. Both presets ask and receive approval for
upload, download, filesystem write, Git write and shell execution. Before any
exposure, workspace file reads do not artificially mark a context exposed.

### Evidence map and qualification boundaries

| Criterion | Expected and asserted result | Executable evidence |
| --- | --- | --- |
| TLS, OAuth, PRM, PKCE, RFC 8707, JWKS | A real SDK-issued bearer reaches the paired CrotService through HTTPS/WSS | `tests/remote-acceptance/{harness,client,remote.test}.ts` |
| Project files and Git | Real workspace bytes and commits, not mocks | `tests/remote-acceptance/remote.test.ts`, `tests-e2e/browser/wp32-scenario.ts` |
| All three revisions × two presets | Six complete browser/project scenarios, with correct control-channel approvals | `tests-e2e/browser/wp32.e2e.test.ts` |
| CommandConfinement L1 | A real sandboxed command and payload AppArmor label; no unconfined fallback | `tests/native-host/linux-l1/remote-acceptance.test.ts` |
| Combined browser + L1 | The exact same six-row project/browser scenario, with successful L1 shell execution mandatory | Same file's second test on installed x64 Ubuntu L1 runners |
| Docker mediation | Real DockerService authorization/mediation and audit; a missing daemon is not reported as successful Docker execution | `docker_ps` assertion in the combined browser scenario; actual daemon mediation has existing L1 Docker tests |
| Remote missing tabId | INVALID_INPUT without authorization/bridge effects | `remote.test.ts`; exhaustive per-tool preauthorization checks are also retained from WP-27 |
| Wrong device / revoked client | 401 / 403; no execution | `negative.test.ts`, each revision |
| Remote mode off | WSS route closes and subsequent request is refused (503) | `negative.test.ts`, each revision |
| Concurrent clients/common tab | Exact distinct OAuth client principals, openedBy attribution, observed FIFO `ORDER:12` | `wp32-scenario.ts` |
| No token or file payload in logs | Token, page/input/upload/download/file-output canaries absent from relay/service diagnostics; file bodies absent from audit | Root and browser scenarios |
| Pinned identity artifact | Dev environment file is never read; malformed replacement does not alter existing output | `release.test.ts` |
| Staging config/lifecycle | Config validation, fixed compose project, explicit destructive-reset confirmation | `release.test.ts`, `scripts/staging.mjs`, mandatory x64 L1 `staging-container.test.ts` image build/TLS smoke |

`npm test` runs the TLS/project, negative, release and deadline tests on the
existing Linux/macOS/Windows Node 20/22 matrix. This is not a claim that Chromium
or L1 runs on every one of those six jobs. The existing real-Chromium Linux job
runs the six browser rows. The four existing installed-L1 Ubuntu jobs run remote
shell acceptance; x64 L1 jobs additionally run the complete browser matrix in
headless Chromium. On arm64 the combined browser case is explicitly not selected,
not represented as passing; actual remote shell/L1 remains mandatory.

A development machine without installed L1 must refuse remote sandbox shell
execution with CONFINEMENT_UNAVAILABLE. The ordinary Chromium job checks this
safe refusal where applicable; only the mandatory installed-L1 job may qualify
successful remote shell execution. Production L1 policy is unchanged.

## OD-5 measurements and timeout ordering

`tests/remote-acceptance/deadline.test.ts` makes real SDK calls through the full
TLS/WSS/service chain; its `WP32_TIMEOUT` log records contain only revision,
configured durations and elapsed milliseconds.

- Real device deadline test: relay exchange deadline **6000 ms**, unchanged
  production device margin **5000 ms**, observed device reset **1008 ms** in the
  first local measurement. Accepted timing range 700–3500 ms allows CI jitter.
  This short relay deadline is a constructor-only test setting: public config
  still requires 60–900 s. No pending write reaches the workspace.
- SDK 1.31 and 2.3 default request timeouts are **60000 ms**. With unmodified
  defaults a gated request ends **earlier**, at the production broker's roughly
  **45000 ms** unanswered-approval expiry, with PERMISSION_DENIED, not execution.
  Local measurements: modern **45065 ms**, 2025-11-25 **45018 ms**,
  2025-06-18 **45021 ms** (43–55 s accepted range).
  It must not mislabel this as an observed 60 s SDK timeout.
- An explicitly configured SDK request timeout of **300 ms** is separately
  measured at **313 / 301 / 301 ms** respectively for modern / 2025-11-25 /
  2025-06-18 (250–2500 ms accepted range); it wins over approval
  expiry and relay/device deadlines. No write is published.

These measurements are for the named SDKs and the automated test network, not
for the four external cloud clients. A client may impose a shorter limit than
CROT's 15-minute exchange deadline or a human may take too long to approve. Do
not automatically retry a mutating call with unknown outcome. External clients'
actual timeout behavior must be added to the manual table below.

## Reproduction

```sh
npm ci
npm run check
CROT_E2E_CHROME=/path/to/chrome xvfb-run -a npm run test:e2e:browser
# Native L1 qualification: use the existing .github/workflows/l1.yml on real Ubuntu.
# CROT_L1_REQUIRED=1 tests fail if the installed L1 or required x64 browser is missing.
```

The unchanged CI workflow set has eleven jobs: six OS/Node jobs, four installed
L1 jobs, one real-Chromium job. A reviewed revision is qualified only when all
eleven checks are green. Local Linux browser rows and root tests are evidence,
not a substitute for the installed-L1 or other-OS jobs.

## Public staging and four-client manual acceptance — not executed

Deploy using [the staging runbook](../STAGING.md), configure a live identity
tenant and ship a pinned device build. For each supported revision and each of
at least four independent remote MCP clients, use this owner-facing scenario:

1. Connect the public device MCP URL, sign in and authorize the test device.
2. Read the project fixture and open the acceptance webpage. Inspect its form,
   enter a value, confirm the local approval when requested and submit.
3. Open the linked child tab, handle its dialog, upload the fixture and download
   it back. Confirm the downloaded bytes from the project using the client.
4. Repeat in both presets; ordinary browser actions should not repeatedly ask
   in autonomous-browser, but upload/download and computer writes still must.
5. Revoke the client and turn remote mode off; access must cease. Record actual
   client timeout and any client-specific inability to select protocol versions.

| External client | Revision(s) actually negotiated | Both presets | OAuth + project/browser | Timeout observed | Evidence/date | Blocking issue |
| --- | --- | --- | --- | --- | --- | --- |
| Notion | Not run | Not run | Not run | Not measured | — | Public deployment/live tenant pending |
| Claude | Not run | Not run | Not run | Not measured | — | Public deployment/live tenant pending |
| Cursor | Not run | Not run | Not run | Not measured | — | Public deployment/live tenant pending |
| Fourth independent client (record name) | Not run | Not run | Not run | Not measured | — | Public deployment/live tenant pending |

Do not fill a client's unsupported revision with an SDK result or a claimed pass.
RFC 9207/live WorkOS assumptions, commercial entitlement, production capacity,
signing/publication and external security review remain their original gates.
