# Shared Windows background lifecycle. Never stores device tokens or passwords.
$taskConnectorRoot = [System.IO.Path]::GetFullPath($PSScriptRoot)
$taskConnectorSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$taskConnectorHash = [System.Security.Cryptography.SHA256]::Create()
try {
    $taskConnectorKey = [BitConverter]::ToString($taskConnectorHash.ComputeHash(
        [System.Text.Encoding]::UTF8.GetBytes($taskConnectorSid + '|' + $taskConnectorRoot.ToUpperInvariant())
    )).Replace('-', '').Substring(0, 24)
} finally { $taskConnectorHash.Dispose() }
$taskConnectorName = 'CodexPhoneRemoteWatch_' + $taskConnectorKey
$taskConnectorLauncher = Join-Path $taskConnectorRoot 'run-remote-watch.vbs'
$taskConnectorWscript = Join-Path $env:SystemRoot 'System32/wscript.exe'
$taskConnectorArguments = '//B //Nologo "' + $taskConnectorLauncher + '"'
$taskConnectorModeFile = Join-Path $taskConnectorRoot '.data/connector-supervision.json'

function Get-ConnectorUserSupervisor {
    $processes = Get-CimInstance Win32_Process -Filter "Name='wscript.exe'" -ErrorAction SilentlyContinue
    return @($processes | Where-Object {
        $_.CommandLine -and $_.CommandLine.Contains('"' + $taskConnectorLauncher + '"')
    } | Select-Object -First 1)[0]
}

function Start-ConnectorUserSupervisor {
    $hashMutex = New-Object System.Threading.Mutex($false, ('Local\' + $taskConnectorName + '_Launch'))
    $owned = $false
    try {
        try { $owned = $hashMutex.WaitOne(5000) } catch [System.Threading.AbandonedMutexException] { $owned = $true }
        if (-not $owned) { throw 'Another background launch is still in progress.' }
        $existing = Get-ConnectorUserSupervisor
        if ($existing) { Write-Output ('Background connector supervisor already running: ' + $existing.ProcessId); return }
        # Use the actual interactive desktop broker, not a fresh Shell.Application dispatch.
        # The resulting worker belongs to Explorer instead of the terminal/Codex job.
        $shellWindows = (New-Object -ComObject Shell.Application).Windows()
        $desktop = $shellWindows.Item([uint32]8)
        if (-not $desktop) { throw 'Log in to the Windows desktop before starting the connector.' }
        $desktop.Document.Application.ShellExecute($taskConnectorWscript, $taskConnectorArguments, $taskConnectorRoot, 'open', 0)
        $deadline = (Get-Date).AddSeconds(5)
        do {
            $started = Get-ConnectorUserSupervisor
            if ($started) { break }
            Start-Sleep -Milliseconds 100
        } while ((Get-Date) -lt $deadline)
        if (-not $started) { throw 'The independent background supervisor did not start.' }
        Write-Output ('Independent connector supervisor started: ' + $started.ProcessId)
    } finally {
        if ($owned) { $hashMutex.ReleaseMutex() }
        $hashMutex.Dispose()
    }
}

function Get-ConnectorScheduledTask {
    $scheduled = Get-ScheduledTask -TaskPath '\' -TaskName $taskConnectorName -ErrorAction SilentlyContinue
    if ($scheduled) {
        $actions = @($scheduled.Actions)
        if ($actions.Count -ne 1 -or $actions[0].Execute -ne $taskConnectorWscript -or
            $actions[0].Arguments -ne $taskConnectorArguments -or $actions[0].WorkingDirectory -ne $taskConnectorRoot) {
            throw 'Scheduled task ownership mismatch. Existing task preserved.'
        }
    }
    return $scheduled
}

function Test-ConnectorTaskAutostart($scheduled) {
    return [bool]($scheduled -and $scheduled.Settings.Enabled -and @($scheduled.Triggers | Where-Object { $_.Enabled }).Count)
}

function Set-ConnectorScheduledTask([bool]$enabled) {
    $existing = Get-ConnectorScheduledTask
    if (-not (Test-Path -LiteralPath $taskConnectorLauncher) -or
        -not (Test-Path -LiteralPath (Join-Path $taskConnectorRoot 'start-remote-watch.ps1'))) {
        throw 'Connector background launcher is missing.'
    }
    $action = New-ScheduledTaskAction -Execute $taskConnectorWscript -Argument $taskConnectorArguments -WorkingDirectory $taskConnectorRoot
    $logon = New-ScheduledTaskTrigger -AtLogOn -User $taskConnectorSid
    # A normal exit (including a killed parent) must also recover, not just nonzero failures.
    $periodic = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)
    $logon.Enabled = $enabled
    $periodic.Enabled = $enabled
    $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable `
        -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) `
        -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -Hidden
    $principal = New-ScheduledTaskPrincipal -UserId $taskConnectorSid -LogonType Interactive -RunLevel Limited
    $definition = New-ScheduledTask -Action $action -Trigger @($logon, $periodic) -Settings $settings -Principal $principal `
        -Description ('Codex Phone connector recovery for ' + $taskConnectorRoot)
    try {
        Register-ScheduledTask -TaskName $taskConnectorName -TaskPath '\' -InputObject $definition -Force -ErrorAction Stop | Out-Null
    } catch {
        if ($_.CategoryInfo.Category -ne 'PermissionDenied' -and $_.Exception.HResult -ne -2147024891) { throw }
        # Keep normal-user installs usable when this Windows policy requires elevation for tasks.
        [pscustomobject]@{ mode='user-supervisor'; taskRegistration='access-denied' } |
            ConvertTo-Json -Compress | Set-Content -LiteralPath $taskConnectorModeFile -Encoding UTF8
        return $null
    }
    [pscustomobject]@{ mode='scheduled-task'; taskRegistration='registered' } |
        ConvertTo-Json -Compress | Set-Content -LiteralPath $taskConnectorModeFile -Encoding UTF8
    return Get-ConnectorScheduledTask
}

function Start-ConnectorScheduledTask {
    $scheduled = Get-ConnectorScheduledTask
    if (-not $scheduled) {
        $legacyPath = Join-Path ([Environment]::GetFolderPath('Startup')) 'Codex Phone Remote Agent.lnk'
        $enabled = $false
        if (Test-Path -LiteralPath $legacyPath) {
            $wsh = New-Object -ComObject WScript.Shell
            $enabled = $wsh.CreateShortcut($legacyPath).WorkingDirectory -eq $taskConnectorRoot
        }
        $knownMode = if (Test-Path -LiteralPath $taskConnectorModeFile) {
            (Get-Content -LiteralPath $taskConnectorModeFile -Encoding UTF8 -Raw | ConvertFrom-Json).mode
        } else { '' }
        if ($knownMode -ne 'user-supervisor') { $scheduled = Set-ConnectorScheduledTask $enabled }
    }
    if (-not $scheduled) {
        Start-ConnectorUserSupervisor
        return
    }
    if ($scheduled.State -ne 'Running') {
        Start-ScheduledTask -TaskName $taskConnectorName -TaskPath '\'
    }
    Write-Output ('Background connector task started: ' + $taskConnectorName)
}
