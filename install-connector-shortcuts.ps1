$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$taskControl = Join-Path $PSScriptRoot 'connector-control.ps1'
if (-not (Test-Path -LiteralPath $taskControl)) { throw 'Connector control window not found' }
$taskShell = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
$taskWsh = New-Object -ComObject WScript.Shell
$taskMenu = Join-Path ([Environment]::GetFolderPath('Programs')) 'Codex Phone'
New-Item -ItemType Directory -Path $taskMenu -Force | Out-Null
foreach ($taskFolder in @([Environment]::GetFolderPath('Desktop'), $taskMenu)) {
    $taskPath = Join-Path $taskFolder 'Codex 随行 - 电脑连接.lnk'
    $taskShortcut = $taskWsh.CreateShortcut($taskPath)
    if ((Test-Path -LiteralPath $taskPath) -and $taskShortcut.WorkingDirectory -ne $PSScriptRoot) {
        throw 'Another connector installation owns this shortcut. Existing shortcut preserved.'
    }
    $taskShortcut.TargetPath = $taskShell
    $taskShortcut.Arguments = '-NoProfile -STA -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $taskControl + '"'
    $taskShortcut.WorkingDirectory = $PSScriptRoot
    $taskShortcut.IconLocation = (Join-Path $env:SystemRoot 'System32/shell32.dll') + ',17'
    $taskShortcut.Description = '启动电脑连接、查看运行状态、设置开机自启动'
    $taskShortcut.WindowStyle = 7
    $taskShortcut.Save()
}
Write-Output 'Desktop and Start menu connector shortcuts installed.'
