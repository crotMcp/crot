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
$commands=@('call "'+$vc+'" '+$Architecture+' >nul','cd /d "'+$OutputDirectory+'"')
foreach($unit in $units){$commands+='cl.exe /nologo /std:c++17 /EHsc /W3 /MT /O2 /DWIN32_LEAN_AND_MEAN /D_WIN32_WINNT=0x0A00 /I"'+$vendor+'" /c "'+(Join-Path $vendor ($unit+'.cpp'))+'" /Fo"'+(Join-Path $OutputDirectory ($unit+'.obj'))+'"'}
$objects=($units | ForEach-Object {'"'+(Join-Path $OutputDirectory ($_+'.obj'))+'"'}) -join ' '
$commands+='cl.exe /nologo /std:c++17 /EHsc /W4 /MT /O2 /LD /DUNICODE /D_UNICODE /D_WIN32_WINNT=0x0A00 /I"'+$vendor+'" "'+(Join-Path $shim 'shim.cpp')+'" /Fo"'+(Join-Path $OutputDirectory 'shim.obj')+'" /link /OUT:"'+(Join-Path $OutputDirectory 'crot-local-shim.dll')+'" /DEF:"'+(Join-Path $shim 'shim.def')+'" '+$objects+' advapi32.lib kernel32.lib'
& $env:ComSpec /d /c ($commands -join ' && ')
if($LASTEXITCODE -ne 0){throw 'LOCAL shim SDK build failed'}
