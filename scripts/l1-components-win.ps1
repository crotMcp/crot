# Explicit per-user component delivery. Does not alter NUL policy or elevate.
[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$StateDirectory,
      [string]$NodeExecutable=(Get-Command node.exe -ErrorAction Stop).Source,
      [string]$Library)
$ErrorActionPreference='Stop'
Import-Module -Name "$PSHOME\Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1" -ErrorAction Stop
$owner=[Security.Principal.WindowsIdentity]::GetCurrent().User
$parent=Join-Path ([IO.Path]::GetFullPath($StateDirectory)) 'windows-l1'
$target=Join-Path $parent 'components'
if(Test-Path -LiteralPath $target){throw 'Stop CROT and explicitly remove the previous component delivery before reinstalling.'}
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CrotComponentSecurity {
 [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string text,uint revision,out IntPtr descriptor,IntPtr size);
 [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool SetFileSecurity(string name,uint flags,IntPtr descriptor);
 [DllImport("kernel32.dll")] public static extern IntPtr LocalFree(IntPtr memory);
}
'@
function PrivateObject([string]$p,[bool]$directory,[bool]$runtime=$false) {
 if(([IO.File]::GetAttributes($p) -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'Reparse component object is forbidden'}
 $inherit=if($directory){'OICI'}else{''}
 $rights=if($runtime){'NW'}else{'NWNR'}
 $text="D:P(A;$inherit;FA;;;$($owner.Value))S:(ML;$inherit;$rights;;;ME)"
 $descriptor=[IntPtr]::Zero
 if(-not [CrotComponentSecurity]::ConvertStringSecurityDescriptorToSecurityDescriptor($text,1,[ref]$descriptor,[IntPtr]::Zero)){throw 'Component descriptor conversion failed'}
 try {
  # LABEL_SECURITY_INFORMATION, not SACL_SECURITY_INFORMATION: no elevation.
  if(-not [CrotComponentSecurity]::SetFileSecurity($p,[uint32]2147483668,$descriptor)){throw "Component descriptor install failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"}
 } finally {if([CrotComponentSecurity]::LocalFree($descriptor) -ne [IntPtr]::Zero){throw 'Component descriptor release failed'}}
}
function PrivateDirectory([string]$p,[bool]$runtime=$false) {
 [IO.Directory]::CreateDirectory($p) | Out-Null
 PrivateObject $p $true $runtime
}
# An existing parent is inspected, not silently re-ACL'd over active leases.
if(-not (Test-Path -LiteralPath $parent)){PrivateDirectory $parent}
if(([IO.File]::GetAttributes($parent) -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'Reparse L1 parent is forbidden'}
PrivateDirectory $target $true
try {
 if($Library) {[IO.File]::Copy([IO.Path]::GetFullPath($Library),(Join-Path $target 'crot-local-shim.dll'),$false)}
 else { & (Join-Path $PSScriptRoot 'build-windows-local-shim.ps1') -OutputDirectory $target -Architecture x64 }
 [IO.File]::Copy([IO.Path]::GetFullPath($NodeExecutable),(Join-Path $target 'node.exe'),$false)
 # Build intermediates are not delivered runtime components.
 Get-ChildItem -LiteralPath $target -File | Where-Object {$_.Name -notin @('crot-local-shim.dll','node.exe')} | Remove-Item -Force
 $files=[ordered]@{}
 foreach($name in @('crot-local-shim.dll','node.exe')) {$files[$name]=(Get-FileHash -LiteralPath (Join-Path $target $name) -Algorithm SHA256).Hash.ToLowerInvariant()}
 $manifest=[ordered]@{version='windows-l1-v1';arch='x64';files=$files} | ConvertTo-Json -Depth 4 -Compress
 [IO.File]::WriteAllText((Join-Path $target 'manifest.json'),$manifest,[Text.UTF8Encoding]::new($false))
 foreach($name in @('crot-local-shim.dll','node.exe','manifest.json')) {PrivateObject (Join-Path $target $name) $false $true}
 Write-Output '{"componentsProvisioned":true,"version":"windows-l1-v1"}'
} catch { throw }
