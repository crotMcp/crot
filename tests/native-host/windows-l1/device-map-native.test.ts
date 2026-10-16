/** Bounded diagnostic: fixed trusted image, CREATE_SUSPENDED, never ResumeThread.
 * This is NOT a sandbox actor, production fallback, or proof of pipe isolation. */
import { appendFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, inject, it } from "vitest";
import { bindPrivatePipeMaps } from "../../../src/native-host/windows-l1/device-map.js";
import { loadAppContainerProfiles } from "../../../src/native-host/windows-l1/appcontainer-profile.js";
import { currentUserSid, windowsTools } from "../../../src/native-host/windows-acl.js";
import { loadJobObjectApi } from "../../../src/native-host/windows-job.js";
import { isWindows } from "../../helpers.js";

describe.runIf(isWindows)("private DeviceMap suspended trusted control", () => {
  it("assigns to a never-resumed ordinary process, then drains its owned Job", async () => {
    const imported = await import("koffi"),
      ffi = imported.default ?? imported;
    const root = process.env.SystemRoot ?? "C:\\Windows",
      tools = windowsTools(root);
    const dll = (name: string) => path.join(root, "System32", name);
    const kernel = ffi.load(dll("kernel32.dll"));
    const infoType = ffi.struct("CROT_MAP_CONTROL_PROCESS_INFO", {
      process: "void *",
      thread: "void *",
      pid: "uint32_t",
      tid: "uint32_t",
    });
    expect(ffi.sizeof(infoType)).toBe(24);
    const create = kernel.func(
      "int __stdcall CreateProcessW(str16 file, void *command, void *processAttributes, void *threadAttributes, int inherit, uint32_t flags, void *environment, str16 cwd, void *startup, _Out_ CROT_MAP_CONTROL_PROCESS_INFO *info)",
    );
    const terminate = kernel.func("int __stdcall TerminateProcess(void *process, uint32_t code)");
    const wait = kernel.func("uint32_t __stdcall WaitForSingleObject(void *object, uint32_t ms)");
    const close = kernel.func("int __stdcall CloseHandle(void *object)");
    const last = kernel.func("uint32_t __stdcall GetLastError(void)");
    const owner = await currentUserSid(tools),
      profile = (await loadAppContainerProfiles()).create();
    const job = (await loadJobObjectApi()).createKillOnCloseJob();
    let map: ReturnType<ReturnType<typeof bindPrivatePipeMaps>["create"]> | undefined;
    const info: { process?: unknown; thread?: unknown; pid?: number } = {};
    let assignment: unknown, fault: unknown;
    try {
      map = bindPrivatePipeMaps(ffi, {
        ntdll: dll("ntdll.dll"),
        kernel32: dll("kernel32.dll"),
        advapi32: dll("advapi32.dll"),
      }).create(owner, profile.sid);
      const startup = Buffer.alloc(104);
      startup.writeUInt32LE(104);
      const environment = Buffer.from(`SystemRoot=${root}\0\0`, "utf16le");
      const command = Buffer.from(`"${path.join(root, "System32", "cmd.exe")}" /d /c exit 99\0`, "utf16le");
      // No inherited handles, no service environment, no untrusted arguments,
      // no resumed thread and no authority supplied to any sandbox actor.
      expect(
        create(
          path.join(root, "System32", "cmd.exe"),
          command,
          null,
          null,
          0,
          0x4 | 0x400 | 0x08000000,
          environment,
          path.dirname(path.join(root, "System32", "cmd.exe")),
          startup,
          info,
        ),
        `CreateProcessW ${last()}`,
      ).toBe(1);
      expect(info.pid).toBeGreaterThan(0);
      expect(job.assign(info.pid!)).toBe(true);
      expect(job.activeProcessCount()).toBe(1);
      try {
        map.apply(info.process);
        assignment = { success: true };
      } catch (e) {
        assignment = { success: false, message: String(e), details: (e as { details?: unknown }).details };
        throw e;
      }
    } catch (e) {
      fault = e;
    } finally {
      try {
        if (info.process) {
          expect(terminate(info.process, 99)).toBe(1);
          expect(wait(info.process, 5000)).toBe(0);
          expect(job.activeProcessCount()).toBe(0);
        }
        for (const handle of [info.thread, info.process]) if (handle) expect(close(handle)).toBe(1);
        job.close();
        map?.close();
        profile.close();
      } catch (e) {
        fault ??= e;
      }
      appendFileSync(
        inject("stage6aEvidence"),
        JSON.stringify({
          title: "CROT-6A-device-map-trusted-suspended-control",
          value: {
            assignment,
            resumed: false,
            jobClosed: job.closed,
            profileClosed: profile.closed,
            failure: fault ? String(fault) : null,
          },
        }) + "\n",
      );
    }
    if (fault) throw fault;
  }, 30000);
});
