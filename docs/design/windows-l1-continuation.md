# WP-23c continuation — WinPS and native process transport

**Partial implementation, not Windows L1 acceptance.** Production Windows
confinement still reports `not_implemented`; PR #27 stays open and Draft. No
backend, write-through filesystem, global write boundary or architecture
selection is claimed by historical green component checks.

## AD-28 current continuation — zero license fees is not security acceptance

**WP-23c NOT accepted; production Windows none/not_implemented; PR27 Draft/open.**
Dokan's official commercial-use permission under LGPL/MIT removes a mandatory
third-party commercial-license purchase, not the security or compliance gates.
No paid WinFsp route, repository relicensing, unsafe backend registration,
original/global/device ACL weakening or copy-back is introduced.

### Latest unchanged-code validation — `20808e8`

All9 non-Windows CI jobs PASS again, including macOS20, all4 Linux L1 and
Chromium; both Windows jobs remain FAILED. Tested PR merge ancestry and exact
src/tests/native/scripts/CI/package/extension Git-object identities against
implementation75ce0f2 are retained in20808e8-validation-summary.json. No assertion,
timeout, skip or runtime code was changed to obtain this follow-up result.
The prior75ce0f2 macOS20 concurrent-start failure is retained, not diagnosed as
fixed. A separate bounded Linux Node24 crash+4-concurrent-start stress check
passes16/16 rounds; that is NOT independent macOS qualification or root cause.

Windows20/22 repeat the same fixed-child entry, four owner-positive raw denials,
owner literal-zero denial (inconclusive), and NUL RW failure. This is not a
production backend, complete filesystem/runtime pass, or WP-23c acceptance.
Local fullcheck1732/168 skipped +147 remains explicitly pinned to implementation75ce0f2.

### Implemented native continuation and exact evidence

| Source | Change and observed native evidence |
| --- | --- |
| `07afa3c` / `dc52bc4` | Fixed OS-only AppContainer/LPAC child/controller, same signed Dokan fixture; move new private executable under an existing owned build root. Both native helpers compile; original Medium-before2 passes, owner NT prerequisite fails. |
| `673edb6` / `ac37992` | Separate owner controls localize the absolute-NT open; metadata/non-directory semantics fix all four owner positive controls on20/22. Not literal-zero denial proof. |
| `9faa901` / `2c023ad` | Unique profile names <=64; native setup succeeds but CreateProcess returns ERROR_FILE_NOT_FOUND2. No child-entry or denial proof. |
| `eb60654` | Documented CreateAppContainerProfile/DeleteAppContainerProfile ownership/bootstrap; both processes now created suspended. Exact profile cleanup after Job/token/process settlement; abrupt crash recovery UNQUALIFIED. |
| `d43f96b` / `4804e32` | Split token predicates; LPAC class46 fails both generic Win32 query87 and fixed native ULONG query STATUS_INVALID_INFO_CLASS0xc0000003. These failed prerequisites are retained, never called isolation. Full local4804:1730/168 skipped +147. |
| `75ce0f2` | Replace unsupported flag query with public in-memory effective AccessCheck predicate, parent before resume and child after entry. New v2 diagnostic separately observes literal NtCreateFile DesiredAccess0/non-directory and owner control, metadata/read and Win32 opens plus NUL. Full local1732/168 skipped +147; 37 focused portable tests pass. Native results below. |

The effective check requires successfully evaluated user-only denial and exact
package-positive access, then the documented ALL_APPLICATION_PACKAGES distinction
(normal AppContainer allowed /LPAC denied, LPAC ALL_RESTRICTED_APPLICATION_PACKAGES
positive). These descriptors exist only in memory, never installed on real objects;
no common/shared SID is granted to any filesystem/device object. This is an
effective-access observation, not a claim that token class46 was supported.
The original mandatory WRITE_RESTRICTED Low raw-control gate remains unchanged
and still rejects READY; no sensitive IOCTL/token/event operation is invoked.

**Latest tested source:** `75ce0f211fac413b66da877c7f32721359f63fef`.
Actual PR merge checkout and source ancestry are verified in75ce0f2-tested-merge.json.
Native AppContainer/LPAC result (not production readiness):

- Node20: `{"protocolVersion":2,"completed":true,"ownerControls":true,"ownerNtLiteralZero":"access-denied","devicePackageAccessGranted":false,"appContainer":{"ready":true,"win32Zero":"access-denied","win32Read":"access-denied","ntMetadata":"access-denied","ntRead":"access-denied","nulReadWriteOpened":false,"ntLiteralZero":"access-denied"},"lpac":{"ready":true,"win32Zero":"access-denied","win32Read":"access-denied","ntMetadata":"access-denied","ntRead":"access-denied","nulReadWriteOpened":false,"ntLiteralZero":"access-denied"}}`
- Node22: `{"protocolVersion":2,"completed":true,"ownerControls":true,"ownerNtLiteralZero":"access-denied","devicePackageAccessGranted":false,"appContainer":{"ready":true,"win32Zero":"access-denied","win32Read":"access-denied","ntMetadata":"access-denied","ntRead":"access-denied","nulReadWriteOpened":false,"ntLiteralZero":"access-denied"},"lpac":{"ready":true,"win32Zero":"access-denied","win32Read":"access-denied","ntMetadata":"access-denied","ntRead":"access-denied","nulReadWriteOpened":false,"ntLiteralZero":"access-denied"}}`

**Interpretation:** both profiles really entered the fixed native child and deny
four owner-positive raw opens. Literal NT0 also denies the owner, so it is not
isolation evidence. NUL generic RW fails for both profiles/runtimes: a concrete
runtime/stdio compatibility blocker. No data grant has been enabled. Diagnostic
`ready:true` is child entry/readback only, never backend readiness. Do not grant
shared NUL/device/global ACLs to turn these observations green.

**CI:** 8/9 non-Windows jobs PASS; 2/2 Windows jobs FAIL. The macOS Node20 concurrent-service-start assertion also
failed at this source (one losing start exited1 instead of0); preserve the failure,
do not claim green CI or attribute it to Windows code without root-cause evidence.
Earlier4804e32 has all9 non-Windows checks PASS. Core and existing PS/RPC protected
source identities are verified unchanged against8b00b61 in the native summary.

### Eight mandatory criteria — current result

| # / criterion | Commit and concrete evidence | Status / remaining work |
| --- | --- | --- |
| 1 Original Medium backing, ordinary APIs, unchanged SD | `ca04414` actual mount and Medium-before2; `75ce0f2` Medium-before2 again, rejects mandatory raw gate before actor. | NOT MET: no ready same-backing CRUD/after-SD, full sharing/replace/mmap. |
| 2 Process/env/stdio/lifecycle | `c6a1c45` native process11/11 each runtime; `eb60654` fresh profile ownership; `75ce0f2` fixed-child startup and Job/token gates are separately observed. | PARTIAL: real strong runtime/descendants and abrupt profile/helper recovery unqualified. |
| 3 Global/outside/Low/aliases/concurrency/network | `43ff402`/`c6a1c45` original raw zero-open blocker; `75ce0f2` five independent raw-open outcomes with owner controls and no sensitive IOCTL. | NOT MET: post-data-grant isolation, all aliases/races/other Jobs/descendants/network absent. |
| 4 Actual CROT state/control/self-approval/Docker | `9ced362` and `c6a1c45` ready Node22 denies5 actual reads+5 writes and endpoint, with working owner controls. No substitute secrets added at `75ce0f2`. | PARTIAL: Node20 pre-JS, full Docker/self-approval/external settings not qualified. |
| 5 Node20/22/cmd/WinPS and OS/user/architecture matrix | `75ce0f2` actual hosted Windows20/22 diagnostics, not a production runtime pass. | NOT MET: transparent runtime compatibility; Win11 standard-user x64/ARM64 matrix. |
| 6 Full regressions / CI | `75ce0f2` local1732+147 pass; complete check records retained including Windows and macOS failures. `4804e32` all9 non-Windows green. Original `43f7392` PS /`01ed8ce` RPC assertions preserved. | PARTIAL: not all CI green; macOS concurrent-start failure needs diagnosis, Windows gates remain red. |
| 7 Same Core/ExecutionGuard/PermissionEngine, safe backend | `75ce0f2` unchanged src/core Git object versus8b00b61 and protected launcher/token/PS/RPC paths in zero-license-native-summary.json; no production registration. | PARTIAL: no accepted CommandConfinement backend. |
| 8 No critical blockers, weaker fallback or false proof | `75ce0f2` refuses original raw gate; startup/readback/cleanup errors distinct from strict denied/absent/opened outcomes; literal-zero independent of metadata. | NOT MET: safe control/data, runtime/lifecycle/network/matrix and release compliance blockers remain. |

Every new result is source-pinned in zero-license-native-summary.json plus complete
lossless Node20/22 event wrappers, checks and tested-merge receipts. The original142
manifest hashes remain unchanged. See windows-l1-zero-license.md for the conditional
commercial route and release obligations. No criterion is closed by license terms.

## AD-27 continuation — actual build/mount, raw control blocker confirmed

**WP-23c is NOT accepted. PR27 stays Draft/open; OD-6/OD-9 OPEN.** No
production CommandConfinement registration, common-SID fallback, copy-back,
original workspace SD change or global/shared device ACL weakening.

### Source changes and actual native results

| Source commit | Implementation and concrete evidence |
| --- | --- |
| `2ee1a90493506112337a5421455768580cb1c945` | Actual C++ same-backing Dokan helper; pinned signed-driver fixture; exact requestor token/actor Job; handle-relative I/O; retained ownership. Native setup FAILS at Security module autoload, before compile. |
| `4aa7546ce7f9907e0f23a47107dced3e21a8e11b` | Trusted PSHOME Utility/Management/Security imports; .NET archive extraction; Windows ordinal Unicode-case protected roots. Native reaches MSVC, fails missing NTSTATUS. |
| `9a2765e87f6ef6a5909b82a5a27c258d70af336d` | Read-only original root/file OWNER/GROUP/DACL/LABEL snapshot (query0x17, serialize0x0f), hash comparison/no SID output;4 portable fault tests. Native attempted SDK include fails UNICODE_STRING conflict. Full local1702+147. |
| `25afa5acc8d3f8cc8eab603286a723302635a5e5` | Exact signed32 LONG NTSTATUS ABI avoids competing SDK structures. Both Windows runtimes compile helper and verify pinned MSI/installed kernel driver signature/version2.3.1.1000. Next prerequisite FAILS duplicate Koffi Job type from mixed ESM/CJS registries. |
| `ca0441472228d24c9129cef5489cac9ecdd53f2e` | Canonical ESM Job API loader with normal empty-Job self-test; reports nonzero helper unmount as failure and retains owner. Both runtimes PASS build, original-Medium-before snapshot(objects2), and mount. Node20 actor FAILS pre-JS0xc0000142; Node22 FAILS code1/stderr/nonready. NO live-original-after/CRUD success. Full local1703+147. |
| `0eb15199fa9bcfebe2cb4af8f3cd65530018ea63` | Native same-profile unique WRITE_RESTRICTED Low raw-control self-test before READY; harmless zero/read opens of exact new owned device only; no token/event IOCTL. **Node20 FAILS `helper startup control-zero-open`: zero-access raw open succeeded**, so helper rejects READY/unmounts and actor never launches. Node22 FAILS first-test10s trusted setup hook before executing this new test. Full local1706 Core/168 skipped +147 extension. |
| `43ff4022c8b6ad5a9f4cfea0d7d7250d617e658b` | Fixes trusted fixture lifetime: compose four existing30s tool limits plus10s desktop handshake rather than default10s total hook; await exact setup Promise before cleanup; record fixed phase durations. Actor deadlines, mandatory assertions, exit/denial predicates and skip policy unchanged. Full local1706+147 PASS. Both Windows runtimes now reach the raw-control test and FAIL `control-zero-open`; all13 fixture setups ready each runtime (maximum3691ms Node20/6118ms Node22). Native process11,diagnostics10,RPC7 each pass both. CI8 green/2 Windows red/1 independent Ubuntu22 ECR rate limit. |
| `c6a1c4520e9f9e2c4a3fdb779b5838bbaa811440` | Restores non-Windows CI stability: bounded two-registry fallback to the exact same verified official Alpine3.20 multiarch index digest, not a different/mutable image.5 portable failure/identity tests added; real Linux Docker security assertions unchanged. Full local1711 Core/168 skipped +147 extension; all9 non-Windows CI PASS including4 Linux L1. Both Windows view prerequisites FAIL control-zero-open; mic-only process11/diagnostics10/RPC7 each PASS20/22; actual state gate remains PASS ready Node22. |

Each source's `*-checks.json`, Node20/22 lossless `*-events.gzip.json`
and verified `*-tested-merge.json` live in
`docs/evidence/windows-l1-continuation/`; SHA256 manifest preserves historical
receipts unchanged. The evidence README documents verified decoding; no event
is omitted from the compressed arrays. Local check receipts identify source/log hash/platform.
A compile/mount/setup failure is never counted as actor denial or filesystem
success. ca04414's mounted result is historical experimental evidence, not a
safe mechanism selection.

### Confirmed control-plane blocker, not a data-write workaround

Pinned Dokan2.3.1 `sys/init.c:DokanSetVolumeSecurity` installs only DACL, not
SACL/LABEL. Supplying Low SDDL does NOT install a Low raw-device label. Raw disk
create bypasses CROT file callbacks; `sys/fscontrol.c:DokanDiskUserFsRequest`
dispatches token/event requests with FILE_ANY_ACCESS; `sys/access.c` can open
pending requestor tokens. Native0eb1519(Node20) and43ff402/c6a1c45(both Node20/22) demonstrate the required
zero-access raw open is reachable by the exact Low restricted profile. **No sensitive IOCTL
or token theft was attempted; opening alone is not claimed as a completed exploit.**
The pre-READY check deliberately fails closed, does not grant data rights or
solve atomic/concurrent isolation, and is not a production backend. Never lower
the raw label or ignore this result merely to make ordinary writes pass.

WinFspv2.1 was inspected as a possible separate-control-handle design, not
selected/installed/linked/bundled. Its GPLv3/FLOSS-only linking exception does
not justify silently relicensing current UNLICENSED CROT or assuming commercial
rights. No license/configuration change is made. A suitable signed mechanism and
native exact-token/Job/control isolation proof remain required.

Received user archives: SHA256 receipts show the two104831151307 files are
identical. Tested mergec2d8d8e433b4a431d1a246217a3a5db019b608bd has source077c9fe
and main289f500; only write-boundary.test.ts fails on Windows, not managed-service
regressions. Ubuntu22 ECR rate limiting is recorded separately.2ee1a90's Ubuntu24
ECR failure is also retained; 0eb1519 has all9 non-Windows checks green.43ff402 has8 green/2 Windows
red/1 independently retained Ubuntu22 ECR `toomanyrequests` failure.
C6a1c45 removes the registry single point of failure without changing image identity
or security assertions; all9 non-Windows jobs now pass.

### Eight mandatory acceptance criteria

| # / criterion | Source commit and concrete proof | Remaining status |
| --- | --- | --- |
| 1 Ordinary APIs on original Medium backing; unchanged SD | `ca04414` events: signed build, original-Medium-before(objects2), mounted on20/22; `9a2765e` snapshot/fault tests. `0eb1519`/`43ff402`/`c6a1c45` refuse unsafe control before actor. | NOT MET: no ready-actor passing same-backing CRUD/after-SD result; full sharing/replace/mmap absent. |
| 2 Processes/env/stdio/lifecycle | `c6a1c45` test-summary native-process11/11 each runtime, separate mic-only transport component (binary streams, argv/env/cwd, existing Core, real cmd/PS, detached descendant/cleanup). `ca04414` retains failed helper unmount owner. | PARTIAL: strong unique-token Node20 pre-JS and descendants/NUL remain; complete view crash/recovery unqualified. |
| 3 Global outside/Low/aliases/concurrency/descendants | `4aa7546` Windows ordinal Unicode-case protection; `c6a1c45` ready Node22 global-Low boundary test passes. Raw control zero-open native FAIL is explicitly retained. | NOT MET: raw control separation, full aliases/races/other-Job/descendants and original-backing proof absent. |
| 4 Actual CROT secrets/key/settings/audit/control/self-approval/Docker | `e0cdb06` provider +`9ced362` descriptor fix; `c6a1c45` Node22 ready actor5 EPERM reads +5 writes, endpoint attempted/unreachable and working owner controls. | PARTIAL: Node20 actor pre-JS fails; Docker/self-approval/external configuration unqualified. |
| 5 Native20/22/cmd/WinPS; OS/arch/user qualification | `c6a1c45` Windows Server2025 x64 elevated host; mandatory unique-token write-boundary test-summary FAIL on20/22. | NOT MET: NUL/cmd/WinPS/Node20 compatibility; ARM64/Win11/standard-user matrix. |
| 6 Full regressions / Linux / macOS / extension / CI | `c6a1c45` full local1711/168 skipped +147; all9 non-Windows CI PASS (including4 Linux L1),2 Windows FAIL; bounded identical-digest registry fallback fixes prior ECR failure; native process11,stage6a10,workspaceRPC7 PASS both runtimes. `43f7392`/`01ed8ce` original PS/RPC assertions preserved. | PARTIAL: both Windows jobs still red; no claim all CI green or entire WP complete. |
| 7 Same Core/ExecutionGuard/PermissionEngine and safe backend | `3b91370` existing Core byte transport; `2ee1a90` one-shot exact Job through existing NativeProcessLauncher, `ca04414` canonical normal Job loader/self-test. | PARTIAL: production Windows none/not_implemented and remote fail-closed retained, not an accepted backend. |
| 8 No critical blockers, weaker fallback or fake evidence | `0eb1519`/`43ff402`/`c6a1c45` newly reachable raw control rejects READY; pre-JS/setup failures remain failed. No original/global ACL lowering, shared restricting SID, startup substitution or assertion downgrade. | NOT MET: control, compatibility, global/network, matrix and backend blockers remain. |

**Do not announce WP-23c ready.** Required next work is a safe control/data
mechanism, ordinary runtime/filesystem compatibility and the complete native
matrix; preserving partial component successes does not close those criteria.

## Historical native result — `9ced362`, actual state component qualified on Node22 only

Implementation commits:
- `e0cdb0682c6070fd7f36299f81f63f9138828d97`: AD-26 actual service private-state provider,
  fixed-name legacy hardening before secret initialization, same provider in
  service Core/bridge/audit, shim fail-before-spawn/truncation and actual-service gate.
- `9ced362379876ecf14b3b74eba7c03d8dc5b1b0c`: corrects actual native descriptor
  serialization failure and strengthens AD-24 label read-back. Query/install
  LABEL0x10 is NOT the SDDL serialization selection: serialize the returned
  SACL0x08 (DACL+SACL0x0c for state, owner+DACL+SACL0x0d for owned objects).
  Absent parent SACL is checked with GetSecurityDescriptorSacl, never inferred
  from failed encoding. No new full-SACL query/privilege or ACL weakening.
  Adds failed legacy bootstrap, empty-temp atomic-write and strict serialization/
  wrong-label/absence/persistent native cleanup regression tests.

At e0cdb06, native real-service setup failed descriptor encoding before any
actor attempt; managed-service regressions were also red. That failure is
retained and NOT called isolation. At9ced362, actual owner service startup,
authenticated ping, settings update, preserved legacy credential and exact
kernel private descriptors for5 files pass on **both20 and22**.

On **Node22**, `CROT-6A-actual-state-ready-actor` reports ready=true,
all5 reads=EPERM, all5 writes=EPERM, actual control endpoint attempted=true,
result=unreachable. The mandatory test passes, including unchanged host file
bytes and working authenticated ping afterwards. Files are actual CrotService
file-backend service/control tokens, actual device-key secret, actual
service-settings and actual Core audit file. No synthetic substitute secrets,
credential bytes or endpoint/path capabilities appear in evidence.

On **Node20**, owner controls pass but the actor exits0xc0000142 before JS;
there is no ready-actor attempt event, and the test remains FAILED. This is
not denial evidence. Self-approval, Docker and every external user config path
are still unqualified; criterion4 is NOT closed.

Full local `npm run check` for9ced362: **1683 Core passed /167 skipped,
147 extension passed**, lint/format/types/builds passed (Linux x64 Node24.14.1).
Completed CI: **8 successful /2 Windows failures /1 external Ubuntu24 registry
failure**. Linux/macOS Node20/22, Chromium and3 Linux L1 jobs pass. Ubuntu24 L1
fails pulling public ECR Alpine (`toomanyrequests: Data limit exceeded`), not
counted as green. The preceding e0cdb06 has all9 non-Windows checks green.
Both Windows jobs at9ced362 still fail the unchanged strong-token startup,
NUL reopen, descendants and shell gates. Native process component11/11,
stage6a10/10 and workspace RPC component7/7 pass in each Windows job.
Production PowerShell43f7392 and strict aligned RPC01ed8ce fixes are retained.

All check records, complete native events, failure annotations, tested PR merge
ancestry and local-log hashes are source-pinned under the evidence manifest.
[Native20](https://github.com/mysteriumpersonae/crot-mcp/actions/runs/38684369415/job/116255761687),
[Native22](https://github.com/mysteriumpersonae/crot-mcp/actions/runs/38684369415/job/116255761650).
No claim of full green CI, original-backing filesystem or production activation.

| # / acceptance criterion | Commit and concrete proof | Status / missing |
| --- | --- | --- |
| 1 Ordinary APIs/redirection on original Medium backing, unchanged workspace SD | `9ced362` Windows events retain ordinary NUL/cmd/WinPS failures; private fixture is not original workspace | NOT MET: no transparent same-backing filesystem |
| 2 Process/env/stdio/lifecycle | `3b91370` existing Core byte transport; `86d8a53`/`bde77eb`/`0625595` cleanup; `9ced362` native process component11/11 on both runtimes | PARTIAL: strong-token Node20/descendants and full crash/recovery remain |
| 3 Global writes/Low/aliases/concurrency/descendants | `9ced362` ready Node22 private CRUD and unrelated Low/WRITE_DAC denial pass | NOT MET: full aliases/concurrency/descendants and original backing unproven |
| 4 Actual state/key/settings/audit/control/self-approval/Docker | `e0cdb06` provider; `9ced362` actual-service gate PASS Node22 (5 EPERM reads +5 EPERM writes +endpoint unreachable with owner controls); Node20 pre-JS FAILED | PARTIAL, NOT MET: Docker/self-approval/external config/native20 missing |
| 5 Native20/22/cmd/PS; OS/arch/user matrix | `9ced362` Windows20/22 jobs FAILED; actual owner fixture works both but actor20 pre-JS fails | NOT MET: ARM64/Win11/standard-user and ordinary runtime compatibility |
| 6 Fullcheck/Linux/macOS/extension regressions | `9ced362` full1683+147;8 CI green; Ubuntu24 ECR rate-limit independently retained; `e0cdb06` all9 non-Windows green | PARTIAL: no claim all CI green; Windows strong-token gates red |
| 7 Existing Core/NativeHost/launcher and safe confinement backend | `3b91370` existing Core integration; `e0cdb06` same trusted provider through service; `9ced362` none/not_implemented/remote fail-closed retained | PARTIAL: no accepted production CommandConfinement backend |
| 8 No critical blockers, fake proof or weaker fallback | `9ced362` real state gate and explicit failed Node20; strict PS/RPC assertions unchanged; no global/common SID/workspace/device ACL grants | NOT MET: critical runtime/filesystem/network/matrix blockers remain |

**WP-23c NOT accepted; OD-6/OD-9 OPEN; PR27 Draft/open, no merge.** Historical
sections below are source-pinned evidence, not competing current results.

## Latest native result — `504a02f`, AD-26 follow-up awaiting qualification

The GitHub check head is `504a02ff6af7f65e5ac18722b1eb0a313b4aab31`;
its actual tested PR merge checkout is `e2d146a66949f0bf3e825ba7c6310756e7ab4a60`.
The retained tested-merge record confirms504a02f as its second parent. Full local check
**1647 Core /166 skipped +147 extension**. Native **8 successful checks,
2 Windows failures, 1 independent ECR registry failure**.
[Windows20](https://github.com/mysteriumpersonae/crot-mcp/actions/runs/38680615574/job/116244071612),
[Windows22](https://github.com/mysteriumpersonae/crot-mcp/actions/runs/38680615574/job/116244071873),
[Ubuntu22 L1](https://github.com/mysteriumpersonae/crot-mcp/actions/runs/38680615509/job/116244070907).
Complete source-pinned events/annotations/checks are retained in the evidence
manifest. Ubuntu22 cannot pull public ECR Alpine (`toomanyrequests: Data limit
exceeded`); the other three Linux L1 jobs pass. This infrastructure failure is
not a green Linux qualification and not a Windows confinement defect.

AD-25 adds internal branded cryptographic BNO prefix, the exact276-byte process
attribute alongside the unchanged1/3-handle stdio allowlist, and bounded kernel
TokenBnoIsolation read-back before the one permitted resume. Both native jobs
reach the ordinary actor launch path without a BNO attribute/read-back error.
That component success does **not** solve Node20 pre-JS0xc0000142, Node22 NUL
EPERM/descendant failures, cmd or WinPS. No object/device/workspace ACL is
weakened to hide those failures. BNO namespace descriptor/inheritance/lifetime
qualification is still incomplete.

`e0cdb0682c6070fd7f36299f81f63f9138828d97` implements AD-26 actual Windows service private files,
not synthetic secret canaries: bootstrap service/shim/secret CLI now selects
owner-only protected DACL + Medium NWNR before bytes, exact kernel SD read-back,
handle-relative no-reparse/single-link pinning and retained release ownership.
Known legacy state filenames are hardened before secret initialization; newly
created private directories are protected, existing arbitrary directories are
not relabeled. Service Core audit/bridge/state use the same provider. Shim
log protection failure prevents truncation/spawn and closes its descriptor.

A mandatory native actual-CrotService gate creates real file-backend service,
control and device-key secrets, changes real settings through authenticated
control, verifies real audit/private descriptors, then requires a ready actor's
file read/write and deliberately unauthenticated actual-endpoint attempts.
No credential/path bytes are recorded in evidence; pre-JS or failed import is
not denial. This gate is awaiting native qualification. It does not cover
self-approval, every external config or Docker; criterion4 stays NOT MET.

| Criterion | Current source / concrete evidence | Status |
| --- | --- | --- |
| 1 Ordinary APIs and original Medium backing | `504a02f` Windows20/22 events: startup/NUL/shell failures; no transparent same-backing filesystem | NOT MET |
| 2 Process/environment/lifecycle | `3b91370` native bytes/Core/exit/timeout/ready-grandchild; cleanup `86d8a53`/`bde77eb`/`0625595`; `504a02f` BNO launch read-back, ordinary descendants still red | PARTIAL |
| 3 Global outside-write/Low/aliases/concurrency | `504a02f` ready Node22 private actor denies unrelated Low and WRITE_DAC; full aliases/concurrency/descendants unproven | NOT MET |
| 4 Actual state/control/Docker | AD-26 real-service provider/gate implementation awaiting native commit-pinned evidence; Docker/self-approval/external config suite incomplete | NOT MET |
| 5 Independent native runtime/OS/arch/user matrix | `504a02f` both Windows jobs fail; ARM64/Win11/standard-user absent | NOT MET |
| 6 Regressions | `504a02f` local1647+147;8 CI green, Ubuntu22 ECR explicitly failed | PARTIAL / external infra failure |
| 7 Existing interfaces and safe backend | `3b91370` existing Core launcher; `504a02f` safe none/not_implemented/remote fail-closed; no accepted production confinement backend | PARTIAL |
| 8 No critical blockers or fake proof | `504a02f` startup/NUL/descendants/shells and filesystem/state/network/matrix blockers remain explicit; PS43f7392/RPC01ed8ce unchanged | NOT MET |

WP-23c remains OPEN, OD-6/OD-9 OPEN, PR27 Draft/open. Earlier checkpoints below
are historical, not a claim that all current checks are green.

## Earlier implementation result — `59068ab`, NOT Windows L1 acceptance

Implementation source `59068ab1b53a4fae04200c6c7361d2d553c7c3f5`:
**9 completed successful checks /2 Windows failures**. All four Linux L1 jobs,
Linux/macOS Node20/22 and Chromium pass. No external registry failure on this
pin. Full local `npm run check`: **1630 Core passed /166 skipped;147 extension
passed**, including lint/format/types/builds (Linux x64 Node24.14.1).
[Native20](https://github.com/mysteriumpersonae/crot-mcp/actions/runs/38677566639/job/116234542384),
[Native22](https://github.com/mysteriumpersonae/crot-mcp/actions/runs/38677566639/job/116234542455).
Both Windows failures remain explicit. All exact checks, complete event arrays,
annotations and local-check summary are retained with a SHA-256 manifest.
The documentation-only update containing this result does not change tested code.

`0625595` repairs actual byte teardown/setup leaks: failed completed-event,
parent/child and descriptor release retain exact owners; no new allocation on
persistent failure, retries without double close. A failed Endpoint.close can
recover. Pending kernel I/O still requires completion acknowledgement, and an
incomplete operation is quarantined, not called released.

`59068ab` fixes external debugger attachment ordering, confirmed natively:
CDB ready=true and targetReturned=true on both20/22. The launcher waits
READ-ONLY until the debugger's transient extra suspension leaves, then calls
ResumeThread exactly once and still requires returned count1. Unsupported or
malformed queries, count0 and a persistent extra suspension fail before resume.
No extra resume, weaker retry, changed actor token or new remote authority.
Node22's diagnostic target exits0. Node20 still exits3221225794/0xc0000142.

Sanitized stacks now expose OpenEvent from combase InitHookOle, AccessCheck
through BasepIsServiceSidBlocked/USER32 and CreateMutexEx from CRYPT32/WIL.
**These calls also fail in Node22's successfully exited diagnostic target.**
They are not by themselves the fatal root cause, a protected-resource attempt,
or a global boundary proof. Loader-snaps tests still exceed their existing
bounded diagnostic run and are retained as failures. No deadline is increased.

| # / required criterion | Status, implementation/source commit | Specific evidence / still missing |
| --- | --- | --- |
| 1. Ordinary APIs/redirection, original Medium backing, unchanged user SDs | NOT MET; `43f7392`, `281b559`, `59068ab` | Shared PS fix retained. Ready Node22 private fixture is not original Medium backing. NUL reopen EPERM; no transparent same-backing filesystem. No user workspace SD weakening. |
| 2. Process correctness/environment/lifecycle | PARTIAL; `3b91370`, `86d8a53`, `bde77eb`, `0625595`, `59068ab` | Native bytes/Core/exit23/timeout/ready-grandchild gates at3b91370; concrete Job/token/byte release fault injection since. Fresh native attach ordering works. Strong-token Node20/ordinary descendants/shells and exhaustive crash/recovery/ambiguous-I/O-start paths remain unqualified. |
| 3. Global outside-write/Low/aliases/descendants | NOT MET; `fcb4748`, `59068ab` | Ready Node22 private actor denies Low sibling and WRITE_DAC with trusted controls. Full aliases/concurrency/descendants + original backing unproven; no pre-JS failure counted as denial. |
| 4. Actual CROT secrets/key/config/audit/control/Docker | NOT MET; observation pin `59068ab` | No implemented qualifying actual-service suite/endpoint boundary. Environment omission is NOT Docker protection. |
| 5. Native20/22/cmd/PS and independent OS/arch/user matrix | NOT MET; `59068ab` | Both Windows jobs fail ordinary runtime cases; only x64 elevated Server runner observed. ARM64/Win11/standard user absent; workflow-write403 is a separate infrastructure limit, not acceptance. |
| 6. Regressions | PASS at `59068ab` | Full local1630+147 and all9 non-Windows checks, including all4 real Linux L1 jobs. Earlier bde77eb ECR failure separately recorded. Both Windows jobs remain red. |
| 7. Existing production interfaces/safe backend | PARTIAL COMPONENTS, NOT MET; `3b91370`, `59068ab` | Native ProcessLauncher consumed through same Core/ExecutionGuard/PermissionEngine. No accepted CommandConfinement backend; none/not_implemented and remote fail-closed remain. |
| 8. No known critical blockers or fake proof | NOT MET; `59068ab` | Startup/NUL/descendants/shells, transparent FS, actual-state/network/backend/matrix blockers remain. No required assertion/strict PS/RPC gate relaxed; no broad SID, global device or workspace ACL grants. |

Implementation changes preserve original `43f7392` production PowerShell and
`01ed8ce` aligned RPC fixes. OD-6/OD-9 stay OPEN. PR27 is Draft/open, not merged,
not review-ready. No available=true registration. No v1 platform target or
WP-25/26/27 scope is removed. Earlier sections below are source-pinned history,
not competing claims about the current source.

## Earlier native checkpoint `0625595` — still NOT accepted

Implementation source `0625595d5b720677f4642ba07fb1915896dad021`:
**9 completed successful checks /2 Windows failures**. All four real Linux L1
jobs, Linux/macOS Node20/22 and Chromium pass. Full local1624 Core /166 skipped
and147 extension. Windows native jobs:
[Node20](https://github.com/mysteriumpersonae/crot-mcp/actions/runs/38676382474/job/116230833930),
[Node22](https://github.com/mysteriumpersonae/crot-mcp/actions/runs/38676382474/job/116230834028).
Full checks/events/annotations retained with manifest. Existing native byte,
Job, strict PS/RPC gates remain, without assertion weakening. Strong-token
startup/NUL/ordinary descendants and shells remain red; all eight criterion
statuses below remain unchanged (the older table's exact281b559 evidence is
historical, not mislabeled as new source proof).

The native diagnostic now proves **ResumeThread previousSuspendCount=2** on
both Node20/22. CDB's attached flag arrives while an extra suspension is still
present. The new follow-up queries ThreadSuspendCount (NtQueryInformationThread
class35, ULONG, since Windows8.1), read-only over the already held owned thread.
It waits at most10s for count1, then still requires the real ResumeThread return
exactly1. It NEVER performs an extra resume, changes the thread context, accepts
count0/2 as successful launch or exposes thread handles/PID openers. Nonzero
NTSTATUS, wrong output size, malformed/count0 and deadline fail before resume;
production/Core does not forward diagnostics. This is a diagnostic ordering fix,
not a filesystem/token/runtime compatibility solution or new permission system.
The native ABI declaration is checked against the public phnt thread enum:
https://github.com/winsiderss/systeminformer/blob/master/phnt/include/ntpsapi.h
(no third-party implementation is copied).

Focused portable/C-ABI follow-up:90 passed (68 token ABI,2 process ownership,
4 fixed debugger lifetime,16 environment/arguments). Added delayed attach2→1,
unsupported query, count0, wrong size, invalid ULONG and persistent-suspension
cases. They prove no extra resume and no lost child on failure; native CI for
this source remains pending, and USER32/root cause is NOT claimed solved.

## Earlier acceptance checkpoint — native source `281b559`, NOT accepted

Source `281b5590892a4c689aa19906ff6cdcfb47bbdb55` has nine completed
successful checks and two failed Windows checks. All four real Linux L1 jobs,
Linux/macOS Node20/22 and Chromium pass. Local full check:1614 Core passed,
166 skipped;147 extension passed. Native jobs:
[Node20](https://github.com/mysteriumpersonae/crot-mcp/actions/runs/38674838820/job/116225973416),
[Node22](https://github.com/mysteriumpersonae/crot-mcp/actions/runs/38674838820/job/116225973421).
Exact checks, full event arrays and annotations are in the SHA-256 manifest.

| Criterion | Status / implementation commit | Concrete evidence / remaining failure |
| --- | --- | --- |
| 1. Ordinary same-Medium-backing workspace | NOT MET; `43f7392` shell fix retained, `281b559` owned objects | Node22 private fixture runs, not original Medium backing. No transparent filesystem exists; ordinary NUL reopen is EPERM. |
| 2. Process/environment/lifecycle | PARTIAL; `3b91370`, `86d8a53`, `bde77eb`, `281b559` | Historical native byte/exit/Core/tree gates pass at `3b91370`; cleanup ABI fault injection added since. Strong-token Node20/descendants/shells remain failed. Byte setup/event release repairs in this change require fresh native CI. |
| 3. Global write boundary | NOT MET; `fcb4748`, `281b559` | Ready Node22 private actor denies unrelated Low writes and WRITE_DAC, with trusted controls. Full aliases/concurrency/descendants plus transparent backing not proven. Node20 pre-JS failure is not a denial. |
| 4. Actual CROT state/control/Docker | NOT MET; `281b559` is observation pin, not implementation of this boundary | No qualifying actual-service fixture suite or direct endpoint confinement; environment omission is not protection. |
| 5. Independent native supported matrix | NOT MET; `281b559` | Both x64 Windows jobs fail. Native ARM64, Windows11 and standard-user qualification remain absent. Workflow creation returned403; existing x64 CI is usable. |
| 6. Regressions | PASS at `281b559`, pending fresh source | Nine non-Windows jobs including all4 Linux L1 pass; full local1614+147. Earlier `bde77eb` ECR failure is distinct and not hidden. Windows failures remain visible. |
| 7. Production integration | PARTIAL components, NOT MET; `3b91370`, `281b559` | Existing Core ProcessLauncher consumes native transport, same PermissionEngine. CommandConfinement remains none/not_implemented and remote launch fail-closed; no accepted production backend. |
| 8. No known critical blocker | NOT MET; `281b559` | Startup/NUL/descendants/shells, filesystem/state/network/backend/matrix remain blockers. No relaxed gates, broad grants, unsafe fallback or readiness invention. |

The diagnostic boolean witness reaches native attachment but the unchanged
ResumeThread ==1 check still fails. The previous message's GetLastError0 did
not reveal the returned suspend count. This change records that exact count
without extra resume attempts, tolerating debugger suspensions, or downgrading
the gate. No resolved USER32/loader root cause is claimed.

## Native process component — qualified at `3b91370`

Continued from verified `6fbfc2d634819f576a7d807ab7389800a37a7d80`
(11 completed successful checks). The new `byte-stdio.ts` implements owned
OVERLAPPED byte streams, independent concurrent stdout/stderr draining, bounded
Node stream backpressure, partial stdin writes and EOF. Asynchronous ReadFile /
WriteFile use NULL immediate-count pointers: no temporary FFI output object can
outlive the call. OVERLAPPED, event and data buffers remain pinned until native
completion; cancellation is acknowledged before release. Incomplete cancellation
quarantines native memory/handles and prevents further transport creation.

`restricted-stdio.ts` supplies exactly three privately branded child handles via
PROC_THREAD_ATTRIBUTE_HANDLE_LIST. Parent handles and unrelated inheritable host
handles are not on that list. The child is still suspended until verified Job
assignment. Child handle copies are released before resume. The native primary
process exit code is saved before handle release, including after forced cleanup.
Trusted cmd.exe wrappers preserve CommandSpec.windowsVerbatimArguments; ordinary
argv uses CRT escaping. Windows environment names such as ProgramFiles(x86) no
longer fail an incorrectly POSIX-shaped name validator.

`native-process.ts` implements the existing ProcessLauncher / ManagedProcess
contract and owns Jobs even after a direct child exits. Core can consume its
streams through the existing authorized ProcessService. A fatal transport error
is distinct from a real child exit status (`ManagedProcess.failure`); foreground
execution and background output reads report it rather than return false
success. Foreground cleanup now runs in finally. The additive error field is not
an authorization or permission-policy change; Node/Linux/macOS implementations
retain their contracts. No new IPC/filesystem broker authority is introduced.

Portable ownership/state-machine tests and compiled C ABI tests check deferred
buffer writes, NULL count pointers, 64-bit layouts and cancellation-before-free.
Real Windows gates cover binary megabyte stdio, argv/cwd/environment/exit 23,
Core stdin/timeout/permission denial, production cmd/WinPS shell preparation,
.cmd escaping, a ready detached grandchild after parent exit and cancellation
with pending reads/backpressured writes. All eight native cases passed on both
Node 20 and Node 22 at `3b9137021e794fc86832b2eb2ec5acce6ea080ee`:
[Node 20](https://github.com/mysteriumpersonae/crot-mcp/actions/runs/38662556892/job/116186984193),
[Node 22](https://github.com/mysteriumpersonae/crot-mcp/actions/runs/38662556892/job/116186984253).
All 11 CI checks completed success, including Linux L1 and Chromium. Full local
check: 1537 core passed / 152 skipped, 147 extension passed. The full native
summary arrays and check snapshot are retained with SHA-256 manifest. Linux skips
are not native proof. Existing strict WinPS and all original RPC gates remain.

This is an implementation component, not another filesystem RPC adapter and not
a complete backend. It is intentionally **not registered as CommandConfinement**.
The MIC-only native fixture is not a global write boundary. Same-backing writes,
actual CROT state/control/Docker protection,
crash/recovery and supported-machine matrix remain mandatory unclosed criteria.
No user workspace SD is modified and production availability remains false.

## Bounded environment and unique write-filter implementation — native pending

`launch-environment.ts` supplies literal fixed system paths, explicit runtime
bins, one deterministic PATH, PATHEXT, private profile/temp/cache paths, and a
private WinPS analysis cache. It never reads process.env. Core still applies its
existing AD-18 source allowlist; user literal values pass except reserved path
controls, which use the trusted layout. PSModulePath and direct DOCKER_* settings
are removed. This omission is **not** Docker endpoint isolation. Provisioning and
checking the private roots remain the confinement owner's responsibility; merely
naming a directory is not an access grant or security proof.

Both command resolution and native launch apply this policy. Core now asks the
**selected** launcher to resolve exec/start commands after the existing guard;
previously it always used the base launcher. Linux's confinement resolver already
delegates unchanged, so its policy is not changed. A native cmd traversal gate
requires bare `node` lookup, pinned runtime PATH, private temp, fixed SystemRoot,
caller literal preservation and absent direct Docker env despite hostile path
overrides. Portable seven-case policy tests and Core error-audit regressions pass.

`command-token.ts` creates fresh unique-SID WRITE_RESTRICTED Low tokens without
Everyone/Builtin Users/Restricted Code/logon SID additions. It never falls back
to MIC-only on setup failure. New mandatory native gates require owner-only
project reads, private writes, unrelated Low write denial and ready normal/hidden
Node descendants. They grant Modify only to the disposable new CROT-owned root,
never an existing user workspace. These gates are pending, **not accepted** from
token API descriptions. In particular the old rejected SID-filtered descendant
failures remain retained and are not weakened or replaced by MIC-only success.

Additional native gates test an unrelated trusted inheritable canary handle
(actual trusted ReadFile control, child attempt without canary output) and 25
failed launches with native process-handle-count checks. All old strict WinPS,
original RPC and stage-6A assertions remain in force. No Windows backend is
registered and no filesystem/view/driver decision has been made.

## `fb86f97`: new native failures retained; stronger token NOT accepted

Source `fb86f9732f7eb855c9ff7698a4b5ba185ff73292` completed 8 success / 3 failure.
Both Windows jobs failed new mandatory gates, while all original WinPS/RPC and
stage-6A assertions passed. The bounded PATH/private-temp traversal and unrelated
host-handle noninheritance gates passed on both Node versions. They do not imply
that the unique write-filter or whole L1 works.

- Unique-SID WRITE_RESTRICTED Low actor exits **0xc0000142 before JS** in all
  three direct/normal-descendant/hidden-descendant cases. No ready actor or
  denied filesystem attempt was reached: **NOT a global write denial proof**.
  The mandatory positive/negative gates stay red; no common SID is added and no
  MIC-only fallback is used to pass them. Windows 20/22 evidence preserves every
  row, not a filtered success selection.
- The new 25-failed-launch native handle-count assertion observed cold growth
  of +7 (Node 20) / +15 (Node 22), exceeding the unchanged <=2 bound. This is not
  declared clean. The next version measures one cold batch and **two** separate
  steady-state batches of 25, applying the original <=2 bound to each and
  recording all four counts. This separates one-time runtime initialization
  from continuing growth; it does not raise the bound or claim a result yet.
- Linux L1 Ubuntu 24.04 again failed pulling the unchanged Alpine fixture from
  public ECR with `toomanyrequests: Data limit exceeded`. Other three Linux L1
  checks, Linux/macOS regression and Chromium passed. This external failure is
  retained separately; no skip, replacement image or pass conversion.

Current fixes retain child-handle ownership after a failed CloseHandle and block
reuse of consumed stdio authority; parent cleanup still runs and failed closes
can be retried. A portable fault regression exercises this exact path.
For the startup blocker, bounded owned loader tracing is added: DEBUG_ONLY_THIS_PROCESS
and an after-Job/before-resume trusted diagnostic hook, never forwarded from Core
or RPC. Only the new child's PEB loader-snap flag is touched, not IFEO, registry
or the installed executable. Debug strings are reduced to failing loader symbol,
DLL basename and NTSTATUS; no raw strings/addresses/paths/arguments are published.
The regular acceptance gates remain untraced and unchanged. Trace output is
pending and will be used for an implementation fix, not acceptance.

## Previous qualification and retained rerun failure

**Latest qualified code/test source: `01ed8cece9c867bc7aef9e56b3c7c0b793bf14c7`.**
All 11 checks completed successfully; synthetic checkout
`475650d5e17e52ee02e1e4b89c63732464e34c10`.
Windows [Node 20 job 116167869297](https://github.com/mysteriumpersonae/crot-mcp/actions/runs/38656643071/job/116167869297)
and [Node 22 job 116167869398](https://github.com/mysteriumpersonae/crot-mcp/actions/runs/38656643071/job/116167869398)
pass the strict ordinary-redirection and all original workspace-RPC assertions.
Full local `npm run check` on this source passed again: 1526 core / 144 skipped,
147 extension. The implementation in `src/` is unchanged from `43f7392`.

The documentation-only HEAD `ec11e2e0dae0b4d3f0bcb70ca2b5f5fe266ab331` had
**9 successful / 2 failed** checks on its separate rerun: the initialized
strict redirection gate passed, but the legacy `powershell` workspace-RPC test
timed out on both Node versions. That test still used a raw runtime invocation,
not Core's initialized shell preparation. The failure is retained in the full
check/event snapshots; the earlier 11/11 at `43f7392` is not retroactively
rewritten as a durable raw-startup guarantee.

`01ed8ce` makes that legacy RPC gate use the same production `shellCommand`
preparation. Its user command, 60-second existing exit wait, ordinary stream
redirection, exit 23, RPC CRUD/negatives, Unicode and observed-descendant
assertions are unchanged. The separate module-free .NET path is unchanged.
The original raw discovery/redirection controls still explicitly time out; no
raw direct-process compatibility guarantee is inferred from initialized-shell
success. This correction aligns the product-like test with the production fix,
not a separate fixture-only module workaround.

## Final documentation rerun: Windows passed, external ECR failure retained

Documentation/evidence HEAD `2a09e5081500e5e92bc217716a261f76ae3c956d`
completed **10 success / 1 failure**. Both native Windows Node 20/22 jobs passed,
including the initialized strict redirection and legacy RPC gates. Linux L1
Ubuntu 24.04 x64 failed while pulling the unchanged Alpine fixture image:
`public.ecr.aws/docker/library/alpine:3.20` returned
`toomanyrequests: Data limit exceeded`.

The failure is pinned to
[job 116170366198](https://github.com/mysteriumpersonae/crot-mcp/actions/runs/38657412482/job/116170366198),
with its complete annotation snapshot retained beside the check/event arrays.
It is classified as an external registry failure, not silently skipped,
converted to PASS or called a Windows regression. The other three Linux L1
jobs passed. The prior full 11/11 at qualified code/test pin `01ed8ce` remains
valid for that run only. This documentation/evidence update triggers a bounded
repeat on **unchanged src/tests/workflows/dependency manifests**; its result is
reported separately in the final PR/archive, not assumed in this document.

## Restored baseline and implementation commits

The supplied handoff was restored in a fresh Linux checkout. `git fetch origin`
confirmed source and remote branch HEAD
`3c913841f28276e4b9d1819d9a5d10f42e5d06c1`, with no unpublished patch.
Koffi 3.3.2 installed through a fresh `npm ci`. Its baseline `npm run check`
passed: 1522 core tests / 140 skips; 147 extension tests. Windows-only skips are
not Windows proof.

- `3a677623c36669290eca3a431bc742c6602c4132`: owned debugger output now retains
  native and managed call-site names with separate budgets, removes addresses,
  parameter text and unrelated output, and runs native stacks before CLR stacks.
  Three portable regressions cover sanitization and independent budgets. Added
  paired trusted/Low discovery, explicit import and assembly-load controls.
- `43f739224cf39c7bac688aa5609de5959e73f001`: **production shell preparation**
  explicitly imports Windows PowerShell's Utility module from that runtime's
  `$PSHOME` before the unchanged user script. `shellCommand` selects this only
  for legacy `powershell`, not `pwsh` or POSIX. Core's existing ProcessService
  already calls that shell provider after authorization. No second permission
  system, audit change, new launch backend or availability change was added.

The module-qualified `Microsoft.PowerShell.Core\Import-Module` uses an explicit
runtime-relative manifest, not a name searched in the project or user module
path. `-ErrorAction Stop` prevents continuation into the user script if
initialization fails. Initialization executes **inside the launched child**;
for the Low probe the token/Job setup is completed before any child code runs.
There is no trusted execution of the user's program before lowering integrity,
no insecure retry, no execution-policy override and no disabling of module
analysis, auto-loading or security checks.

Changed production code: `src/core/platform/shells.ts`. Coverage includes
`tests/platform/windows-command.test.ts`, the native Low redirection gate and
`tests/capabilities/process.test.ts`'s real Core shell regression.

## What the native comparison actually established

At `3a67762`, raw discovery of Out-File timed out at 15 seconds for the trusted
process as well as the earlier Low case. Explicit import of the fixed system
Utility manifest completed for both trusted and Low processes, followed by
ordinary expression redirection and verified output. CDB completed with exit 0
on both Node versions. The pipeline native stack at that snapshot is in CLR
`ClassLoader::PopulateAvailableClassHashTable` / nested-type hash-table work,
not a demonstrated RPC wait or the normal remoting listener wait.

This does **not** identify every unrelated assembly encountered by discovery,
prove an infinite deadlock or explain every internal CLR cause. It does prove
that the observed failure is not unique to Low integrity and that loading the
required system module explicitly avoids this discovery path. The known
Utility assembly loads successfully in both identities in the corrected GAC
control at `43f7392`.

Two new diagnostic fixture defects at `3a67762` remain visible in the archived
failed results: an early trusted-control assertion prevented collecting the
paired Low discovery row, and the assembly control guessed a DLL next to
powershell.exe. The latter was an invalid test input, not an isolation denial.
`43f7392` collects both identities before assertions and loads the one fixed
Utility DLL under the system GAC directory. No functional acceptance assertion
was removed to fix those fixture defects.

## Strict gate and real Core regression

The original ordinary redirection script is unchanged. The supported
`bounded-runtime` row now uses the **same shared shell preparation as Core**,
not a test-only import wrapper. Each child still has its original 15-second
functional deadline; output content, completion and Medium-attempt assertions
remain. The prior bare invocation is retained as `bounded-runtime-raw`, with
all observations preserved. The suite allowance is 150 seconds only to include
that additional raw observation/debugger collection, not to extend the
functional deadline.

Both native Node versions at `43f7392` observe:

- `bounded-runtime`: exit 0, private-Low UTF-16 output contains the marker;
  `low-complete;medium-attempt` is reached, then
  `System.UnauthorizedAccessException` / `OutFileCommand` FileOpenFailure;
  no Medium output file. This is a reached MIC denial, **not** successful
  transparent Medium workspace writing.
- `bounded-runtime-raw`: still reaches `low-attempt` and times out without
  output. Direct `process.exec` of powershell.exe with arbitrary arguments is
  **not fixed** by the shell-provider initialization. Other arbitrary module
  discovery is not qualified or claimed fixed.
- The separate Core regression starts a local unconfined PowerShell shell with
  a fresh profile/cache and verifies real Medium file content, stdout, stderr
  and exit 23 before 15 seconds. It proves production process correctness,
  **not** confinement or a Low-to-Medium writable view.
- All seven original `workspace-native.test.ts` RPC gates pass. That remains
  special-adapter behavior, not ordinary filesystem compatibility.

NUL stdio remains a research startup mode. This change does not implement the
native stdin/stdout/stderr byte bridge or independently qualify every inherited
handle case.

## Pinned evidence

All decoded event arrays (including repeated titles, raw timeouts and fixture
failures) and full check snapshots are in
`docs/evidence/windows-l1-continuation/`. `manifest.json` records the SHA-256 of
each JSON file's exact stored bytes. Gzip/base64 annotation parts were retrieved
only after Windows checks completed and verified for complete ordered parts.

| Source HEAD | Synthetic PR checkout | Windows Node 20 | Windows Node 22 | Overall |
| --- | --- | --- | --- | --- |
| `3a677623c36669290eca3a431bc742c6602c4132` | `ad4284cc3e95c3b4e9a229cb0628a92bcb433d65` | FAIL; strict gate and two new fixture controls | Same | 9 success / 2 failure |
| `43f739224cf39c7bac688aa5609de5959e73f001` | `89b79d98559e25873a5965c5ec4e84dd62a8be6c` | PASS, [job 116160740422](https://github.com/mysteriumpersonae/crot-mcp/actions/runs/38654435566/job/116160740422) | PASS, [job 116160740353](https://github.com/mysteriumpersonae/crot-mcp/actions/runs/38654435566/job/116160740353) | 11 success |

Additional retained pins:

- `ec11e2e`: documentation-only source above, Windows rerun FAIL at
  [Node 20 job 116164221850](https://github.com/mysteriumpersonae/crot-mcp/actions/runs/38655518644/job/116164221850)
  and [Node 22 job 116164221991](https://github.com/mysteriumpersonae/crot-mcp/actions/runs/38655518644/job/116164221991).
- `01ed8ce`: corrected shared-initialization legacy gate, latest successful
  qualification and exact merge/job pins at the top of this report.

The event field `sourceBaseline=4031536a...` is a historical hardcoded probe
label, **not** the tested source HEAD. Source pins above come from GitHub's
commit checks and the published branch; `testedCheckout` records the merge
checkout independently. Documentation commits are separate from these code
pins.

Measured configuration: Windows Server 2025 Datacenter, Rtl 10.0.26100,
UBR 33438, x64; Node 20 v20.20.2 / libuv 1.46.0 and Node 22 v22.23.3 /
libuv 1.51.0; WinPS 5.1.26100.33438. Trusted parent High IL/elevated, children
Low IL. These admin-runner results are **not** standard-user, Windows 11 or
native ARM64 qualification. No workflow-write authorization limit from the old
connection is asserted as a fact about this session.

Local full `npm run check` on `43f7392` passed: **1526 core / 144 skipped**,
**147 extension**; lint/format/types/builds passed. Local runtime was Node v24.14.1 on Linux x86_64, not a
native Windows substitute. All four actual Linux L1 CI jobs, Linux/macOS
Node 20/22, extension checks and real Chromium CI passed on that source pin.

## Historical shared-shell acceptance snapshot — superseded by current status

| Required criterion | Result of this continuation | Blocking work still required |
| --- | --- | --- |
| Developer workflows / same Medium backing / unchanged user SDs | Not met | Transparent ordinary Node/cmd/PS writes against original backing; no ACL/IL weakening; full SD comparison |
| Process correctness and lifecycle | Partial | Shared WinPS fix retained; native byte ProcessLauncher component now implemented, native qualification pending. Bounded production environment, crash/recovery and full tree qualification remain open |
| Global write boundary | Not met | Unapproved Low sibling remains writable; MIC alone is not an allowed-write policy |
| Protected actual CROT state/control/Docker | Not met | Actual service fixtures, secret store/device key, control/IPC/self-approval/Docker and descendants/concurrent attacks |
| Native supported-machine acceptance | Partial | Node 20/22 x64 Server shell/RPC gates pass; ordinary Medium positives/full negatives, Windows 11/standard-user/ARM64 remain unqualified |
| Regression | Met at latest qualified code/test pin | Full local check and all 11 native/regression CI checks passed; this alone is not L1 acceptance |
| Production integration | Partial compatibility fix only | No Windows CommandConfinement backend or filesystem/global boundary; NativeHost remains fail-closed for remote workspace process/shell |
| No known critical blockers | Not met | All above critical gaps remain; raw direct WinPS discovery also remains a bounded-runtime limitation |

No user workspace labels or ACL grants were changed. ARCHITECTURE.md,
WP-25/26/27, Linux confinement, existing permissions/full_control/local
semantics and the macOS/Windows ARM64 v1 targets are unchanged. OD-6/OD-9
remain open. A new filesystem/identity/driver trust boundary must follow the
project's decision-before-code order and be proven by a real vertical slice;
this shell fix is not that mechanism decision. The full requested implementation
has **not** been delivered or accepted, and no backend is enabled.

## Active continuation: owned Win32 desktop (AD-24), qualification pending

The current implementation adds a fixed trusted helper owning a randomly named,
noninteractive window station and desktop. Only these NEW objects receive the
owner/SYSTEM/unique-token SID descriptor and Low mandatory label. No existing
station, desktop or workspace security descriptor is modified. The helper is
inside a host-owned kill-on-close Job; actor launch remains suspended until its
separate Job is assigned. Helper failure blocks launches and kills active actors;
normal disposal terminates actors before disposing the helper. There is no
arbitrary helper RPC or actor code before restriction. Native qualification is
mandatory; this is not a claim that the loader blocker is resolved.

The motivating pinned result is `8e6a01de3d4d29d826b6ae7436357857680e3d69`:
9 CI jobs succeeded (including all four real Linux L1 jobs), while both Windows
Node 20/22 jobs FAILED the unchanged unique-token startup gates. The owned loader
trace identifies `user32.dll` initialization failure, followed by oleaut32 delay
load failure and final STATUS_DLL_INIT_FAILED (0xc0000142), not a filesystem
security denial. Exact trace and check snapshots are stored under
`docs/evidence/windows-l1-continuation/8e6a01d-*`.

That pin also measured failed-launch handle batches: Node 20 [223,230,230,230],
Node 22 [227,242,242,242]. The original cold-growth failure at `fb86f97` remains
recorded. Both subsequent 25-launch steady batches had zero growth and satisfy
the unchanged <=2 growth bound. This is repeated-launch evidence, not proof of
all crash/teardown semantics.

Cleanup is additionally hardened: failed Job/process/stdio closes retain the
exact owned handles for retry; incomplete cleanup blocks later launches instead
of reporting a clean lifecycle. Portable fault-injection tests distinguish these
contracts from actual Windows kernel proof.

Acceptance remains OPEN: no transparent same-Medium-backing filesystem path,
actual protected CROT-service fixture qualification, complete supported-machine
matrix or production CommandConfinement backend is claimed. Backend availability
stays none/not_implemented and the PR remains Draft. The earlier full-acceptance
table describes the last qualified baseline; the active Windows gates above are
currently red, not green regression acceptance.

The helper path is further hardened after `ca50059`: it uses the SAME owned
native suspended launch and explicit three-handle allowlist, with a verified
fresh Job before ResumeThread. It does not rely on the generic host launcher's
post-spawn assignment/fallback. A duplicated source-integrity mic-only token
runs only the fixed helper; arbitrary actor code is never run at that integrity.
The command actor remains unique-SID write-only restricted and Low. This
clarifies implementation of AD-24, not an availability/security-policy fallback.

Mandatory native gates now also require ready ignored-stdio descendants with
both windowsHide settings, and ordinary cmd/WinPS private CRUD/redirection via
the unchanged production shell provider. These test a necessary private-runtime
slice, NOT transparent Medium workspace writes. Previous direct and normal/hidden
pipe-descendant gates remain. The old 0xc0000142 results remain visible until a
new native run proves otherwise.

Local `npm run check` on `ca50059213104a467eb58a590a47faa8dd33481c` passed:
1570 Core tests, 159 skips; 147 extension tests; lint/format/types/builds passed.
The Linux/Node24 sandbox skips are not Windows native evidence. New helper-path
changes require their own full and native checks.

### Native follow-up pins: partial success and setup defect, not acceptance

`ca50059213104a467eb58a590a47faa8dd33481c`: 9 CI checks passed; both Windows
jobs failed. Node 22 direct unique-token Node readiness + owner-project read +
private write + unrelated Low create/write denial passed. Node 20 untraced direct
startup still failed 0xc0000142. Both pipe-descendant gates failed (Node 22 exit
1), and both owned debugger diagnostics timed out without a proven exit. This is
not an all-runtime boundary proof. Old WinPS/RPC/native-byte gates still passed.

`427caedcd165652f51abb57de3c1cf5e21dafcf2`: native setup exposed a duplicate
Koffi type declaration, `CROT_L1_TOKEN_HANDLE`, caused by mixing source and
compiled native component graphs in one integration fixture. Both Windows jobs
failed before the new token/desktop gates executed. This is NOT a denial or
product acceptance. The correction runs the entire fixture through ONE freshly
built production graph, preserving native stdio ownership brands as well as
native type registry identity. All required gates remain mandatory.

Local full check on `427caed` passed (1571 Core / 163 skips; 147 extension);
those Linux platform skips did not detect the native setup defect. Full decoded
CI events/checks for both failed pins are retained under the evidence directory.
Additional native gates attempt owner WRITE_DAC (reapply the same DACL, with a
working trusted native control) and record a child JS-readiness witness before
attempts. Debugger runs also record whether JS was actually reached before exit.

### `fcb4748` executed gates and the owned-console implementation correction

Both Windows jobs now execute the one-built-graph gates. Node 22 direct
readiness/private write/outside-Low denial AND native owner WRITE_DAC denial
passed (trusted same-DACL setter returns 0, actor setter returns 5). Node 20
still exits 0xc0000142 before JS. All descendants and private shell gates fail;
cmd exits 23 with the expected output but has stderr; WinPS exits 0xffff0000.
These failures are retained, not reclassified as security denials. Debugger JS
witness is false on both runtimes. Nine other CI checks, including all four real
Linux L1 jobs, succeeded. Local full check passed (1571 Core/164 skips,
147 extension), not a substitute for the failed native tests.

A concrete launch defect is now corrected for requalification: the native
primitive previously always used CREATE_NO_WINDOW, but the unchanged production
cmd UTF-8 provider requires a console for chcp. AD-24 explicitly permits ONLY a
NEW hidden console on the already owned, noninteractive desktop. There is no
host console attach, interactive input switch, broad SID grant or weaker token
retry. The restricted actor remains suspended until its Job is verified;
explicit three-handle stdio inheritance remains unchanged. This does not assume
that console allocation resolves the separate Node20/user32 loader failure.

Before readiness, the helper now READS BACK the kernel owner/DACL/mandatory
label and compares OS-canonical descriptors against the exact owner/SYSTEM/
unique-SID grants and Low label, accepting only GA or its object-specific mapped
mask. Supplying an SD to CREATE alone is not accepted as evidence. A mismatch
fails closed before actor execution. Startup-cleanup failures also retain their
exact native/stdio/Job owners, block new starts, and retry without disposing the
helper while an actor cleanup remains incomplete. Two new portable fault tests
and eight user-object contract tests cover these paths; native proof remains
mandatory.

### `5d32102`: kernel descriptor self-test correctly refuses readiness

Both Windows Node 20/22 jobs fail BEFORE actor execution because the new kernel
security-descriptor read-back differs from the intended descriptor. No console,
Node, shell, descendant or ACL denial is claimed from these setup failures.
All nine other CI checks pass. Local full check passed: 1575 Core /164 skips,
147 extension. The exact decoded events/checks are retained.

The follow-up explicitly installs LABEL_SECURITY_INFORMATION on ONLY the two
fresh owned Win32 objects before reading them back. It does not change the
borrowed host station/desktop, DACL or owner, and a name collision is refused
before either setter runs. The exact kernel descriptor comparison stays
mandatory; it is not removed or replaced with a startup-success test. On mismatch,
only a bounded layout with personal/random SIDs replaced by OWNER/UNIQUE/OTHER
is reported, never a raw descriptor, secret, environment or capability. This is
needed to distinguish label installation from DACL mapping/control differences;
no descriptor mismatch is silently accepted. Portable gates cover the exact
LABEL-only setter targets, setter failure cleanup, mismatch refusal, and refusal
of hidden-console mode without an owned desktop or on WinSta0\\Default.

### `b62ea10`: explicit user-object Low installation verified; remaining failures

The exact kernel owner/DACL/Low-label self-test now passes on both native
runtimes, so the previous descriptor mismatch was not bypassed: the two fresh
objects are explicitly labeled before verification. Node22 direct private-write /
unrelated Low denial and native owner WRITE_DAC denial still pass. Node20 exits
0xc0000142 before JS; normal/hidden/ignored descendants and WinPS remain red.
Ignored stdio reports EPERM in the Node spawn path; cmd produces the expected
output/exit23 but also Access Denied. Hidden-console allocation alone did not
resolve those failures. No ordinary-process acceptance is claimed. Full local
check passed: 1576 Core /164 skips;147 extension.

This native run has 8 successful and 3 failed CI checks: the two Windows jobs
above, plus Ubuntu24 x64 L1. Its exact annotations show external ECR
`toomanyrequests: Data limit exceeded` while pulling Alpine, not an assertion
failure in Linux isolation. This is not counted as green regression. The other three real Linux L1
jobs and Linux/macOS/Chromium checks passed.

The next diagnostic records ONLY symbolic call-site rows at fixed Access Denied
breakpoints in one freshly created owned suspended actor, using a separate
trusted debugger Job and fixed commands. No arbitrary PID endpoint, executable,
script, user environment or debugger command is accepted. Its temporary log is
inside a new owner-only Medium-NR fixture directory, deleted on cleanup; only
sanitized symbols/standalone markers leave it, not raw addresses/frame arguments.
Echoed debugger commands are explicitly excluded by portable tests. Missing SDK
diagnosis is UNAVAILABLE, not a claim of an exercised debugger; the actual actor
exit assertion and all existing ordinary/runtime gates remain mandatory.
A separate ordinary NUL-reopen test adds a working trusted control; no global
NUL/device ACL is modified to make the unique token succeed.

A NEW attempt to add an extra fast-feedback workflow with the current GitHub
connection was rejected with HTTP403 (`Resource not accessible by personal
access token`) while creating the workflow tree. It made no repository change.
The original CI workflow and all original mandatory gates remain unchanged;
the failure is not bypassed through another credential/path. This is fresh
connection evidence, not an inference from the old handoff's permissions.


## Native source f4fdfee — precise NUL failure and diagnostic interference

Source `f4fdfeea8159815a5f602832644d4f249348833f` has 9 successful and
2 failed checks (both Windows). All four real Linux L1 jobs, both macOS,
both Linux Node jobs and real Chromium are green. This run has no ECR quota
failure. Node20: <https://github.com/mysteriumpersonae/crot-mcp/actions/runs/38671398687/job/116215113613>;
Node22: <https://github.com/mysteriumpersonae/crot-mcp/actions/runs/38671398687/job/116215113577>.
Full local check: 1578 Core passed /166 skipped and 147 extension passed.

Node22 direct boundary and owner WRITE_DAC denial still pass. The NEW NUL
working control succeeds in the trusted process; the genuinely ready actor's
ordinary `fs.openSync("\\\\.\\NUL", "r+")` returns EPERM. This is a real
compatibility failure, not filesystem isolation evidence. Normal/hidden and
ignored-stdio descendants remain red; cmd emits Access Denied and WinPS exits
0xffff0000. Node20 still exits 0xc0000142 before JS. Unique-token loader diagnosis
records JS-ready=false on both runtimes and times out on Node22.

The fixed CDB diagnostic itself interferes with startup: Node20 collects three
Access Denied stacks in KERNELBASE WIL feature staging and exits 0xc0000354;
Node22 fails the unchanged exact ResumeThread-count check after debugger attach.
These are debugger-affected observations, NOT proof of the undebugged DLL
failure's root cause. The raw debug log is removed and only sanitized stack
symbols are retained. No common SID, host desktop or global NUL ACL was widened.

## Job cleanup implementation follow-up — source pin supplied by commit

Fixed actual lifetime defects in the existing native Job implementation and
host wrapper: failed SetInformationJobObject configuration (including an FFI
throw) always attempts closure; failed self-test probe closure is retained too; failed closure retains the exact Job owner
across FFI API rebindings/self-test retries and blocks new allocation until
cleanup succeeds. No retry by PID or weaker process launch is introduced.

JobTracker owns a Job while the inner launch is in flight, retains failed
shutdown/launch/exit cleanup, retries it before further allocations, and does
not clear failed owners as though they were released. NativeHost.closeSync
retries retained resources even after launches are disabled. Host-close during
an inner asynchronous launch kills the returned unassigned process rather than
returning an uncontained fallback after closure. Empty-tree async close failures
are caught without an unhandled rejection; forced termination still attempts
kill-on-close if TerminateJobObject throws. The existing general-host assignment
fallback is preserved, not used by the suspended Windows L1 launcher.

Portable evidence: windows-job-ownership (6 tests), job-launcher-ownership
(8 tests), Native Host tests (7 passed /2 platform skips). These inject failures
and prove ownership/order; they do not substitute for native tree-kill gates.
Criterion 2 improves but remains OPEN, as do criteria 1/3/4/5/7/8; criterion 6's
native regression evidence is the exact f4fdfee job set above. No Windows L1
availability registration or WP-23c completion is asserted.

Unreturned children whose forced termination itself fails are retained by the
host tracker, exposed as `incompleteProcessCleanup`, and retried synchronously
on close/recovery; new allocations are blocked while cleanup keeps failing.


## Job lifetime pin 86d8a53 and token/helper ownership follow-up

Implementation commit `86d8a53d9515b4c45930b74ae56c47682327a041` repairs Job
configuration/self-test/shutdown ownership and unreturned-child cleanup. Full
local check: 1589 Core passed /166 skipped;147 extension passed. Native CI again
has **9 successful checks /2 Windows failures**, with all four Linux L1 jobs and
Linux/macOS/Chromium green. Native Windows Node20:
<https://github.com/mysteriumpersonae/crot-mcp/actions/runs/38672849973/job/116219728482>;
Node22: <https://github.com/mysteriumpersonae/crot-mcp/actions/runs/38672849973/job/116219728655>.
Existing Job tree-kill, original PowerShell/RPC and process component gates
remain in that run. Unique-token startup/NUL/descendant/shell gates are still
red, so neither this run nor the local green check accepts Windows L1.

The next implementation fixes another real ownership bug: restricted-token
close previously marked the token closed BEFORE either native CloseHandle and
could lose a handle permanently. Close now immediately disables token use,
attempts both owned handles even after a failure, retains only unreleased exact
handles, and reports `closed` only when both are released. Retry never recloses
an already released pointer. Failed creation/source-token/SID/descriptor cleanup
also stays reachable in the cached native binding and prevents further
allocation until recovery; a failed setup never returns a usable token.

The desktop helper now recovers exact failed-setup owners before allocating a
new name/token/process. Previously it retained those owners but could only
refuse every future creation forever. Async/sync shutdown are idempotent after
successful disposal, avoid writing close twice to ended stdin, and release the
bounded one-shot readiness parser instead of retaining/growing its transcript.
No actor authority, token SID filter, filesystem/desktop ACL or permission
policy is expanded by these cleanup fixes.

The fixed CDB diagnostic now uses documented `-pb` (no injected initial break-in
thread on a suspended target) and `-pd` (debugger exit does not kill target),
never `-pr`. The native launcher's exact suspend-count assertion is unchanged.
It disables debugger shell/handle inheritance and records bounded evidence even
if native resume fails. A debugger-affected exit remains diagnosis, not a denial
or ordinary-tool success. Reference: Microsoft CDB Command-Line Options,
<https://learn.microsoft.com/en-us/windows-hardware/drivers/debugger/cdb-command-line-options>.

Focused local evidence: **87 passed** across restricted-token compiled ABI
stand-in (55), helper lifetime/protocol (9), owned CDB ordering (3), sanitizer
(5), user-object ABI (9), command-token policy (4) and native process cleanup (2).
The compiled fixture's fault codes21–26 prove primary/impersonation close,
partial setup/source/SID retention, no allocation growth on persistent failure,
exact recovery and use-after-partial-close refusal. These are fault-injection
and ABI results, explicitly NOT actual Windows kernel-denial evidence.

Acceptance remains: criterion1 OPEN (no transparent same-backing filesystem);
2 PARTIAL (real process component plus new cleanup fixes, but strong-token
ordinary descendants/recovery not qualified);3 PARTIAL (Node22 direct Low-sibling
and WRITE_DAC denial only);4 OPEN (actual service secret/device/config/audit/
control/Docker boundary not qualified);5 OPEN (both current Windows jobs red,
ARM64/Win11/standard-user matrix missing);6 native non-Windows regression green
at86d8a53;7 OPEN (no production CommandConfinement backend);8 OPEN (known critical
compatibility blockers). No WP-23c ready/review-ready claim or available=true.


## Token/helper pin bde77eb — native result and next corrective implementation

Commit `bde77eb16f79206332bacff7c9e5b5b0d6f6432f` passed full local check:
1608 Core /166 skipped;147 extension. Native checks: **8 success /3 failures**.
Windows Node20 and Node22 still fail startup/descendant/NUL/shell qualification:
<https://github.com/mysteriumpersonae/crot-mcp/actions/runs/38673807056/job/116222718447>
and <https://github.com/mysteriumpersonae/crot-mcp/actions/runs/38673807056/job/116222718349>.
Ubuntu22 x64 L1 failed only while pulling Alpine from ECR with exact
`toomanyrequests: Data limit exceeded`; the other three Linux L1 jobs,
Linux/macOS Node jobs and real Chromium succeeded. The failed job is retained:
<https://github.com/mysteriumpersonae/crot-mcp/actions/runs/38673807072/job/116222718293>.
No claim that this entire source pin has green regression CI.

The -pb CDB attempt deadlocked its readiness protocol on both runtimes:
ready=false/targetReturned=false, no recorded denied call or stack frame.
Commands that wait for a debug stop cannot be the condition for resuming an
already suspended primary thread. Both failures remain visible; no deadline or
exact ResumeThread count is relaxed.

Corrective implementation supplies a transient **boolean-only**
CheckRemoteDebuggerPresent witness over the already held, newly owned child
process handle. It is valid only inside beforeResume, cannot reopen a PID or
expose a handle, and throws if saved/called after the callback. The debugger
waits for native attachment, then the launcher consumes exactly its original
single suspension. Fixed debugger commands/readiness are verified afterwards;
missing readiness is still failure. Debugger owner-forced cleanup is distinguished
from natural exit, with the native final exit code read after closure instead of
inventing an observation failure from querying an already closed handle.

The fresh private station is now explicitly labeled and its full kernel
owner/DACL/Low label is read back **before association and before creating a
desktop beneath it**. Previously the label was installed only after desktop
creation. Station-label failure now prevents desktop creation entirely. This
corrects provisioning order but does not assert that all USER32 initialization
or internal resource labels are thereby solved; native ordinary-process gates
remain decisive. No borrowed/interactive object or workspace SD is changed.

Token owners now retain their failed temporary SID/security-descriptor frees
as well as both token handles. Close attempts all resources, reports not closed
while owned memory remains, and can retry without double-free. The cached
binding still prevents allocation growth on persistent native cleanup failure.

Focused portable/C-ABI tests: **98 passed** (59 token ABI,10 user-object,9 helper
lifetime,4 owned debugger ordering,16 probe-spec). Native witness failure and
malformed BOOL are rejected before ResumeThread; process/Job handles are
released. These prove contracts/ownership, not Windows isolation. All eight
acceptance criteria retain their prior OPEN/PARTIAL statuses until actual
native proofs and the missing filesystem/state/network/backend work qualify.

## Byte teardown retry implementation follow-up

The full local check for source `281b5590892a4c689aa19906ff6cdcfb47bbdb55`
passed:1614 Core /166 skipped and147 extension. Native evidence is recorded
separately after completion; no Windows acceptance is inferred from local skips.

Further actual cleanup defects found in the byte transport are corrected:
a rejected Endpoint.close promise no longer poisons every later close after
successful synchronous/native recovery; a completed request is retained until
its event release succeeds instead of being forgotten before CloseHandle; the
native request marks released only AFTER the event handle really closes. Failed
completed-event releases stay reachable by their exact operation object and
block new native allocations until recovery. Shared released state prevents a
later owner retry from double-closing a recycled handle value. Pending kernel
requests still require acknowledged cancellation; the incomplete-I/O quarantine,
byte semantics, three-handle authority and no-reuse gate are unchanged.

Focused evidence:74 portable/C-ABI tests pass (59 token ABI,10 byte state
machine,3 byte native ABI,2 native process ownership). New cases inject failed
parent/event releases, prove no allocation growth during persistent event-close
failure, exercise async close after synchronous recovery, and preserve a
completed request until cleanup succeeds. These are ownership/ABI contracts,
not an assertion that every exceptional native setup path or the complete
strong-token lifecycle is already qualified. Criterion2 remains PARTIAL.


## Partial pipe setup ownership follow-up

The first byte release repair passed a complete local check:1618 Core /166
skipped and147 extension. Subsequent fault injection found unreturned partial
setup owners: both pipe ends and a descriptor could be lost if cleanup itself
failed. Both transport-level and native-binding setup now retain exact retry
closures, attempt every owned resource, and block new allocation until recovery.
A descriptor must really release before setup returns success. Persistent
CloseHandle/LocalFree failures cause no new native allocation; a recovery closes
each remaining resource exactly once. Pending-I/O quarantine is unchanged and
also checked by direct low-level creators. No quarantine is treated as cleanup.

New compiled C ABI cases inject simultaneous failed parent/child/descriptor
cleanup and a separate descriptor free failure after successful connection;
portable tests inject a third-pipe setup failure with two retained child owners.
These are ownership/ABI evidence, NOT Windows isolation acceptance. Ambiguous
FFI-exception I/O start paths still need further audit; this does not claim
exhaustive exceptional-path qualification or completion of criterion2/8.

Final local full check of this byte setup/count-diagnostic change: **1624 Core passed /166 skipped;147 extension passed**, including lint/format/types/builds. Focused portable/C-ABI suite:94 passed (62 token ABI,11 byte state,5 byte ABI,16 environment/argument). Runtime Linux x64 Node24.14.1; local Windows skips are not native proof. Native CI for this new source is pending.

Read-only attach synchronization full local check: **1630 Core passed /166 skipped;147 extension passed**, including lint/format/types/builds. Native Windows requalification remains pending; local platform skips are not acceptance.

## AD-25 BNO runtime implementation follow-up — native qualification pending

The existing strong token cannot create ordinary named runtime objects in an
ambient namespace just by having a private default DACL. This follow-up adds a
new, branded CROT-generated BNO prefix through the native extended-startup
attribute (BOOL + WCHAR[136], class0x20013). It is additive to, never a
replacement for, the exact one-NUL/three-byte-handle allowlist. No common SID,
global namespace/device ACL or user workspace descriptor changes.

The actual existing NativeProcessLauncher accepts only this internal capability
and passes it through the existing suspended, Job-owned launch. The native child
must still be restricted. Its exact held process handle is used to query the
actual child token's TokenBnoIsolation: enabled=true and the exact requested
prefix inside a bounded native output buffer. An unsupported attribute, foreign
pointer, malformed size/flag, mismatch or unavailable query fails BEFORE resume;
no nonisolated retry. Read-back token handles have retained retry ownership;
persistent CloseHandle failure blocks further verification/allocation. Both
native runtime versions run the same original ordinary/descendant/negative
assertions with this additional namespace component. Legacy MIC-only and strict
PowerShell/RPC gates are unchanged.

Focused portable/C-ABI:102 passed (68 token ABI,12 BNO,20 stdio authority,2
process ownership). Includes bounded output/pointer failure, persistent cleanup
failure with no growth, fabricated capability refusal, unsupported attribute with
zero child creations, and exact unchanged inherited handle set. These are ABI/
ownership tests, NOT a Windows readiness or isolation conclusion. AD-25 records
the decision before code. Native directory descriptors, child namespace
inheritance/alias/concurrency/resource lifetime, actual CROT protected state and
all eight mandatory criteria still need qualification; matching token read-back
alone does not close those requirements. Production availability remains false.

Full local check for this AD-25 implementation: **1647 Core passed /166 skipped;147 extension passed**, including lint/format/types/builds. Runtime Linux x64 Node24.14.1. Native BNO/runtime qualification is pending; local platform skips are not evidence of Windows isolation.

### Corroborated NUL compatibility limit

Microsoft's MXC process-container host-preparation documentation explicitly says
that default `\Device\Null` security omits AppContainer grants and ordinary NUL
opens can fail ERROR_ACCESS_DENIED. Its Tier3 workaround prepares shared NUL and
system-drive-root ACLs for well-known AppContainer SIDs. Those changes are forbidden
by CROT's current boundaries and were **not** executed. This supports treating the
native75ce0f2 NUL failure as a real compatibility blocker, not a successful denial
or a reason to weaken global policy. The document is source-pinned in
mxc-null-source-review.json; no MXC implementation was copied or deployed.

Source: https://github.com/microsoft/mxc/blob/ae9e3c06469fd2958da546b71bd170932e7f8ba2/docs/backends/process-container/host-prep.md
