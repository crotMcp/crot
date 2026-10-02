// TEMPORARY Windows diagnostic (see README.md). Records data; asserts nothing.
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "vitest";
import { OutputBuffer } from "../../src/core/capabilities/process/output-buffer.js";
import { decodingFor } from "../../src/core/platform/encoding.js";
import { createNodePlatform } from "../../src/core/platform/node-platform.js";
import type { CommandSpec, Platform } from "../../src/core/platform/types.js";
import { createTestCore, makeTempDirs, testContext as ctx } from "../../tests/helpers.js";

const w = path.win32;
/** Text of the failing echo test. */
const ECHO_TEXT = "grüße €✓ 日本";
/** File name of the failing dir test, plus the name from the CI report. */
const FILE_NAMES = ["ünï✓日.txt", "uni_日本.txt"];
const PROBE_TIMEOUT_MS = 15_000;
const MAX_HEX_BYTES = 4096;

/** ASCII-only rendering: non-printable / non-ASCII UTF-16 units as \uXXXX. */
const esc = (s: string) => s.replace(/[^\x20-\x7e\n]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
const hex = (b: Buffer) =>
  (b.length > MAX_HEX_BYTES ? b.subarray(0, MAX_HEX_BYTES) : b).toString("hex").replace(/(..)(?!$)/g, "$1 ") + (b.length > MAX_HEX_BYTES ? " ..." : "");
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref());
const closed = (s: NodeJS.ReadableStream & { readableEnded?: boolean; destroyed?: boolean }) =>
  new Promise<void>((resolve) => {
    if (s.readableEnded || s.destroyed) return resolve();
    s.once("end", () => resolve());
    s.once("close", () => resolve());
  });

function specInfo(spec: CommandSpec) {
  const commandLine = spec.windowsVerbatimArguments ? `"${spec.file}" ${spec.args.join(" ")}` : "(arguments quoted by Node)";
  return {
    file: spec.file,
    args: [...spec.args],
    windowsVerbatimArguments: spec.windowsVerbatimArguments ?? false,
    display: spec.display,
    approximateCommandLine: commandLine,
    approximateCommandLineEscaped: esc(commandLine),
  };
}

function describeBytes(platform: Platform, bytes: Buffer) {
  const buffer = new OutputBuffer(1 << 20, platform.encodings.resolve("auto"));
  buffer.append(bytes);
  buffer.end();
  const crot = buffer.readAll();
  const fallback = platform.encodings.fallback ? decodingFor(platform.encodings.fallback) : null;
  const utf8 = bytes.toString("utf8");
  return {
    length: bytes.length,
    hex: hex(bytes),
    asUtf8: utf8,
    asUtf8Escaped: esc(utf8),
    asOemFallback: fallback ? { name: fallback.name, textEscaped: esc(fallback.decode(bytes, false) ?? "") } : null,
    asUtf16leEscaped: esc(bytes.toString("utf16le")),
    crotAuto: { data: crot.data, dataEscaped: esc(crot.data), encoding: crot.encoding },
  };
}

/** Launch through CROT's platform launcher (same spawn path as CROT) and capture raw bytes. */
async function runRaw(platform: Platform, label: string, purpose: string, spec: CommandSpec, cwd: string) {
  const entry: Record<string, unknown> = { label, purpose, spec: specInfo(spec) };
  try {
    const proc = await platform.launcher.launch(spec, { cwd, env: platform.baseEnvironment, stdin: false });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    proc.stdout.on("data", (c: Buffer) => out.push(c));
    proc.stderr.on("data", (c: Buffer) => err.push(c));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      void proc.terminate("force");
    }, PROBE_TIMEOUT_MS);
    const exit = await proc.exited;
    clearTimeout(timer);
    await Promise.race([Promise.all([closed(proc.stdout), closed(proc.stderr)]), delay(2_000)]);
    await proc.terminate("force").catch(() => undefined);
    Object.assign(entry, {
      exit,
      timedOut,
      stdout: describeBytes(platform, Buffer.concat(out)),
      stderr: describeBytes(platform, Buffer.concat(err)),
    });
  } catch (error) {
    entry.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
  }
  console.log(`\n===== PROBE: ${label} =====\n${esc(JSON.stringify(entry, null, 2))}`);
  return entry;
}

describe.runIf(process.platform === "win32")("TEMPORARY DIAGNOSTIC: Windows cmd output encoding", () => {
  it("records chcp, code pages, command lines, raw bytes and CROT decoding", async () => {
    const dirs = await makeTempDirs();
    const platform = await createNodePlatform();
    const core = await createTestCore({ workspace: { root: dirs.workspace }, limits: { maxOutputBytes: 1024, maxCommandTimeoutMs: 30_000 } });
    try {
      for (const name of FILE_NAMES) await writeFile(path.join(dirs.workspace, name), "");
      const comspec = platform.info.shells.find((s) => s.id === "cmd")!.path;
      const chcp = w.join(w.dirname(comspec), "chcp.com");
      const cmd = (line: string, extra: string[] = []): CommandSpec => ({
        file: comspec,
        args: ["/d", ...extra, "/s", "/c", `"${line}"`],
        windowsVerbatimArguments: true,
        display: line,
      });
      // Visible prelude: code page before, chcp 65001 with stdout+stderr visible, its exit code, code page after.
      // `call echo %^errorlevel%` expands errorlevel after chcp ran (plain %errorlevel% would expand at parse time).
      const instrumented = (payload: string) =>
        `echo [before]& "${chcp}"& echo [prelude: chcp 65001, stdout+stderr visible]& "${chcp}" 65001& call echo [chcp 65001 exit code]=%^errorlevel%& echo [after]& "${chcp}"& echo [payload]& ${payload}`;
      const echoScript = `echo ${ECHO_TEXT}`;
      const dirScript = "dir /b *.txt";
      const cwd = dirs.workspace;

      const meta = {
        node: process.version,
        osRelease: os.release(),
        arch: process.arch,
        stdoutIsTTY: Boolean(process.stdout.isTTY),
        stderrIsTTY: Boolean(process.stderr.isTTY),
        comspec,
        chcp,
        platformEncoding: platform.info.encoding,
        autoFallback: platform.encodings.fallback,
        expectedEchoEscaped: esc(ECHO_TEXT),
        filesCreatedEscaped: FILE_NAMES.map(esc),
        productionSpecs: {
          echo: specInfo(platform.shells.command(echoScript, "cmd")),
          dir: specInfo(platform.shells.command(dirScript, "cmd")),
        },
      };
      console.log(`\n===== META =====\n${esc(JSON.stringify(meta, null, 2))}`);

      const probes: unknown[] = [];
      const add = async (label: string, purpose: string, spec: CommandSpec) => probes.push(await runRaw(platform, label, purpose, spec, cwd));

      await add("chcp-direct-query", "chcp.com with no arguments, launched directly: exit code, stdout, stderr, active code page", {
        file: chcp,
        args: [],
        display: "chcp",
      });
      await add("chcp-direct-65001", "chcp.com 65001 launched directly: exit code, stdout, stderr", { file: chcp, args: ["65001"], display: "chcp 65001" });
      await add("cmd-chcp-query", "cmd /c chcp: active code page inside cmd before any prelude", cmd(`"${chcp}"`));
      await add("echo-instrumented", "echo case with a visible prelude", cmd(instrumented(echoScript)));
      await add("dir-instrumented", "dir case with a visible prelude", cmd(instrumented(dirScript)));
      await add("echo-production-prelude-stderr-visible", "CROT's prelude with only stdout hidden (stderr visible)", cmd(`"${chcp}" 65001 >nul & ${echoScript}`));
      await add("dir-production-prelude-stderr-visible", "CROT's prelude with only stdout hidden (stderr visible)", cmd(`"${chcp}" 65001 >nul & ${dirScript}`));
      await add("echo-production-spec", "exact CommandSpec CROT builds (prelude hides chcp output)", platform.shells.command(echoScript, "cmd"));
      await add("dir-production-spec", "exact CommandSpec CROT builds (prelude hides chcp output)", platform.shells.command(dirScript, "cmd"));
      await add("echo-no-prelude", "echo case without any chcp prelude (baseline)", cmd(echoScript));
      await add("dir-no-prelude", "dir case without any chcp prelude (baseline)", cmd(dirScript));
      await add("cmd-u-informational", "INFORMATIONAL ONLY, not a fix: cmd /u (builtins write UTF-16LE to pipes)", cmd(`${echoScript}& ${dirScript}`, ["/u"]));

      // Exactly the code path of the failing tests (Core, PermissionEngine, ProcessService, OutputBuffer).
      const core_: unknown[] = [];
      for (const script of [echoScript, dirScript]) {
        const entry: Record<string, unknown> = { label: `core.processes.shell: ${esc(script)}`, spec: specInfo(core.platform.shells.command(script, "cmd")) };
        try {
          const r = await core.processes.shell(ctx, { script });
          Object.assign(entry, {
            exitCode: r.exitCode,
            timedOut: r.timedOut,
            stdout: r.stdout,
            stdoutEscaped: esc(r.stdout),
            stderr: r.stderr,
            stderrEscaped: esc(r.stderr),
            stdoutTruncated: r.stdoutTruncated,
            stderrTruncated: r.stderrTruncated,
            encoding: r.encoding,
          });
        } catch (error) {
          entry.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
        }
        console.log(`\n===== CORE: ${entry.label} =====\n${esc(JSON.stringify(entry, null, 2))}`);
        core_.push(entry);
      }

      const outDir = path.resolve(process.cwd(), "diagnostics-output");
      await mkdir(outDir, { recursive: true });
      const file = path.join(outDir, `windows-cmd-encoding-node${process.versions.node}.json`);
      await writeFile(file, JSON.stringify({ meta, probes, core: core_ }, null, 2), "utf8");
      console.log(`\nDiagnostic report written to ${file}`);
    } finally {
      await core.shutdown();
      await dirs.cleanup();
    }
  });
});
