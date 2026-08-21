$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$pidFile = Join-Path $projectRoot '.local-pvp\processes.json'
$processIds = New-Object System.Collections.Generic.HashSet[int]

if (Test-Path -LiteralPath $pidFile) {
    $record = Get-Content -LiteralPath $pidFile -Raw | ConvertFrom-Json
    foreach ($recordedId in @($record.relayPid, $record.webPid)) {
        if ($recordedId -and $recordedId -gt 0) {
            $null = $processIds.Add([int]$recordedId)
        }
    }
}

# Recover ArcShot service PIDs when a previous launcher saw the ports already
# occupied and therefore could not record the processes it originally created.
foreach ($port in @(8080, 8081)) {
    $listeners = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue
    foreach ($listener in @($listeners)) {
        $candidateId = [int]$listener.OwningProcess
        $candidate = Get-CimInstance Win32_Process -Filter "ProcessId=$candidateId" -ErrorAction SilentlyContinue
        $commandLine = [string]$candidate.CommandLine
        $belongsToProject = $commandLine.IndexOf($projectRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0
        $isRelay = $port -eq 8081 -and $commandLine.IndexOf('LocalRelayServer.js', [StringComparison]::OrdinalIgnoreCase) -ge 0
        $isWeb = $port -eq 8080 -and (
            $commandLine.IndexOf('StaticWebServer.js', [StringComparison]::OrdinalIgnoreCase) -ge 0 -or
            $commandLine.IndexOf('http.server', [StringComparison]::OrdinalIgnoreCase) -ge 0
        )
        if ($belongsToProject -and ($isRelay -or $isWeb)) {
            $null = $processIds.Add($candidateId)
        }
    }
}

foreach ($processId in $processIds) {
    $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
    if ($process) { Stop-Process -Id $processId -Force }
}
if (Test-Path -LiteralPath $pidFile) {
    Remove-Item -LiteralPath $pidFile -Force
}
Write-Host "Stopped $($processIds.Count) local ArcShot PVP service process(es)."
