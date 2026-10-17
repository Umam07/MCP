# start.ps1 - Start Cloudflare Named Tunnel and MCP Server
$ErrorActionPreference = "SilentlyContinue"

$projectRoot = $PSScriptRoot
Set-Location $projectRoot

# Ensure .bridge directory exists
New-Item -ItemType Directory -Force -Path (Join-Path $projectRoot ".bridge") | Out-Null

# 1. Stop old tunnel if running
$tunnelPidFile = Join-Path $projectRoot ".bridge\tunnel.pid"
if (Test-Path $tunnelPidFile) {
    $oldPid = Get-Content $tunnelPidFile
    if ($oldPid) { Stop-Process -Id $oldPid -Force -ErrorAction SilentlyContinue }
    Remove-Item $tunnelPidFile -Force -ErrorAction SilentlyContinue
}

# 2. Stop old server if running
$serverPidFile = Join-Path $projectRoot ".bridge\pid.txt"
if (Test-Path $serverPidFile) {
    $oldPid = Get-Content $serverPidFile
    if ($oldPid) { Stop-Process -Id $oldPid -Force -ErrorAction SilentlyContinue }
    Remove-Item $serverPidFile -Force -ErrorAction SilentlyContinue
}

# 3. Load .env into process environment variables
$envFile = Join-Path $projectRoot ".env"
if (Test-Path $envFile) {
    Get-Content $envFile | ForEach-Object {
        $line = $_.Trim()
        if ($line -and -not $line.StartsWith("#") -and $line -match '^([^=]+)=(.*)$') {
            $name = $matches[1].Trim()
            $val = $matches[2].Trim()
            [System.Environment]::SetEnvironmentVariable($name, $val, "Process")
        }
    }
}

Write-Host "Starting Cloudflare Named Tunnel (mcp.syafiul.id)..." -ForegroundColor Cyan
$cfBin = Join-Path $projectRoot "bin\cloudflared.exe"
$cfConfig = ".bridge\tunnel\config.yml"
$cfLog = Join-Path $projectRoot ".bridge\tunnel.log"
$cfErr = Join-Path $projectRoot ".bridge\tunnel-err.log"

$cfProcess = Start-Process -FilePath $cfBin -ArgumentList "--config", $cfConfig, "tunnel", "run", "c5fce942-a27f-4df4-8f9f-9149b2dba2e7" -WorkingDirectory $projectRoot -RedirectStandardOutput $cfLog -RedirectStandardError $cfErr -PassThru
$cfProcess.Id | Out-File -FilePath $tunnelPidFile -Encoding ascii

# Wait 4 seconds for tunnel handshake to complete
Start-Sleep -Seconds 4

Write-Host "Starting MCP Server..." -ForegroundColor Cyan
$serverLog = Join-Path $projectRoot ".bridge\server.log"
$serverErr = Join-Path $projectRoot ".bridge\server-err.log"

$serverProcess = Start-Process -FilePath "node" -ArgumentList "dist/index.js" -WorkingDirectory $projectRoot -RedirectStandardOutput $serverLog -RedirectStandardError $serverErr -PassThru
$serverProcess.Id | Out-File -FilePath $serverPidFile -Encoding ascii

Start-Sleep -Seconds 2

Write-Host ""
Write-Host "=====================================================" -ForegroundColor Green
Write-Host " [OK] MCP Server & Named Tunnel are RUNNING!" -ForegroundColor Green
Write-Host " Tunnel Domain : $env:PUBLIC_URL" -ForegroundColor Yellow
Write-Host " MCP Endpoint  : $env:PUBLIC_URL/mcp" -ForegroundColor Yellow
Write-Host " OAuth Info    : $env:PUBLIC_URL/.well-known/oauth-authorization-server" -ForegroundColor Yellow
Write-Host " Tunnel PID    : $($cfProcess.Id)"
Write-Host " Server PID    : $($serverProcess.Id)"
Write-Host "=====================================================" -ForegroundColor Green
