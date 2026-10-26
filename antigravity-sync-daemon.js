/**
 * Antigravity Real-Time Synchronization Daemon & Live Chat Mirror Server
 * Bridges Antigravity IDE and Antigravity 2.0 with zero latency.
 * 
 * - Monitors trajectory databases & session logs in real time
 * - Detects active executions (RUNNING / IDLE) across both environments
 * - Synchronizes SQLite conversation_summaries.db & agyhub_summaries_proto.pb
 * - Synchronizes VS Code's Unified State Sync in state.vscdb
 * - Normalizes field 16 (not_fully_idle = 0) so completed chats appear in "Recent"
 * - Serves a real-time Live Chat Mirror at http://127.0.0.1:37288/live
 * - Provides Server-Sent Events (SSE) for streaming steps & thoughts
 * 
 * Zero external dependencies: Uses built-in node:sqlite, node:crypto, node:http, node:fs
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const USERPROFILE = process.env.USERPROFILE || 'C:\\Users\\Default';
const APPDATA = process.env.APPDATA || path.join(USERPROFILE, 'AppData', 'Roaming');

const BASE_DIR = path.join(USERPROFILE, '.gemini', 'antigravity');
const CONV_DIR = path.join(BASE_DIR, 'conversations');
const BRAIN_DIR = path.join(BASE_DIR, 'brain');
const DB_PATH = path.join(BASE_DIR, 'conversation_summaries.db');
const PROTO_PATH = path.join(BASE_DIR, 'agyhub_summaries_proto.pb');
const VSCDB_PATH = path.join(APPDATA, 'Antigravity IDE', 'User', 'globalStorage', 'state.vscdb');
const APP_STORAGE_PATH = path.join(APPDATA, 'antigravity', 'app_storage.json');
const LOG_DIR = path.join(USERPROFILE, '.gemini', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'sync-daemon.log');
const PID_FILE = path.join(LOG_DIR, 'sync-daemon.pid');
const PORT = 37288;

if (!fs.existsSync(LOG_DIR)) {
  try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch(e) {}
}

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    fs.appendFileSync(LOG_FILE, line, 'utf8');
  } catch(e) {}
  try {
    if (process.stdout && process.stdout.isTTY) {
      process.stdout.write(line);
    }
  } catch(e) {}
}

// Canonical Projects mapping
const CANONICAL_PROJECTS = [
  { id: '1668e1a8-c513-4bf6-9043-98285517fa42', name: 'AquaDot', pattern: /aquado|aqua.*dot/i },
  { id: '52c502b4-dae3-44f3-bcf7-0bc31b51e508', name: 'LADA AI', pattern: /lada.*ai|lada/i },
  { id: '5a4d1b82-6294-4d83-9bc7-5c2f0f46f497', name: 'Lively Hopper (Antigravity Workspace)', pattern: /lively.*hopper|livelyhopper/i },
  { id: '5c0e181b-53c8-47bc-ad9f-c68e14620577', name: 'PortFolio', pattern: /portfolio/i },
  { id: '653d6ca0-c3df-4c58-b470-9b4461893f9a', name: 'Web Dev & Portfolio Suite', pattern: /web.*dev|suite/i },
  { id: '7bf3a201-4be5-4de9-af43-305f88fc009a', name: 'Core Infrastructure', pattern: /infra|core/i }
];

function resolveProject(workspaceUri, textContent) {
  const combined = (workspaceUri || '') + ' ' + (textContent || '');
  for (const p of CANONICAL_PROJECTS) {
    if (p.pattern.test(combined)) {
      return { id: p.id, name: p.name, uri: workspaceUri };
    }
  }

  if (workspaceUri) {
    const rawPath = decodeURIComponent(workspaceUri.replace('file:///', ''));
    const parts = rawPath.split(/[\\/]/).filter(Boolean);
    const folderName = parts.length > 0 ? parts[parts.length - 1] : 'Workspace';
    const hash = crypto.createHash('md5').update(workspaceUri).digest('hex');
    const pseudoUuid = `${hash.slice(0,8)}-${hash.slice(8,12)}-4${hash.slice(13,16)}-a${hash.slice(17,20)}-${hash.slice(20,32)}`;
    return {
      id: pseudoUuid,
      name: folderName.charAt(0).toUpperCase() + folderName.slice(1),
      uri: workspaceUri
    };
  }

  return {
    id: '5a4d1b82-6294-4d83-9bc7-5c2f0f46f497',
    name: 'Lively Hopper (Antigravity Workspace)',
    uri: 'file:///c:/Users/LALITKO/Documents/antigravity/lively-hopper'
  };
}

// Protobuf Helper Functions
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

function encodeLengthDelimited(fieldNum, data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
  const tag = encodeVarint((fieldNum << 3) | 2);
  const len = encodeVarint(buf.length);
  return Buffer.concat([tag, len, buf]);
}

function encodeVarintField(fieldNum, val) {
  const tag = encodeVarint((fieldNum << 3) | 0);
  const valBuf = encodeVarint(val);
  return Buffer.concat([tag, valBuf]);
}

function encodeTimestamp(fieldNum, isoDateStr) {
  const date = isoDateStr ? new Date(isoDateStr) : new Date();
  const seconds = Math.floor(date.getTime() / 1000);
  const nanos = (date.getTime() % 1000) * 1000000;
  const innerSec = encodeVarintField(1, seconds);
  const innerNanos = encodeVarintField(2, nanos);
  const innerBuf = Buffer.concat([innerSec, innerNanos]);
  return encodeLengthDelimited(fieldNum, innerBuf);
}

function parseBuf(b) {
  let offset = 0;
  const fields = [];
  function readVarint() {
    let res = 0, shift = 0, byte;
    do {
      byte = b[offset++];
      res |= (byte & 0x7f) << shift;
      shift += 7;
    } while (byte & 0x80);
    return res;
  }
  while (offset < b.length) {
    const tag = readVarint();
    const fn = tag >> 3;
    const wt = tag & 7;
    if (wt === 0) {
      fields.push({ fn, wt, val: readVarint() });
    } else if (wt === 2) {
      const len = readVarint();
      const data = b.subarray(offset, offset + len);
      offset += len;
      fields.push({ fn, wt, len, data });
    } else {
      break;
    }
  }
  return fields;
}

function patchSummaryProtobuf(rawBuf, isRunning) {
  const fields = parseBuf(rawBuf);
  const newParts = [];
  let hasFn5 = false;
  let hasFn16 = false;
  let hasFn21 = false;

  for (const f of fields) {
    if (f.fn === 5) {
      hasFn5 = true;
      newParts.push(encodeVarintField(5, isRunning ? 2 : 1));
    } else if (f.fn === 16) {
      hasFn16 = true;
      newParts.push(encodeVarintField(16, isRunning ? 1 : 0));
    } else if (f.fn === 21) {
      hasFn21 = true;
      newParts.push(encodeVarintField(21, isRunning ? 1 : 0));
    } else {
      if (f.wt === 0) {
        newParts.push(encodeVarintField(f.fn, f.val));
      } else if (f.wt === 2) {
        newParts.push(encodeLengthDelimited(f.fn, f.data));
      }
    }
  }

  if (!hasFn5) newParts.push(encodeVarintField(5, isRunning ? 2 : 1));
  if (!hasFn16) newParts.push(encodeVarintField(16, isRunning ? 1 : 0));
  if (!hasFn21) newParts.push(encodeVarintField(21, isRunning ? 1 : 0));

  return Buffer.concat(newParts);
}

function buildTopicProto(summariesMap) {
  const dataEntries = [];
  for (const [convId, summaryBuf] of Object.entries(summariesMap)) {
    const summaryBase64 = Buffer.isBuffer(summaryBuf)
      ? summaryBuf.toString('base64')
      : Buffer.from(summaryBuf).toString('base64');
    const rowMsg = encodeLengthDelimited(1, summaryBase64);
    const dataEntry = Buffer.concat([
      encodeLengthDelimited(1, convId),
      encodeLengthDelimited(2, rowMsg)
    ]);
    dataEntries.push(encodeLengthDelimited(1, dataEntry));
  }
  return Buffer.concat(dataEntries);
}

function syncToStateVscdb(mainDb) {
  if (!fs.existsSync(VSCDB_PATH)) return;
  let vscDb;
  try {
    vscDb = new DatabaseSync(VSCDB_PATH);
    vscDb.exec('PRAGMA busy_timeout = 3000;');

    const summariesMap = {};
    const existingRow = vscDb.prepare('SELECT value FROM ItemTable WHERE key = ?').get('antigravityUnifiedStateSync.trajectorySummaries');
    if (existingRow && existingRow.value) {
      try {
        const existingBuf = Buffer.from(existingRow.value, 'base64');
        const topicFields = parseBuf(existingBuf);
        for (const tf of topicFields) {
          const dataEntry = parseBuf(tf.data);
          const key = dataEntry.find(f => f.fn === 1)?.data?.toString('utf8');
          const f2 = dataEntry.find(f => f.fn === 2);
          if (key && f2) {
            const rowMsg = parseBuf(f2.data);
            const f1InRow = rowMsg.find(f => f.fn === 1);
            if (f1InRow) {
              const b64 = f1InRow.data.toString('utf8');
              summariesMap[key] = patchSummaryProtobuf(Buffer.from(b64, 'base64'), false);
            }
          }
        }
      } catch(e) {}
    }

    const rows = mainDb.prepare('SELECT conversation_id, raw_summary, status, not_fully_idle FROM conversation_summaries WHERE raw_summary IS NOT NULL').all();
    for (const r of rows) {
      const isRunning = (r.status === 'RUNNING' || r.status === 'CASCADE_RUN_STATUS_RUNNING' || r.not_fully_idle === 1);
      summariesMap[r.conversation_id] = patchSummaryProtobuf(Buffer.from(r.raw_summary), isRunning);
    }

    const topicProto = buildTopicProto(summariesMap);
    const base64Value = topicProto.toString('base64');

    vscDb.prepare(`
      INSERT INTO ItemTable (key, value) VALUES ('antigravityUnifiedStateSync.trajectorySummaries', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(base64Value);

    vscDb.close();
  } catch(err) {
    log(`[WARN] state.vscdb sync failed: ${err.message}`);
    if (vscDb) {
      try { vscDb.close(); } catch(e) {}
    }
  }
}

function encodeSummary(opts) {
  const parts = [];
  parts.push(encodeLengthDelimited(1, opts.title || 'Conversation'));
  parts.push(encodeVarintField(2, opts.stepCount || 1));
  parts.push(encodeTimestamp(3, opts.modifiedAt));
  parts.push(encodeLengthDelimited(4, opts.trajectoryId));
  parts.push(encodeVarintField(5, opts.isRunning ? 2 : 1));
  parts.push(encodeTimestamp(7, opts.createdAt));

  if (opts.workspaceUri) {
    const wsUriEncoded = encodeLengthDelimited(1, opts.workspaceUri);
    const wsBranchEncoded = encodeLengthDelimited(4, 'master');
    const wsBlock = Buffer.concat([wsUriEncoded, wsUriEncoded, wsBranchEncoded]);
    parts.push(encodeLengthDelimited(9, wsBlock));
  }

  parts.push(encodeTimestamp(10, opts.modifiedAt));
  if (opts.preview) {
    parts.push(encodeLengthDelimited(15, opts.preview));
  }

  parts.push(encodeVarintField(16, opts.isRunning ? 1 : 0));
  parts.push(encodeVarintField(21, opts.isRunning ? 1 : 0));
  parts.push(encodeVarintField(22, 4));

  return Buffer.concat(parts);
}

function reSerializeProto(db) {
  const rows = db.prepare('SELECT conversation_id, raw_summary FROM conversation_summaries WHERE raw_summary IS NOT NULL').all();
  const parts = [];
  for (const r of rows) {
    const convIdBuf = Buffer.from(r.conversation_id, 'utf8');
    const summaryBuf = Buffer.from(r.raw_summary);
    const inner = Buffer.concat([
      encodeLengthDelimited(1, convIdBuf),
      encodeLengthDelimited(2, summaryBuf)
    ]);
    parts.push(encodeLengthDelimited(1, inner));
  }
  const finalBuf = Buffer.concat(parts);
  fs.writeFileSync(PROTO_PATH, finalBuf);
}

// Active Execution State
let activeConversationId = null;
let activeExecutionStatus = 'IDLE';
let activeStepPreview = '';
const sseClients = new Set();

function broadcastSSE(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(payload);
    } catch(e) {
      sseClients.delete(client);
    }
  }
}

// Conversation Synchronizer
function syncConversation(convId, isExplicitRunning = false) {
  if (convId.includes('.db-') || convId.endsWith('.tmp')) return;

  const dbFile = path.join(CONV_DIR, convId + '.db');
  const brainDir = path.join(BRAIN_DIR, convId);
  const transcriptPath = path.join(brainDir, '.system_generated', 'logs', 'transcript.jsonl');

  let title = '';
  let preview = '';
  let stepCount = 0;
  let createdAt = null;
  let modifiedAt = null;
  let workspaceUri = '';
  let touchedText = '';
  let lastStep = null;
  let isRunning = isExplicitRunning;

  if (fs.existsSync(transcriptPath)) {
    try {
      const stat = fs.statSync(transcriptPath);
      modifiedAt = stat.mtime.toISOString();
      const content = fs.readFileSync(transcriptPath, 'utf8');
      const lines = content.split('\n').filter(l => l.trim().length > 0);
      stepCount = lines.length;
      if (lines.length > 0) {
        try {
          const firstStep = JSON.parse(lines[0]);
          if (firstStep.created_at) createdAt = firstStep.created_at;
          if (firstStep.content) {
            const m = firstStep.content.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
            if (m) {
              preview = m[1].trim().replace(/\r?\n/g, ' ').slice(0, 150);
              title = preview.slice(0, 60);
            }
          }
        } catch(e) {}

        try {
          lastStep = JSON.parse(lines[lines.length - 1]);
          if (lastStep.status === 'RUNNING') {
            isRunning = true;
          } else {
            isRunning = false;
          }
        } catch(e) {}
      }
      touchedText = content.slice(0, 10000);
    } catch(e) {}
  }

  if (fs.existsSync(dbFile)) {
    try {
      const convDb = new DatabaseSync(dbFile, { readOnly: true });
      const row = convDb.prepare("SELECT data FROM trajectory_metadata_blob WHERE id='main'").get();
      if (row && row.data) {
        const str = Buffer.from(row.data).toString('utf8');
        const m = str.match(/file:\/\/\/[a-zA-Z]:[^\s\x00-\x1f\"'\<\>]+/);
        if (m) {
          workspaceUri = m[0].replace(/[\x00-\x1f\x7f-\xff].*$/, '');
        }
      }
      convDb.close();
    } catch(e) {}
  }

  if (!modifiedAt) modifiedAt = new Date().toISOString();
  if (!createdAt) createdAt = modifiedAt;
  if (!title) title = 'Conversation ' + convId.slice(0, 8);
  if (!preview) preview = title;

  const project = resolveProject(workspaceUri, touchedText);
  const chosenUri = project.uri || workspaceUri || 'file:///c:/Users/LALITKO/Desktop/projects';

  activeConversationId = convId;
  activeExecutionStatus = isRunning ? 'RUNNING' : 'IDLE';
  activeStepPreview = preview;

  const summaryBlob = encodeSummary({
    title,
    preview,
    stepCount: Math.max(stepCount, 1),
    modifiedAt,
    createdAt,
    trajectoryId: convId,
    workspaceUri: chosenUri,
    isRunning
  });

  let mainDb;
  try {
    mainDb = new DatabaseSync(DB_PATH);
    mainDb.exec('PRAGMA journal_mode = WAL;');
    mainDb.exec('PRAGMA busy_timeout = 5000;');

    const wsJson = JSON.stringify([chosenUri]);
    const existing = mainDb.prepare('SELECT conversation_id, title FROM conversation_summaries WHERE conversation_id = ?').get(convId);
    const statusStr = isRunning ? 'RUNNING' : 'IDLE';
    const notFullyIdle = isRunning ? 1 : 0;
    
    // Preserve custom title if existing
    const finalTitle = (existing && existing.title && !existing.title.startsWith('Conversation ')) ? existing.title : title;

    if (existing) {
      mainDb.prepare(`
        UPDATE conversation_summaries 
        SET project_id = ?, workspace_uris = ?, title = ?, preview = ?, step_count = ?, last_modified_time = ?, status = ?, not_fully_idle = ?, raw_summary = ? 
        WHERE conversation_id = ?
      `).run(project.id, wsJson, finalTitle, preview, Math.max(stepCount, 1), modifiedAt, statusStr, notFullyIdle, summaryBlob, convId);
    } else {
      mainDb.prepare(`
        INSERT INTO conversation_summaries 
        (conversation_id, project_id, workspace_uris, title, preview, step_count, last_modified_time, last_user_input_time, status, not_fully_idle, raw_summary)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(convId, project.id, wsJson, finalTitle, preview, Math.max(stepCount, 1), modifiedAt, createdAt, statusStr, notFullyIdle, summaryBlob);
    }

    const ftsCheck = mainDb.prepare('SELECT count(*) as c FROM conversations_fts WHERE conversation_id = ?').get(convId);
    if (ftsCheck.c > 0) {
      mainDb.prepare('UPDATE conversations_fts SET title = ?, workspace = ?, project = ? WHERE conversation_id = ?')
        .run(finalTitle, chosenUri, project.name, convId);
    } else {
      mainDb.prepare(`
        INSERT INTO conversations_fts 
        (conversation_id, chunk_index, chunk_first_step, chunk_last_step, last_modified_time, step_count, last_step_created_at, archived, user_step_byte_offsets, agent_step_byte_offsets, title, workspace, project, user_body, agent_body)
        VALUES (?, 0, 0, 1, ?, ?, ?, 0, '', '', ?, ?, ?, ?, '')
      `).run(convId, modifiedAt, Math.max(stepCount, 1), modifiedAt, finalTitle, chosenUri, project.name, preview);
    }

    mainDb.prepare("DELETE FROM conversation_summaries WHERE conversation_id LIKE '%.db-%'").run();
    mainDb.prepare("DELETE FROM conversations_fts WHERE conversation_id LIKE '%.db-%'").run();

    reSerializeProto(mainDb);
    syncToStateVscdb(mainDb);
    mainDb.close();

    log(`[${statusStr}] ${convId.slice(0, 8)} -> [${project.name}] ("${finalTitle.slice(0, 40)}")`);

    broadcastSSE('sync', {
      convId,
      projectName: project.name,
      status: statusStr,
      stepCount,
      title: finalTitle,
      preview,
      lastStep
    });

  } catch(err) {
    log(`[ERROR] Sync failed for ${convId}: ${err.message}`);
    if (mainDb) {
      try { mainDb.close(); } catch(e) {}
    }
  }
}

// Watchers
const debounceTimers = new Map();
function onConvFileEvent(eventType, filename) {
  if (!filename) return;
  const match = filename.match(/^([0-9a-fA-F-]{36})\.db$/);
  if (!match) return;
  const convId = match[1];

  if (debounceTimers.has(convId)) {
    clearTimeout(debounceTimers.get(convId));
  }

  debounceTimers.set(convId, setTimeout(() => {
    debounceTimers.delete(convId);
    syncConversation(convId);
  }, 300));
}

const transcriptWatchers = new Map();
function watchTranscript(convId, transcriptPath) {
  if (transcriptWatchers.has(convId)) return;
  try {
    const watcher = fs.watch(transcriptPath, { persistent: false }, (evt) => {
      syncConversation(convId, true);
    });
    transcriptWatchers.set(convId, watcher);
  } catch(e) {}
}

function scanActiveTranscripts() {
  if (!fs.existsSync(BRAIN_DIR)) return;
  try {
    const entries = fs.readdirSync(BRAIN_DIR);
    for (const id of entries) {
      if (/^[0-9a-fA-F-]{36}$/.test(id)) {
        const tPath = path.join(BRAIN_DIR, id, '.system_generated', 'logs', 'transcript.jsonl');
        if (fs.existsSync(tPath)) {
          watchTranscript(id, tPath);
        }
      }
    }
  } catch(e) {}
}

// Live Chat Mirror Server
const server = http.createServer((req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);

  if (parsedUrl.pathname === '/live') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Antigravity Live Chat Mirror</title>
  <style>
    :root {
      --bg: #121316;
      --card-bg: #1e2025;
      --text: #e1e3e8;
      --accent: #5e9eff;
      --running: #00e676;
      --idle: #90a4ae;
      --border: #2d3139;
    }
    body {
      margin: 0;
      padding: 20px;
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding-bottom: 16px;
      border-bottom: 1px solid var(--border);
    }
    .status-badge {
      padding: 6px 14px;
      border-radius: 20px;
      font-weight: 600;
      font-size: 0.85rem;
      letter-spacing: 0.5px;
      display: inline-flex;
      align-items: center;
      gap: 8px;
    }
    .status-running {
      background: rgba(0, 230, 118, 0.15);
      color: var(--running);
      border: 1px solid rgba(0, 230, 118, 0.4);
      animation: pulse 1.5s infinite;
    }
    .status-idle {
      background: rgba(144, 164, 174, 0.15);
      color: var(--idle);
      border: 1px solid rgba(144, 164, 174, 0.3);
    }
    @keyframes pulse {
      0% { opacity: 0.7; }
      50% { opacity: 1; }
      100% { opacity: 0.7; }
    }
    .pulse-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: currentColor;
    }
    .card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 16px;
      margin-top: 16px;
    }
    .log-stream {
      font-family: 'Consolas', 'Fira Code', monospace;
      font-size: 0.85rem;
      background: #090a0c;
      padding: 12px;
      border-radius: 6px;
      overflow-y: auto;
      max-height: 480px;
      white-space: pre-wrap;
    }
  </style>
</head>
<body>
  <div class="header">
    <div>
      <h2 style="margin: 0; font-size: 1.4rem;">Antigravity Live Chat Mirror</h2>
      <div style="font-size: 0.85rem; color: #888; margin-top: 4px;">Zero-Latency Sync: IDE &harr; 2.0</div>
    </div>
    <div id="statusBadge" class="status-badge status-idle">
      <span class="pulse-dot"></span>
      <span id="statusText">IDLE</span>
    </div>
  </div>

  <div class="card">
    <div style="font-size: 0.85rem; color: #888;">ACTIVE CONVERSATION</div>
    <h3 id="activeTitle" style="margin: 6px 0 10px 0;">No active execution</h3>
    <div id="activeProject" style="display: inline-block; font-size: 0.8rem; background: #2a2e37; padding: 3px 8px; border-radius: 4px;">Project: -</div>
  </div>

  <div class="card">
    <div style="font-size: 0.85rem; color: #888; margin-bottom: 8px;">LIVE EXECUTION LOGS</div>
    <div id="logStream" class="log-stream">Connecting to sync stream...</div>
  </div>

  <script>
    const evtSource = new EventSource('/events');
    const badge = document.getElementById('statusBadge');
    const statusText = document.getElementById('statusText');
    const titleEl = document.getElementById('activeTitle');
    const projectEl = document.getElementById('activeProject');
    const logsEl = document.getElementById('logStream');

    evtSource.addEventListener('sync', (e) => {
      const data = JSON.parse(e.data);
      titleEl.innerText = data.title;
      projectEl.innerText = 'Project: ' + data.projectName;
      if (data.status === 'RUNNING') {
        badge.className = 'status-badge status-running';
        statusText.innerText = 'RUNNING';
      } else {
        badge.className = 'status-badge status-idle';
        statusText.innerText = 'IDLE';
      }
      const time = new Date().toLocaleTimeString();
      logsEl.innerText = '[' + time + '] ' + data.status + ' - ' + data.title + '\\n' + logsEl.innerText;
    });

    evtSource.onopen = () => {
      logsEl.innerText = '[System] Live stream connected.\\n';
    };
  </script>
</body>
</html>`);
    return;
  }

  if (parsedUrl.pathname === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });
    res.write('event: connected\ndata: {"status": "ok"}\n\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  if (parsedUrl.pathname === '/active') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({
      activeConversationId,
      status: activeExecutionStatus,
      preview: activeStepPreview,
      timestamp: new Date().toISOString()
    }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

server.listen(PORT, '127.0.0.1', () => {
  log(`Live Chat Mirror server listening on http://127.0.0.1:${PORT}/live`);
});

// Initialization
fs.writeFileSync(PID_FILE, String(process.pid), 'utf8');
log(`=== Antigravity Sync Daemon v2.0 started (PID: ${process.pid}) ===`);
log(`Watching ${CONV_DIR} for conversation database updates...`);
log(`Watching active sessions in ${BRAIN_DIR}...`);

// Initial full sync on start
try {
  if (fs.existsSync(DB_PATH)) {
    const initDb = new DatabaseSync(DB_PATH);
    syncToStateVscdb(initDb);
    initDb.close();
    log('Initial state.vscdb sync complete.');
  }
} catch(e) {
  log(`Initial sync warning: ${e.message}`);
}

const convWatcher = fs.watch(CONV_DIR, { persistent: true }, onConvFileEvent);
scanActiveTranscripts();
const scanInterval = setInterval(scanActiveTranscripts, 15000);

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

function shutdown() {
  log('Stopping sync daemon...');
  clearInterval(scanInterval);
  convWatcher.close();
  for (const w of transcriptWatchers.values()) {
    try { w.close(); } catch(e) {}
  }
  server.close();
  try { fs.unlinkSync(PID_FILE); } catch(e) {}
  log('Daemon stopped cleanly.');
  process.exit(0);
}
