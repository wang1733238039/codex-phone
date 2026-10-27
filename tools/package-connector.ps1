$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskStage = Join-Path $taskRoot '.data/connector-package'
$taskOutput = Join-Path $taskRoot 'public/downloads/codex-phone-agent.zip'
$taskFiles = @(
    'src/agent.mjs', 'src/desktop.mjs', 'src/config.mjs', 'src/codex.mjs', 'src/local-source.mjs', 'src/sidebar.mjs', 'src/transcript.mjs', 'src/activity.mjs',
    'src/attachment-common.mjs', 'src/agent-attachments.mjs',
    'tools/pair.mjs', 'tools/remote-agent.mjs', 'tools/connector-status.mjs', 'tools/install-connector.mjs',
    'package.json', 'package-lock.json', 'README.md', 'start-remote-agent.ps1', 'start-remote-watch.ps1', 'install-remote-autostart.ps1',
    'connector-control.ps1', 'install-connector-shortcuts.ps1',
    'LICENSE', 'NOTICE', 'THIRD-PARTY-NOTICES.md',
    'vendor/agent-hub/LICENSE', 'vendor/agent-hub/PROVENANCE.json', 'vendor/agent-hub/package.json',
    'vendor/agent-hub/dist/desktop-ipc.mjs', 'vendor/agent-hub/dist/runtime-session.js', 'vendor/agent-hub/windows/desktop-pipe.ps1',
    'vendor/agent-hub/source/scripts/web-adapter-entry.mjs',
    'vendor/agent-hub/source/packages/codex-adapter/src/desktop-ipc.ts',
    'vendor/agent-hub/source/packages/codex-adapter/src/desktop-framing.ts',
    'vendor/agent-hub/source/packages/codex-adapter/src/desktop-live-window.ts',
    'vendor/agent-hub/source/packages/codex-adapter/src/desktop-platform.ts',
    'vendor/agent-hub/source/packages/codex-adapter/src/desktop-private-state-native.ts',
    'vendor/agent-hub/source/packages/codex-adapter/src/runtime.ts',
    'vendor/agent-hub/source/packages/codex-adapter/src/message-links.ts',
    'vendor/agent-hub/source/packages/codex-adapter/src/desktop-sidebar.ts',
    'vendor/agent-hub/source/packages/codex-adapter/src/desktop-history-identity.ts',
    'vendor/agent-hub/source/packages/codex-adapter/src/history-reader.ts',
    'vendor/agent-hub/source/packages/codex-adapter/src/generation-settings.ts',
    'vendor/agent-hub/source/packages/codex-adapter/src/windows-process.ts',
    'vendor/agent-hub/source/packages/codex-adapter/windows/desktop-pipe.ps1'
)
foreach ($taskFile in $taskFiles) {
    $taskPath = Join-Path $taskStage $taskFile
    if (-not (Test-Path -LiteralPath $taskPath)) { throw 'Connector staging file missing' }
}
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$taskStream = [System.IO.File]::Open($taskOutput, [System.IO.FileMode]::Create)
try {
    $taskZip = [System.IO.Compression.ZipArchive]::new($taskStream, [System.IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($taskFile in $taskFiles) {
            [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($taskZip, (Join-Path $taskStage $taskFile), $taskFile, [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
        }
    } finally { $taskZip.Dispose() }
} finally { $taskStream.Dispose() }
Write-Output 'Connector package built (allowlisted source only, no private configuration).'
