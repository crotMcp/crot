/** AD-29: OS SDK only, no kernel-driver provisioning or external downloads. */
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
const execute = promisify(execFile);
export async function buildWorkspaceViewFixture(): Promise<{ helper: string; cleanup(): Promise<void> }> {
  if (process.platform !== "win32" || !["x64", "arm64"].includes(process.arch))
    throw new Error("Native Windows SDK required.");
  const dir = await mkdtemp(path.join(os.tmpdir(), "crot-native-os-"));
  const cleanup = () => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  try {
    const ps = path.join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    const env = {
      ...process.env,
      CROT_VIEW_BUILD: dir,
      CROT_VIEW_ARCH: process.arch === "arm64" ? "ARM64" : "x64",
      CROT_VIEW_SOURCE: path.resolve("native/windows-workspace-view/main.cpp"),
      CROT_CHILD_SOURCE: path.resolve("native/windows-workspace-view/control-profile-child.cpp"),
    };
    await execute(
      ps,
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        path.resolve("scripts/l1-install-win.ps1"),
        "-Apply",
      ],
      { env, timeout: 30000 },
    );
    await execute(
      ps,
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `
$ErrorActionPreference='Stop'
$vs=Join-Path \${env:ProgramFiles(x86)} 'Microsoft Visual Studio\\Installer\\vswhere.exe'
$install=& $vs -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
$vc=Join-Path $install 'VC\\Auxiliary\\Build\\vcvarsall.bat'
foreach($item in @(@($env:CROT_VIEW_SOURCE,'view.exe','view.obj'),@($env:CROT_CHILD_SOURCE,'control-profile-child.exe','child.obj'))) {
 $line='call "'+$vc+'" '+$env:CROT_VIEW_ARCH+' >nul && cl.exe /nologo /std:c++17 /utf-8 /EHsc /W4 /MT /DUNICODE /D_UNICODE /D_WIN32_WINNT=0x0A00 "'+$item[0]+'" /Fo"'+(Join-Path $env:CROT_VIEW_BUILD $item[2])+'" /link /OUT:"'+(Join-Path $env:CROT_VIEW_BUILD $item[1])+'" advapi32.lib kernel32.lib userenv.lib ole32.lib'
 & $env:ComSpec /d /c $line
 if($LASTEXITCODE -ne 0){throw 'Windows SDK build failed'}
}`,
      ],
      { env, timeout: 60000, maxBuffer: 1024 * 1024 },
    );
    await execute(
      ps,
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        path.resolve("scripts/build-windows-local-shim.ps1"),
        "-OutputDirectory",
        dir,
        "-Architecture",
        process.arch === "arm64" ? "ARM64" : "x64",
      ],
      { timeout: 120000, maxBuffer: 1048576 },
    );
    return { helper: path.join(dir, "view.exe"), cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
