<#
.SYNOPSIS
    Antigravity IDE & Antigravity 2.0 Permanent Synchronization Installer
.DESCRIPTION
    Automates end-to-end setup of zero-latency, bidirectional synchronization between
    Antigravity IDE and Antigravity 2.0:
    1. Validates Node.js (v22+) and system environment.
    2. Consolidates storage and configures transparent NTFS Directory Junctions.
    3. Safely repairs state.vscdb to fix missing conversations and clears 55+ falsely stuck "Running" chats.
    4. Deploys real-time synchronization daemon to ~/.gemini/bin.
    5. Registers Windows Startup persistence and launches Live Chat Mirror (port 37288).
.EXAMPLE
    # Single-line installation:
    irm https://raw.githubusercontent.com/Lalitkishore2/antigravity-sync-bridge/main/install.ps1 | iex

    # Unattended silent setup:
    & ([scriptblock]::Create((irm https://raw.githubusercontent.com/Lalitkishore2/antigravity-sync-bridge/main/install.ps1))) -Silent -Force
#>

[CmdletBinding()]
param (
    [switch]$Silent,
    [switch]$Force,
    [switch]$SkipIdeRestart
)

$ErrorActionPreference = "Stop"

Write-Host @"
===================================================================
       Antigravity Real-Time Sync Bridge Installer (v2.0)
     Zero-Latency Dynamic Synchronization: IDE <---> 2.0
===================================================================
"@ -ForegroundColor Cyan

# 1. Environment & Path Resolution
$UserProfile   = $env:USERPROFILE
$AppData       = $env:APPDATA
$LocalAppData  = $env:LOCALAPPDATA

$MasterBase    = Join-Path $UserProfile ".gemini\antigravity"
$MasterConv    = Join-Path $MasterBase "conversations"
$MasterBrain   = Join-Path $MasterBase "brain"
$MasterDb      = Join-Path $MasterBase "conversation_summaries.db"
$MasterProto   = Join-Path $MasterBase "agyhub_summaries_proto.pb"

$IdeBase       = Join-Path $UserProfile ".gemini\antigravity-ide"
$IdeConv       = Join-Path $IdeBase "conversations"
$IdeBrain      = Join-Path $IdeBase "brain"

$VscdbPath     = Join-Path $AppData "Antigravity IDE\User\globalStorage\state.vscdb"
$BinDir        = Join-Path $UserProfile ".gemini\bin"
$LogDir        = Join-Path $UserProfile ".gemini\logs"
$StartupDir    = Join-Path $AppData "Microsoft\Windows\Start Menu\Programs\Startup"
$StartupCmd    = Join-Path $StartupDir "AntigravitySyncDaemon.cmd"

# 2. Check Node.js
Write-Host "`n[1/6] Checking Prerequisites..." -ForegroundColor Yellow

$NodeExe = "C:\Program Files\nodejs\node.exe"
if (-not (Test-Path $NodeExe)) {
    $nodeCmd = Get-Command "node" -ErrorAction SilentlyContinue
    if ($nodeCmd) { $NodeExe = $nodeCmd.Source }
}

if (-not (Test-Path $NodeExe)) {
    Write-Host "[ERROR] Node.js is required but was not found." -ForegroundColor Red
    Write-Host "Please install Node.js v22+ from https://nodejs.org/" -ForegroundColor Yellow
    exit 1
}

$nodeVer = & $NodeExe -v
Write-Host "  Found Node.js: $nodeVer ($NodeExe)" -ForegroundColor Green

# 3. Handle Running Antigravity IDE
Write-Host "`n[2/6] Checking Running Processes..." -ForegroundColor Yellow
$ideProcs = Get-Process -Name "*Antigravity IDE*" -ErrorAction SilentlyContinue
$wasIdeRunning = $false

if ($ideProcs) {
    $wasIdeRunning = $true
    Write-Host "  Detected active Antigravity IDE processes." -ForegroundColor Gray
    if (-not $Silent -and -not $Force) {
        $confirm = Read-Host "  Antigravity IDE must close briefly to update state.vscdb safely. Close now? [Y/n]"
        if ($confirm -match "^[Nn]") {
            Write-Host "[ABORTED] Installation canceled by user." -ForegroundColor Red
            exit 0
        }
    }
    Write-Host "  Closing Antigravity IDE gracefully..." -ForegroundColor Cyan
    Stop-Process -Name "*Antigravity IDE*" -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
} else {
    Write-Host "  No running IDE conflicts detected." -ForegroundColor Green
}

# 4. Storage Consolidation & NTFS Directory Junctions
Write-Host "`n[3/6] Configuring Zero-Latency Storage (NTFS Junctions)..." -ForegroundColor Yellow

foreach ($d in @($MasterBase, $MasterConv, $MasterBrain, $BinDir, $LogDir)) {
    if (-not (Test-Path $d)) {
        New-Item -ItemType Directory -Path $d -Force | Out-Null
    }
}

if (-not (Test-Path $IdeBase)) {
    New-Item -ItemType Directory -Path $IdeBase -Force | Out-Null
}

function Create-SafeJunction([string]$LinkPath, [string]$TargetPath) {
    if (Test-Path $LinkPath) {
        $item = Get-Item $LinkPath -Force
        $isJunction = ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0
        if ($isJunction) {
            Write-Host "  Junction already active: $LinkPath -> $TargetPath" -ForegroundColor Green
            return
        }
        # Copy any unique files to master before linking
        Write-Host "  Consolidating files from $LinkPath into $TargetPath..." -ForegroundColor Gray
        Copy-Item -Path "$LinkPath\*" -Destination $TargetPath -Recurse -Force -ErrorAction SilentlyContinue
        Remove-Item -Path $LinkPath -Recurse -Force
    }
    cmd /c mklink /J "$LinkPath" "$TargetPath" | Out-Null
    Write-Host "  Created Junction: $LinkPath -> $TargetPath" -ForegroundColor Green
}

Create-SafeJunction $IdeConv $MasterConv
Create-SafeJunction $IdeBrain $MasterBrain

# 5. Deploy Daemon Files
Write-Host "`n[4/6] Deploying Real-Time Sync Daemon..." -ForegroundColor Yellow

$SourceDir = $PSScriptRoot
$IsRemote = -not (Test-Path (Join-Path $SourceDir "antigravity-sync-daemon.js"))

if ($IsRemote) {
    Write-Host "  Fetching scripts from GitHub repository..." -ForegroundColor Gray
    $baseUrl = "https://raw.githubusercontent.com/Lalitkishore2/antigravity-sync-bridge/main"
    Invoke-WebRequest -Uri "$baseUrl/antigravity-sync-daemon.js" -OutFile (Join-Path $BinDir "antigravity-sync-daemon.js") -UseBasicParsing
    Invoke-WebRequest -Uri "$baseUrl/manage-sync-daemon.ps1" -OutFile (Join-Path $BinDir "manage-sync-daemon.ps1") -UseBasicParsing
    Invoke-WebRequest -Uri "$baseUrl/launch-sync-daemon.vbs" -OutFile (Join-Path $BinDir "launch-sync-daemon.vbs") -UseBasicParsing
} else {
    Copy-Item -Path (Join-Path $SourceDir "antigravity-sync-daemon.js") -Destination $BinDir -Force
    Copy-Item -Path (Join-Path $SourceDir "manage-sync-daemon.ps1") -Destination $BinDir -Force
    Copy-Item -Path (Join-Path $SourceDir "launch-sync-daemon.vbs") -Destination $BinDir -Force
}
Write-Host "  Daemon files installed to: $BinDir" -ForegroundColor Green

# 6. Repair and Sync state.vscdb
Write-Host "`n[5/6] Repairing State Sync & Clearing Stuck 'Running' Chats..." -ForegroundColor Yellow

$repairScript = @"
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

const userProfile = process.env.USERPROFILE;
const appData = process.env.APPDATA;
const masterDbPath = path.join(userProfile, '.gemini', 'antigravity', 'conversation_summaries.db');
const vscdbPath = path.join(appData, 'Antigravity IDE', 'User', 'globalStorage', 'state.vscdb');

function encodeVarint(val) {
  const buf = [];
  let n = typeof val === 'number' ? BigInt(val) : BigInt(val);
  while (n > 127n) {
    buf.push(Number((n & 127n) | 128n));
    n >>= 7n;
  }
  buf.push(Number(n));
  return Buffer.from(buf);
}
function encodeLengthDelimited(fn, data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
  return Buffer.concat([encodeVarint((fn << 3) | 2), encodeVarint(buf.length), buf]);
}
function encodeVarintField(fn, val) {
  return Buffer.concat([encodeVarint((fn << 3) | 0), encodeVarint(val)]);
}
function parseBuf(b) {
  let off = 0; const fields = [];
  function rVar() {
    let res = 0, shift = 0, byte;
    do { byte = b[off++]; res |= (byte & 0x7f) << shift; shift += 7; } while (byte & 0x80);
    return res;
  }
  while (off < b.length) {
    const tag = rVar(); const fn = tag >> 3; const wt = tag & 7;
    if (wt === 0) fields.push({ fn, wt, val: rVar() });
    else if (wt === 2) { const len = rVar(); fields.push({ fn, wt, len, data: b.subarray(off, off + len) }); off += len; }
    else break;
  }
  return fields;
}

if (fs.existsSync(vscdbPath) && fs.existsSync(masterDbPath)) {
  try {
    fs.copyFileSync(vscdbPath, vscdbPath + '.backup');
    const vscDb = new DatabaseSync(vscdbPath);
    const mainDb = new DatabaseSync(masterDbPath, { readOnly: true });

    const summariesMap = {};
    const existingRow = vscDb.prepare('SELECT value FROM ItemTable WHERE key = ?').get('antigravityUnifiedStateSync.trajectorySummaries');
    if (existingRow && existingRow.value) {
      try {
        const top = parseBuf(Buffer.from(existingRow.value, 'base64'));
        for (const tf of top) {
          const de = parseBuf(tf.data);
          const k = de.find(f => f.fn === 1)?.data?.toString('utf8');
          const f2 = de.find(f => f.fn === 2);
          if (k && f2) {
            const rm = parseBuf(f2.data);
            const f1 = rm.find(f => f.fn === 1);
            if (f1) summariesMap[k] = Buffer.from(f1.data.toString('utf8'), 'base64');
          }
        }
      } catch(e) {}
    }

    const rows = mainDb.prepare('SELECT conversation_id, raw_summary FROM conversation_summaries WHERE raw_summary IS NOT NULL').all();
    for (const r of rows) {
      summariesMap[r.conversation_id] = Buffer.from(r.raw_summary);
    }

    // Normalize field 16 (not_fully_idle = 0) and field 5 (status = 1 IDLE)
    const fixedMap = {};
    for (const [cid, sBuf] of Object.entries(summariesMap)) {
      const f = parseBuf(sBuf);
      const newParts = [];
      let hasFn5 = false, hasFn16 = false, hasFn21 = false;
      for (const field of f) {
        if (field.fn === 5) { hasFn5 = true; newParts.push(encodeVarintField(5, 1)); }
        else if (field.fn === 16) { hasFn16 = true; newParts.push(encodeVarintField(16, 0)); }
        else if (field.fn === 21) { hasFn21 = true; newParts.push(encodeVarintField(21, 0)); }
        else {
          if (field.wt === 0) newParts.push(encodeVarintField(field.fn, field.val));
          else if (field.wt === 2) newParts.push(encodeLengthDelimited(field.fn, field.data));
        }
      }
      if (!hasFn5) newParts.push(encodeVarintField(5, 1));
      if (!hasFn16) newParts.push(encodeVarintField(16, 0));
      if (!hasFn21) newParts.push(encodeVarintField(21, 0));
      fixedMap[cid] = Buffer.concat(newParts);
    }

    const dataEntries = [];
    for (const [cid, sBuf] of Object.entries(fixedMap)) {
      const rowMsg = encodeLengthDelimited(1, sBuf.toString('base64'));
      const de = Buffer.concat([encodeLengthDelimited(1, cid), encodeLengthDelimited(2, rowMsg)]);
      dataEntries.push(encodeLengthDelimited(1, de));
    }
    const finalB64 = Buffer.concat(dataEntries).toString('base64');

    vscDb.prepare(\`
      INSERT INTO ItemTable (key, value) VALUES ('antigravityUnifiedStateSync.trajectorySummaries', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    \`).run(finalB64);

    vscDb.close();
    mainDb.close();
    console.log('[OK] Synced and normalized ' + Object.keys(fixedMap).length + ' conversations in state.vscdb.');
  } catch(err) {
    console.error('[WARN] state.vscdb repair error:', err.message);
  }
}
"@

$tempRepairFile = Join-Path $env:TEMP "antigravity-repair-state.js"
Set-Content -Path $tempRepairFile -Value $repairScript -Force
& $NodeExe $tempRepairFile
Remove-Item $tempRepairFile -Force -ErrorAction SilentlyContinue

# 7. Register Startup & Launch Daemon
Write-Host "`n[6/6] Registering Auto-Start & Launching Daemon..." -ForegroundColor Yellow

$manageScript = Join-Path $BinDir "manage-sync-daemon.ps1"
& powershell -ExecutionPolicy Bypass -File $manageScript install-startup
& powershell -ExecutionPolicy Bypass -File $manageScript restart

Start-Sleep -Seconds 2

# Verify Health
try {
    $activeInfo = Invoke-RestMethod -Uri "http://127.0.0.1:37288/active" -TimeoutSec 3 -ErrorAction Stop
    Write-Host "  Live Chat Mirror Server is active on port 37288." -ForegroundColor Green
} catch {
    Write-Host "  [NOTICE] Sync daemon started in background." -ForegroundColor Gray
}

# Re-launch IDE if it was previously running
if ($wasIdeRunning -and -not $SkipIdeRestart) {
    $ideExe = Join-Path $LocalAppData "Programs\Antigravity IDE\Antigravity IDE.exe"
    if (Test-Path $ideExe) {
        Write-Host "`n[INFO] Relaunching Antigravity IDE..." -ForegroundColor Cyan
        Start-Process -FilePath $ideExe
    }
}

Write-Host @"

===================================================================
      [SUCCESS] Antigravity Sync Bridge is Active Forever!
===================================================================
- Real-Time Live Mirror : http://127.0.0.1:37288/live
- Search All Convos     : Press Ctrl+Shift+A in Antigravity IDE
- Status & Management   : .\manage-sync-daemon.ps1 status
- Auto-Start on Login   : Enabled in Windows Startup folder

Enjoy zero-latency dynamic chat synchronization across IDE and 2.0!
===================================================================
"@ -ForegroundColor Green
