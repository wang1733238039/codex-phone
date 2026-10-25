$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)
$taskGitRoot = git rev-parse --show-toplevel
if ($LASTEXITCODE -ne 0 -or [System.IO.Path]::GetFullPath($taskGitRoot) -ne [System.IO.Path]::GetFullPath((Get-Location).Path)) {
    throw 'Run this packager from the standalone codex-phone Git checkout.'
}
$taskData = Join-Path (Get-Location).Path '.data'
New-Item -ItemType Directory -Path $taskData -Force | Out-Null
$taskOutput = Join-Path (Get-Location).Path '.data/codex-phone-deploy.zip'
git archive --format=zip --output $taskOutput HEAD
if ($LASTEXITCODE -ne 0) { throw 'Failed to archive the committed release.' }
Write-Output 'Packaged committed Git files only; local configuration and uncommitted files are excluded.'
Write-Output $taskOutput
