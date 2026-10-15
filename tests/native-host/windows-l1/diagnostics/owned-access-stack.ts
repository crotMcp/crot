/** Test-only fixed CDB commands for one freshly created owned suspended actor. */
import { readFileSync } from "node:fs";
import { ownedStackNames } from "./owned-stack.js";
import type { RestrictedToken } from "../../../../src/native-host/windows-l1/restricted-token.js";
import type { JobObjectApi } from "../../../../src/native-host/windows-job.js";
import type { ProbeProcess } from "../../../../src/native-host/windows-l1/probe-process.js";
export function accessStackTokens(text: string) {
  const lines = text.split(/\r?\n/);
  const frameLines = lines.filter((line) =>
    /^\s*(?:[0-9a-f]{2}\s+)?[0-9a-f`]{8,}\s+[0-9a-f`]{8,}\s+[A-Za-z0-9_.-]+!/i.test(line),
  );
  return {
    denialSites: lines.filter((line) => line.trim() === "CROT_ACCESS_DENIED").length,
    frames: ownedStackNames(frameLines.join("\n")),
  };
}
export function ownedAccessStack(options: {
  debuggerPath: string;
  log: string;
  cwd: string;
  systemRoot: string;
  token: RestrictedToken;
  jobs: JobObjectApi;
}) {
  if ([options.debuggerPath, options.log, options.cwd].some((s) => /["\0\r\n]/.test(s)))
    throw new Error("Invalid owned diagnostic path.");
  let debuggerProcess: ProbeProcess | undefined;
  let used = false;
  const register = process.arch === "arm64" ? "@w0" : "@ecx";
  return {
    beforeResume: (pid: number) => {
      if (used || !Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid owned diagnostic identity.");
      used = true;
      // Fixed commands, no data/code/environment from the actor. k, never kp/kv:
      // only symbols leave the private log, never addresses or frame arguments.
      const commands = [
        `.logopen /u "${options.log}"`,
        `bp ntdll!RtlSetLastWin32Error ".if (${register} == 5) { .echo CROT_ACCESS_DENIED; k 16; }; gc"`,
        `bp ntdll!RtlRaiseStatus ".if (${register} == 0xc0000022) { .echo CROT_ACCESS_DENIED; k 16; }; gc"`,
        ".echo CROT_OWNED_DEBUG_READY",
        ".logclose",
        `.logappend /u "${options.log}"`,
        "g",
      ].join(";");
      debuggerProcess = options.token.launchProbe(
        {
          executable: options.debuggerPath,
          args: ["-G", "-p", String(pid), "-c", commands],
          cwd: options.cwd,
          env: {
            SystemRoot: options.systemRoot,
            PATH: options.systemRoot + "\\System32",
            TEMP: options.cwd,
            TMP: options.cwd,
          },
          stdio: "nul",
        },
        options.jobs.createKillOnCloseJob(),
      );
      const deadline = Date.now() + 10000;
      const sleeper = new Int32Array(new SharedArrayBuffer(4));
      while (Date.now() < deadline) {
        const text = (() => {
          try {
            return readFileSync(options.log, "utf16le");
          } catch {
            return "";
          }
        })();
        if (/^CROT_OWNED_DEBUG_READY\r?$/m.test(text)) return;
        if (debuggerProcess.exitCode() !== null) throw new Error("Owned debugger exited before readiness.");
        Atomics.wait(sleeper, 0, 0, 10);
      }
      throw new Error("Owned debugger readiness deadline exceeded.");
    },
    collect: () => {
      let text = "";
      try {
        text = readFileSync(options.log, "utf16le");
      } catch {
        /* unavailable is explicit */
      }
      if (text.length > 1024 * 1024) throw new Error("Owned debugger diagnostic budget exceeded.");
      return {
        ready: /^CROT_OWNED_DEBUG_READY\r?$/m.test(text),
        ...accessStackTokens(text),
      };
    },
    close: () => debuggerProcess?.close(),
  };
}
