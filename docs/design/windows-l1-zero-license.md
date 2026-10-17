> **Исторический отчёт, не текущий статус.** Срез main — merge PR #27
> `e23b7b9`, WP-23c Done, OD-6 / Windows OD-9 закрыты AD-30.
> [Действующее руководство](../L1.md), [текущая приёмка](windows-l1-curator-appcontainer.md).
> Все Draft/open/not_implemented/NOT MET ниже относятся только к исходным
> экспериментам и их SHA; отрицательные результаты и ограничения сохранены.
> AD-27/AD-28 не являются выбранным производственным механизмом.

# Windows L1: $0 third-party license-fee qualification

WP-23c remains OPEN. This document narrows the commercial licensing constraint;
it does not accept a backend or substitute for the eight mandatory criteria.
AD-28 records the decision before the experiment code. The AD-27 helper with signed Dokan driver,
PowerShell/RPC gates and unavailable production backend remain unchanged.

## License decision

Dokan is not rejected because CROT is commercial or proprietary. Its official
site explicitly permits commercial products subject to its licenses. The
upstream README maps library/driver/network/FUSE/installer components to LGPL,
control tools and samples to MIT. The pinned v2.3.1.1000 LGPL text is LGPLv3.
No per-copy commercial license purchase is required by those grants. Donations
are optional, not a commercial-use fee.

This does not waive obligations: audit the actual distributed DLL, driver,
installer and other components; preserve notices and license copies; provide
corresponding LGPL library source, including modifications; satisfy LGPLv3
section 4's combined-work/relinking or suitable shared-library mechanism and
reverse-engineering/modification terms; supply installation information where
applicable. Do not copy upstream sample/library implementation into proprietary
CROT without checking that component's license. The diagnostic code here is
CROT-owned, uses Windows SDK/OS APIs, and embeds no Dokan/Chromium implementation.
A release compliance checklist and legal review remain a shipping prerequisite.
A runtime hash/version/signature pin is not an automatic LGPL exception to library
replacement/relinking requirements. Validate an LGPLv3 section4(d)(0) relinking
materials route or4(d)(1) suitable compatible shared-library mechanism and applicable
installation information; do not silently waive either compliance or security.
CROT remains UNLICENSED; this is conditional engineering/compliance analysis, not
legal clearance or a change to CROT licensing.

Authoritative sources:
- https://dokan-dev.github.io/ (FAQ: commercial products; license section).
- https://github.com/dokan-dev/dokany/blob/v2.3.1.1000/README.md
- https://github.com/dokan-dev/dokany/blob/v2.3.1.1000/license.lgpl.txt
- https://github.com/dokan-dev/dokany/blob/v2.3.1.1000/license.mit.txt

WinFsp's GPL/FLOSS-only linking exception is not a proprietary CROT exception.
No WinFsp binary is installed/linked/bundled, no paid commercial route selected,
and no repository license is changed.

## Security decision, separate from license

| Candidate | License fee | Current engineering verdict |
| --- | --- | --- |
| Stock signed Dokan + existing WRITE_RESTRICTED Low actor | $0 under LGPL/MIT conditions | **Rejected as currently safe:** native `0eb1519`, `43ff402`, `c6a1c45` demonstrate raw zero-access open before READY. No sensitive IOCTL invoked. |
| Stock Dokan network mode | $0 under same conditions | **Not an escape hatch:** upstream network volume dispatch calls the same disk control dispatcher. Hiding a raw name is not authentication. |
| Zero-capability AppContainer / LPAC + same-backing projection | OS APIs; no new third-party license fee | **Not qualified:**75ce0f2 fixed children enter, four owner-positive raw controls deny, but NUL RW fails and no projected-data grant/full runtime proof exists. Literal NT0 also denies owner, hence is inconclusive for isolation. |
| Hardened LGPL Dokan with controller-open capability in kernel | $0 license fee; publish library/driver modifications as required | Technically plausible but **not implemented/qualified**. Needs atomic controller FILE_OBJECT authorization for every privileged operation/alias, authenticated data requests, lifecycle/race proof and a production signed binary. |
| WinFsp proprietary commercial license | Paid route | Outside this budget; not selected. |
| Windows Sandbox/VM | Edition/platform prerequisites vary | Not a drop-in or proven $0-license replacement. Mapped folders do not prove all workspace/protected-subtree/alias/lifetime requirements. |

The existing device DACL and supplied Low SDDL do not authenticate ANY_ACCESS
IOCTLs; upstream installs only DACL, not the label. Original workspace or shared
device ACL changes, common restricting SIDs, lowering the raw device label,
unsigned/test-signed drivers and copy-back are forbidden. A hardened fork loses
the upstream binary's signature. Microsoft production signing qualification,
EV-certificate/account/HLK/infrastructure costs are separate from license fees;
zero license fees do not guarantee free signing. No purchase is authorized.
An upstream-maintained/signed fix would avoid owning a driver distribution but
cannot be promised without maintainers' agreement and an actual signed release.

Sources:
- https://github.com/dokan-dev/dokany/blob/v2.3.1.1000/sys/init.c
- https://github.com/dokan-dev/dokany/blob/v2.3.1.1000/sys/create.c
- https://github.com/dokan-dev/dokany/blob/v2.3.1.1000/sys/fscontrol.c
- https://github.com/dokan-dev/dokany/blob/v2.3.1.1000/sys/access.c
- https://learn.microsoft.com/en-us/windows-hardware/drivers/dashboard/code-signing-reqs
- https://learn.microsoft.com/en-us/windows-hardware/drivers/install/kernel-mode-code-signing-policy--windows-vista-and-later-

## Implemented qualification experiment (not backend)

`native/windows-workspace-view/control-profile-probe.h` runs only with the fixed
trusted `--diagnose-control-profiles` helper option. The initial profileless experiment failed CreateProcess before child entry.
The supported-bootstrap continuation creates separate new per-user profiles with
CreateAppContainerProfile, obtains their unique AppContainer/LPAC SIDs, creates
new private executable objects with exact-package
RX, launches a fixed co-located CROT-owned native child suspended into an empty
kill-on-close Job **at creation**, and checks actual package SID/zero capabilities/
Low IL/LPAC state/Job membership before resume. Only S_OK grants profile ownership; existing profiles are never adopted. Exact
profile owners are retained for deletion after the child Job settles and token/
process handles close. Cleanup failure stops fresh allocation and is not qualified
evidence. Teardown retries the exact owned profiles. Abrupt-death/crash recovery
is unqualified: this remains a disposable hosted-CI experiment, never production.
Only those newly created objects receive ACLs; parent/original/global/device SDs
are never changed. Fixed child code repeats token readback after entry.
At4804e32, the LPAC SDK class46 query returns STATUS_INVALID_INFO_CLASS even with
its fixed ULONG ABI.75ce0f2 uses effective public AccessCheck observations instead:
user-only deny, exact-package positive, AAP distinction and LPAC ARAP positive.
These are in-memory descriptors only; no object receives a shared-SID grant.
This verifies effective access semantics, not successful token-flag querying.

Owner positive controls open the exact new raw endpoint with both access masks
through Win32 GLOBALROOT and absolute NtCreateFile. The absolute-NT minimum uses FILE_READ_ATTRIBUTES | SYNCHRONIZE and a
non-directory open to match Win32 minimum metadata semantics (not literal zero
NtCreateFile DesiredAccess, which failed owner controls at `673edb6`). The v2 child
repeats those four and a fifth literal-zero NON_DIRECTORY NT open, with a separate
owner literal-zero classification. These are **harmless open/close operations only**; no IOCTL or event/token operation exists.
All five results distinguish strict native access denied, open success, namespace
absence, and other failure. A fixed typed exit marker proves child entry; loader
0xc0000142, create/readback/wait/protocol/cleanup failures never become denial.
An ordinary NUL open/close is separately observed, not a stdio workaround.

Two profile results are encoded in a bounded fixed hex frame. The existing
helper still runs the original mandatory raw-control test and refuses READY on
failure. Evidence is decoded only for a trusted diagnostic run, logged as fixed
`CROT-6A-workspace-view / control-profile-probes` data, then the original error
is rethrown. Native fixture builds both fixed executables with SDK/OS libraries;
pinned signed Dokan provisioning, actor deadlines and security assertions stay.

**Important limit:** no package is granted raw-device or workspace rights in this
experiment. Even four access denials do not prove control/data separation after
data access is enabled. Next gates must grant only projected data access while preserving raw control
isolation (if raw-device grants are required, test them explicitly and reject
any reopened control), validate literal-zero owner/profile results, and prove original
Medium immediate-host CRUD and SD identity, ready Node20/22/cmd/WinPS descendants,
outside-Low/protected state/Docker/network/aliases/races/lifetime and independent
Windows11 standard-user x64/ARM64 coverage. No criterion is marked met by design.

OS API references:
- https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer
- https://learn.microsoft.com/en-us/windows/win32/secauthz/appcontainer-isolation
- https://learn.microsoft.com/en-us/windows/win32/secauthz/appcontainer-for-legacy-applications-
- https://learn.microsoft.com/en-us/windows/win32/api/userenv/nf-userenv-deriveappcontainersidfromappcontainername
- https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute

## Source-pinned native result

Latest source75ce0f2; full local1732 Core/168 skipped +147 extension PASS.
8/9 non-Windows jobs PASS; 2/2 Windows jobs FAIL. Complete events/checks/merge ancestry and all eight criteria are in
windows-l1-continuation.md and the evidence manifest. No safe backend is accepted.

- Node20: `{"protocolVersion":2,"completed":true,"ownerControls":true,"ownerNtLiteralZero":"access-denied","devicePackageAccessGranted":false,"appContainer":{"ready":true,"win32Zero":"access-denied","win32Read":"access-denied","ntMetadata":"access-denied","ntRead":"access-denied","nulReadWriteOpened":false,"ntLiteralZero":"access-denied"},"lpac":{"ready":true,"win32Zero":"access-denied","win32Read":"access-denied","ntMetadata":"access-denied","ntRead":"access-denied","nulReadWriteOpened":false,"ntLiteralZero":"access-denied"}}`
- Node22: `{"protocolVersion":2,"completed":true,"ownerControls":true,"ownerNtLiteralZero":"access-denied","devicePackageAccessGranted":false,"appContainer":{"ready":true,"win32Zero":"access-denied","win32Read":"access-denied","ntMetadata":"access-denied","ntRead":"access-denied","nulReadWriteOpened":false,"ntLiteralZero":"access-denied"},"lpac":{"ready":true,"win32Zero":"access-denied","win32Read":"access-denied","ntMetadata":"access-denied","ntRead":"access-denied","nulReadWriteOpened":false,"ntLiteralZero":"access-denied"}}`

### Interpretation and next implementation gate

At75ce0f2 both native profiles/runtimes reach fixed child entry after actual Low,
zero-capability, package-SID, Job and effective-access checks. All four Win32/
metadata/read raw opens deny while the matching owner positive controls succeed.
The fifth literal NT DesiredAccess0 open also denies the owner: this result is
**inconclusive for isolation**, not an additional positive-control-backed denial.
Both profiles report ordinary NUL generic read/write false. A fixed native /MT
child starting does not establish Node20/22, cmd, WinPS or stdio compatibility.
`ready:true` in this diagnostic means child entry/predicates, never backend READY.

No safe Windows L1 backend is selected. Stock Dokan remains eligible on license
fees, but the existing Low profile is rejected for raw reachability. AppContainer/
LPAC is not a qualified drop-in replacement: NUL compatibility is a concrete
functional blocker and data-only grants/control separation have not been tested.
Do not install any grant on shared NUL/raw/global objects to bypass it. Next work
must demonstrate ordinary named-NUL/runtime semantics with an owned per-execution
mechanism, or select another mechanism without that compromise; then prove
projected-data-only grants and every raw alias again. If that cannot be done under
the stated constraints, this branch cannot be promoted merely because it is $0.
A hardened upstream/fork route still needs an actual production-signed artifact;
no free signature, maintainers' acceptance or shipping clearance is promised.

### Release compliance checklist (not yet fulfilled)

- Inventory exact shipped DLL/driver/installer/tools and each component's license.
- Include notices and LGPLv3/MIT plus applicable incorporated license terms.
- Provide corresponding LGPL library source and modifications by a compliant method.
- Validate section4(d)(0) relinking materials or4(d)(1) suitable shared-library
  replacement; runtime security pins are not an automatic exception.
- Preserve required modification/reverse-engineering permissions for library debugging,
  notices and applicable installation information; review the combined-work EULA.
- Obtain release legal/compliance review without silently relicensing CROT.
- Separately resolve Windows edition/signing/EV/HLK/infrastructure needs; $0 license
  fees is not a promise of $0 total distribution cost. No purchase is authorized.

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
