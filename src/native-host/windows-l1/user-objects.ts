/** AD-24: only NEW owned noninteractive Win32 objects, in the fixed helper. */
import { CrotError } from "../../core/errors.js";
import { validateSid } from "../validation.js";
import type { TokenFfi } from "./restricted-token.js";
export interface OwnedUserObjects {
  readonly desktop: string;
  close(): void;
}
const SECURITY = "CROT_OWNED_USER_SECURITY",
  HANDLE = "CROT_OWNED_USER_HANDLE",
  SIZE = "CROT_OWNED_USER_SIZE";
interface UserObjectsFfi extends TokenFfi {
  readonly decode: { string16(pointer: unknown, length: number): string };
}
const declared = new WeakSet<object>();
const ok = (value: unknown) => value === true || (typeof value === "number" && value !== 0);
const valid = (value: unknown) =>
  value !== null &&
  value !== undefined &&
  value !== 0 &&
  value !== 0n &&
  value !== -1n &&
  value !== 0xffffffffffffffffn;
export function validateOwnedDesktopName(name: string): string {
  if (!/^crot-[0-9a-f]{48}\\actor$/.test(name))
    throw new CrotError("INVALID_INPUT", "Invalid owned Win32 desktop name.");
  return name;
}
export function bindOwnedUserObjects(ffi: UserObjectsFfi) {
  if (!declared.has(ffi)) {
    ffi.struct(SECURITY, { length: "uint32_t", descriptor: "void *", inherit: "int32_t" });
    ffi.struct(HANDLE, { value: "void *" });
    ffi.struct(SIZE, { value: "uint32_t" });
    declared.add(ffi);
  }
  if (ffi.sizeof(SECURITY) !== 24)
    throw new CrotError("OPERATION_FAILED", "Owned Win32 objects require the 64-bit ABI.");
  const k = ffi.load("kernel32.dll"),
    a = ffi.load("advapi32.dll"),
    u = ffi.load("user32.dll");
  const last = k.func("uint32_t __stdcall GetLastError(void)");
  const setLast = k.func("void __stdcall SetLastError(uint32_t error)");
  const free = k.func("void * __stdcall LocalFree(void *memory)");
  const threadId = k.func("uint32_t __stdcall GetCurrentThreadId(void)");
  const descriptor = a.func(
    `int __stdcall ConvertStringSecurityDescriptorToSecurityDescriptorW(str16 text, uint32_t revision, _Out_ ${HANDLE} *out, void *size)`,
  );
  const stringify = a.func(
    `int __stdcall ConvertSecurityDescriptorToStringSecurityDescriptorW(void *descriptor, uint32_t revision, uint32_t info, _Out_ ${HANDLE} *text, _Out_ ${SIZE} *length)`,
  );
  const querySecurity = u.func(
    `int __stdcall GetUserObjectSecurity(void *object, void *info, void *descriptor, uint32_t length, _Out_ ${SIZE} *needed)`,
  );
  const setSecurity = u.func("int __stdcall SetUserObjectSecurity(void *object, void *info, void *descriptor)");
  const getStation = u.func("void * __stdcall GetProcessWindowStation(void)");
  const setStation = u.func("int __stdcall SetProcessWindowStation(void *station)");
  const getDesktop = u.func("void * __stdcall GetThreadDesktop(uint32_t thread)");
  const setDesktop = u.func("int __stdcall SetThreadDesktop(void *desktop)");
  const createStation = u.func(
    `void * __stdcall CreateWindowStationW(str16 name, uint32_t flags, uint32_t access, ${SECURITY} *security)`,
  );
  const info = u.func(
    "int __stdcall GetUserObjectInformationW(void *object, int kind, void *data, uint32_t size, void *needed)",
  );
  const createDesktop = u.func(
    `void * __stdcall CreateDesktopW(str16 name, void *device, void *mode, uint32_t flags, uint32_t access, ${SECURITY} *security)`,
  );
  const closeDesktop = u.func("int __stdcall CloseDesktop(void *desktop)");
  const closeStation = u.func("int __stdcall CloseWindowStation(void *station)");
  const fail = (stage: string) => {
    const nativeCode = Number(last());
    return new CrotError("OPERATION_FAILED", `Owned Win32 objects: ${stage} failed (${nativeCode}).`, {
      stage,
      nativeCode,
    });
  };
  return (name: string, ownerSid: string, restrictingSid: string): OwnedUserObjects => {
    validateOwnedDesktopName(`${name}\\actor`);
    validateSid(ownerSid);
    validateSid(restrictingSid);
    if (ownerSid === restrictingSid)
      throw new CrotError("INVALID_INPUT", "Owned Win32 objects require a distinct restricting SID.");
    const originalStation = getStation(),
      originalDesktop = getDesktop(Number(threadId()));
    if (!valid(originalStation) || !valid(originalDesktop)) throw fail("borrowed context query");
    let station: unknown,
      desktop: unknown,
      associated = false;
    const sd: { value?: unknown } = {};
    // Query uses OWNER|DACL|LABEL (0x15), but string conversion must select
    // SACL (0x08), otherwise mandatory-label ACEs can be omitted silently.
    const canonical = (value: unknown): string => {
      const text: { value?: unknown } = {},
        length: { value?: number } = {};
      try {
        if (
          !ok(stringify(value, 1, 0x0d, text, length)) ||
          !valid(text.value) ||
          !Number.isInteger(length.value) ||
          length.value! < 1 ||
          length.value! > 65536
        )
          throw fail("security descriptor encoding");
        return ffi.decode.string16(text.value, length.value! - 1).toUpperCase();
      } finally {
        if (valid(text.value)) free(text.value);
      }
    };
    const verifySecurity = (object: unknown, rights: number) => {
      // READ BACK kernel security before readiness. Supplying an SD to CREATE
      // is not proof that its Low label, owner and exact unique-SID grants stuck.
      const info = Buffer.alloc(4);
      info.writeUInt32LE(0x15);
      const needed: { value?: number } = {};
      querySecurity(object, info, null, 0, needed);
      if (!Number.isInteger(needed.value) || needed.value! < 20 || needed.value! > 65536)
        throw fail("security descriptor size");
      const actual = Buffer.alloc(needed.value!);
      if (!ok(querySecurity(object, info, actual, actual.length, needed))) throw fail("security descriptor query");
      const observed = canonical(actual);
      // Windows may map GENERIC_ALL to the object's specific all-access mask.
      // Compare OS-canonical encodings, NOT an incomplete SDDL string parser.
      for (const mask of ["GA", `0x${rights.toString(16)}`]) {
        const expected: { value?: unknown } = {};
        try {
          if (
            !ok(
              descriptor(
                `O:${ownerSid}D:P(A;;${mask};;;${ownerSid})(A;;${mask};;;SY)(A;;${mask};;;${restrictingSid})S:(ML;;NW;;;LW)`,
                1,
                expected,
                null,
              ),
            ) ||
            !valid(expected.value)
          )
            throw fail("expected security descriptor");
          if (canonical(expected.value) === observed) return;
        } finally {
          if (valid(expected.value)) free(expected.value);
        }
      }
      // Publish only a NEW-object layout with personal/random SIDs removed.
      // No paths, raw descriptors, credentials or capabilities leave the helper.
      const layout = observed
        .replaceAll(ownerSid.toUpperCase(), "OWNER")
        .replaceAll(restrictingSid.toUpperCase(), "UNIQUE")
        .replace(/S-1-(?:[0-9]+-)*[0-9]+/g, "OTHER")
        .slice(0, 1024);
      const error = fail("security descriptor verification");
      throw new CrotError("OPERATION_FAILED", error.message, { ...error.details, layout });
    };
    const restore = () => {
      if (!associated) return;
      if (!ok(setStation(originalStation))) throw fail("original station restore");
      if (!ok(setDesktop(originalDesktop))) throw fail("original desktop restore");
      associated = false;
    };
    const close = () => {
      let error: unknown;
      const attempt = (fn: () => void) => {
        try {
          fn();
        } catch (cause) {
          error ??= cause;
        }
      };
      attempt(restore);
      if (!associated) {
        if (valid(desktop))
          attempt(() => {
            if (!ok(closeDesktop(desktop))) throw fail("desktop close");
            desktop = undefined;
          });
        if (valid(station))
          attempt(() => {
            if (!ok(closeStation(station))) throw fail("station close");
            station = undefined;
          });
      }
      if (error) throw error;
    };
    try {
      if (
        !ok(
          descriptor(
            `O:${ownerSid}D:P(A;;GA;;;${ownerSid})(A;;GA;;;SY)(A;;GA;;;${restrictingSid})S:(ML;;NW;;;LW)`,
            1,
            sd,
            null,
          ),
        ) ||
        !valid(sd.value)
      )
        throw fail("descriptor creation");
      const security = { length: 24, descriptor: sd.value, inherit: 0 };
      setLast(0);
      station = createStation(name, 0, 0xf037f, security);
      if (!valid(station)) throw fail("station creation");
      if (Number(last()) === 183) throw fail("station collision");
      const flags = Buffer.alloc(12);
      if (!ok(info(station, 1, flags, flags.length, Buffer.alloc(4))) || (flags.readUInt32LE(8) & 1) !== 0)
        throw fail("noninteractive verification");
      // Provision and READ BACK the parent station BEFORE associating the
      // helper or creating a desktop inside it. CREATE does not guarantee its
      // requested Low label; descendants must not be created under an as-yet
      // unverified Medium station. Change only the two fresh owned objects.
      const labelInfo = Buffer.alloc(4);
      labelInfo.writeUInt32LE(0x10);
      if (!ok(setSecurity(station, labelInfo, sd.value))) throw fail("station low label install");
      verifySecurity(station, 0xf037f);
      if (!ok(setStation(station))) throw fail("private station association");
      associated = true;
      setLast(0);
      desktop = createDesktop("actor", null, null, 0, 0xf01ff, security);
      if (!valid(desktop)) throw fail("desktop creation");
      if (Number(last()) === 183) throw fail("desktop collision");
      if (!ok(setSecurity(desktop, labelInfo, sd.value))) throw fail("desktop low label install");
      verifySecurity(desktop, 0xf01ff);
      // The helper emits readiness only after restoring its original context.
      // Neither the service/tray thread nor user input desktop is switched.
      restore();
      return Object.freeze({ desktop: `${name}\\actor`, close });
    } catch (error) {
      try {
        close();
      } catch {
        /* caller exits helper; OS releases remaining owned handles */
      }
      throw error;
    } finally {
      if (valid(sd.value)) free(sd.value);
    }
  };
}
