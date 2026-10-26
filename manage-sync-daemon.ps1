<#
.SYNOPSIS
    Antigravity Sync Daemon Controller
    Controls real-time dynamic chat & project synchronization between Antigravity IDE and 2.0.
.EXAMPLE
    .\manage-sync-daemon.ps1 start
    .\manage-sync-daemon.ps1 status
    .\manage-sync-daemon.ps1 stop
    .\manage-sync-daemon.ps1 restart
    .\manage-sync-daemon.ps1 install-startup
    .\manage-sync-daemon.ps1 uninstall-startup
#>

param (
    [Parameter(Position=0)]
    [ValidateSet("start", "stop", "restart", "status", "install-startup", "uninstall-startup", "sync-all")]
    [string]$Action = "status"
)

$UserProfile   = $env:USERPROFILE
$AppData       = $env:APPDATA

$NodeExe       = "C:\Program Files\nodejs\node.exe"
if (-not (Test-Path $NodeExe)) {
    $nodeCmd = Get-Command "node" -ErrorAction SilentlyContinue
    if ($nodeCmd) { $NodeExe = $nodeCmd.Source }
}

$DaemonScript  = Join-Path $UserProfile ".gemini\bin\antigravity-sync-daemon.js"
if (-not (Test-Path $DaemonScript)) {
    $LocalScript = Join-Path $PSScriptRoot "antigravity-sync-daemon.js"
    if (Test-Path $LocalScript) { $DaemonScript = $LocalScript }
}

$LogDir        = Join-Path $UserProfile ".gemini\logs"
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }

$LogFile       = Join-Path $LogDir "sync-daemon.log"
$PidFile       = Join-Path $LogDir "sync-daemon.pid"
$StartupDir    = Join-Path $AppData "Microsoft\Windows\Start Menu\Programs\Startup"
$StartupCmd    = Join-Path $StartupDir "AntigravitySyncDaemon.cmd"

function Get-DaemonProcess {
    if (Test-Path $PidFile) {
        $daemonPid = (Get-Content $PidFile -ErrorAction SilentlyContinue).Trim()
        if ($daemonPid) {
            $proc = Get-Process -Id $daemonPid -ErrorAction SilentlyContinue
            if ($proc -and $proc.ProcessName -match "node") {
                return $proc
            }
        }
    }
    try {
        $candidates = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match "antigravity-sync-daemon\.js" }
        if ($candidates) {
            return (Get-Process -Id $candidates[0].ProcessId -ErrorAction SilentlyContinue)
        }
    } catch {}
    return $null
}

switch ($Action) {
    "start" {
        $existing = Get-DaemonProcess
        if ($existing) {
            Write-Host "[ALREADY RUNNING] Antigravity Sync Daemon is already active (PID: $($existing.Id))." -ForegroundColor Yellow
            return
        }

        if (-not (Test-Path $NodeExe)) {
            Write-Host "[ERROR] Node.js executable not found. Please install Node.js 22+." -ForegroundColor Red
            return
        }

        # Start node directly with hidden window style
        $proc = Start-Process -FilePath $NodeExe -ArgumentList "`"$DaemonScript`"" -WindowStyle Hidden -PassThru
        Start-Sleep -Milliseconds 800

        $running = Get-DaemonProcess
        if ($running) {
            Write-Host "[SUCCESS] Antigravity Sync Daemon started successfully (PID: $($running.Id))." -ForegroundColor Green
            Write-Host "Logs: $LogFile" -ForegroundColor Gray
            Write-Host "Live Chat Mirror: http://127.0.0.1:37288/live" -ForegroundColor Cyan
        } else {
            Write-Host "[WARNING] Daemon initiated with PID $($proc.Id). Check $LogFile for details." -ForegroundColor Yellow
        }
    }

    "stop" {
        $proc = Get-DaemonProcess
        if ($proc) {
            Write-Host "Stopping Antigravity Sync Daemon (PID: $($proc.Id))..." -ForegroundColor Cyan
            Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
            if (Test-Path $PidFile) { Remove-Item $PidFile -Force -ErrorAction SilentlyContinue }
            Write-Host "[SUCCESS] Antigravity Sync Daemon stopped." -ForegroundColor Green
        } else {
            Write-Host "[INFO] Antigravity Sync Daemon is not running." -ForegroundColor Gray
        }
    }

    "restart" {
        & $PSCommandPath stop
        Start-Sleep -Seconds 1
        & $PSCommandPath start
    }

    "status" {
        $proc = Get-DaemonProcess
        if ($proc) {
            Write-Host "=== Antigravity Sync Daemon Status ===" -ForegroundColor Cyan
            Write-Host "Status      : " -NoNewline; Write-Host "RUNNING" -ForegroundColor Green
            Write-Host "Process ID  : $($proc.Id)"
            Write-Host "Working Set : $([math]::Round($proc.WorkingSet64 / 1MB, 2)) MB"
            Write-Host "Start Time  : $($proc.StartTime)"
            Write-Host "Endpoint    : http://127.0.0.1:37288/live"
            Write-Host "`nRecent Sync Activity (last 6 lines):" -ForegroundColor Cyan
            if (Test-Path $LogFile) {
                Get-Content $LogFile -Tail 6 | ForEach-Object { Write-Host "  $_" -ForegroundColor Gray }
            }
        } else {
            Write-Host "=== Antigravity Sync Daemon Status ===" -ForegroundColor Cyan
            Write-Host "Status      : " -NoNewline; Write-Host "STOPPED" -ForegroundColor Red
            if (Test-Path $LogFile) {
                Write-Host "`nLast Log Activity:" -ForegroundColor Cyan
                Get-Content $LogFile -Tail 6 | ForEach-Object { Write-Host "  $_" -ForegroundColor Gray }
            }
        }
    }

    "install-startup" {
        $cmdContent = "@echo off`r`nstart `"`" /B `"$NodeExe`" `"$DaemonScript`"`r`n"
        Set-Content -Path $StartupCmd -Value $cmdContent -Force
        Write-Host "[SUCCESS] Windows Startup script registered:" -ForegroundColor Green
        Write-Host "  $StartupCmd" -ForegroundColor Gray
    }

    "uninstall-startup" {
        if (Test-Path $StartupCmd) {
            Remove-Item $StartupCmd -Force
            Write-Host "[SUCCESS] Windows Startup script removed." -ForegroundColor Green
        } else {
            Write-Host "[INFO] Startup script does not exist." -ForegroundColor Gray
        }
    }

    "sync-all" {
        Write-Host "Running immediate full synchronization..." -ForegroundColor Cyan
        & $NodeExe -e "
            const { DatabaseSync } = require('node:sqlite');
            const fs = require('fs');
            const path = require('path');
            require('$($DaemonScript.Replace('\', '/'))');
        "
        Write-Host "[SUCCESS] Synchronization cycle triggered." -ForegroundColor Green
    }
}
