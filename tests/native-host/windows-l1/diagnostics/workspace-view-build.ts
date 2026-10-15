/** Disposable native CI fixture only: never imported by production. AD-27. */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
const execute = promisify(execFile);
const tag = "v2.3.1.1000";
const release = `https://github.com/dokan-dev/dokany/releases/download/${tag}/`;
const raw = `https://raw.githubusercontent.com/dokan-dev/dokany/${tag}/`;
const assets = [
  [release + "dokan.zip", "sdk.zip", "cbfb89718d4e671f8dd65187912c1141fde0e5197f40ac2979b3216753d42c7c"],
  [raw + "dokan/dokan.h", "headers/dokan.h", "986dad86d25a422089f430d7976d914a3c8babb04e0c5bd041e9544c26f8322e"],
  [raw + "dokan/fileinfo.h", "headers/fileinfo.h", "c463ca2e97804865ddef3397d30a9d36e74853cef47dae0e123ab47d2471b7a1"],
  [raw + "sys/public.h", "headers/public.h", "d8485c7600947a396500a0d847ccf44d65ca831e3c63c1f92c724da36bf90895"],
] as const;
async function download(url: string, destination: string, expected: string) {
  const response = await fetch(url, { signal: AbortSignal.timeout(90_000) });
  if (!response.ok || !response.body) throw new Error("Pinned Dokan fixture download failed.");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 100 * 1024 * 1024) throw new Error("Pinned Dokan fixture exceeds limit.");
    chunks.push(Buffer.from(chunk));
  }
  const bytes = Buffer.concat(chunks);
  if (createHash("sha256").update(bytes).digest("hex") !== expected)
    throw new Error("Pinned Dokan fixture hash mismatch.");
  await writeFile(destination, bytes, { flag: "wx" });
}
export async function buildWorkspaceViewFixture(): Promise<{ helper: string; cleanup(): Promise<void> }> {
  if (process.platform !== "win32" || !["x64", "arm64"].includes(process.arch))
    throw new Error("Native workspace fixture requires a qualified Windows architecture.");
  // Driver installation is restricted to disposable CI. No runtime installer,
  // unsigned/test-signing bypass, fallback driver, or permissive skip exists.
  if (process.env.GITHUB_ACTIONS !== "true" || process.env.RUNNER_ENVIRONMENT !== "github-hosted")
    throw new Error("Provision the pinned signed Dokan fixture on a disposable GitHub-hosted runner.");
  const dir = await mkdtemp(path.join(os.tmpdir(), "crot-view-native-"));
  const cleanup = () => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  try {
    await mkdir(path.join(dir, "headers"));
    await Promise.all(assets.map(([url, name, hash]) => download(url, path.join(dir, name), hash)));
    const arm = process.arch === "arm64";
    await download(
      release + (arm ? "Dokan_ARM64.msi" : "Dokan_x64.msi"),
      path.join(dir, "driver.msi"),
      arm
        ? "f812a5bf11c15bc3910a1f0f53830ff771ceb3c80458f10686b0f45b0db91d2e"
        : "69ff8cb37bfec3a75921c85ffd1c6370b50a9ec4ecef2cf3a009d488dcbf5465",
    );
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
      CROT_VIEW_ARCH: arm ? "ARM64" : "x64",
      CROT_VIEW_SOURCE: path.resolve("native/windows-workspace-view/main.cpp"),
      CROT_VIEW_PROBE_SOURCE: path.resolve("native/windows-workspace-view/control-profile-child.cpp"),
    };
    await execute(
      ps,
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `
$ErrorActionPreference='Stop'
Import-Module -Name "$PSHOME\\Modules\\Microsoft.PowerShell.Utility\\Microsoft.PowerShell.Utility.psd1" -ErrorAction Stop
Import-Module -Name "$PSHOME\\Modules\\Microsoft.PowerShell.Management\\Microsoft.PowerShell.Management.psd1" -ErrorAction Stop
Import-Module -Name "$PSHOME\\Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1" -ErrorAction Stop
$d=$env:CROT_VIEW_BUILD
$msi=Join-Path $d 'driver.msi'
if ((Get-AuthenticodeSignature -LiteralPath $msi).Status -ne 'Valid') { throw 'Pinned driver signature invalid' }
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::ExtractToDirectory((Join-Path $d 'sdk.zip'),(Join-Path $d 'sdk'))
$vswhere=Join-Path ([Environment]::GetEnvironmentVariable('ProgramFiles(x86)')) 'Microsoft Visual Studio\\Installer\\vswhere.exe'
$vs=(& $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath)
if (!$vs) { throw 'MSVC unavailable' }
$vc=Join-Path $vs 'VC\\Auxiliary\\Build\\vcvarsall.bat'
$lib=Join-Path $d ('sdk\\'+$env:CROT_VIEW_ARCH+'\\Release\\dokan2.lib')
$exe=Join-Path $d 'workspace-view.exe'
$probe=Join-Path $d 'control-profile-child.exe'
foreach ($p in @($vc,$lib,$exe,$d,$probe,$env:CROT_VIEW_SOURCE,$env:CROT_VIEW_PROBE_SOURCE)) { if ($p -match '["%!\\r\\n]') { throw 'Unsafe compiler path' } }
$line='call "'+$vc+'" '+$env:CROT_VIEW_ARCH+' >nul && cl.exe /nologo /std:c++17 /EHsc /W4 /MT /DUNICODE /D_UNICODE /D_WIN32_WINNT=0x0A00 /I"'+$d+'\\headers" "'+$env:CROT_VIEW_SOURCE+'" /Fo"'+$d+'\\view.obj" /link /OUT:"'+$exe+'" "'+$lib+'" advapi32.lib kernel32.lib userenv.lib'
& $env:ComSpec /d /s /c $line
if ($LASTEXITCODE -ne 0) { throw 'Workspace view native compilation failed' }
$line='call "'+$vc+'" '+$env:CROT_VIEW_ARCH+' >nul && cl.exe /nologo /std:c++17 /EHsc /W4 /MT /DUNICODE /D_UNICODE /D_WIN32_WINNT=0x0A00 "'+$env:CROT_VIEW_PROBE_SOURCE+'" /Fo"'+$d+'\\control-probe.obj" /link /OUT:"'+$probe+'" advapi32.lib kernel32.lib'
& $env:ComSpec /d /s /c $line
if ($LASTEXITCODE -ne 0) { throw 'Control profile child native compilation failed' }
Copy-Item -LiteralPath (Join-Path $d ('sdk\\'+$env:CROT_VIEW_ARCH+'\\Release\\dokan2.dll')) -Destination (Join-Path $d 'dokan2.dll')
$p=Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\\msiexec.exe') -ArgumentList @('/i',('"'+$msi+'"'),'/qn','/norestart') -Wait -PassThru
if ($p.ExitCode -ne 0) { throw ('Pinned driver install did not qualify: '+$p.ExitCode) }
$driver=Join-Path $env:SystemRoot 'System32\\drivers\\dokan2.sys'
if ((Get-AuthenticodeSignature -LiteralPath $driver).Status -ne 'Valid') { throw 'Installed kernel driver signature invalid' }
if ((Get-Item -LiteralPath $driver).VersionInfo.FileVersion -notmatch '^2\\.3\\.1(?:\\.|$)') { throw 'Installed kernel driver version mismatch' }
`,
      ],
      { env, timeout: 240_000, maxBuffer: 32 * 1024, windowsHide: true },
    ).catch((error: unknown) => {
      // Source/build diagnostics only. This happens before any actor, workspace,
      // token or private-state fixture is supplied to the helper.
      const e = error as { stdout?: string; stderr?: string };
      throw new Error(
        `Workspace helper build/provision failed: ${(e.stdout ?? "").slice(0, 12000)} ${(e.stderr ?? "").slice(-4000)}`,
      );
    });
    return { helper: path.join(dir, "workspace-view.exe"), cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
