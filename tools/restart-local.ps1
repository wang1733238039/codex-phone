$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)
$taskPidFile = Join-Path (Get-Location).Path '.data/local.pid'
if (Test-Path -LiteralPath $taskPidFile) {
    $taskSavedPid = [int](Get-Content -Encoding UTF8 -LiteralPath $taskPidFile)
    $taskParent = Get-CimInstance Win32_Process -Filter "ProcessId=$taskSavedPid"
    if ($taskParent -and $taskParent.Name -eq 'node.exe' -and $taskParent.CommandLine -like '*tools/local.mjs*') {
        $taskChildren = Get-CimInstance Win32_Process -Filter "ParentProcessId=$taskSavedPid"
        foreach ($taskChild in $taskChildren) {
            if ($taskChild.Name -eq 'node.exe' -and $taskChild.CommandLine -match 'codex-phone.*src[\\/](server|agent)\.mjs') {
                Stop-Process -Id $taskChild.ProcessId -ErrorAction SilentlyContinue
            }
        }
        Stop-Process -Id $taskSavedPid -ErrorAction SilentlyContinue
    }
}
$taskProcess = Start-Process -FilePath (Get-Command node).Source -ArgumentList @('tools/local.mjs') -WorkingDirectory (Get-Location).Path -WindowStyle Hidden -RedirectStandardOutput '.data/local.stdout.log' -RedirectStandardError '.data/local.stderr.log' -PassThru
$taskProcess.Id | Set-Content -Encoding UTF8 -LiteralPath $taskPidFile
Write-Output "Started Codex Phone process $($taskProcess.Id)"
for ($taskAttempt = 0; $taskAttempt -lt 30; $taskAttempt++) {
    try {
        $taskHealth = Invoke-RestMethod -Uri 'http://127.0.0.1:3819/healthz' -TimeoutSec 1
        if ($taskHealth.ok) { Write-Output 'Local server is ready.'; break }
    } catch { Start-Sleep -Milliseconds 200 }
}
