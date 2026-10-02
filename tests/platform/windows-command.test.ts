import { describe, expect, it } from "vitest";
import { powershellCommand, shellCommand } from "../../src/core/platform/shells.js";
import { batchFileCommand, cmdScriptCommand, comspecFrom, escapeCmdArgument, findWindowsExecutable, isBatchFile } from "../../src/core/platform/windows-command.js";

const files = (list: string[]) => {
  const set = new Set(list.map((f) => f.toLowerCase()));
  return async (candidate: string) => set.has(candidate.toLowerCase());
};

describe("Windows executable lookup (pure)", () => {
  const PATH = "C:\\Program Files\\nodejs;\"C:\\Quoted Dir\";C:\\Windows\\System32";

  it("finds .cmd shims via PATHEXT (npm)", async () => {
    const isFile = files(["C:\\Program Files\\nodejs\\npm.cmd", "C:\\Program Files\\nodejs\\node.exe"]);
    expect(await findWindowsExecutable("npm", { cwd: "C:\\proj", path: PATH, pathExt: undefined, isFile })).toBe("C:\\Program Files\\nodejs\\npm.cmd");
    expect(await findWindowsExecutable("node", { cwd: "C:\\proj", path: PATH, pathExt: ".COM;.EXE;.BAT;.CMD", isFile })).toBe(
      "C:\\Program Files\\nodejs\\node.exe",
    );
  });

  it("follows PATHEXT order and honours explicit extensions", async () => {
    const isFile = files(["C:\\Windows\\System32\\tool.exe", "C:\\Windows\\System32\\tool.cmd"]);
    const lookup = { cwd: "C:\\proj", path: PATH, pathExt: ".COM;.EXE;.BAT;.CMD", isFile };
    expect(await findWindowsExecutable("tool", lookup)).toBe("C:\\Windows\\System32\\tool.exe");
    expect(await findWindowsExecutable("tool.cmd", lookup)).toBe("C:\\Windows\\System32\\tool.cmd");
  });

  it("searches the working directory first, strips quoted PATH entries, resolves relative paths", async () => {
    const isFile = files(["C:\\proj\\build.bat", "C:\\Quoted Dir\\q.exe", "C:\\proj\\node_modules\\.bin\\tsc.cmd"]);
    const lookup = { cwd: "C:\\proj", path: PATH, pathExt: undefined, isFile };
    expect(await findWindowsExecutable("build", lookup)).toBe("C:\\proj\\build.bat");
    expect(await findWindowsExecutable("q", lookup)).toBe("C:\\Quoted Dir\\q.exe");
    expect(await findWindowsExecutable("node_modules/.bin/tsc", lookup)).toBe("C:\\proj\\node_modules\\.bin\\tsc.cmd");
    expect(await findWindowsExecutable("missing", lookup)).toBeNull();
  });

  it("detects batch files", () => {
    expect(isBatchFile("C:\\x\\npm.CMD")).toBe(true);
    expect(isBatchFile("C:\\x\\run.bat")).toBe(true);
    expect(isBatchFile("C:\\x\\node.exe")).toBe(false);
  });
});

describe("cmd.exe quoting (pure)", () => {
  it("escapes metacharacters and quotes", () => {
    expect(escapeCmdArgument("a b", false)).toBe('^"a^ b^"');
    expect(escapeCmdArgument("x&y|z", false)).toBe('^"x^&y^|z^"');
    expect(escapeCmdArgument('say "hi"', false)).toBe('^"say^ \\^"hi\\^"^"');
    expect(escapeCmdArgument("trailing\\", false)).toBe('^"trailing\\\\^"');
  });

  it("double-escapes for node_modules/.bin shims", () => {
    expect(escapeCmdArgument("x&y", true)).toBe('^^^"x^^^&y^^^"');
    const spec = batchFileCommand("C:\\Windows\\System32\\cmd.exe", "C:\\proj\\node_modules\\.bin\\tsc.cmd", ["a&b"]);
    expect(spec.args.at(-1)).toContain("^^^&");
  });

  it("runs batch files through cmd.exe verbatim", () => {
    const spec = batchFileCommand("C:\\Windows\\System32\\cmd.exe", "C:\\Program Files\\nodejs\\npm.cmd", ["install", "left-pad"]);
    expect(spec.file).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(spec.windowsVerbatimArguments).toBe(true);
    expect(spec.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(spec.args[3]).toBe('"C:\\Program^ Files\\nodejs\\npm.cmd ^"install^" ^"left-pad^""');
  });

  it("wraps cmd scripts like Node's shell option", () => {
    expect(cmdScriptCommand("cmd.exe", 'echo "a b"')).toMatchObject({ args: ["/d", "/s", "/c", '"echo "a b""'], windowsVerbatimArguments: true });
  });

  it("derives ComSpec", () => {
    expect(comspecFrom((n) => ({ ComSpec: "X:\\cmd.exe" })[n])).toBe("X:\\cmd.exe");
    expect(comspecFrom((n) => ({ SystemRoot: "D:\\Win" })[n])).toBe("D:\\Win\\System32\\cmd.exe");
  });
});

describe("shell invocations (pure)", () => {
  it("encodes PowerShell scripts as UTF-16LE base64", () => {
    const spec = powershellCommand("pwsh", "Write-Output 'é \"q\"'");
    expect(spec.args.slice(0, 4)).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand"]);
    const decoded = Buffer.from(spec.args[4]!, "base64").toString("utf16le");
    expect(decoded.endsWith("Write-Output 'é \"q\"'")).toBe(true);
  });

  it("uses -c for POSIX shells", () => {
    expect(shellCommand({ id: "bash", path: "/usr/bin/bash" }, "echo hi")).toMatchObject({ file: "/usr/bin/bash", args: ["-c", "echo hi"] });
  });
});
