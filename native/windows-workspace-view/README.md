# Windows workspace projection component (AD-27)

This is a native same-backing filesystem helper, **not an accepted Windows L1
backend**. It dynamically links the separately installed Dokan 2.3.1 DLL
(LGPL-3.0). No driver/header/library implementation is vendored here. The
production service does not download or install a driver. Build with the matching
Dokan development headers/import library and the Windows SDK/MSVC, for the target
architecture; independent x64/ARM64 qualification is required.

The original local root is pinned component-by-component without reparse traversal.
File operations use held relative handles, not concatenated host paths. Existing
SDs are never changed. The new volume presents private Low security; actual
backing operations execute in this fixed trusted helper. A real kernel requestor
must match the owner, Low unique restricted token, process token ID and exact
owned Job. A guessed restricting SID or PID alone is insufficient.

The first slice is deliberately incomplete: directory enumeration qualification, full sharing,
atomic existing-target replacement, full memory-map/crash and concurrent alias
qualification remain mandatory. Exclusive file opens and rejection are not a
claim of native Windows compatibility. NUL/ordinary runtime/IPC/network/global
boundary criteria are independent and remain open. No RPC write adapter or
copy-back is used and no original workspace label/DACL is weakened.

Stdin is a single trusted UTF-16 configuration frame (magic CRV1), followed only
by shutdown/EOF. It is not exposed to the actor. Stdout contains one fixed ready
marker; errors contain only bounded status codes, not paths/SIDs/content.
EOF or any unexpected control byte unmounts; mutation transport failures are
never replayed. Actor termination must precede view/helper teardown.

## Control-plane prerequisite (not a qualification workaround)

Dokan2.3.1 applies only the DACL from VolumeSecurityDescriptor to its raw disk
control device; supplying a Low SACL does not install that device label. Raw
control dispatch bypasses filesystem callbacks, and token/event IOCTLs use
FILE_ANY_ACCESS. Do not lower the raw device label to make data writes pass.
Before publishing READY, the helper tests harmless zero-access/read-only opens
of only its own exact new raw device using a read-back unique WRITE_RESTRICTED
Low profile. Any successful open or unverifiable failure rejects readiness and
unmounts. No token/event IOCTL is invoked by this self-test. A failed prerequisite
is not an actor denial or filesystem success. This is a fail-closed experimental
check, NOT proof of atomic isolation from concurrent actors. A suitable signed
mechanism must separately protect control handles while enabling Low data I/O.
