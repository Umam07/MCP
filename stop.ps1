# stop.ps1 - Stop Cloudflare Named Tunnel and MCP Server
$ErrorActionPreference = "SilentlyContinue"

$projectRoot = $PSScriptRoot
$tunnelPidFile = Join-Path $projectRoot ".bridge\tunnel.pid"
$serverPidFile = Join-Path $projectRoot ".bridge\pid.txt"

if (Test-Path $tunnelPidFile) {
    $pidToKill = Get-Content $tunnelPidFile
    if ($pidToKill) {
        Stop-Process -Id $pidToKill -Force -ErrorAction SilentlyContinue
        Write-Host "Stopped Tunnel (PID: $pidToKill)" -ForegroundColor Yellow
    }
    Remove-Item $tunnelPidFile -Force -ErrorAction SilentlyContinue
}

if (Test-Path $serverPidFile) {
    $pidToKill = Get-Content $serverPidFile
    if ($pidToKill) {
        Stop-Process -Id $pidToKill -Force -ErrorAction SilentlyContinue
        Write-Host "Stopped Server (PID: $pidToKill)" -ForegroundColor Yellow
    }
    Remove-Item $serverPidFile -Force -ErrorAction SilentlyContinue
}

Write-Host "All bridge services stopped." -ForegroundColor Green
