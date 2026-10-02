import path from "node:path";
import { finished } from "node:stream/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OutputBuffer } from "../../src/core/capabilities/process/output-buffer.js";
import type { CrotCore } from "../../src/core/crot-core.js";
import { createNodePlatform } from "../../src/core/platform/node-platform.js";
import type { CommandSpec, Platform } from "../../src/core/platform/types.js";
import { comspecFrom } from "../../src/core/platform/windows-command.js";
import { createTestCore, isWindows, makeTempDirs, testContext, type TempDirs } from "../helpers.js";

/**
 * Real cmd.exe behaviour behind CROT's cmd shell design (see cmdScriptCommand),
 * established by the Windows CI encoding diagnostic, plus the encoding limits that
 * remain. The end-to-end Unicode tests live in tests/capabilities/process.test.ts.
 */
const TEXT = "grüße €✓ 日本";

describe.runIf(isWindows)("cmd.exe output encoding (Windows)", () => {
  let platform: Platform;
  let dirs: TempDirs;
  let core: CrotCore;
  let comspec: string;
  let chcp: string;

  beforeAll(async () => {
    platform = await createNodePlatform();
    dirs = await makeTempDirs();
    core = await createTestCore({ workspace: { root: dirs.workspace } });
    comspec = comspecFrom((n) => platform.environment.get(platform.baseEnvironment, n));
    chcp = path.win32.join(path.win32.dirname(comspec), "chcp.com");
  });

  afterAll(async () => {
    await core?.shutdown();
    await dirs?.cleanup();
  });

  /** A single cmd.exe running `line`, as Node's `shell: true` would. */
  const cmdLine = (line: string): CommandSpec => ({ file: comspec, args: ["/d", "/s", "/c", `"${line}"`], windowsVerbatimArguments: true, display: line });

  async function runRaw(spec: CommandSpec) {
    const child = await platform.launcher.launch(spec, { cwd: dirs.workspace, env: platform.baseEnvironment, stdin: false });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => err.push(c));
    const [status] = await Promise.all([child.exited, finished(child.stdout), finished(child.stderr)]);
    return { code: status.code, stdout: Buffer.concat(out), stderr: Buffer.concat(err) };
  }

  /** Decode with CROT's own "auto" encoding, as process results do. */
  function decodeAuto(bytes: Buffer) {
    const buffer = new OutputBuffer(1 << 20, platform.encodings.resolve("auto"));
    buffer.append(bytes);
    buffer.end();
    return buffer.readAll();
  }

  it("built-ins keep the OEM code page after a successful chcp 65001 in the same cmd, and CROT does not report UTF-8", async () => {
    const fallback = platform.encodings.fallback;
    // Only meaningful where the console code page is not UTF-8 already (CI runners: 437).
    if (fallback === null) return;
    const r = await runRaw(cmdLine(`"${chcp}" 65001 & echo ${TEXT}`));
    expect(r.code).toBe(0);
    expect(r.stderr.toString("latin1")).toBe("");
    const newline = r.stdout.indexOf(0x0a);
    // chcp itself succeeded and reports the new code page ...
    expect(r.stdout.subarray(0, newline).toString("latin1")).toMatch(/65001/);
    // ... but echo, a built-in of the same cmd, wrote OEM bytes: '?' for characters outside the OEM code page.
    const echoed = r.stdout.subarray(newline + 1);
    expect(echoed.equals(Buffer.from(`${TEXT}\r\n`, "utf8"))).toBe(false);
    expect(echoed.includes(0x3f)).toBe(true);
    // CROT detects that this is not UTF-8 and says which encoding it used.
    const decoded = decodeAuto(echoed);
    expect(decoded.encoding.name).toBe(fallback);
    expect(decoded.encoding.name).not.toBe("utf-8");
  });

  it("a cmd.exe started after chcp 65001 writes built-in output as UTF-8", async () => {
    const r = await runRaw(cmdLine(`"${chcp}" 65001 >nul & "${comspec}" /d /c echo ${TEXT}`));
    expect(r.code).toBe(0);
    expect(r.stderr.toString("latin1")).toBe("");
    expect(r.stdout.toString("hex")).toBe(Buffer.from(`${TEXT}\r\n`, "utf8").toString("hex"));
    expect(decodeAuto(r.stdout).encoding).toEqual({ name: "utf-8", lossy: false });
  });

  it("the cmd shell passes the script to cmd unchanged and does not leak its transport variable", async () => {
    const r = await core.processes.shell(testContext, {
      script: "echo a!b^^c %CROT_UNDEFINED_VARIABLE%& if defined CROT_CMD_SCRIPT (echo leaked) else (echo clean)",
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trimEnd().split(/\r?\n/)).toEqual(["a!b^c %CROT_UNDEFINED_VARIABLE%", "clean"]);
    expect(r.encoding.stdout).toEqual({ name: "utf-8", lossy: false });
  });

  it("the cmd shell returns the script's exit code", async () => {
    const r = await core.processes.shell(testContext, { script: "echo x& exit /b 7" });
    expect(r.exitCode).toBe(7);
  });

  it("limitation: built-in UTF-8 mixed with a program's OEM bytes is reported as the fallback encoding, not UTF-8", async () => {
    const fallback = platform.encodings.fallback;
    if (fallback === null) return;
    // echo writes UTF-8; the program writes byte 0x81 (u-umlaut in CP437/CP850), which is not UTF-8.
    const script = `echo ü& "${process.execPath}" -e "process.stdout.write(Buffer.from([0x81,0x0d,0x0a]))"`;
    const auto = await core.processes.shell(testContext, { script });
    expect(auto.exitCode).toBe(0);
    expect(auto.encoding.stdout.name).toBe(fallback);
    expect(auto.encoding.stdout.name).not.toBe("utf-8");
    // An explicit encoding is honoured and the undecodable bytes are flagged.
    const utf8 = await core.processes.shell(testContext, { script, encoding: "utf-8" });
    expect(utf8.encoding.stdout).toEqual({ name: "utf-8", lossy: true });
    expect(utf8.stdout.startsWith("ü\r\n")).toBe(true);
  });
});
