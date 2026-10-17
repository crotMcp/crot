# Test-owned phase probes, never a user-command wrapper or a module-security bypass.
$ErrorActionPreference = 'Stop'
function Record([string]$phase) {
    [IO.File]::AppendAllText($env:CROT_MODULE_REPORT, $phase + "`n")
}
Record 'entry'
try {
    if ($env:CROT_MODULE_PHASE -eq 'assembly') {
        Record 'assembly-attempt:Microsoft.PowerShell.Commands.Utility'
        # WinPS stores this DLL in the GAC, not necessarily next to powershell.exe.
        # Only the fixed system assembly directory is inspected, never host/user modules.
        $root = $env:SystemRoot + '\Microsoft.NET\assembly\GAC_MSIL\Microsoft.PowerShell.Commands.Utility'
        $files = [IO.Directory]::GetFiles($root, 'Microsoft.PowerShell.Commands.Utility.dll', [IO.SearchOption]::AllDirectories)
        if ($files.Length -ne 1) { throw [InvalidOperationException]::new('Ambiguous system assembly') }
        $assembly = [Reflection.Assembly]::LoadFrom($files[0])
        Record ('assembly-loaded:' + $assembly.GetName().Name)
    }
    if ($env:CROT_MODULE_PHASE -ne 'discovery') {
        Record 'import-attempt:Microsoft.PowerShell.Utility'
        Import-Module ($PSHOME + '\Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1') -ErrorAction Stop
        Record 'import-complete'
    }
    Record 'get-command-attempt:Out-File'
    $command = Get-Command Out-File -ErrorAction Stop
    Record ('command-module:' + $command.ModuleName)
    Record 'redirect-attempt'
    'module-marker' > $env:CROT_MODULE_OUTPUT
    Record 'redirect-complete'
    exit 0
} catch {
    Record ('error-type:' + $_.Exception.GetType().FullName)
    Record ('error-hresult:' + $_.Exception.HResult)
    exit 1
}
