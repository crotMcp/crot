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
function PrivateDirectory([string]$p) {
 [IO.Directory]::CreateDirectory($p) | Out-Null
 if(([IO.File]::GetAttributes($p) -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'Reparse component directory is forbidden'}
 $acl=[Security.AccessControl.DirectorySecurity]::new()
 $acl.SetOwner($owner);$acl.SetAccessRuleProtection($true,$false)
 $flags=[Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
 $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($owner,[Security.AccessControl.FileSystemRights]::FullControl,$flags,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow))
 [IO.Directory]::SetAccessControl($p,$acl)
}
# An existing parent is inspected, not silently re-ACL'd over active leases.
if(-not (Test-Path -LiteralPath $parent)){PrivateDirectory $parent}
if(([IO.File]::GetAttributes($parent) -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'Reparse L1 parent is forbidden'}
PrivateDirectory $target
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
 Write-Output '{"componentsProvisioned":true,"version":"windows-l1-v1"}'
} catch { throw }
