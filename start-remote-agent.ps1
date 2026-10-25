$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Set-Location -LiteralPath $PSScriptRoot
$taskConfig = Join-Path $PSScriptRoot '.data/agent.remote.json'
if (-not (Test-Path -LiteralPath $taskConfig)) { throw 'Missing .data/agent.remote.json' }
$taskPidFile = Join-Path $PSScriptRoot '.data/remote-agent.pid'
if (Test-Path -LiteralPath $taskPidFile) {
    $taskSavedPid = [int](Get-Content -Encoding UTF8 -LiteralPath $taskPidFile)
    $taskExisting = Get-CimInstance Win32_Process -Filter "ProcessId=$taskSavedPid"
    if ($taskExisting -and $taskExisting.Name -eq 'node.exe' -and $taskExisting.CommandLine -like '*tools/remote-agent.mjs*') {
        Write-Output "Remote agent already running: $taskSavedPid"
        exit 0
    }
}
$taskProcess = Start-Process -FilePath (Get-Command node).Source -ArgumentList @('tools/remote-agent.mjs') -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -RedirectStandardOutput '.data/remote-agent.stdout.log' -RedirectStandardError '.data/remote-agent.stderr.log' -PassThru
$taskProcess.Id | Set-Content -Encoding UTF8 -LiteralPath $taskPidFile
Write-Output "Remote agent started: $($taskProcess.Id)"
