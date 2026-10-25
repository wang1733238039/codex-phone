$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$taskPidFile = Join-Path $PSScriptRoot '.data/local.pid'
if (-not (Test-Path -LiteralPath $taskPidFile)) { Write-Output 'No background process record.'; exit }
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
    Write-Output 'Codex Phone stopped.'
} else { Write-Output 'Recorded background process is no longer running.' }
