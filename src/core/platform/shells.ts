import { cmdScriptCommand } from "./windows-command.js";
import { CrotError } from "../errors.js";
import type { CommandSpec, ShellId, ShellInfo, ShellProvider } from "./types.js";

/** PowerShell: pass the script as -EncodedCommand (UTF-16LE base64) so no command-line quoting is involved. */
export function powershellCommand(executable: string, script: string): CommandSpec {
  const prelude = "$ProgressPreference='SilentlyContinue';";
  const encoded = Buffer.from(prelude + script, "utf16le").toString("base64");
  return { file: executable, args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], display: script };
}

export function shellCommand(shell: ShellInfo, script: string): CommandSpec {
  switch (shell.id) {
    case "cmd":
      return cmdScriptCommand(shell.path, script);
    case "powershell":
    case "pwsh":
      return powershellCommand(shell.path, script);
    case "sh":
    case "bash":
    case "zsh":
      return { file: shell.path, args: ["-c", script], display: script };
  }
}

export function createShellProvider(defaultShell: ShellId, shells: readonly ShellInfo[]): ShellProvider {
  return {
    defaultShell,
    available: () => shells,
    command(script, shell = defaultShell) {
      const info = shells.find((s) => s.id === shell);
      if (!info) {
        throw new CrotError("NOT_FOUND", `Shell '${shell}' is not available on this machine. Available: ${shells.map((s) => s.id).join(", ") || "none"}.`);
      }
      return shellCommand(info, script);
    },
  };
}
