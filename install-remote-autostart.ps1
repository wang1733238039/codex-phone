param([switch]$Disable, [switch]$NoStart)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Set-Location -LiteralPath $PSScriptRoot
$taskWatcher = Join-Path $PSScriptRoot 'start-remote-watch.ps1'
if (-not (Test-Path -LiteralPath $taskWatcher)) { throw 'Missing remote agent watcher' }
if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot '.data/agent.remote.json'))) { throw 'Missing remote agent configuration' }
$taskShell = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
$taskStartup = [Environment]::GetFolderPath('Startup')
$taskShortcutPath = Join-Path $taskStartup 'Codex Phone Remote Agent.lnk'
$taskWsh = New-Object -ComObject WScript.Shell
$taskShortcut = $taskWsh.CreateShortcut($taskShortcutPath)
if ((Test-Path -LiteralPath $taskShortcutPath) -and $taskShortcut.WorkingDirectory -ne $PSScriptRoot) {
    throw 'Another connector installation already owns this startup shortcut. Existing installation preserved.'
}
. (Join-Path $PSScriptRoot 'connector-task.ps1')
if ($Disable) {
    $taskRegistered = Get-ConnectorScheduledTask
    if ($taskRegistered) {
        $taskTriggers = @($taskRegistered.Triggers)
        foreach ($taskTrigger in $taskTriggers) { $taskTrigger.Enabled = $false }
        Set-ScheduledTask -TaskName $taskConnectorName -TaskPath '\' -Trigger $taskTriggers | Out-Null
    }
    if (Test-Path -LiteralPath $taskShortcutPath) {
        Remove-Item -LiteralPath $taskShortcutPath
    }
    Write-Output 'User logon and periodic startup disabled. The current connector keeps running.'
    exit 0
}
$taskRegistered = Set-ConnectorScheduledTask $true
# Only remove the old entry after its independent replacement registered successfully.
if ($taskRegistered) {
    if (Test-Path -LiteralPath $taskShortcutPath) { Remove-Item -LiteralPath $taskShortcutPath }
} else {
    $taskShortcut.TargetPath = $taskConnectorWscript
    $taskShortcut.Arguments = $taskConnectorArguments
    $taskShortcut.WorkingDirectory = $PSScriptRoot
    $taskShortcut.WindowStyle = 7
    $taskShortcut.Description = 'Codex phone independent background supervisor'
    $taskShortcut.Save()
}
if (-not $NoStart) { & $taskWatcher }
Write-Output 'User logon and independent background recovery installed.'
