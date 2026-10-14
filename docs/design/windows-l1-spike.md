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

## Remaining bounded experiments

1. **Preserve legitimate developer reads:** compare the full restricting-SID
   candidate with a write-restricted token plus an explicit CROT-secret read
   boundary (for example a verified mandatory-label/identity mechanism), or
   an AppContainer/identity broker. Write restriction or low IL alone does
   not protect CROT reads. No global weakening of user-file ACLs is allowed.
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
