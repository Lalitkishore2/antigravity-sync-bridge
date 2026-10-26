<div align="center">

# ⚡ Antigravity Sync Bridge

**Zero-latency dynamic bidirectional synchronization & live chat mirror between Antigravity IDE & Antigravity 2.0.**

[![Platform: Windows](https://img.shields.io/badge/Platform-Windows%2010%20%7C%2011-blue.svg)](https://github.com/Lalitkishore2/antigravity-sync-bridge)
[![Node.js: 22+](https://img.shields.io/badge/Node.js-22%2B%20(Built--in%20SQLite)-green.svg)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-purple.svg)](./LICENSE)
[![Zero-Dependencies](https://img.shields.io/badge/Dependencies-Zero%20(Native)-brightgreen.svg)](#features)

</div>

---

## 🚀 1-Line Quick Install ("Link Forever")

Open **PowerShell** (Run as normal user or Administrator) and run:

```powershell
irm https://raw.githubusercontent.com/Lalitkishore2/antigravity-sync-bridge/main/install.ps1 | iex
```

> **For headless / automated scripts (No prompts):**
> ```powershell
> & ([scriptblock]::Create((irm https://raw.githubusercontent.com/Lalitkishore2/antigravity-sync-bridge/main/install.ps1))) -Silent -Force
> ```

---

## 🎯 What Problems Does This Solve?

1. **Current / Recent Chats Missing in Antigravity IDE**:
   - In Antigravity IDE, pressing `Ctrl + Shift + A` ("Search all convos...") only searches conversations recorded in VS Code's Unified State Sync (`state.vscdb`). Chats created in Antigravity 2.0 or CLI did not appear in the IDE.
   - **Fix**: The sync bridge automatically injects all conversations with proper metadata and workspace links into `state.vscdb` continuously.

2. **Dozens of Conversations Stuck in "Running"**:
   - In Antigravity IDE's picker, completed historical conversations are often falsely labeled as **"Running"** because Protobuf wire field 16 (`not_fully_idle`) is left set to `1`.
   - **Fix**: Normalizes field 16 to `0` and field 5 to `1` (IDLE) for all finished sessions, instantly placing them under **"Recent"**.

3. **Separate Storage & Data Duplication**:
   - Antigravity IDE and 2.0 store conversations in different directories (`~/.gemini/antigravity-ide` vs `~/.gemini/antigravity`).
   - **Fix**: Transparent **NTFS Directory Junctions** (`mklink /J`) consolidate all trajectory databases and brain directories to unified storage with 0ms disk latency and zero duplication.

4. **Dynamic Concurrent Multi-Instance Chats**:
   - Both Antigravity IDE and Antigravity 2.0 can write, append, and continue chats simultaneously with SQLite WAL (Write-Ahead Logging) concurrency protection.
   - Live steps and thoughts stream in real-time to an embedded web dashboard at **`http://127.0.0.1:37288/live`**.

---

## 🏗️ Architecture

```
                       ┌────────────────────────────────────────┐
                       │    Antigravity IDE & 2.0 Instances     │
                       │  - Either instance runs prompts        │
                       │  - Steps stream into transcript.jsonl  │
                       └──────────────────┬─────────────────────┘
                                          │ (Live File Appends)
                                          ▼
                       ┌────────────────────────────────────────┐
                       │       Unified Storage (Junctions)      │
                       │   ~/.gemini/antigravity/conversations  │
                       │   ~/.gemini/antigravity/brain          │
                       └──────────────────┬─────────────────────┘
                                          │
                            High-Frequency File Watchers
                                          ▼
                       ┌────────────────────────────────────────┐
                       │    Antigravity Sync Daemon (v2.0)      │
                       │  - Watches SQLite DBs & transcript     │
                       │  - Updates conversation_summaries.db   │
                       │  - Re-encodes agyhub_summaries_proto   │
                       │  - Injects state.vscdb Unified State   │
                       │  - Embedded Live Mirror Server (37288) │
                       └──────────────────┬─────────────────────┘
                                          │
                    ┌─────────────────────┴─────────────────────┐
                    ▼                                           ▼
┌──────────────────────────────────────┐   ┌──────────────────────────────────────┐
│        Antigravity 2.0 (App)         │   │     Antigravity IDE (VS Code)        │
│ - Reads conversation_summaries.db    │   │ - Reads state.vscdb                  │
│ - Reads agyhub_summaries_proto.pb    │   │ - "Search all convos..." (Ctrl+Sh+A) │
│ - Categorizes projects & sessions    │   │ - Completed chats in "Recent"        │
│ - Real-time execution tracking       │   │ - Live Chat Mirror in Simple Browser │
└──────────────────────────────────────┘   └──────────────────────────────────────┘
```

---

## 🔍 Technical Deep-Dive

### The `state.vscdb` Unified State Sync Storage

Antigravity IDE is built on a custom VS Code / Electron fork. The conversation picker (`Ctrl+Shift+A`, handled by `S3u` in `workbench.desktop.main.js`) does **not** read SQLite `conversation_summaries.db`. Instead, it reads exclusively from:

`%APPDATA%\Antigravity IDE\User\globalStorage\state.vscdb`

under the key:
`antigravityUnifiedStateSync.trajectorySummaries`

### Protobuf Wire Format & The "Running" Bug

The value stored in `state.vscdb` is a Base64-encoded Protobuf topic containing nested `CascadeTrajectorySummary` messages:

| Wire Field | Type | Description |
|:---:|:---:|:---|
| **Field 1** | String | Conversation Title / Summary |
| **Field 2** | Varint | Step Count |
| **Field 3** | Message | Timestamp (seconds + nanos) |
| **Field 4** | String | Trajectory UUID |
| **Field 5** | Varint | Status (`1` = `IDLE`, `2` = `RUNNING`) |
| **Field 7** | Message | Created At Timestamp |
| **Field 9** | Message | Workspace URI & Git Branch |
| **Field 16**| Varint | **`not_fully_idle`** (`0` = Show under "Recent", `1` = Show under "Running") |
| **Field 21**| Varint | Secondary run state flag |

> **Why chats were stuck under "Running":** If a conversation is created or synced with field 16 set to `1`, the IDE UI permanently categorizes it as active/running. The sync daemon intercepts and normalizes field 16 to `0` for all completed sessions.

### In-Memory Storage Cache Invalidation

Electron's `IStorageMainService` caches `state.vscdb` in memory. If `state.vscdb` is modified while `Antigravity IDE.exe` is running, Electron overwrites the file on process exit. The installer safely detects running processes and flushes changes cleanly.

---

## 🛠️ CLI Management

A PowerShell management utility is deployed to `~/.gemini/bin/manage-sync-daemon.ps1`:

```powershell
# Check real-time daemon status, memory, and recent sync activity
.\manage-sync-daemon.ps1 status

# Manually trigger immediate full synchronization across all databases
.\manage-sync-daemon.ps1 sync-all

# Stop the daemon
.\manage-sync-daemon.ps1 stop

# Start the daemon
.\manage-sync-daemon.ps1 start

# Restart the daemon
.\manage-sync-daemon.ps1 restart
```

---

## 🌐 Live Chat Mirror (`http://127.0.0.1:37288/live`)

The background daemon includes an embedded, high-performance HTTP & Server-Sent Events (SSE) server:

- **Web Dashboard**: Open `http://127.0.0.1:37288/live` in any browser or directly in Antigravity IDE (`Ctrl+Shift+P` ➔ `Simple Browser: Show` ➔ `http://127.0.0.1:37288/live`).
- **Live SSE Stream**: Connect to `http://127.0.0.1:37288/events` for real-time tool execution logs, agent thoughts, and status transitions.
- **Active Status API**: `GET http://127.0.0.1:37288/active` returns JSON describing the currently executing conversation.

---

## 🧹 Uninstallation

To cleanly stop the daemon and remove startup persistence:

```powershell
powershell -ExecutionPolicy Bypass -File .\uninstall.ps1
```

Or with junctions preserved:
```powershell
powershell -ExecutionPolicy Bypass -File .\uninstall.ps1 -KeepJunctions
```

---

## 📄 License

MIT License &copy; 2026 [Lalit Kishore](https://github.com/Lalitkishore2).
