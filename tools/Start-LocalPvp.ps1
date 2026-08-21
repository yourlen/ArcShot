$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$relayEntry = Join-Path $projectRoot 'server\dist\server\src\LocalRelayServer.js'
$staticServerEntry = Join-Path $projectRoot 'tools\StaticWebServer.js'
$webRoot = Join-Path $projectRoot 'build\web-desktop'
$indexFile = Join-Path $webRoot 'index.html'
$runtimeDir = Join-Path $projectRoot '.local-pvp'
$pidFile = Join-Path $runtimeDir 'processes.json'

if (-not (Test-Path -LiteralPath $relayEntry)) {
    throw "Relay has not been compiled: $relayEntry"
}
if (-not (Test-Path -LiteralPath $indexFile)) {
    throw "Web build was not found: $indexFile"
}
if (-not (Test-Path -LiteralPath $staticServerEntry)) {
    throw "Static web server was not found: $staticServerEntry"
}

$nodeCandidates = @(
    (Join-Path $projectRoot 'runtime\node.exe'),
    'C:\Users\yourlen\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe',
    (Get-Command node.exe -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -First 1)
) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }

$nodeExe = $nodeCandidates | Select-Object -First 1
if (-not $nodeExe) { throw 'Node.js was not found.' }

New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null
$relayProcess = $null
$webProcess = $null
$relayListening = Get-NetTCPConnection -State Listen -LocalPort 8081 -ErrorAction SilentlyContinue
$webListening = Get-NetTCPConnection -State Listen -LocalPort 8080 -ErrorAction SilentlyContinue

if (-not $relayListening) {
    $relayProcess = Start-Process -FilePath $nodeExe -ArgumentList @($relayEntry) -WorkingDirectory (Join-Path $projectRoot 'server') -WindowStyle Hidden -PassThru
}
if (-not $webListening) {
    $webProcess = Start-Process -FilePath $nodeExe -ArgumentList @($staticServerEntry, $webRoot, '8080') -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru
}

@{
    relayPid = if ($relayProcess) { $relayProcess.Id } else { 0 }
    webPid = if ($webProcess) { $webProcess.Id } else { 0 }
    startedAt = (Get-Date).ToString('o')
} | ConvertTo-Json | Set-Content -LiteralPath $pidFile -Encoding UTF8

for ($attempt = 0; $attempt -lt 30; $attempt += 1) {
    try {
        $relay = Invoke-RestMethod -Uri 'http://127.0.0.1:8081/diagnostics' -TimeoutSec 1
        $client = Invoke-WebRequest -Uri 'http://127.0.0.1:8080/?pvp=1' -UseBasicParsing -TimeoutSec 1
        if ($relay.protocolVersion -eq 'arcshot-pvp-local/0.2' -and $client.StatusCode -eq 200) { break }
    } catch {
        Start-Sleep -Milliseconds 200
    }
}

$urlA = 'http://127.0.0.1:8080/?pvp=1&client=A'
$urlB = 'http://127.0.0.1:8080/?pvp=1&client=B'
$chromeCandidates = @(
    (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe')
) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
$chromeExe = $chromeCandidates | Select-Object -First 1

if ($chromeExe) {
    Start-Process -FilePath $chromeExe -ArgumentList @('--new-window', $urlA)
    Start-Process -FilePath $chromeExe -ArgumentList @('--new-window', $urlB)
} else {
    Start-Process $urlA
    Start-Process $urlB
}

Write-Host 'ArcShot local two-client PVP started.'
Write-Host 'Client: http://127.0.0.1:8080/?pvp=1'
Write-Host 'Relay diagnostics: http://127.0.0.1:8081/diagnostics'
