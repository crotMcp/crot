# Fixed test-owned Node invocation; no shell command service or policy changes.
$ErrorActionPreference = 'Stop'
$lines = [Collections.Generic.List[string]]::new()
$lines.Add('entry=1')
$lines.Add('psVersion=' + $PSVersionTable.PSVersion.ToString())
$lines.Add('languageMode=' + $ExecutionContext.SessionState.LanguageMode.ToString())
$lines.Add('cwdMatches=' + ([IO.Directory]::GetCurrentDirectory() -eq $env:CROT_6A_WORKSPACE))
$lines.Add('nodePresent=' + [IO.File]::Exists($env:CROT_6A_NODE))
$lines.Add('clientPresent=' + [IO.File]::Exists($env:CROT_6A_CLIENT))
[IO.File]::WriteAllLines($env:CROT_6A_PS_REPORT, $lines)
foreach ($mode in @('dotnet-redirected', 'legacy-native')) {
    $lines.Add($mode + '.attempted=1')
    [IO.File]::WriteAllLines($env:CROT_6A_PS_REPORT, $lines)
    try {
        if ($mode -eq 'legacy-native') {
            $Error.Clear()
            $global:LASTEXITCODE = $null
            $value = & $env:CROT_6A_NODE '--version'
            $lines.Add($mode + '.success=' + [string]$?)
            $lines.Add($mode + '.errorCount=' + [string]$Error.Count)
            if ($Error.Count -gt 0) {
                $lines.Add($mode + '.errorId=' + $Error[0].FullyQualifiedErrorId)
                $lines.Add($mode + '.errorType=' + $Error[0].Exception.GetType().FullName)
            }
            $lines.Add($mode + '.exit=' + [string]$LASTEXITCODE)
            $lines.Add($mode + '.versionMatched=' + ([string]$value -match '^v[0-9]+\.[0-9]+\.[0-9]+$'))
        } else {
            $si = [Diagnostics.ProcessStartInfo]::new()
            $si.FileName = $env:CROT_6A_NODE
            $si.Arguments = '--version'
            $si.UseShellExecute = $false
            $si.CreateNoWindow = $true
            $si.RedirectStandardInput = $true
            $si.RedirectStandardOutput = $true
            $si.RedirectStandardError = $true
            $p = [Diagnostics.Process]::Start($si)
            try {
                $p.StandardInput.Close()
                if (!$p.WaitForExit(8000)) {
                    $lines.Add($mode + '.timeout=1')
                    $p.Kill()
                    $p.WaitForExit(5000) | Out-Null
                } else {
                    $value = $p.StandardOutput.ReadToEnd().Trim()
                    $err = $p.StandardError.ReadToEnd()
                    $lines.Add($mode + '.exit=' + $p.ExitCode)
                    $lines.Add($mode + '.versionMatched=' + ($value -match '^v[0-9]+\.[0-9]+\.[0-9]+$'))
                    $lines.Add($mode + '.stderrEmpty=' + ($err.Length -eq 0))
                }
            } finally { $p.Dispose() }
        }
    } catch {
        $e = $_.Exception
        $depth = 0
        while ($null -ne $e -and $depth -lt 6) {
            $prefix = $mode + '.exception' + $depth
            $lines.Add($prefix + '.type=' + $e.GetType().FullName)
            $lines.Add($prefix + '.hresult=' + $e.HResult)
            if ($e -is [ComponentModel.Win32Exception]) {
                $lines.Add($prefix + '.native=' + $e.NativeErrorCode)
            }
            $e = $e.InnerException
            $depth++
        }
    }
    [IO.File]::WriteAllLines($env:CROT_6A_PS_REPORT, $lines)
}
$lines.Add('complete=1')
[IO.File]::WriteAllLines($env:CROT_6A_PS_REPORT, $lines)
exit 0