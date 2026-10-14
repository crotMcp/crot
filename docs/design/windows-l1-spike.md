# Windows L1 — native restricted-token spike (WP-23c)

Status: spike in progress, **not a production L1 backend**. OD-6 is open.
Windows x64 and ARM64 remain targets with native remote shell/process. A
mechanism that meets negative tests by breaking development workflows does not
meet the product contract. WSL and x64-on-ARM execution are not acceptance.

## Implemented in this stage

`src/native-host/windows-l1/restricted-token.ts` binds native Windows APIs
through the existing koffi dependency:

- opens the current process token with query/duplicate/assign-primary/adjust-default and WRITE_DAC rights;
- creates a token with `DISABLE_MAX_PRIVILEGE` and one restricting SID;
- verifies `IsTokenRestricted` and duplicates an impersonation token for
  `AccessCheck` (it never impersonates the running CROT service);
- reads a fixture's owner/group/DACL and checks `FILE_READ_DATA` and
  `FILE_WRITE_DATA` separately;
- releases source/SID/descriptor/primary/impersonation allocations, rejects
  failed or malformed native output, validates paths/SIDs and rejects use
  after close. Errors omit paths, SID values and canary contents.

The flag does not mean every privilege is absent: Windows retains the
traverse privilege under `DISABLE_MAX_PRIVILEGE`. No assertion is made about
MIC, token integrity, process/IPC permissions or privilege escape.

The module is intentionally not registered in NativeHost and does not change
`CommandConfinement`, `crot_status`, permissions, approvals or the existing
`not_implemented` refusal. Stage 2 adds an internal research-only restricted
process probe; it is not a Core tool or production launcher. Tests change only
ACLs in disposable fixture directories, never user files or the installed Node
executable.
This research implementation creates no new production trust boundary.

## Tests and exact meaning of results

The compiled C ABI stand-in tests pointer/struct marshalling, allocation
cleanup, failure handling and validation. It is **not Windows security**.

Real Windows tests create disposable canary files and use native owner-only
ACLs. The restricting SID for this experiment is Builtin Users
(`S-1-5-32-545`), not an accepted production policy:

1. Owner-only CROT-like canary: restricted DACL read/write are denied while
   the trusted service retains actual filesystem access.
2. Workspace fixture with an explicit SID grant: read/write allowed.
3. Read-only fixture: read allowed, write denied.
4. Ordinary owner-only user-project file: also denied. This exposes an
   incompatibility with the intended developer-read baseline; it is **not**
   an accepted limitation or a reason to remove Windows support.
5. Missing descriptor: operation fails, not a fabricated denial/availability.
6. Token lifecycle: close is idempotent and closed tokens cannot be checked.

The first Windows CI run exposed three fixture failures: PowerShell `Get-Acl`
requires a module not available in the restricted CROT environment. The
fixture now uses direct .NET `File.GetAccessControl`/`SetAccessControl`, matching
the existing ACL implementation. No environment/security exception was added;
the corrected native Node 20/22 jobs passed at `10bab7bf`.

Stage 1 established real DACL decisions using a restricted token, **not child
execution or complete L1 acceptance**. AccessCheck does not prove MIC, traversal,
TOCTOU, inherited handles, IPC or descendants. Test failures cannot be
converted into skips on the dedicated Windows jobs.

A dedicated `.github/workflows/windows-l1-spike.yml` is prepared locally but
not published yet: the GitHub connection rejects workflow writes with HTTP
403; the same code/docs payload without the workflow succeeds. Existing CI
will execute native tests on its Windows x64 runner. ARM64 evidence remains
pending, not passed. Publishing the prepared workflow requires Workflows write
permission (classic PAT: `workflow`).

The prepared workflow requires native Node architecture and records the OS build. Windows Server 2025 x64 provides native API evidence,
not Windows 11 x64 client qualification. Windows 11 ARM64 provides a native
ARM64 run; its exact build is recorded, not assumed to cover all versions.
Both jobs also exercise existing ACL, DPAPI and Job Object tests because this
is a new architecture-specific qualification, not repetition of Linux tests.
JSON test reports are retained on success and failure.

## Stage 2 — pre-execution native restricted process probes

`probe-process.ts` adds `CreateProcessAsUserW` with a restricted primary token,
`CREATE_SUSPENDED`, `CREATE_UNICODE_ENVIRONMENT`, `CREATE_NO_WINDOW`, explicit
UTF-16 environment and `bInheritHandles=false`. STARTUPINFO and
PROCESS_INFORMATION ABI sizes are verified (64-bit x64/ARM64 layout).
The primary token is opened with query/duplicate/assign-primary rights.

The launcher verifies a fresh empty Job, creates the suspended process,
assigns it, checks Job accounting, and only then calls `ResumeThread`. Native
creation/assignment/accounting/resume failures terminate the child and dispose
owned handles/Job. No retry outside the restricted-token path exists. A
nonempty or unverifiable Job is not closed: it may belong to another workload.
The probe polls exit without blocking and closes its Job to end detached
children even after the direct parent exits.

There is no stdio bridge or inherited service environment. This is a canary
probe, not production shell/process integration. The public tool catalogue,
ExecutionGuard, PermissionEngine and NativeHost confinement are unchanged.

### Startup investigation and confirmed native result

The first stage-2 native run (`f4268b6d`) created suspended processes, but
Windows exited with `0xC0000022` (STATUS_ACCESS_DENIED) before JavaScript.
Changing only the new restricted token's default/object DACLs (`62622c30`)
did not resolve startup. These DACLs grant only the trusted owner, a generated
unique SID and SYSTEM, without modifying the original service token or any
existing CROT file ACL. Disposable workspace grants use the unique SID, not a
normal user/group.

The logon-SID fixture at `150c7149` found no logon SID in CI service identities
and stopped in setup. This was a fixture assumption failure, not proof of an
unsupported Windows configuration. The current experiment queries the trusted
Windows identity and adds an actual logon SID only when present. It never
fabricates one, adds the owner's SID to the restricting set, or skips actual
launch tests when the logon SID is absent.

The native passing candidate (`a6cdab2e`) uses the unique SID plus Builtin Users,
Everyone and Restricted Code, with the optional actual logon SID. The common
resource set is informed by Chromium's `USER_LIMITED` case in
[`restricted_token_utils.cc`](https://github.com/chromium/chromium/blob/main/sandbox/win/src/restricted_token_utils.cc).
This experiment establishes a working resource baseline, **not the exact
object responsible for the earlier loader failure**, and it does not adopt or
claim Chromium's complete sandbox.

All **11 existing CI checks passed** at
`a6cdab2eace879e4c19eebcb776506b687a52638`, including native Windows
[Node 20](https://github.com/mysteriumpersonae/crot-mcp/actions/runs/38492897789/job/115622022632)
and [Node 22](https://github.com/mysteriumpersonae/crot-mcp/actions/runs/38492897789/job/115622022728).
Local `npm run check` passed: 1458 core tests, 110 skipped; 147 extension tests.
Windows-only cases are skipped locally on Linux, not counted as local Windows
passes. The actual Windows cases passed without new skips:

- child execution: CROT-like canary read/write and creation in its protected
  directory denied; explicit disposable workspace write succeeds;
- copied native Node executable in a space-containing path, Unicode,
  empty/quote/backslash/metacharacter argv; parent-only environment absent;
- injected Job assignment failure: no user-code marker, suspended PID gone;
- detached grandchild inherits the secret-read restriction; Job close ends it
  after the parent exits;
- actual nonzero exit status.

**The common and logon SIDs are not read-only.** Existing host ACLs may grant
them writes or IPC access outside these fixtures. The passing canaries do not
establish a complete outside-write/IPC boundary, and this candidate cannot be
enabled as production L1. Existing CROT ACLs, authorizations and production
fail-closed behavior are unchanged. Owner-only developer reads remain an
unresolved functional requirement; Windows ARM64, Windows 11 client versions
and standard-user execution are not qualified by these x64 CI results.

The portable compiled ABI suite verifies ordering, partial native failures,
no resume on assignment failure, handle cleanup and no takeover of an existing
Job. These are not substitutes for the real Windows cases. Native standard-user
(not only CI admin), stdio/handle allowlist, MIC/IPC, spawn escape matrix and
full developer-read baseline remain open.

## Stage 3 — write restriction and mandatory integrity comparison

Status: native comparative probes passed at
`14084c6ff54840f588ce870851eb7f0b0c0dc5fd`, **not production L1 acceptance**.
All 11 CI checks passed, including native Windows
[Node 20](https://github.com/mysteriumpersonae/crot-mcp/actions/runs/38495613676/job/115630575415)
and [Node 22](https://github.com/mysteriumpersonae/crot-mcp/actions/runs/38495613676/job/115630575234).
Local `npm run check`: 1469 core passed / 113 skipped; 147 extension passed.
The three Windows-only comparison tests skip on local Linux and passed in the
Windows jobs; no native failures were converted to skips. No production
backend, installer, existing CROT ACL or user-project label is changed.
`CreateRestrictedToken` can now use an explicit research-only `write-only`
mode (`DISABLE_MAX_PRIVILEGE | WRITE_RESTRICTED`); the default remains the
stage-1/2 all-access restriction. `lowerProbeIntegrity` lowers only the newly
created primary probe token to Low. Its DACL-check impersonation token is
not a substitute for checking MIC: AccessCheck here deliberately loads no SACL.
`probe-integrity.ts` binds label-only SetNamedSecurityInfo, with temporary
fixture labels Low/NW, Medium/NW, and Medium/NW+NR. It never changes the DACL
or owner. Compiled ABI tests cover buffer allocation, flags, SID/descriptor
cleanup and native failure paths; these are not Windows security evidence.

The native comparison established all three of the following. Expected
exposure/functional-gap assertions identify rejected standalone candidates;
a green comparative suite does not turn those weaknesses into product guarantees:

1. Write-only restriction preserves ordinary owner-only project reads, but
   also reads an unlabelled owner-only CROT-like secret. This expected exposure
   is a test **against accepting WRITE_RESTRICTED alone**, not a desired policy.
2. Low IL plus an explicit Medium/NO_READ_UP secret label denies actual secret
   read/write/delete, while ordinary project reads and a Low-labelled disposable
   workspace continue working. A DACL-only AccessCheck may still allow the read.
3. Low IL cannot write an ordinary Medium workspace. This expected functional
   gap must be resolved with a safe implementation, not by relabelling existing
   user projects or removing Windows remote shell/process from v1.

Tests alter only disposable temporary fixture paths. They do not establish
safe production label provisioning, parent/alias/reparse/handle coverage,
secret-store/DPAPI/IPC/network boundaries, desktop self-approval prevention,
standard-user privileges, or x64/ARM64 version-matrix qualification.

Microsoft references:
[WRITE_RESTRICTED](https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-createrestrictedtoken),
[Mandatory Integrity Control / NO_READ_UP](https://learn.microsoft.com/en-us/windows/win32/secauthz/mandatory-integrity-control),
[label-only security updates](https://learn.microsoft.com/en-us/windows/win32/api/aclapi/nf-aclapi-setnamedsecurityinfow).
Low IL alone normally provides no-write-up, **not secret-read isolation**.

## Stage 4 — adversarial MIC probes and descendant compatibility

Native paired matrix passed at
`418b7d1fee04c55e6e3dfe2b51ed404b3019f99c`: all 11 CI checks green,
including Windows [Node 20](https://github.com/mysteriumpersonae/crot-mcp/actions/runs/38499124778/job/115641617524)
and [Node 22](https://github.com/mysteriumpersonae/crot-mcp/actions/runs/38499124778/job/115641617375).
Local `npm run check`: 1470 core passed / 124 skipped; 147 extension passed.
Windows-only cases skip locally on Linux, not in the native Windows suites.
No production changes, availability claim or final OD-6 selection.

The matrix runs the same file/alias/token/descendant checks for two candidates:

| Probe | WRITE_RESTRICTED + Low MIC | Privilege-stripped Low MIC, no extra restricting SIDs |
| --- | --- | --- |
| Ordinary owner-only project read | Allowed | Allowed |
| Secret without NR label (before Low/NR setup) | Exposed: standalone candidate rejected | Exposed: standalone candidate rejected |
| NR-labelled secret read/write/delete; hard-link/junction read/copy | Denied in fixture | Denied in fixture |
| Normal project hard-link/junction read | Allowed | Allowed |
| Set own token Low again (positive API/rights/ABI control) | Succeeds | Succeeds |
| Raise own token to Medium | Denied (access/privilege error) | Denied (access/privilege error) |
| Normal and hidden Node descendants with pipe stdio | EPERM: functional gap, rejected candidate | Launch succeeds; project read allowed, NR secret read denied |
| Ordinary Medium workspace write at Low IL | Denied: functional gap | Denied: functional gap |

The first native attempt (`d0057d74`) exposed the ordinary spawn failure;
`4cdd9d19` also failed with `windowsHide: true`, rejecting the console-only
hypothesis. Both SID-filtered spawn failures remain explicit evidence in the
paired suite, not skipped or declared acceptable product behavior. The passing
MIC-only descendant branch must actually launch with both window settings and
retain the secret denial. Removing the extra SID filter restores these tested
workflows; the exact failing kernel object in the earlier path is not identified.

The MIC-only research mode uses CreateRestrictedToken/DISABLE_MAX_PRIVILEGE
without an added restricting SID list, then Low IL and explicit fixture NR
labels. The original default all-access SID restriction is unchanged. This
mode is **not a complete L1 backend**: IsTokenRestricted reports restricting
SIDs, not privilege removal/MIC, and no availability is inferred from it.
The engineering direction for the next experiment is this compatible MIC
component plus a separately verified allowed-write/IPC/secret boundary, not
retaining a SID-filter candidate by sacrificing normal process spawning.

Trusted setup creates real hard links and a junction before the low child
opens them; denial of alias creation alone would not prove protected reads.
Fixture trees are not relabelled after reparse points are created. Only
throwaway paths are modified. The token-raise attempt first proves the same
API can set Low, so a malformed call is not counted as an escalation denial.

Still unqualified: process-memory/handle theft, mutable reparse races,
inherited/broker-provided handles, IPC/DPAPI, GUI/network, all host Low-labelled
write locations, production secret provisioning, ordinary workspace writes,
standard-user/client-version/ARM64 qualification. No user-project labels are
lowered and no protection is removed from production. Passing expected-gap
assertions is a research result, never full platform acceptance.

## Stage 5 — memory/handle and readonly IPC canaries

Native evidence passed at `15bb9357ee2abd5c905006fc051b212dda3c4856`:
all 11 CI green, including Windows
[Node 20](https://github.com/mysteriumpersonae/crot-mcp/actions/runs/38502122337/job/115651281558)
and [Node 22](https://github.com/mysteriumpersonae/crot-mcp/actions/runs/38502122337/job/115651281814).
Local `npm run check`: 1470 core passed / 126 skipped, 147 extension passed.
Both Windows-only memory/IPC tests skip on local Linux, run natively in Windows
and are not substituted with mock/skip evidence. Only test-owned processes, private pipe
names and artificial random bytes are used; never a user's process or secret.
The trusted victim runs inside its own kill-on-close Job. Its exact buffer
address and an open canary-file handle are provided as test metadata to a
Low/MIC-only attacker. Trusted controls must first actually read that memory
and duplicate/read the file handle. Duplicates share offsets, so the probe
resets the file offset before each read; EOF cannot masquerade as protection.
Low attacks must fail with access/privilege errors, not invalid-address/ABI
errors. This is not a general permission to inspect other processes.

IPC uses native read-only CreateFile/ReadFile, not only Node's duplex connect.
A temporary NW-only Medium pipe is expected to expose the synthetic bytes;
this explicitly rejects relying on Low/no-write-up for secret-bearing IPC.
An explicit Medium/NO_READ_UP pipe must refuse the Low reader, while a separate
Low-labelled local fixture pipe must actually work. A trusted caller must
read the protected control pipe first. All pipes have fixture-owner DACLs and
reject remote clients; no existing CROT pipe or ACL is changed.

The fixture blocks pipe connects on Koffi worker threads, not the Node loop;
the owned victim Job tears down all native handles/threads on success or
failure. Reports contain API results/counts/match booleans, never canary bytes.
These probes do not qualify memory writes, injection, races, inherited handles,
DPAPI, real CROT IPC provisioning, workspace mediation, GUI/network,
standard-user/ARM64/client-version acceptance or production L1 availability.

## Stage 6 — explicit workspace capability experiment (acceptance OPEN)

This is a bounded **explicit RPC** experiment, not a transparent filesystem
projection and not completion of stage 6. The native tests target the real
ordinary Medium directory itself, not a copied Low directory or a mock. The
Low process must fail direct writes both before and after mediated writes.
Existing project reads still use the ordinary Windows filesystem.

`workspace-probe.ts` implements four fixed verbs: create, replace UTF-8 file
contents, rename without replacement, and remove a regular file. The trusted
research caller selects one local workspace root. Requests cannot supply a
root, absolute path, stream, handle, executable, command, security descriptor
or environment. Writes are bounded to 32 KiB; no read/execute/list/link verb.
This is deliberately not registered as a NativeHost/Core capability or a second
production permission engine. Production integration still requires the
existing ExecutionGuard/PermissionEngine and the architecture decision.

The implementation pins the drive and each root ancestor, then opens one
component at a time relative to directory handles using NtCreateFile,
OBJ_DONT_REPARSE and FILE_OPEN_REPARSE_POINT. Directory opens exclude concurrent
write/delete sharing; regular files are opened exclusively, checked for
reparse/type and a single link before any mutation. New files use FILE_CREATE,
never overwrite-before-validation. Rename and deletion use the source handle
and native information classes, with a held destination directory handle;
rename cannot replace an existing destination. Ambiguous paths, DOS devices,
short-name spelling, alternate streams and extra request fields are refused.
No file security setters, process creation, impersonation or dynamic code
execution exist in the filesystem mediator.

`workspace-pipe-probe.ts` exposes only that fixed capability on a fresh,
owner-only, local-only Low-labelled named pipe, first-instance protected, with
a fresh per-run capability. This is a NEW disposable IPC endpoint; it changes
no workspace label, DACL or existing CROT endpoint. Requests and responses are
bounded; failed authentication grants no operation and returns no native path,
content or error detail. Nonblocking native I/O bounds shutdown; the client
acknowledges the tiny response before server disconnect. A peer can monopolize
this research endpoint temporarily; it is not an availability-qualified service.
The per-run capability is test-only, not a CROT credential, and must not be logged.

The three Low client cases invoke the same explicit Node RPC client directly,
from cmd.exe, and from Windows PowerShell. Tests require real host-visible
create/write/rename/remove, unchanged outside files and synthetic NR secret,
rejected junction/hard-link/namespace/stream/short-alias/exec requests, bad
capability refusal, compatible descendants and a nonzero native exit code.
Separate tests exercise root pin/release and Job-tree termination. Grammar
unit tests on Linux establish only request parsing, not Windows security.

**Evidence:** first local `npm run check` passed: 1507 core tests / 131 skipped, 147 extension tests. The five new native tests skip on Linux, not counted as local Windows passes. First Windows Node 20 run at `af2daa8` exposed a fixture environment error: spreading the platform environment included names rejected by the research launcher grammar (for example Windows names with parentheses). Four launch tests failed before process creation; root pin/release passed. The fixture now supplies only explicit supported environment names; the validator was NOT relaxed. Native rerun pending. Earlier
stage-5 passing results do not validate it. No failures will be turned into
Windows skips. The existing PR Windows x64 matrix will run on publication;
no workflow file or ARM64 permission change is part of this experiment.

**Unmet stage-6 acceptance:** ordinary `echo > file`, PowerShell file cmdlets
and unmodified Node `fs.writeFile` still cannot write the Medium workspace.
The client is an explicit adapter, not syscall interception; do NOT present it
as transparent native shell/process support. Shell redirection into private
Low test outputs is not a safe, byte-preserving inherited stdio handle bridge.
The grammar has no mkdir, binary/large writes, append, shared writers, directory
rename, watch or mmap semantics. Root pinning and static alias tests are not a
complete adversarial mutable-reparse/hard-link race proof. Remaining host Low
write areas, real protected-path provisioning, IPC/DPAPI/GUI/network, broker
resource limits and the standard-user/ARM64/Windows11 matrix remain unqualified.
A transparent filesystem mediation mechanism and an architectural choice are
still required before calling the full requested prototype complete. A green
explicit-RPC suite must not be used to lower that acceptance criterion.

API references: [NtCreateFile](https://learn.microsoft.com/en-us/windows/win32/api/winternl/nf-winternl-ntcreatefile),
[NtSetInformationFile](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/nf-ntifs-ntsetinformationfile),
[named pipe modes](https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-type-read-and-wait-modes).

## Remaining bounded experiments

1. **Safe workspace mediation and read-boundary bypass probes:** stage 3
   establishes permitted owner-only reads and explicit secret NR denial, but
   also the Medium-workspace write gap. Stage 4 qualifies static aliases,
   own-token raise denial and compatible MIC-only descendants. Next test
   process-memory/handle, mutable reparse and IPC bypasses, then qualify an isolated write view or
   brokered workspace without lowering existing user-file labels. Compare an
   AppContainer/identity broker if required to meet the same positive/negative
   contract. WRITE_RESTRICTED or Low IL alone remains rejected; no global
   weakening of user-file ACLs is allowed.
2. **Production pre-execution boundary:** qualify the research native path
   for standard-user service execution, add a safe stdio/handle allowlist and
   connect it only after the approved mechanism meets the full profile.
   Existing launch-before-assign/taskkill fallback stays forbidden for L1.
3. **Actual canary execution:** child and grandchildren attempt secret reads,
   outside writes, DPAPI extraction, handle duplication, named-pipe/control
   access, GUI self-approval and breakaway; concurrently run positive shell,
   process and development workflows.
4. **Lifecycle and resources:** stop/timeout/service crash, protected IPC,
   network on/off and mediated Docker Desktop/other configured transports.
5. OD-6 mechanism selection from comparative positive/negative evidence,
   architecture decision before production boundary changes; then native
   x64/ARM64 backend, self-test/status/audit and packaged qualification.

macOS WP-23b remains a separate work package/PR: native Seatbelt launch,
identity-scoped Keychain access, IPC and descendants, with real Intel/Apple
Silicon runners. Nothing in this Windows primitive is claimed as macOS proof.

## Release gate

Both positive native remote shell/process and the full negative safety suite
must pass, along with installer/browser UX. `not_implemented`, AccessCheck
results, mocks, safe refusal or CI definitions alone do not complete WP-23c.
