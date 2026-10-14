# WP-23c stage 6A — workspace mediation diagnosis and direction

Status: diagnostic report delivered; remaining failures explicitly OPEN. **Not WP-23c acceptance, stage-6 acceptance, or production L1.**

Branch: `wp-23c-restricted-token-spike`; [draft PR #27](https://github.com/mysteriumpersonae/crot-mcp/pull/27), not merged. Starting point: `4031536a45d67743e5fe25b18faaf36895692f67`. Final tested code: [`61d0f87a395ed1962cdbc4b19c7c482698a992e4`](https://github.com/mysteriumpersonae/crot-mcp/commit/61d0f87a395ed1962cdbc4b19c7c482698a992e4). This documentation commit does not replace that evidence pin. `ARCHITECTURE.md`, WP-25/26/27, workflows and production source are unchanged by stage 6A. Existing failing assertions were not converted to skips.

**Historical pin:** the findings below remain attached to their original code.
Later production WinPS shell preparation and fresh Node 20/22 evidence are in
[the continuation](windows-l1-continuation.md); neither report accepts full
Windows L1.

## 1. Outcome and decision boundary

- Node 20's missing-PATH spawn failure is an environment/libuv compatibility issue, not a demonstrated Low-IL child-creation prohibition. An explicit empty PATH fixes direct Node launches and proves actual detached-descendant Job cleanup. It does **not** fix the cmd path, where the Node client's environment no longer contains PATH.
- Windows PowerShell 5.1's baseline legacy native invocation depends on PATHEXT in this experiment. Fixed `.EXE;.COM` restores the bounded version probe. The legacy full RPC scenario remains inconsistent across the final two jobs; fully redirected .NET reaches every RPC operation but times out at child completion. These are OPEN lifecycle/stdio issues, not a demonstrated filesystem-RPC rejection.
- RPC changes a real Medium NTFS directory without granting Low direct Medium writes. It is a special adapter, not transparent filesystem support. Ordinary Medium CRUD remains denied.
- **Critical boundary limitation:** the same Low process can perform ordinary CRUD in a test-created, unapproved Low sibling outside workspace/private temp. Low MIC is not a global allowed-write policy. A writable view alone cannot close that gap.
- Continue only as research. Retain RPC as a bounded reference. Before integration, compare stronger confinement combined with a genuine same-backing writable view, and the supported-Windows feasibility of Microsoft's experimental filesystem sandbox. No mechanism is selected or production activation authorized here.

## 2. Evidence, versions and reproducibility

Final native jobs, both FAILED:

- [Node 20 / Windows](https://github.com/mysteriumpersonae/crot-mcp/actions/runs/38635441734/job/116097269360): Node `v20.20.2`, libuv `1.46.0`.
- [Node 22 / Windows](https://github.com/mysteriumpersonae/crot-mcp/actions/runs/38635441734/job/116097269229): Node `v22.23.3`, libuv `1.51.0`.

Both: Windows Server 2025 Datacenter, native RtlGetVersion `10.0.26100`, UBR `33438`, productType `3`, architecture x64; Windows PowerShell `5.1.26100.33438`, FullLanguage. PR synthetic merge checkout `28ec90aed4bafff659f166215d418138274880ea`, source HEAD `61d0f87a…`. Trusted parent IL `S-1-16-12288` (High), elevated true; experimental clients/descendants IL `S-1-16-4096` (Low). Low clients still report elevation true: this is NOT standard-user qualification. No Windows 11 or ARM64 result is inferred.

Machine-readable proof: [Node 20](../evidence/windows-l1-stage6a/node20.json), [Node 22](../evidence/windows-l1-stage6a/node22.json), raw annotations and [all eleven checks](../evidence/windows-l1-stage6a/checks.json). The reporter serializes **all** events as gzip/base64 multipart annotations, validates limits, and preserves repeated titles. These files contain test-owned paths, presence flags and synthetic observations; no run capability, credentials, environment values or secret bytes. Original JSON test summaries are retained even when a preceding assertion prevents later assertions from running.

Nine other checks on the tested code passed: Linux/macOS Node 20/22, four Linux L1 architecture/OS jobs, and real Chromium. These are not Windows evidence. Earlier Linux L1 CI also encountered Docker registry `toomanyrequests`; it was not a Windows mechanism failure and was not hidden by a skip. Local verification is recorded below separately.

Reproduce on an authorized disposable native Windows runner at the pinned code:

```powershell
npm ci
npx vitest run tests/native-host/windows-l1/stage6a-decode.test.ts tests/native-host/windows-l1/stage6a-evidence.test.ts tests/native-host/windows-l1/stage6a-diagnostics.test.ts tests/native-host/windows-l1/workspace-native.test.ts
```

Run independently under the exact Node 20 and Node 22 versions above. Full CI uses `npm run check`; Linux cannot execute Windows-only tests. Actions' Node-20 deprecation warning concerns the runtime of checkout/setup actions, not the measured Node version inside these tests.

The fixtures create an actual NTFS Medium directory named `проект space 😀`, existing project files, private Low temp and protected synthetic secrets. Host reads observe actual persisted bytes; this is not a mock or a project copy/sync. It is also not qualification of a full existing Git checkout, npm/editor workflows or a user's live secrets.

## 3. Node 20: root cause, descendants and cleanup

The diagnostic matrix fixes absolute executable/client paths and compares Medium versus private-Low cwd, pipe/ignore/inherit stdio, native CreateProcessW and Node spawn/spawnSync.

| Observation | Node 20 | Node 22 |
| --- | --- | --- |
| Native Low CreateProcessW, PATH absent, suspended/unsuspended controls | Child runs, Low, canary read denied, exit 17 | Same |
| Six Node spawnSync rows, PATH absent | ENOENT, errno -4058 | Exit 17, expected child observations |
| Async/held matrix, PATH absent | Parent exit 1; checkpoint `before-spawn-pipe`; no child readiness | Complete |
| Same matrix, PATH explicitly empty | All 11 rows complete, expected statuses and pipe output | Complete |
| Detached held child observed alive after parent exit, then actual Job close | Verified with empty PATH | Verified with absent and empty PATH |
| Original mediated tree-stop gate after explicit environment correction | PASS | PASS |
| cmd-launched RPC descendant | FAIL: PATH absent again, ENOENT/-4058 | PASS |

Source corroboration is from the exact Node release vendored libuv, not just a guessed version: [Node 20 process.c](https://github.com/nodejs/node/blob/v20.20.2/deps/uv/src/win/process.c#L1022-L1045) obtains missing PATH via GetEnvironmentVariableW and exits on zero length; [Node 22 process.c](https://github.com/nodejs/node/blob/v22.23.3/deps/uv/src/win/process.c#L986-L1002) permits missing PATH. The absolute executable still encounters this environment-processing step in Node 20.

Trusted spawn controls are not identical environment controls: libuv's `uv_make_env` imports required Windows variables from the trusted parent's environment. The research native launcher builds an explicit smaller environment. Presence flags distinguish this; do not misattribute the comparison solely to integrity level.

The final cmd test receives `PATH=""` in its launch environment, but the Node client reached through cmd reports PATH absent; its descendant reproduces the same Node 20 error. The environment loss is observed. The exact cmd normalization implementation was not traced. An approved explicit minimal environment contract that survives shell traversal still needs investigation; no inherited host search path was added as a shortcut.

The empty-PATH detached probe reports readiness, is actually observed alive after parent exit 0, then disappears after the owned Job closes. Accounting `active=1` before close is supplementary, not a substitute for actual PID observation. Earlier non-detached probes were unsuitable: libuv's own kill-on-close Job can end such children when Node exits. Native own standard handles are valid, not evidence of an invalid-handle root cause.

**OPEN:** the missing-PATH async Node 20 parent exits at `before-spawn-pipe`; its lower-level abrupt error path is not fully captured. Cleanup in this row is `NOT_EXERCISED_CHILD_NOT_READY`, not a pass. The passing original tree-stop gate is a separate observed result.

## 4. PowerShell: phase localization, MRE and open causes

The bounded native-invocation MRE is `fixtures/stage6a-powershell.ps1`, invoked with `-NoProfile -NonInteractive -File`, explicit absolute Node/client paths, fixed cwd, private temp, SystemRoot and the following controlled environment variants:

| Variant | Legacy `& absolute-node --version` | .NET ProcessStartInfo, all three streams redirected |
| --- | --- | --- |
| PATH/PATHEXT absent | `$?=True`, zero PowerShell errors, empty LASTEXITCODE, no matching version | Exit 0, matching version, empty stderr |
| PATH explicitly empty, PATHEXT absent | Same incomplete legacy result | Same success |
| PATH empty, PATHEXT `.EXE;.COM` | LASTEXITCODE 0 and matching version | Same success |

Entry, version, paths and cwd are confirmed before launch. This establishes a reproducible PATHEXT-sensitive environment defect for WinPS 5.1. It does not trace a closed-source 5.1 internal function or establish arbitrary argument/stream compatibility. Public PowerShell 6/7 source is not used as proof of 5.1 internals.

The full filesystem MRE is the parameterized `workspace-native.test.ts` test, with its fixed `workspace-client.mjs` RPC adapter:

- Legacy `& Node client 1>privateLow/stdout 2>privateLow/stderr`: final Node 20 gate PASS; final Node 22 times out waiting for process exit. Earlier runs failed too; this is not a durable fix. No final Node 22 RPC result event is emitted before its wait assertion fails, so later operations/observations are NOT independently certified for that row.
- .NET UseShellExecute=false, all std streams redirected, explicit UTF-8 decoding: both clients report Low IL, correct cwd, all RPC CRUD, ten refused requests, protected-secret denial, successful descendant, and host-visible persistence. **Both outer PowerShell processes exit 98 after the explicit 45-second child-completion timeout, not expected 23.** Thus IPC and filesystem operations completed; child exit/lifecycle did not. Unicode stream/exit assertions after that failure are NOT reached.
- Ordinary PowerShell `>`: both minimal-fixed and disposable-private-profile variants reach `low-attempt`, then do not finish within 15 seconds. Neither Low nor Medium output file exists. Medium-write denial is NOT proven by these rows because the Low positive control already failed; Medium attempt is NOT_EXERCISED.

The private-profile experiment supplies only newly created disposable Low profile/cache directories and fixed system module paths; it does not relabel a user's profile. It did not resolve the timeout.

**OPEN:** concrete low-level cause of the PowerShell Out-File/redirection stall, legacy Node 22 exit stall, and .NET child-completion stall. Pending IPC handles, pipe draining and PowerShell host shutdown are hypotheses, not established diagnoses. The .NET fixture waits for exit before draining output, so it is not a general streaming bridge; current evidence does not identify a pipe-capacity deadlock. A next bounded probe should distinguish result-file completion, live handles, stream EOF and process exit without suppressing existing gates. The report explicitly does not call PowerShell solved.

## 5. Ordinary operations versus special adapter

| Operation / actual observed effects | Node 20 | Node 22 |
| --- | --- | --- |
| Read existing Medium project, Unicode/space cwd | ALLOWED | ALLOWED |
| Ordinary fs create/write/rename/remove in Medium workspace | EPERM for all four, host state unchanged | Same |
| Same ordinary CRUD in private Low control | ALLOWED, host observes all effects | Same |
| Same ordinary CRUD in unapproved Low sibling | **ALLOWED, host observes all effects** | Same |
| cmd `>` Low positive control then Medium attempt | Low file created, Medium file absent, exit 1 | Same |
| PowerShell `>` Low positive control | Timeout, no file; Medium step not exercised | Same |
| Explicit direct Node RPC, original full gate | PASS | PASS |
| Explicit cmd RPC actual CRUD | Effects observed; full gate FAIL on descendant | Full gate PASS |
| Legacy PowerShell RPC | Full gate PASS in this run only | Exit wait timeout; full gate FAIL |
| .NET PowerShell RPC | Effects observed; full gate FAIL on exit 98 | Same |

Direct Node gate also verifies empty argument, Unicode argument, quote/backslash round-trip and exit 23; these results must not be generalized to every shell. RPC create/write/rename/remove and UTF-8 contents are special-adapter behavior; ordinary fs.writeFile and shell redirection do not gain workspace write access. No transparent developer workflow is demonstrated.

## 6. Security observations and residual gaps

Meaningful negatives use working positive controls, explicit attempt records and host state checks, not a bare nonzero process exit:

- Node RPC rows execute all ten negative requests: traversal, pre-created junction, synthetic-secret/ordinary hard links, tested short-alias spelling, ADS, absolute NT path, rename into junction, exec verb and read-secret verb. All return false; wrong capability is refused. The broker was not extended into command execution or arbitrary reads.
- Protected synthetic secret reads from Low return EPERM while the trusted host can still read it. Host-observed outside, secret and original-project contents remain unchanged in completed RPC rows. This is fixture-secret proof, not real CROT credentials/DPAPI/IPC qualification.
- Root substitution is refused while the pinned root handle is owned. Idle broker close releases it and the host can rename it. Both original pin/lifecycle gates PASS.
- Runtime CRUD has working private-Low controls. Unapproved-Low CRUD also succeeds: **the global outside-write requirement remains unmet**. Medium NW denial is only one part of the boundary. MIC alone does not provide an allowlist of writable directories; [Microsoft MIC documentation](https://learn.microsoft.com/en-us/windows/win32/secauthz/mandatory-integrity-control).
- Job close terminates the observed ready detached tree in the successful environment variant. No process escape is inferred from a row in which no descendant became ready.

Limits not closed by stage 6A:

1. Static pre-created junction/alias/hard-link cases are not qualification of concurrent path replacement, mutable reparse races, all alias forms, or link-count races.
2. Connected/in-flight broker cancellation, benign concurrent requests, service crash, stream EOF/cleanup and long-running workloads are not completely qualified.
3. No independent before/after equality measurement of every fixture security descriptor was added. Existing source contains no mediator ACL/label weakening; fixtures label ONLY newly created test objects (Medium workspace, Low temp/IPC, protected artificial secret). This is not proof of complete real-user metadata preservation.
4. No actual CROT secret store/control endpoints, DPAPI, handle-transfer or GUI policy are accepted by these results.
5. No Windows ARM64, standard-user or complete Windows 11 qualification. ARM64 workflow publication remains blocked by reported `Workflows: write` authorization; existing x64 CI was used without editing workflows.

## 7. Alternatives: evidence-led comparison, not mechanism selection

Costs below are relative engineering estimates, not measured schedules. Every alternative must keep existing user-file ACLs/labels unchanged and prove global confinement independently of its write mechanism.

| Candidate | Ordinary writes / developer workflows | Boundary and abuse risks | Descendants, lifecycle, cleanup | Research / integration cost and evidence before decision |
| --- | --- | --- | --- | --- |
| Fixed bounded RPC, current reference | Explicit adapter CRUD works; ordinary fs/redirection incompatible | Narrow verbs/root/capability can constrain broker; MIC global write gap remains; mutable aliases/in-flight close not qualified | Jobs partly proven; cmd environment and PS exit/stdio still open | Low to retain as diagnostic baseline, high to make every tool adapter-aware; require original gates, race/cancellation/secret provisioning proof; cannot meet transparent-workflow requirement alone |
| Genuine write-through filesystem view, e.g. WinFsp | Potential normal runtime writes against view of **same Medium backing**, not copy/sync; changed path/device semantics may affect Git/editors | File mediation remains trusted; stronger global confinement required; handle/object identity, links, mappings, DOS/NT aliases and permissions must be enforced | All descendants use owned view; unmount after drain/cancel, crashes and open handles must fail closed | High; native feasibility on standard-user/ARM64, real CRUD/locks/mmap/rename, original-backing persistence and unchanged SDs, races and forced shutdown; [WinFsp tutorial](https://winfsp.dev/doc/WinFsp-Tutorial/) |
| AppContainer/LPAC plus bounded broker or writable view | Potential normal writes within virtual view; ordinary owner-only reads/tool startup not automatic | Stronger identity/namespace policy may close global writes; LPAC/capabilities, IPC and executable compatibility need exact proof; no grants to existing user files as shortcut | Child token/capability inheritance, stdio, network and view lifetime must be qualified | High; first bounded standard-user compatibility/secret/IPC tests and no-ACL-change backing access; [AppContainer isolation](https://learn.microsoft.com/en-us/windows/win32/secauthz/appcontainer-isolation) |
| Write-restricted SID plus same-backing view | Potential owner reads plus restricted writes; transparent view remains unbuilt | Could constrain writes using grants only on newly owned view/temp/IPC objects; earlier SID-filtered spawn/kernel-object EPERM is still rejected evidence, not solved by current MIC tests | Needs owned default DACL/kernel objects, inherited handles and jobs qualification; do not repeat phases 1–5 as if absent | High; narrowly justified follow-up with original comparison preserved; no existing-user-ACL grants and full outside-Low/secret controls; no current acceptance |
| Experimental Microsoft isolation/filesystem APIs | Potential native filesystem mediation without per-runtime adapters; precise path semantics/version support unproven | Experimental contract/capabilities and sharing require careful policy; unchanged real-file SDs and host-access limits not yet measured | Session, child/handle inheritance and teardown support must be tested on documented supported hosts | High feasibility uncertainty; on this Server runner processmodel.dll unavailable (126), APIs NOT invoked. Need supported Windows 11 host and standard-user/ARM64 evidence before decision; [CreateProcessInSandbox](https://learn.microsoft.com/en-us/windows/win32/secauthz/createprocessinsandbox), [isolation broker](https://learn.microsoft.com/en-us/windows/win32/secauthz/isoenvbroker) |
| Separate / restricted Medium identity alone | Ordinary file APIs, but same-owner/default grants may still allow outside writes; separate identity may lose project reads | Not a workspace policy by itself; no ACL grants to user files allowed; still needs broker/view and secret/IPC isolation | Different identity changes profile, startup, child tokens and host interaction | Medium/high feasibility; positive owner-only reads and outside denials without modifying user SDs, full lifecycle; not recommend standalone |
| Filesystem minifilter policy | Potential original-path normal APIs, including transparent interception | Large privileged/kernel TCB; correct identity binding, reparse/link/mapped-I/O coverage and all host surfaces required | Tag descendants reliably, handle crash/exit/reuse, revoke open handles safely | Very high; signing/install/support cost, native stress and independent review; avoid premature kernel implementation |
| ProjFS / hydration-based projection | Reads/hydration useful; notifications alone do not establish synchronous safe writes to original backing | After-the-fact copy-back is not accepted mediation; alias/state races and atomicity need a new proven design | Provider lifetime and pending notifications need cleanup; descendants not automatically confined | Medium feasibility / high if new write-through design; first prove same-backing commit semantics, not eventual copy sync; [ProjFS notifications](https://learn.microsoft.com/en-us/windows/win32/projfs/file-system-operation-notifications) |

A view solves write routing, not total isolation. AppContainer/write-restricted identity solves neither transparent reads nor compatibility automatically. No candidate is chosen just because it has simpler code or green tests.

## 8. Changes, diagnostic failures and next decision

Stage 6A added native observations, exact version/token/handle snapshots, controlled environment comparisons, Unicode/space fixtures, ordinary-write positive controls, the extra .NET PS path and lossless CI evidence transport. It corrected test-only explicit environment defaults (`PATH=""`, `PATHEXT=.EXE;.COM`). Existing legacy PS, cmd descendant and readiness assertions remain visible; no production launcher or security policy was changed.

Diagnostic infrastructure failures are distinct from original product blockers:

- Initial generic UTF-16 SID decode interpreted a native character buffer as a pointer-to-pointer; Vitest worker died with `ERR_IPC_CHANNEL_CLOSED`. Test-owned decoding was corrected to direct `char16_t` decode; a portable regression test was added. No Windows crash-dump exception code is claimed.
- An undefined Linux reporter configuration caused startup failure, corrected with conditional configuration.
- Raw notice output and uncompressed chunking hit progress/annotation limits; the final parent reporter uses lossless gzip/base64 with a portable round-trip/limit test. No failure/event is filtered out.
- The supplied `logs_104663832707 (1).zip` (SHA256 `3da0de0911e08c789e76cc82eec54c743830601e863a043a7af16f8d810d8473`) was used for the older worker-abort diagnosis: source `32363af2073577a5bfe7e522cfe909fe96f9a11c`, synthetic merge `af6d6e4…`, Node 20/22 Windows logs. It is not evidence for the newer fixed code. Full uploaded logs are not republished.

Useful chronology: [`32363af`](https://github.com/mysteriumpersonae/crot-mcp/commit/32363af2073577a5bfe7e522cfe909fe96f9a11c) (uploaded-log source), [`7f899f9`](https://github.com/mysteriumpersonae/crot-mcp/commit/7f899f99611d7dd1ad1b8e94ba975f3ddfc2137d) (safe SID decode), [`82684a4`](https://github.com/mysteriumpersonae/crot-mcp/commit/82684a415407eb4fb0d1b59ea8b927906fa0f203) (full evidence transport), [`4781386`](https://github.com/mysteriumpersonae/crot-mcp/commit/4781386c458bbfbbd028fe352b0fbeed1f1986a5) (environment controls/Unicode/.NET fixture), [`61d0f87`](https://github.com/mysteriumpersonae/crot-mcp/commit/61d0f87a395ed1962cdbc4b19c7c482698a992e4) (explicit UTF-8, final code evidence).

Recommended next owner decision:

1. Authorize a **bounded lifecycle/environment follow-up**, preserving all current gates: cmd PATH survival, PS stream EOF versus exit, Out-File Low positive control and broker in-flight close. Do not interpret passing RPC effects as passing process/stdio acceptance.
2. Separately authorize a **mechanism feasibility comparison**, not production implementation: same-backing view plus stronger global confinement versus the experimental Microsoft facility on a supported Windows host. Require unchanged user security descriptors, outside-Low denials, real developer workflow compatibility, descendants, alias/concurrency and crash teardown before architecture selection.
3. Keep WP-23c open, production L1 fail-closed, PR draft/unmerged. macOS WP-23b remains a separate v1 work package, not removed from v1. No `ARCHITECTURE.md` or WP-25/26/27 change is made here.

## 9. Local verification

`npm run check` on the final code passed locally: lint, formatting, core/extension typechecks and builds; **1511 core tests passed / 140 skipped**, **147 extension tests passed**. The 140 skips include Windows-only suites and are not Windows evidence. Log: `wp23c-6a-final-source-check.log` retained in the working evidence directory. Documentation/evidence formatting is checked separately after writing this report.
