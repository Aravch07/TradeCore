param([int]$Port=4173)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
if (-not (Test-Path -LiteralPath '.\build\tradecore-server.exe')) { & '.\build.ps1' }
Write-Host "Open http://127.0.0.1:$Port in your browser. Press Ctrl+C to stop." -ForegroundColor Green
& '.\build\tradecore-server.exe' $Port
