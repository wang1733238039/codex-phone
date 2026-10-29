$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$taskRepo = Split-Path -Parent $PSScriptRoot
$taskArtifacts = Join-Path $taskRepo 'artifacts/connector-recovery'
$taskFixture = Join-Path $taskArtifacts ('fixture-' + [guid]::NewGuid().ToString('N'))
$taskShell = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
$taskUtf8 = New-Object System.Text.UTF8Encoding($false)
$taskAgentPid = $null
$taskReport = $null

function Assert-ConnectorCheck($condition, [string]$message) { if (-not $condition) { throw $message } }
function Read-FixturePid([string]$name) {
    $file = Join-Path $taskFixture ('.data/' + $name + '.pid')
    if (-not (Test-Path -LiteralPath $file)) { return 0 }
    return [int](Get-Content -LiteralPath $file -Encoding UTF8 -Raw)
}
function Wait-FixturePid([string]$name, [int]$previous = 0) {
    $deadline = (Get-Date).AddSeconds(32)
    do {
        $candidate = Read-FixturePid $name
        if ($candidate -and $candidate -ne $previous -and (Get-Process -Id $candidate -ErrorAction SilentlyContinue)) { return $candidate }
        Start-Sleep -Milliseconds 250
    } while ((Get-Date) -lt $deadline)
    throw ('Fixture did not recover: ' + $name)
}
function Run-FixtureStart {
    & $taskShell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $taskFixture 'start-remote-watch.ps1') | Out-Null
    Assert-ConnectorCheck ($LASTEXITCODE -eq 0) 'Fixture launch failed'
}

try {
    New-Item -ItemType Directory -Path (Join-Path $taskFixture '.data'),(Join-Path $taskFixture 'tools') -Force | Out-Null
    foreach ($file in @('connector-task.ps1', 'run-remote-watch.vbs', 'start-remote-watch.ps1', 'start-remote-agent.ps1')) {
        Copy-Item -LiteralPath (Join-Path $taskRepo $file) -Destination (Join-Path $taskFixture $file)
    }
    [System.IO.File]::WriteAllText((Join-Path $taskFixture '.data/agent.remote.json'), '{"computerName":"fixture"}', $taskUtf8)
    [System.IO.File]::WriteAllText((Join-Path $taskFixture '.data/connector-supervision.json'), '{"mode":"user-supervisor"}', $taskUtf8)
    [System.IO.File]::WriteAllText((Join-Path $taskFixture 'tools/remote-agent.mjs'), 'setInterval(() => {}, 1000);', $taskUtf8)
    # The temporary caller exits before verification. The supervisor must survive it.
    Run-FixtureStart
    $taskAgentPid = Wait-FixturePid 'remote-agent'
    $taskWatchPid = Wait-FixturePid 'remote-watch'
    $taskSupervisor = Get-CimInstance Win32_Process -Filter "Name='wscript.exe'" | Where-Object {
        $_.CommandLine -and $_.CommandLine.Contains('"' + (Join-Path $taskFixture 'run-remote-watch.vbs') + '"')
    } | Select-Object -First 1
    Assert-ConnectorCheck ([bool]$taskSupervisor) 'Independent supervisor is missing'
    $taskOwner = Get-CimInstance Win32_Process -Filter "ProcessId=$($taskSupervisor.ParentProcessId)"
    Assert-ConnectorCheck ($taskOwner.Name -eq 'explorer.exe') 'Supervisor still belongs to the terminal/Codex process tree'
    Run-FixtureStart
    Assert-ConnectorCheck ((Read-FixturePid 'remote-watch') -eq $taskWatchPid) 'Duplicate launch replaced the watcher'
    Assert-ConnectorCheck ((Read-FixturePid 'remote-agent') -eq $taskAgentPid) 'Duplicate launch replaced the connector'

    $taskAgent = Get-CimInstance Win32_Process -Filter "ProcessId=$taskAgentPid"
    Assert-ConnectorCheck ($taskAgent.ParentProcessId -eq $taskWatchPid -and $taskAgent.Name -eq 'node.exe') 'Fixture connector owner mismatch'
    Stop-Process -Id $taskAgentPid -Force
    $taskRecoveredAgent = Wait-FixturePid 'remote-agent' $taskAgentPid
    $taskAgentPid = $taskRecoveredAgent
    $taskWatch = Get-CimInstance Win32_Process -Filter "ProcessId=$taskWatchPid"
    Assert-ConnectorCheck ($taskWatch.CommandLine.Contains($taskFixture) -and $taskWatch.Name -eq 'powershell.exe') 'Fixture watcher owner mismatch'
    Stop-Process -Id $taskWatchPid -Force
    $taskRecoveredWatch = Wait-FixturePid 'remote-watch' $taskWatchPid
    Assert-ConnectorCheck ((Read-FixturePid 'remote-agent') -eq $taskAgentPid) 'Watcher recovery restarted an existing connector'
    $taskReport = [pscustomobject]@{
        passed=$true; verifiedAt=(Get-Date -Format o); noNetworkOrModelCalls=$true
        callerExitSurvived=$true; brokerParent=$taskOwner.Name
        duplicateStartPreserved=$true; connectorCrashRecovered=$true
        watcherCrashRecovered=$true; watcherRecoveryPreservedConnector=$true
        scheduledTaskBranch='not tested; current host denies registration'
    }
    $taskReport | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $taskArtifacts 'report.json') -Encoding UTF8
    $taskReport | ConvertTo-Json -Compress
} finally {
    # Never touch the production worker, its configuration or startup entries.
    Get-CimInstance Win32_Process -Filter "Name='wscript.exe'" -ErrorAction SilentlyContinue | Where-Object {
        $_.CommandLine -and $_.CommandLine.Contains('"' + (Join-Path $taskFixture 'run-remote-watch.vbs') + '"')
    } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue | Where-Object {
        $_.CommandLine -and $_.CommandLine.Contains($taskFixture) -and $_.CommandLine -like '*start-remote-watch.ps1*'
    } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    if ($taskAgentPid) {
        $agent = Get-CimInstance Win32_Process -Filter "ProcessId=$taskAgentPid" -ErrorAction SilentlyContinue
        if ($agent -and $agent.Name -eq 'node.exe' -and $agent.CommandLine -like '*tools/remote-agent.mjs*') {
            Stop-Process -Id $taskAgentPid -Force -ErrorAction SilentlyContinue
        }
    }
    $resolved = [System.IO.Path]::GetFullPath($taskFixture)
    $expected = [System.IO.Path]::GetFullPath($taskArtifacts).TrimEnd('\') + '\'
    if (-not $resolved.StartsWith($expected, [System.StringComparison]::OrdinalIgnoreCase) -or
        [System.IO.Path]::GetFileName($resolved) -notlike 'fixture-*') { throw 'Unsafe recovery fixture cleanup path' }
    if (Test-Path -LiteralPath $resolved) { Remove-Item -LiteralPath $resolved -Recurse -Force }
}
