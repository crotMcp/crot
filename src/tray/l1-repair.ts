/** Explicit owner-UI installer. Never import this module into CrotService or an MCP adapter. */
import { spawn } from "node:child_process";
import { access, realpath } from "node:fs/promises";
import path from "node:path";

export interface RepairCommand {
  readonly file: string;
  readonly args: readonly string[];
}
export interface RepairOptions {
  readonly platform: NodeJS.Platform;
  readonly root: string;
  readonly stateDir?: string;
  readonly exists?: (file: string) => Promise<boolean>;
  readonly run?: (command: RepairCommand) => Promise<void>;
}
const exists = async (file: string): Promise<boolean> => {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
};
const powershellLiteral = (value: string): string => "'" + value.replaceAll("'", "''") + "'";

/** Paths and arguments originate here, never in the renderer, browser bridge or service. */
export async function repairCommand(options: RepairOptions): Promise<RepairCommand | undefined> {
  const has = options.exists ?? exists;
  if (options.platform === "darwin") {
    if (!(await has("/usr/bin/sandbox-exec"))) throw new Error("Seatbelt is unavailable on this macOS version.");
    // The service's real Seatbelt profile/private-storage probe is authoritative; no privileged install on macOS.
    return undefined;
  }
  const name =
    options.platform === "linux" ? "l1-install.sh" : options.platform === "win32" ? "l1-install-win.ps1" : undefined;
  if (!name) throw new Error("L1 repair is not supported on this platform.");
  const candidates = [
    path.resolve(options.root, "scripts", name),
    ...(options.platform === "linux" ? ["/usr/lib/crot/l1-install.sh"] : []),
  ];
  const script = await (async () => {
    for (const candidate of candidates) if (await has(candidate)) return candidate;
    return undefined;
  })();
  if (!script) throw new Error("The shipped L1 installer is missing. Reinstall the complete CROT package.");
  if (options.platform === "win32") {
    // Start-Process uses a second Windows command line: reject embedded double quotes and quote the fixed script path.
    if (/["\r\n\0]/.test(script)) throw new Error("Unsupported installation path.");
    const argLine = '-NoProfile -NonInteractive -File "' + script + '" -Apply';
    const code =
      "$ErrorActionPreference = 'Stop'; $p = Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -Verb RunAs -Wait -PassThru -ArgumentList " +
      powershellLiteral(argLine) +
      "; exit $p.ExitCode";
    return { file: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", code] };
  }
  if (await has("/usr/bin/pkexec")) return { file: "/usr/bin/pkexec", args: ["/bin/bash", script, "install"] };
  const command = ["/usr/bin/sudo", "/bin/bash", script, "install"];
  if (!(await has(command[0]!))) throw new Error("Install pkexec or sudo to authorize L1 setup.");
  for (const [file, prefix] of [
    ["/usr/bin/gnome-terminal", ["--wait", "--"]],
    ["/usr/bin/konsole", ["--nofork", "-e"]],
    ["/usr/bin/x-terminal-emulator", ["-e"]],
  ] as const)
    if (await has(file)) return { file, args: [...prefix, ...command] };
  throw new Error("No authorization dialog or terminal is available. Install pkexec and retry.");
}

function run(command: RepairCommand): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command.file, [...command.args], { shell: false, stdio: "ignore", windowsHide: true });
    child.once("error", () => reject(new Error("Could not open the system authorization dialog.")));
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error("L1 setup was canceled or failed. Review the installation guide.")),
    );
  });
}
export async function repairL1(options: RepairOptions): Promise<void> {
  const command = await repairCommand(options);
  if (command) {
    // Resolve only our own fixed package path before starting elevation; no file/path accepted over IPC.
    if (!options.exists) await realpath(options.root);
    await (options.run ?? run)(command);
    if (options.platform === "win32" && options.stateDir) {
      const has = options.exists ?? exists;
      // Never replace components beneath live leases. Existing delivery is verified by Core.
      if (!(await has(path.join(options.stateDir, "windows-l1", "components")))) {
        const library = path.resolve(options.root, "native", "crot-local-shim.dll");
        await (options.run ?? run)({
          file: "powershell.exe",
          args: [
            "-NoProfile",
            "-NonInteractive",
            "-File",
            path.resolve(options.root, "scripts", "l1-components-win.ps1"),
            "-StateDirectory",
            options.stateDir,
            ...((await has(library)) ? ["-Library", library] : []),
          ],
        });
      }
    }
  }
}
