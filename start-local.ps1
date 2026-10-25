$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Set-Location -LiteralPath $PSScriptRoot
if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'node_modules/ws'))) {
    & npm.cmd ci --ignore-scripts
    if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
}
& node tools/local.mjs
