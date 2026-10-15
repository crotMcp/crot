# Windows L1: $0 third-party license-fee qualification

WP-23c remains OPEN. This document narrows the commercial licensing constraint;
it does not accept a backend or substitute for the eight mandatory criteria.
AD-28 records the decision before the experiment code. The signed AD-27 helper,
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
| Zero-capability AppContainer / LPAC + same-backing projection | OS APIs; no new third-party license fee | **Experimental qualification only:** native probe added; not selected, no data-device grant, no compatibility/whole-system isolation claim. |
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
trusted `--diagnose-control-profiles` helper option. It derives separate unique
AppContainer/LPAC SIDs, creates new private executable objects with exact-package
RX, launches a fixed co-located CROT-owned native child suspended into an empty
kill-on-close Job **at creation**, and checks actual package SID/zero capabilities/
Low IL/LPAC state/Job membership before resume. No persistent profiles are created.
Only those newly created objects receive ACLs; parent/original/global/device SDs
are never changed. Fixed child code repeats token readback after entry.

Owner positive controls open the exact new raw endpoint with both access masks
through Win32 GLOBALROOT and absolute NtCreateFile. The child repeats those four
**harmless open/close operations only**; no IOCTL or event/token operation exists.
The four results distinguish strict native access denied, open success, namespace
absence, and other failure. A signed fixed exit marker proves child entry; loader
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
data access is enabled. Next gates must include that exact grant, original
Medium immediate-host CRUD and SD identity, ready Node20/22/cmd/WinPS descendants,
outside-Low/protected state/Docker/network/aliases/races/lifetime and independent
Windows11 standard-user x64/ARM64 coverage. No criterion is marked met by design.

OS API references:
- https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer
- https://learn.microsoft.com/en-us/windows/win32/secauthz/appcontainer-isolation
- https://learn.microsoft.com/en-us/windows/win32/secauthz/appcontainer-for-legacy-applications-
- https://learn.microsoft.com/en-us/windows/win32/api/userenv/nf-userenv-deriveappcontainersidfromappcontainername
- https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute
