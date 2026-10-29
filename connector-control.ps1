param([switch]$SmokeTest, [string]$CapturePath)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$taskRoot = $PSScriptRoot
$taskConfigPath = Join-Path $taskRoot '.data/agent.remote.json'
if (-not (Test-Path -LiteralPath $taskConfigPath)) { throw 'Pair this computer first: node tools/pair.mjs --server https://your-domain.example' }
$taskConfig = Get-Content -LiteralPath $taskConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
$taskShell = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
$taskStartupPath = Join-Path ([Environment]::GetFolderPath('Startup')) 'Codex Phone Remote Agent.lnk'
$taskWsh = New-Object -ComObject WScript.Shell
. (Join-Path $taskRoot 'connector-task.ps1')

function Get-ConnectorProcess([string]$file, [string]$expectedName, [string]$expectedScript) {
    $path = Join-Path $taskRoot ('.data/' + $file)
    if (-not (Test-Path -LiteralPath $path)) { return $null }
    $saved = 0
    if (-not [int]::TryParse((Get-Content -LiteralPath $path -Raw -Encoding UTF8).Trim(), [ref]$saved)) { return $null }
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$saved" -ErrorAction SilentlyContinue
    if ($process -and $process.Name -eq $expectedName -and $process.CommandLine -like ('*' + $expectedScript + '*')) { return $process }
    return $null
}

function Get-ConnectorState {
    $agent = Get-ConnectorProcess 'remote-agent.pid' 'node.exe' 'remote-agent.mjs'
    $watcher = Get-ConnectorProcess 'remote-watch.pid' 'powershell.exe' 'start-remote-watch.ps1'
    $registered = Test-Path -LiteralPath $taskStartupPath
    $ownStartup = $false
    if ($registered) {
        $shortcut = $taskWsh.CreateShortcut($taskStartupPath)
        $ownStartup = $shortcut.WorkingDirectory -eq $taskRoot
    }
    $scheduled = Get-ConnectorScheduledTask
    [pscustomobject]@{
        running = [bool]$agent
        recoveryRunning = [bool]$watcher
        autostart = $ownStartup -or (Test-ConnectorTaskAutostart $scheduled)
        startupConflict = $registered -and -not $ownStartup
        processId = if ($agent) { $agent.ProcessId } else { $null }
        scheduledRecovery = [bool]$scheduled
        recoveryTask = if ($scheduled) { $scheduled.State.ToString() } else { $null }
        independentRecovery = [bool]($scheduled -or (Get-ConnectorUserSupervisor))
    }
}

function Start-Connector {
    Start-ConnectorScheduledTask | Out-Null
}

function Set-ConnectorAutostart([bool]$enabled) {
    $script = Join-Path $taskRoot 'install-remote-autostart.ps1'
    $arguments = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $script, '-NoStart')
    if (-not $enabled) { $arguments += '-Disable' }
    & $taskShell @arguments | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not change login startup. Check that this installation owns the startup shortcut.' }
}

if ($SmokeTest) {
    Get-ConnectorState | ConvertTo-Json -Compress
    exit 0
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
$taskForm = New-Object System.Windows.Forms.Form
$taskForm.Text = 'Codex 随行 · 电脑连接'
$taskForm.ClientSize = New-Object System.Drawing.Size(512, 458)
$taskForm.MinimumSize = $taskForm.Size
$taskForm.MaximumSize = $taskForm.Size
$taskForm.StartPosition = 'CenterScreen'
$taskForm.FormBorderStyle = 'FixedDialog'
$taskForm.MaximizeBox = $false
$taskForm.AutoScaleMode = 'Dpi'
$taskForm.BackColor = [System.Drawing.ColorTranslator]::FromHtml('#f4f6fb')
$taskForm.ForeColor = [System.Drawing.ColorTranslator]::FromHtml('#18263c')
$taskForm.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 10)

function Add-Label([string]$text, [int]$x, [int]$y, [int]$width, [int]$height, [int]$size = 10, [bool]$bold = $false) {
    $label = New-Object System.Windows.Forms.Label
    $label.Text = $text
    $label.Location = New-Object System.Drawing.Point($x, $y)
    $label.Size = New-Object System.Drawing.Size($width, $height)
    $style = if ($bold) { [System.Drawing.FontStyle]::Bold } else { [System.Drawing.FontStyle]::Regular }
    $label.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', $size, $style)
    $taskForm.Controls.Add($label)
    return $label
}

$null = Add-Label '电脑连接' 28 24 450 38 20 $true
$null = Add-Label '让手机接上这台电脑的 Codex。' 30 67 450 28
$taskStateLabel = Add-Label '正在检查连接程序…' 28 115 450 34 14 $true
$taskDetailsLabel = Add-Label '' 30 154 450 46
$taskComputerLabel = Add-Label ("电脑：" + $taskConfig.computerName) 30 206 450 26
$taskAddressLabel = Add-Label ("手机网页：" + ([uri]$taskConfig.serverUrl).GetLeftPart([System.UriPartial]::Authority)) 30 234 450 26

$taskAutostart = New-Object System.Windows.Forms.CheckBox
$taskAutostart.Text = '登录 Windows 后自动启动连接'
$taskAutostart.Location = New-Object System.Drawing.Point(30, 281)
$taskAutostart.Size = New-Object System.Drawing.Size(450, 32)
$taskAutostart.AccessibleName = '开机自启动'
$taskForm.Controls.Add($taskAutostart)

function Add-Button([string]$text, [int]$x, [int]$width) {
    $button = New-Object System.Windows.Forms.Button
    $button.Text = $text
    $button.Location = New-Object System.Drawing.Point($x, 332)
    $button.Size = New-Object System.Drawing.Size($width, 44)
    $button.FlatStyle = 'Flat'
    $button.FlatAppearance.BorderColor = [System.Drawing.ColorTranslator]::FromHtml('#b8c4d8')
    $button.UseVisualStyleBackColor = $false
    $button.BackColor = [System.Drawing.ColorTranslator]::FromHtml('#f9fbff')
    $taskForm.Controls.Add($button)
    return $button
}
$taskStart = Add-Button '启动连接' 28 142
$taskStart.BackColor = [System.Drawing.ColorTranslator]::FromHtml('#254edb')
$taskStart.ForeColor = [System.Drawing.ColorTranslator]::FromHtml('#f9fbff')
$taskWeb = Add-Button '打开手机网页' 182 154
$taskLogs = Add-Button '查看日志' 348 136
$taskFooter = Add-Label '关闭此窗口后，连接继续在后台运行。' 30 396 450 42 9
$taskFooter.ForeColor = [System.Drawing.ColorTranslator]::FromHtml('#53647b')
$taskForm.AcceptButton = $taskStart
$script:taskUpdating = $false

function Update-ConnectorWindow {
    $state = Get-ConnectorState
    $script:taskUpdating = $true
    try {
        $taskAutostart.Checked = $state.autostart
        $taskAutostart.Enabled = -not $state.startupConflict
    } finally { $script:taskUpdating = $false }
    $taskStart.Enabled = -not ($state.running -and $state.recoveryRunning)
    $taskStart.Text = if ($state.running -and $state.recoveryRunning) { '已在后台运行' } else { '启动连接' }
    $taskStart.BackColor = [System.Drawing.ColorTranslator]::FromHtml($(if ($taskStart.Enabled) { '#254edb' } else { '#e5eafb' }))
    if ($state.running) {
        $taskStateLabel.Text = '连接程序正在运行'
        $taskDetailsLabel.Text = if ($state.recoveryRunning) { '后台守护已运行，连接程序退出后会自动恢复。' } else { '可点击“启动连接”开启后台守护。' }
    } else {
        $taskStateLabel.Text = if ($state.recoveryRunning) { '正在启动连接程序…' } else { '连接程序尚未启动' }
        $taskDetailsLabel.Text = '点击“启动连接”，稍后在手机电脑列表查看在线状态。'
    }
    if ($state.startupConflict) { $taskDetailsLabel.Text = '另一个安装目录占用了自启动入口，请保留原安装并检查。' }
}

$taskStart.Add_Click({
    try { Start-Connector; $taskDetailsLabel.Text = '已发起后台启动，正在检查运行状态。'; Update-ConnectorWindow }
    catch { [System.Windows.Forms.MessageBox]::Show('启动失败，请查看本机连接程序日志。', 'Codex 随行', 'OK', 'Error') | Out-Null }
})
$taskAutostart.Add_CheckedChanged({
    if ($script:taskUpdating) { return }
    try { Set-ConnectorAutostart $taskAutostart.Checked; Update-ConnectorWindow }
    catch {
        [System.Windows.Forms.MessageBox]::Show('未能修改自启动设置，请检查此安装目录的访问权限。', 'Codex 随行', 'OK', 'Error') | Out-Null
        Update-ConnectorWindow
    }
})
$taskWeb.Add_Click({
    try {
        $address = [uri]$taskConfig.serverUrl
        if ($address.Scheme -ne 'https') { throw 'HTTPS is required' }
        Start-Process -FilePath $address.AbsoluteUri
    } catch { [System.Windows.Forms.MessageBox]::Show('无法打开手机网页，请检查连接配置。', 'Codex 随行') | Out-Null }
})
$taskLogs.Add_Click({ Start-Process -FilePath explorer.exe -ArgumentList ('"' + (Join-Path $taskRoot '.data') + '"') })
$taskTimer = New-Object System.Windows.Forms.Timer
$taskTimer.Interval = 4000
$taskTimer.Add_Tick({ Update-ConnectorWindow })
$taskForm.Add_Shown({
    Update-ConnectorWindow
    if (-not $CapturePath) {
        try { Start-Connector } catch { $taskDetailsLabel.Text = '自动启动未成功，可点击“启动连接”重试。' }
    }
    $taskTimer.Start()
    if ($CapturePath) {
        $taskForm.Refresh()
        $bitmap = New-Object System.Drawing.Bitmap($taskForm.ClientSize.Width, $taskForm.ClientSize.Height)
        try {
            $taskForm.DrawToBitmap($bitmap, $taskForm.ClientRectangle)
            $bitmap.Save($CapturePath, [System.Drawing.Imaging.ImageFormat]::Png)
        } finally { $bitmap.Dispose() }
        $taskForm.Close()
    }
})
try { [System.Windows.Forms.Application]::Run($taskForm) }
finally { $taskTimer.Stop(); $taskTimer.Dispose(); $taskForm.Dispose() }
