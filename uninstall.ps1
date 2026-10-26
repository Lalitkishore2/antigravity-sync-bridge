<#
.SYNOPSIS
    Antigravity Sync Bridge Uninstaller
.DESCRIPTION
    Safely stops the synchronization daemon and removes startup entries.
#>

[CmdletBinding()]
param (
    [switch]$KeepJunctions
)

Write-Host "=== Antigravity Sync Bridge Uninstaller ===" -ForegroundColor Cyan

$UserProfile = $env:USERPROFILE
$AppData     = $env:APPDATA
$BinDir      = Join-Path $UserProfile ".gemini\bin"
$ManagePs1   = Join-Path $BinDir "manage-sync-daemon.ps1"
$StartupCmd  = Join-Path $AppData "Microsoft\Windows\Start Menu\Programs\Startup\AntigravitySyncDaemon.cmd"

if (Test-Path $ManagePs1) {
    Write-Host "Stopping sync daemon..." -ForegroundColor Yellow
    & powershell -ExecutionPolicy Bypass -File $ManagePs1 stop
}

if (Test-Path $StartupCmd) {
    Remove-Item $StartupCmd -Force
    Write-Host "Removed Windows Startup persistence." -ForegroundColor Green
}

if (-not $KeepJunctions) {
    $IdeConv  = Join-Path $UserProfile ".gemini\antigravity-ide\conversations"
    $IdeBrain = Join-Path $UserProfile ".gemini\antigravity-ide\brain"
    
    foreach ($j in @($IdeConv, $IdeBrain)) {
        if (Test-Path $j) {
            $item = Get-Item $j -Force
            if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                # Removing junction in PowerShell with cmd /c rmdir removes only the link, not target data
                cmd /c rmdir "$j"
                Write-Host "Unlinked junction: $j" -ForegroundColor Gray
            }
        }
    }
}

Write-Host "`n[SUCCESS] Antigravity Sync Bridge has been cleanly uninstalled." -ForegroundColor Green
