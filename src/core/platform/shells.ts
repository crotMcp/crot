import { cmdScriptCommand } from "./windows-command.js";
import { CrotError } from "../errors.js";
import type { CommandSpec, ShellId, ShellInfo, ShellProvider } from "./types.js";

/**
 * PowerShell: pass the script as -EncodedCommand (UTF-16LE base64) so no command-line
 * quoting is involved. The prelude makes PowerShell write its output, and decode the
 * output of native programs, as UTF-8 instead of the console code page.
 */
export const POWERSHELL_PRELUDE =
  "$ProgressPreference='SilentlyContinue';" +
  "try{[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)}catch{};" +
  "$OutputEncoding=[System.Text.UTF8Encoding]::new($false);";

/**
 * Windows PowerShell 5.1 may enumerate unrelated binary modules while discovering
 * Out-File (including expression redirection) with a fresh analysis cache. Load
 * its standard Utility module from this runtime's own PSHOME, never by a name
 * resolved through a project/user PSModulePath. Import stays inside the child,
 * after the launcher's token/Job setup. Failure stops before the user script;
 * there is no unconfined retry, security-check switch or execution-policy bypass.
 */
export const WINDOWS_POWERSHELL_MODULE_PRELUDE =
  "Microsoft.PowerShell.Core\\Import-Module ($PSHOME+'\\Modules\\Microsoft.PowerShell.Utility\\Microsoft.PowerShell.Utility.psd1') -ErrorAction Stop;";

export function powershellCommand(executable: string, script: string, windowsPowerShell = false): CommandSpec {
  const prelude = POWERSHELL_PRELUDE + (windowsPowerShell ? WINDOWS_POWERSHELL_MODULE_PRELUDE : "");
  const encoded = Buffer.from(prelude + script, "utf16le").toString("base64");
  return {
    file: executable,
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
    display: script,
  };
}

export function shellCommand(shell: ShellInfo, script: string): CommandSpec {
  switch (shell.id) {
    case "cmd":
      return cmdScriptCommand(shell.path, script);
    case "powershell":
      return powershellCommand(shell.path, script, true);
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
        throw new CrotError(
          "NOT_FOUND",
          `Shell '${shell}' is not available on this machine. Available: ${shells.map((s) => s.id).join(", ") || "none"}.`,
        );
      }
      return shellCommand(info, script);
    },
  };
}
