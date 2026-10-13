# Windows L1 — native restricted-token spike (WP-23c)

Status: spike in progress, **not a production L1 backend**. OD-6 is open.
Windows x64 and ARM64 remain targets with native remote shell/process. A
mechanism that meets negative tests by breaking development workflows does not
meet the product contract. WSL and x64-on-ARM execution are not acceptance.

## Implemented in this stage

`src/native-host/windows-l1/restricted-token.ts` binds native Windows APIs
through the existing koffi dependency:

- opens the current process token with query/duplicate rights;
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
`not_implemented` refusal. It launches no process and changes no user ACL.
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
the next native CI run must pass before results are accepted.

These are real DACL decisions using a restricted token, **not child execution
or complete L1 acceptance**. AccessCheck does not prove MIC, traversal,
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

## Next bounded experiments (not implemented in this stage)

1. **Preserve legitimate developer reads:** compare the full restricting-SID
   candidate with a write-restricted token plus an explicit CROT-secret read
   boundary (for example a verified mandatory-label/identity mechanism), or
   an AppContainer/identity broker. Write restriction or low IL alone does
   not protect CROT reads. No global weakening of user-file ACLs is allowed.
2. **Pre-execution boundary:** native suspended restricted-token process
   creation, safe stdio handles, verified Job assignment before resume;
   destroy the child on every partial failure. Existing launch-before-assign
   plus taskkill fallback is not acceptable for this confined path.
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
