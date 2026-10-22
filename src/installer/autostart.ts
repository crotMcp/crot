/** Cross-platform per-user service autostart (WP-34, AD-17 point 2). */
import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { OsFamily } from "../core/platform/types.js";

const exec = promisify(execFile);
export const WINDOWS_TASK_NAME = "CROT MCP Service";

export interface AutostartSpec {
  readonly os: OsFamily;
  readonly home: string;
  readonly executable: string;
  /** JS entrypoint executed by executable (the exact Node binary). */
  readonly script?: string;
  readonly configFile?: string;
  readonly env?: NodeJS.ProcessEnv;
}
export interface AutostartArtifact {
  readonly file: string;
  readonly content: string;
  readonly mode?: number;
  readonly encoding?: "utf8" | "utf16le";
}
export interface AutostartPlan {
  readonly artifacts: readonly AutostartArtifact[];
  readonly installCommand: readonly string[];
  readonly removeCommand: readonly string[];
  readonly statusCommand: readonly string[];
}
export type CommandRunner = (file: string, args: readonly string[]) => Promise<void>;

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
function systemdQuote(value: string): string {
  if (/[\r\n\0]/.test(value)) throw new Error("autostart path contains a control character");
  return `"${value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("$", () => "$$")
    .replaceAll("%", "%%")}"`;
}
function args(spec: AutostartSpec): string[] {
  return [
    ...(spec.script ? [spec.script] : []),
    "service",
    "run",
    ...(spec.configFile ? ["--config", spec.configFile] : []),
  ];
}

export function autostartPlan(spec: AutostartSpec): AutostartPlan {
  if (!path.isAbsolute(spec.home) || !path.isAbsolute(spec.executable))
    throw new Error("autostart paths must be absolute");
  if (spec.configFile && !path.isAbsolute(spec.configFile)) throw new Error("autostart config path must be absolute");
  if (spec.script && !path.isAbsolute(spec.script)) throw new Error("autostart script must be absolute");
  const serviceArgs = args(spec);
  if (spec.os === "linux") {
    const unit = path.join(spec.home, ".config/systemd/user/crot-mcp.service");
    const tmpfiles = path.join(spec.home, ".config/user-tmpfiles.d/crot-mcp.conf");
    return {
      artifacts: [
        {
          file: unit,
          content: `[Unit]\nDescription=CROT MCP per-user service\n\n[Service]\nType=simple\nExecStart=${[spec.executable, ...serviceArgs].map(systemdQuote).join(" ")}\nRestart=on-failure\nRestartSec=2\n\n[Install]\nWantedBy=default.target\n`,
          mode: 0o600,
        },
        {
          file: tmpfiles,
          content: `# Keep CROT private L1 roots out of age-based cleanup (AD-20.3).\nx /var/tmp/crot-l1-*\n`,
          mode: 0o600,
        },
      ],
      installCommand: ["systemctl", "--user", "enable", "--now", "crot-mcp.service"],
      removeCommand: ["systemctl", "--user", "disable", "--now", "crot-mcp.service"],
      statusCommand: ["systemctl", "--user", "is-enabled", "crot-mcp.service"],
    };
  }
  if (spec.os === "macos") {
    const plist = path.join(spec.home, "Library/LaunchAgents/network.crot.service.plist");
    const argXml = [spec.executable, ...serviceArgs].map((a) => `    <string>${xml(a)}</string>`).join("\n");
    return {
      artifacts: [
        {
          file: plist,
          content: `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n  <key>Label</key><string>network.crot.service</string>\n  <key>ProgramArguments</key><array>\n${argXml}\n  </array>\n  <key>RunAtLoad</key><true/>\n  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>\n  <key>ProcessType</key><string>Background</string>\n</dict></plist>\n`,
          mode: 0o600,
        },
      ],
      installCommand: ["launchctl", "bootstrap", `gui/${process.getuid?.() ?? 0}`, plist],
      removeCommand: ["launchctl", "bootout", `gui/${process.getuid?.() ?? 0}/network.crot.service`],
      statusCommand: ["launchctl", "print", `gui/${process.getuid?.() ?? 0}/network.crot.service`],
    };
  }
  const taskFile = path.join(spec.home, "AppData/Local/CROT/autostart/crot-mcp-task.xml");
  const command = xml(spec.executable);
  const argumentsXml = xml(serviceArgs.map((a) => `"${a.replaceAll('"', '\\"')}"`).join(" "));
  return {
    artifacts: [
      {
        file: taskFile,
        encoding: "utf16le",
        content: `\uFEFF<?xml version="1.0" encoding="UTF-16"?>\n<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><Triggers><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers><Principals><Principal id="Author"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure><ExecutionTimeLimit>PT0S</ExecutionTimeLimit></Settings><Actions Context="Author"><Exec><Command>${command}</Command><Arguments>${argumentsXml}</Arguments></Exec></Actions></Task>\n`,
        mode: 0o600,
      },
    ],
    installCommand: ["schtasks.exe", "/Create", "/TN", WINDOWS_TASK_NAME, "/XML", taskFile, "/F"],
    removeCommand: ["schtasks.exe", "/Delete", "/TN", WINDOWS_TASK_NAME, "/F"],
    statusCommand: ["schtasks.exe", "/Query", "/TN", WINDOWS_TASK_NAME],
  };
}

const defaultRunner: CommandRunner = async (file, args) => {
  await exec(file, [...args], { windowsHide: true });
};
async function run(command: readonly string[], runner: CommandRunner): Promise<void> {
  const [file, ...args] = command;
  if (!file) throw new Error("empty autostart command");
  await runner(file, args);
}
export async function installAutostart(
  spec: AutostartSpec,
  runner: CommandRunner = defaultRunner,
): Promise<AutostartPlan> {
  const plan = autostartPlan(spec);
  for (const artifact of plan.artifacts) {
    await mkdir(path.dirname(artifact.file), { recursive: true, mode: 0o700 });
    await writeFile(artifact.file, artifact.content, {
      mode: artifact.mode ?? 0o600,
      encoding: artifact.encoding ?? "utf8",
    });
  }
  if (spec.os === "linux") await runner("systemctl", ["--user", "daemon-reload"]);
  await run(plan.installCommand, runner);
  return plan;
}
export async function autostartStatus(spec: AutostartSpec, runner: CommandRunner = defaultRunner): Promise<boolean> {
  const plan = autostartPlan(spec);
  try {
    for (const artifact of plan.artifacts) await readFile(artifact.file);
    await run(plan.statusCommand, runner);
    return true;
  } catch {
    return false;
  }
}
export async function removeAutostart(spec: AutostartSpec, runner: CommandRunner = defaultRunner): Promise<void> {
  const plan = autostartPlan(spec);
  try {
    await run(plan.removeCommand, runner);
  } catch {
    /* idempotent removal */
  }
  for (const artifact of plan.artifacts) await rm(artifact.file, { force: true });
}
