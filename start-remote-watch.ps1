param([switch]$Run)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Set-Location -LiteralPath $PSScriptRoot
$taskShell = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
if (-not $Run) {
    . (Join-Path $PSScriptRoot 'connector-task.ps1')
    Start-ConnectorScheduledTask
    exit 0
}
$taskHash = [System.Security.Cryptography.SHA256]::Create()
$taskKey = [BitConverter]::ToString($taskHash.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($PSScriptRoot))).Replace('-', '')
$taskHash.Dispose()
$taskMutex = New-Object System.Threading.Mutex($false, ('Local\CodexPhoneRemoteWatch_' + $taskKey))
$taskOwned = $false
$taskWatchPid = Join-Path $PSScriptRoot '.data/remote-watch.pid'
$taskAgentPid = Join-Path $PSScriptRoot '.data/remote-agent.pid'
$taskLog = Join-Path $PSScriptRoot '.data/remote-watch.log'
try {
    try { $taskOwned = $taskMutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $taskOwned = $true }
    if (-not $taskOwned) { exit 0 }
    $PID | Set-Content -Encoding UTF8 -LiteralPath $taskWatchPid
    "$(Get-Date -Format o) watcher started pid=$PID" | Add-Content -Encoding UTF8 -LiteralPath $taskLog
    while ($true) {
        try {
            $taskExisting = $null
            if (Test-Path -LiteralPath $taskAgentPid) {
                $taskSavedPid = [int](Get-Content -Encoding UTF8 -LiteralPath $taskAgentPid)
                $taskExisting = Get-CimInstance Win32_Process -Filter "ProcessId=$taskSavedPid"
            }
            if (-not ($taskExisting -and $taskExisting.Name -eq 'node.exe' -and $taskExisting.CommandLine -like '*tools/remote-agent.mjs*')) {
                & (Join-Path $PSScriptRoot 'start-remote-agent.ps1') | Out-Null
                "$(Get-Date -Format o) connector started" | Add-Content -Encoding UTF8 -LiteralPath $taskLog
            }
        } catch {
            "$(Get-Date -Format o) $($_.Exception.Message)" | Add-Content -Encoding UTF8 -LiteralPath $taskLog
        }
        Start-Sleep -Seconds 20
    }
} finally {
    if ($taskOwned) { $taskMutex.ReleaseMutex() }
    $taskMutex.Dispose()
}
