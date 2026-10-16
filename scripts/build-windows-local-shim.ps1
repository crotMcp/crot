# AD-29 A.2. SDK-only build; vendored pinned source, no runtime downloads.
[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$OutputDirectory,[ValidateSet('x64','ARM64')][string]$Architecture='x64')
$ErrorActionPreference='Stop'
$repo=Split-Path -Parent $PSScriptRoot
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$OutputDirectory=[IO.Path]::GetFullPath($OutputDirectory)
$vs=Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
$install=& $vs -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if(!$install){throw 'Windows C++ SDK is required'}
$vc=Join-Path $install 'VC\Auxiliary\Build\vcvarsall.bat'
$vendor=Join-Path $repo 'native\vendor\detours'
$shim=Join-Path $repo 'native\windows-local-shim'
$units='detours','modules','disasm','image','creatwth','disolx86','disolx64','disolia64','disolarm','disolarm64'
$commands=[System.Collections.Generic.List[string]]::new()
$commands.Add('@echo off')
$commands.Add('chcp 65001 >nul')
$commands.Add('call "'+$vc+'" '+$Architecture+' >nul')
$commands.Add('if errorlevel 1 exit /b %errorlevel%')
$commands.Add('cd /d "'+$OutputDirectory+'"')
foreach($unit in $units){
 $commands.Add('cl.exe /nologo /std:c++17 /EHsc /W3 /MT /O2 /DWIN32_LEAN_AND_MEAN /D_WIN32_WINNT=0x0A00 /I"'+$vendor+'" /c "'+(Join-Path $vendor ($unit+'.cpp'))+'" /Fo"'+(Join-Path $OutputDirectory ($unit+'.obj'))+'"')
 $commands.Add('if errorlevel 1 exit /b %errorlevel%')
}
$objects=($units | ForEach-Object {'"'+(Join-Path $OutputDirectory ($_+'.obj'))+'"'}) -join ' '
$commands.Add('cl.exe /nologo /std:c++17 /EHsc /W4 /MT /O2 /LD /DUNICODE /D_UNICODE /D_WIN32_WINNT=0x0A00 /I"'+$vendor+'" "'+(Join-Path $shim 'shim.cpp')+'" /Fo"'+(Join-Path $OutputDirectory 'shim.obj')+'" /link /OUT:"'+(Join-Path $OutputDirectory 'crot-local-shim.dll')+'" /DEF:"'+(Join-Path $shim 'shim.def')+'" '+$objects+' advapi32.lib kernel32.lib')
$commands.Add('exit /b %errorlevel%')
$batch=Join-Path $OutputDirectory 'build-local-shim.cmd'
[IO.File]::WriteAllText($batch,($commands -join "`r`n")+"`r`n",[Text.UTF8Encoding]::new($false))
$diagnostics=& $env:ComSpec /d /c $batch 2>&1
$code=$LASTEXITCODE
$diagnostics | Write-Output
if($code -ne 0){throw ('LOCAL shim SDK build failed: '+(($diagnostics | Select-Object -Last 12) -join "`n"))}
