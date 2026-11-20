const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { WebSocketServer } = require('ws');

const {
  createRoom,
  getRoom,
  getOrCreateRoom,
  saveRoomState,
  listRecentRooms,
  deleteRoom,
  getRoomPasswordHash,
  setRoomPassword,
  getSessionSecret,
  getRole,
  setRole,
  listRoles,
  hasRole,
  AI_POLICIES,
  createAgent,
  getAgent,
  listAgents,
  deleteAgent,
  touchAgent,
  addMessage,
  listMessages
} = require('./src/db');
const {
  ROOM_SESSION_TTL_MS,
  verifyPassword,
  roomCookieName,
  signRoomToken,
  verifyRoomToken,
  signInviteToken,
  verifyInviteToken,
  parseCookies
} = require('./src/auth');
const { LANGUAGES, DEFAULT_TEMPLATES, PROBLEM_PRESETS, getPresetById } = require('./src/presets');
const { MAX_STAGES, createStage, syncActiveStage, activateStage, getStageState } = require('./src/stages');
const { UPLOADS_DIR, IMAGE_TYPES, saveImage } = require('./src/images');
const { executeCode, executeWorkspace, CONTAINER_RUNTIME, SANDBOX_IMAGE } = require('./src/runner');
const workspaceOps = require('./src/workspace');
const { createRoomMcpHandler, generateAgentToken, verifyAgentToken, MAX_MESSAGE_LENGTH } = require('./src/room-mcp');
const { getVSCodeSession, destroyVSCodeSession } = require('./src/vscode');
const httpProxy = require('http-proxy');
const { createMcpHandler } = require('./src/mcp');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');

const ROLES = ['interviewer', 'interviewee'];

const USER_COLORS = [
  '#38bdf8', // sky
  '#a855f7', // purple
  '#10b981', // emerald
  '#f59e0b', // amber
  '#f43f5e', // rose
  '#ec4899', // pink
  '#6366f1', // indigo
  '#14b8a6'  // teal
];

// Actions that only the interviewer may perform
const INTERVIEWER_ONLY_ACTIONS = new Set([
  'prompt_change',
  'upload_image',
  'load_preset',
  'title_change',
  'reset_template',
  'timer_action',
  'role_change',
  'password_change',
  'stage_add',
  'stage_change',
  'stage_rename',
  'stage_remove',
  'ai_policy_change'
]);

const MAX_AGENTS_PER_ROOM = 10;
const AGENT_ONLINE_MS = 90 * 1000;

// Active rooms in memory: roomId -> { data, clients: Map<ws, clientInfo>, saveTimer, isRunning, timer }
const activeRooms = new Map();

function getActiveRoom(roomId) {
  let entry = activeRooms.get(roomId);
  if (!entry) {
    const data = getOrCreateRoom(roomId);
    entry = {
      data,
      clients: new Map(),
      saveTimer: null,
      isRunning: false,
      agentsOnlineKey: '',
      timer: {
        running: false,
        elapsedMs: 0,
        startedAt: null
      }
    };
    activeRooms.set(roomId, entry);
  }
  return entry;
}

function scheduleRoomSave(entry, immediate = false) {
  if (entry.saveTimer) {
    clearTimeout(entry.saveTimer);
    entry.saveTimer = null;
  }
  if (immediate) {
    try {
      saveRoomState(entry.data);
    } catch (err) {
      console.error('Failed to save room:', err);
    }
    return;
  }
  entry.saveTimer = setTimeout(() => {
    entry.saveTimer = null;
    try {
      saveRoomState(entry.data);
    } catch (err) {
      console.error('Failed to save room:', err);
    }
  }, 400);
}

function getTimerSnapshot(timer) {
  const now = Date.now();
  const currentElapsed = timer.running && timer.startedAt
    ? timer.elapsedMs + (now - timer.startedAt)
    : timer.elapsedMs;
  return {
    running: timer.running,
    elapsedMs: currentElapsed,
    serverNow: now
  };
}

function broadcast(entry, payload, excludeWs = null) {
  const message = JSON.stringify(payload);
  for (const [clientWs] of entry.clients) {
    if (clientWs !== excludeWs && clientWs.readyState === 1) {
      clientWs.send(message);
    }
  }
}

function sendTo(clientWs, payload) {
  if (clientWs && clientWs.readyState === 1) {
    clientWs.send(JSON.stringify(payload));
  }
}

function isInterviewer(info) {
  return info.role === 'interviewer';
}

// Drop an idle room from memory once nobody (browser or waiting agent) uses it.
function scheduleIdleCleanup(roomId) {
  setTimeout(() => {
    const current = activeRooms.get(roomId);
    if (current && current.clients.size === 0 && !current.isRunning && !(messageWaiters.get(roomId)?.size)) {
      scheduleRoomSave(current, true);
      activeRooms.delete(roomId);
    }
  }, 30000);
}

// ---- Chat and room-scoped AI agents ----

// roomId -> Set<(message) => void> for agents blocked in wait_for_messages
const messageWaiters = new Map();
// agentId -> last request time; agents count as online while recently active
const agentLastSeen = new Map();

function postMessage(roomId, message) {
  const saved = addMessage(roomId, message);
  const entry = activeRooms.get(roomId);
  if (entry) broadcast(entry, { type: 'chat_message', message: saved });
  for (const notify of messageWaiters.get(roomId) || []) notify(saved);
  return saved;
}

function aiAllowed(room, role) {
  const policy = room.settings?.aiPolicy || 'interviewer';
  return policy === 'everyone' || (policy === 'interviewer' && role === 'interviewer');
}

function agentsSnapshot(roomId) {
  const now = Date.now();
  return listAgents(roomId).map((agent) => ({
    id: agent.id,
    label: agent.label,
    ownerId: agent.ownerIdentity,
    ownerName: agent.ownerName,
    createdAt: agent.createdAt,
    online: now - Math.max(agent.lastSeenAt, agentLastSeen.get(agent.id) || 0) < AGENT_ONLINE_MS
  }));
}

function broadcastAgents(roomId) {
  const entry = activeRooms.get(roomId);
  if (!entry) return;
  const agents = agentsSnapshot(roomId);
  entry.agentsOnlineKey = agents.filter((agent) => agent.online).map((agent) => agent.id).join(',');
  broadcast(entry, { type: 'agents_updated', agents });
}

function markAgentSeen(agent) {
  const now = Date.now();
  const previous = Math.max(agent.lastSeenAt, agentLastSeen.get(agent.id) || 0);
  agentLastSeen.set(agent.id, now);
  if (now - agent.lastSeenAt > 60000) touchAgent(agent.id, now);
  if (now - previous >= AGENT_ONLINE_MS) broadcastAgents(agent.roomId);
}

// Periodically flip agents to offline in rooms people are watching.
setInterval(() => {
  for (const [roomId, entry] of activeRooms) {
    if (!entry.clients.size) continue;
    const key = agentsSnapshot(roomId).filter((agent) => agent.online).map((agent) => agent.id).join(',');
    if (key !== (entry.agentsOnlineKey || '')) broadcastAgents(roomId);
  }
}, 15000).unref();

// ---- Shared code execution (browser Run button and agents) ----

async function runRoomCode(entry, triggeredBy, { language, stdin } = {}) {
  const room = entry.data;
  if (entry.isRunning) throw new Error('A run is already in progress. Try again when it finishes.');
  if (typeof stdin === 'string') room.stdin = stdin;
  const lang = room.layout === 'workspace'
    ? (workspaceOps.languageForPath(room.workspace?.entryFile || '') || room.language)
    : (LANGUAGES.includes(language) ? language : room.language);
  entry.isRunning = true;
  broadcast(entry, { type: 'run_started', language: lang, triggeredBy, timestamp: Date.now() });
  try {
    const execResult = room.layout === 'workspace'
      ? await executeWorkspace({ workspace: room.workspace, stdin: room.stdin })
      : await executeCode({ language: lang, code: room.codes[lang], stdin: room.stdin });
    const outputRecord = {
      ...execResult,
      entryFile: room.layout === 'workspace' ? room.workspace?.entryFile : undefined,
      triggeredBy,
      timestamp: Date.now()
    };
    room.lastOutput = outputRecord;
    scheduleRoomSave(entry, true);
    broadcast(entry, { type: 'run_finished', result: outputRecord });
    return outputRecord;
  } finally {
    entry.isRunning = false;
  }
}

// ---- Workspace helpers ----

function workspaceTree(workspace) {
  return { paths: Object.keys(workspace.files).sort(), folders: workspace.folders, entryFile: workspace.entryFile };
}

function setStageWorkspace(room, stage, workspace) {
  stage.workspace = workspace;
  if (stage.id === room.activeStageId) room.workspace = workspace;
}

// Applies a structural workspace operation to the active stage and broadcasts it.
function applyWorkspaceOp(entry, { op, path: rawPath, to, content = '' }, sender) {
  const room = entry.data;
  const stage = room.stages.find((item) => item.id === room.activeStageId);
  if (room.layout !== 'workspace' || !stage) throw new Error('This room has no file workspace.');
  syncActiveStage(room);
  let result;
  const event = { op, created: {}, moved: [], removed: [] };
  if (op === 'create_file') {
    result = workspaceOps.createFile(stage.workspace, rawPath, content);
    event.path = result.path;
    event.created[result.path] = content;
  } else if (op === 'create_folder') {
    result = workspaceOps.createFolder(stage.workspace, rawPath);
    event.path = result.path;
  } else if (op === 'delete') {
    result = workspaceOps.deletePath(stage.workspace, rawPath);
    event.path = result.path;
    event.removed = result.removed;
  } else if (op === 'rename') {
    result = workspaceOps.renamePath(stage.workspace, rawPath, to);
    event.path = result.from;
    event.to = result.to;
    event.moved = result.moved;
  } else if (op === 'set_entry') {
    result = workspaceOps.setEntryFile(stage.workspace, rawPath);
    event.path = result.path;
  } else {
    throw new Error('Unknown file operation.');
  }
  setStageWorkspace(room, stage, result.workspace);
  scheduleRoomSave(entry, true);
  broadcast(entry, {
    type: 'workspace_op', stageId: stage.id, ...event, tree: workspaceTree(result.workspace),
    senderId: sender.id, senderName: sender.name
  });
  return event;
}

function writeWorkspaceFile(entry, filePath, content, sender) {
  const room = entry.data;
  const exists = Object.hasOwn(room.workspace?.files || {}, workspaceOps.normalizePath(filePath));
  if (!exists) return applyWorkspaceOp(entry, { op: 'create_file', path: filePath, content }, sender);
  const stage = room.stages.find((item) => item.id === room.activeStageId);
  const result = workspaceOps.writeFile(room.workspace, filePath, content);
  setStageWorkspace(room, stage, result.workspace);
  scheduleRoomSave(entry, true);
  broadcast(entry, {
    type: 'file_update', stageId: stage.id, path: result.path, content, force: true,
    senderId: sender.id, senderName: sender.name
  });
  return { op: 'write', path: result.path };
}

function truncate(text, max = 4000) {
  const value = String(text || '');
  return value.length > max ? `${value.slice(0, max)}\n[truncated ${value.length - max} characters]` : value;
}

// Per-request agent session used by the room MCP tools.
function createAgentSession(agent) {
  const roomId = agent.roomId;
  const entry = getActiveRoom(roomId);
  const room = entry.data;
  const sender = { id: `agent:${agent.id}`, name: agent.label };
  const ownerRole = () => (getRole(roomId, agent.ownerIdentity) || {}).role || 'interviewee';
  const activity = (text) => postMessage(roomId, { kind: 'activity', authorId: agent.id, authorName: agent.label, text });
  const activeStage = () => room.stages.find((item) => item.id === room.activeStageId);
  if (!entry.clients.size) scheduleIdleCleanup(roomId);

  function others(messages) {
    return messages.filter((message) => message.authorId !== agent.id && message.kind !== 'activity');
  }

  return {
    layout: room.layout,
    ownerRole,
    context() {
      syncActiveStage(room);
      const stage = activeStage();
      const latest = listMessages(roomId, { limit: 1 })[0];
      const output = room.lastOutput;
      return {
        room: { id: room.id, title: room.title, layout: room.layout, language: room.language, aiPolicy: room.settings.aiPolicy },
        you: { agentId: agent.id, label: agent.label, actingFor: { name: agent.ownerName, role: ownerRole() } },
        question: {
          stageId: stage.id,
          title: stage.title,
          number: room.stages.indexOf(stage) + 1,
          totalQuestions: room.stages.length,
          promptMarkdown: room.promptMarkdown
        },
        ...(room.layout === 'workspace'
          ? { workspace: { entryFile: room.workspace.entryFile, files: Object.keys(room.workspace.files).sort(), folders: room.workspace.folders } }
          : { code: { language: room.language, content: room.codes[room.language] } }),
        stdin: room.stdin,
        lastOutput: output ? {
          ok: output.ok, exitCode: output.exitCode, timedOut: output.timedOut, durationMs: output.durationMs,
          stdout: truncate(output.stdout), stderr: truncate(output.stderr), triggeredBy: output.triggeredBy
        } : null,
        participants: getParticipantsList(entry).map((p) => ({ name: p.name, role: p.role })),
        agents: agentsSnapshot(roomId).map((a) => ({ label: a.label, ownerName: a.ownerName, online: a.online })),
        latestMessageId: latest ? latest.id : 0
      };
    },
    sendMessage(text) {
      return postMessage(roomId, { kind: 'agent', authorId: agent.id, authorName: agent.label, text });
    },
    readMessages(afterId, limit) {
      return listMessages(roomId, { afterId, limit });
    },
    waitForMessages(afterId, timeoutMs, signal) {
      const pending = others(listMessages(roomId, { afterId, limit: 100 }));
      if (pending.length) return Promise.resolve(pending);
      return new Promise((resolve) => {
        let waiters = messageWaiters.get(roomId);
        if (!waiters) messageWaiters.set(roomId, waiters = new Set());
        const finish = () => {
          clearTimeout(timer);
          waiters.delete(notify);
          if (!waiters.size) messageWaiters.delete(roomId);
          signal?.removeEventListener('abort', finish);
          markAgentSeen(agent);
          resolve(others(listMessages(roomId, { afterId, limit: 100 })));
        };
        const notify = (message) => {
          if (message.authorId !== agent.id && message.kind !== 'activity') finish();
        };
        const timer = setTimeout(finish, timeoutMs);
        waiters.add(notify);
        signal?.addEventListener('abort', finish);
      });
    },
    async run(stdin) {
      const result = await runRoomCode(entry, agent.label, { stdin });
      return {
        ok: result.ok, exitCode: result.exitCode, timedOut: result.timedOut, durationMs: result.durationMs,
        entryFile: result.entryFile, stdout: truncate(result.stdout, 16000), stderr: truncate(result.stderr, 16000)
      };
    },
    listFiles() {
      const ws = room.workspace;
      return {
        entryFile: ws.entryFile,
        folders: ws.folders,
        files: Object.keys(ws.files).sort().map((filePath) => ({
          path: filePath, bytes: Buffer.byteLength(ws.files[filePath], 'utf8'), language: workspaceOps.languageForPath(filePath)
        }))
      };
    },
    readFile(rawPath) {
      const filePath = workspaceOps.normalizePath(rawPath);
      if (!Object.hasOwn(room.workspace.files, filePath)) throw new Error(`"${filePath}" does not exist. Use list_files.`);
      return { path: filePath, content: room.workspace.files[filePath] };
    },
    writeFile(filePath, content) {
      const result = writeWorkspaceFile(entry, filePath, content, sender);
      activity(`${result.op === 'create_file' ? 'created' : 'rewrote'} \`${result.path}\``);
      return { path: result.path, created: result.op === 'create_file' };
    },
    editFile(filePath, oldText, newText, replaceAll) {
      const result = workspaceOps.editFile(room.workspace, filePath, oldText, newText, replaceAll);
      writeWorkspaceFile(entry, result.path, result.workspace.files[result.path], sender);
      activity(`edited \`${result.path}\``);
      return { path: result.path };
    },
    fileOp(op, rawPath, to) {
      const event = applyWorkspaceOp(entry, { op, path: rawPath, to }, sender);
      const verbs = { create_folder: 'created folder', delete: 'deleted', rename: 'renamed', set_entry: 'set the entry file to' };
      activity(`${verbs[op]} \`${event.path}\`${event.to ? ` → \`${event.to}\`` : ''}`);
      return { ok: true, path: event.path, to: event.to, entryFile: room.workspace.entryFile };
    },
    readCode(language) {
      const lang = language || room.language;
      return { language: lang, code: room.codes[lang] };
    },
    writeCode(code, language) {
      const lang = language || room.language;
      room.codes[lang] = code;
      scheduleRoomSave(entry, true);
      broadcast(entry, { type: 'code_update', stageId: room.activeStageId, language: lang, code, senderId: sender.id, forceReplace: true });
      activity(`rewrote the ${lang} code`);
      return { language: lang, bytes: Buffer.byteLength(code, 'utf8') };
    },
    editCode(oldText, newText, replaceAll, language) {
      const lang = language || room.language;
      const fileName = 'code';
      const result = workspaceOps.editFile({ files: { [fileName]: room.codes[lang] }, folders: [] }, fileName, oldText, newText, replaceAll);
      const code = result.workspace.files[fileName];
      if (code.length > 512 * 1024) throw new Error('Code must be 512 KiB or smaller.');
      room.codes[lang] = code;
      scheduleRoomSave(entry, true);
      broadcast(entry, { type: 'code_update', stageId: room.activeStageId, language: lang, code, senderId: sender.id, forceReplace: true });
      activity(`edited the ${lang} code`);
      return { language: lang };
    },
    setQuestion(promptMarkdown) {
      if (ownerRole() !== 'interviewer') throw new Error('Only an interviewer\'s agent can change the question.');
      room.promptMarkdown = promptMarkdown;
      syncActiveStage(room);
      scheduleRoomSave(entry, true);
      broadcast(entry, { type: 'prompt_update', stageId: room.activeStageId, promptMarkdown, senderId: sender.id });
      activity('updated the problem statement');
      return { stageId: room.activeStageId };
    }
  };
}

const handleRoomMcp = createRoomMcpHandler({
  resolve(token) {
    const agent = verifyAgentToken(token, getAgent);
    if (!agent) return { status: 401, error: 'Invalid or revoked room agent token. Create a new one from the room\'s AI panel.' };
    const room = activeRooms.get(agent.roomId)?.data || getRoom(agent.roomId);
    if (!room || room.layout === 'vscode-server') return { status: 404, error: 'Room not found.' };
    const role = (getRole(agent.roomId, agent.ownerIdentity) || {}).role || 'interviewee';
    if (!aiAllowed(room, role)) {
      return { status: 403, error: 'The interviewer has not enabled AI agents for your role in this room.' };
    }
    markAgentSeen(agent);
    return { session: createAgentSession(agent) };
  }
});

// Unique participants list, deduplicated by identityId (handles multiple tabs
// from the same person), using the latest cursor seen across their connections.
function getParticipantsList(entry) {
  const seen = new Map();
  for (const c of entry.clients.values()) {
    const existing = seen.get(c.identityId);
    if (!existing) {
      seen.set(c.identityId, {
        id: c.identityId,
        name: c.name,
        color: c.color,
        role: c.role,
        cursor: c.cursor || null
      });
    } else if (c.cursor) {
      existing.cursor = c.cursor;
    }
  }
  return Array.from(seen.values());
}

// Update every connection belonging to a given identity
function updateIdentity(entry, identityId, patch) {
  for (const [clientWs, info] of entry.clients) {
    if (info.identityId === identityId) {
      Object.assign(info, patch);
    }
  }
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 2 * 1024 * 1024) {
        reject(new Error('Payload too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (e) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

// ---- Room password / unlock helpers ----

function getClientIp(req) {
  const cf = req.headers['cf-connecting-ip'];
  if (cf) return String(cf).split(',')[0].trim();
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return String(forwarded).split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

function isSecureRequest(req) {
  return Boolean(req.socket.encrypted) || req.headers['x-forwarded-proto'] === 'https';
}

function isRoomProtected(roomId) {
  return Boolean(getRoomPasswordHash(roomId));
}

function isRequestAuthorized(req, roomId) {
  const passwordHash = getRoomPasswordHash(roomId);
  if (!passwordHash) return true;

  const cookies = parseCookies(req.headers.cookie || '');
  const token = cookies[roomCookieName(roomId)];
  return verifyRoomToken(roomId, token, passwordHash, getSessionSecret());
}

function appendRoomUnlockCookie(res, req, roomId, passwordHash) {
  const token = signRoomToken(roomId, passwordHash, getSessionSecret());
  const parts = [
    `${roomCookieName(roomId)}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(ROOM_SESSION_TTL_MS / 1000)}`
  ];
  if (isSecureRequest(req)) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function isValidInviteToken(roomId, token) {
  const passwordHash = getRoomPasswordHash(roomId);
  if (!passwordHash) return false;
  return verifyInviteToken(roomId, token, passwordHash, getSessionSecret());
}

// Basic brute-force protection for room unlock attempts.
const UNLOCK_WINDOW_MS = 15 * 60 * 1000;
const UNLOCK_MAX_ATTEMPTS = 10;
const unlockAttempts = new Map();

function unlockAttemptKey(req, roomId) {
  return `${roomId}:${getClientIp(req)}`;
}

function isUnlockRateLimited(req, roomId) {
  const key = unlockAttemptKey(req, roomId);
  const now = Date.now();
  const record = unlockAttempts.get(key);
  if (!record || now - record.firstAt > UNLOCK_WINDOW_MS) {
    unlockAttempts.set(key, { count: 0, firstAt: now });
    return false;
  }
  return record.count >= UNLOCK_MAX_ATTEMPTS;
}

function recordUnlockFailure(req, roomId) {
  const key = unlockAttemptKey(req, roomId);
  const now = Date.now();
  const record = unlockAttempts.get(key);
  if (!record || now - record.firstAt > UNLOCK_WINDOW_MS) {
    unlockAttempts.set(key, { count: 1, firstAt: now });
    return;
  }
  record.count += 1;

  // Keep the map from growing without bound.
  if (unlockAttempts.size > 5000) {
    for (const [k, v] of unlockAttempts) {
      if (now - v.firstAt > UNLOCK_WINDOW_MS) unlockAttempts.delete(k);
    }
  }
}

function clearUnlockFailures(req, roomId) {
  unlockAttempts.delete(unlockAttemptKey(req, roomId));
}

function serveStaticFile(res, filePath, contentType) {
  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache'
    });
    res.end(content);
  });
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

// Reverse proxy for per-room VS Code servers (openvscode-server)
const vsProxy = httpProxy.createProxyServer({ ws: true, xfwd: true });
vsProxy.on('error', (err, req, res) => {
  console.error('VS Code proxy error:', err.message);
  if (res && typeof res.writeHead === 'function' && !res.headersSent) {
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('VS Code server unavailable.');
  }
});

const VSROOM_PATH_RE = /^\/vsroom\/([a-zA-Z0-9_-]+)(\/.*)?$/;

// MCP must use live state rather than a potentially stale database snapshot.
const handleMcp = createMcpHandler({
  getRoom(id) {
    const room = activeRooms.get(id)?.data || getRoom(id);
    if (!room) throw new Error('Room not found.');
    getStageState(room);
    return room;
  },
  listRooms: listRecentRooms,
  createRoom,
  commitRoom(room, events, stagesChanged = true) {
    const entry = activeRooms.get(room.id);
    saveRoomState(room); // Surface persistence errors before changing live state.
    if (!entry) return;
    if (entry.saveTimer) clearTimeout(entry.saveTimer);
    entry.saveTimer = null;
    // Keep the room object identity: in-flight uploads/runs may hold a reference.
    Object.assign(entry.data, room);
    if (stagesChanged) broadcast(entry, {
      type: 'stages_updated', ...getStageState(room), senderName: 'AI agent'
    });
    for (const event of events) broadcast(entry, { ...event, senderName: 'AI agent' });
  }
});

const server = http.createServer(async (req, res) => {
  try {
    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname;

    if (pathname === '/mcp') return await handleMcp(req, res);
    if (pathname === '/mcp/agent') return await handleRoomMcp(req, res);
    const agentUrlMatch = pathname.match(/^\/mcp\/agent\/(wca_[A-Za-z0-9_.-]+)$/);
    if (agentUrlMatch) return await handleRoomMcp(req, res, agentUrlMatch[1]);

    // Per-room VS Code server reverse proxy
    const vsMatch = pathname.match(VSROOM_PATH_RE);
    if (vsMatch) {
      if (!isRequestAuthorized(req, vsMatch[1])) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end('This room is password protected. Open the room link and enter the password first.');
        return;
      }
      try {
        const session = getVSCodeSession(vsMatch[1]);
        const port = await session.ensure();
        vsProxy.web(req, res, { target: `http://127.0.0.1:${port}` });
      } catch (err) {
        sendJson(res, 500, { error: `Failed to start VS Code server: ${err.message || err}` });
      }
      return;
    }

    // Health & runtime status
    if (req.method === 'GET' && pathname === '/api/status') {
      return sendJson(res, 200, {
        ok: true,
        runtime: CONTAINER_RUNTIME,
        sandboxImage: SANDBOX_IMAGE,
        languages: LANGUAGES
      });
    }

    // Presets list
    if (req.method === 'GET' && pathname === '/api/presets') {
      return sendJson(res, 200, {
        presets: PROBLEM_PRESETS.map((p) => ({
          id: p.id,
          title: p.title,
          difficulty: p.difficulty
        })),
        defaultTemplates: DEFAULT_TEMPLATES
      });
    }

    // List recent rooms
    if (req.method === 'GET' && pathname === '/api/rooms') {
      const rooms = listRecentRooms(30).map((r) => {
        const active = activeRooms.get(r.id);
        const roles = listRoles(r.id);
        return {
          ...r,
          activeParticipants: active ? active.clients.size : 0,
          interviewerName: (roles.find((x) => x.role === 'interviewer') || {}).name || null
        };
      });
      return sendJson(res, 200, { rooms });
    }

    // Create a room
    if (req.method === 'POST' && pathname === '/api/rooms') {
      const body = await readJsonBody(req);
      const password = typeof body.password === 'string' ? body.password : '';
      if (password.length > 256) {
        return sendJson(res, 400, { error: 'Password must be 256 characters or fewer.' });
      }

      // Never return an existing room's contents from a create request; that
      // would bypass the password gate for protected rooms.
      const customId = String(body.customId || '').trim().replace(/[^a-zA-Z0-9_-]/g, '');
      if (customId && getRoom(customId)) {
        return sendJson(res, 409, { error: 'That room ID is already in use.' });
      }

      const room = createRoom({
        id: customId,
        title: body.title,
        language: body.language || 'python',
        layout: body.layout || 'legacy',
        presetId: body.presetId || 'blank',
        password
      });

      // Let the creator enter immediately instead of asking for the password
      // they just chose.
      if (password && room) {
        appendRoomUnlockCookie(res, req, room.id, getRoomPasswordHash(room.id));
      }
      return sendJson(res, 201, { room });
    }

    const roomImageMatch = pathname.match(/^\/api\/rooms\/([a-zA-Z0-9_-]+)\/images\/([a-f0-9]{32}\.(png|jpg|gif|webp))$/);
    if (req.method === 'GET' && roomImageMatch) {
      const [, roomId, filename, extension] = roomImageMatch;
      if (!isRequestAuthorized(req, roomId)) {
        return sendJson(res, 401, { error: 'Password required.', locked: true });
      }
      if (!getRoom(roomId)) return sendJson(res, 404, { error: 'Room not found.' });
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'private, no-store');
      return fs.readFile(path.join(UPLOADS_DIR, roomId, filename), (err, content) => {
        if (err) return sendJson(res, 404, { error: 'Image not found.' });
        res.writeHead(200, { 'Content-Type': IMAGE_TYPES[extension] });
        res.end(content);
      });
    }

    // Room access state (used by the unlock page)
    const roomAccessMatch = pathname.match(/^\/api\/rooms\/([a-zA-Z0-9_-]+)\/access$/);
    if (req.method === 'GET' && roomAccessMatch) {
      const roomId = roomAccessMatch[1];
      const room = getRoom(roomId);
      if (!room) return sendJson(res, 404, { error: 'Room not found.' });

      const locked = isRoomProtected(roomId);
      return sendJson(res, 200, {
        locked,
        authorized: !locked || isRequestAuthorized(req, roomId),
        title: room.title
      });
    }

    // Issue an invite token that lets the recipient skip the password prompt.
    const roomInviteMatch = pathname.match(/^\/api\/rooms\/([a-zA-Z0-9_-]+)\/invite$/);
    if (req.method === 'GET' && roomInviteMatch) {
      const roomId = roomInviteMatch[1];
      if (!isRequestAuthorized(req, roomId)) {
        return sendJson(res, 401, { error: 'Password required.', locked: true });
      }
      if (!getRoom(roomId)) return sendJson(res, 404, { error: 'Room not found.' });

      const passwordHash = getRoomPasswordHash(roomId);
      const token = passwordHash
        ? signInviteToken(roomId, passwordHash, getSessionSecret())
        : null;
      return sendJson(res, 200, { token });
    }

    // Unlock a password-protected room
    const roomUnlockMatch = pathname.match(/^\/api\/rooms\/([a-zA-Z0-9_-]+)\/unlock$/);
    if (req.method === 'POST' && roomUnlockMatch) {
      const roomId = roomUnlockMatch[1];
      const passwordHash = getRoomPasswordHash(roomId);
      if (!passwordHash) {
        return sendJson(res, 200, { ok: true, locked: false });
      }

      if (isUnlockRateLimited(req, roomId)) {
        return sendJson(res, 429, {
          error: 'Too many incorrect password attempts. Please try again later.'
        });
      }

      const body = await readJsonBody(req);
      const password = typeof body.password === 'string' ? body.password : '';
      if (!password || password.length > 256 || !verifyPassword(password, passwordHash)) {
        recordUnlockFailure(req, roomId);
        return sendJson(res, 401, { error: 'Incorrect password.' });
      }

      clearUnlockFailures(req, roomId);
      appendRoomUnlockCookie(res, req, roomId, passwordHash);
      return sendJson(res, 200, { ok: true, locked: true });
    }

    // Get or delete a specific room
    const roomApiMatch = pathname.match(/^\/api\/rooms\/([a-zA-Z0-9_-]+)$/);
    if (roomApiMatch) {
      const roomId = roomApiMatch[1];
      if (req.method === 'GET') {
        if (!isRequestAuthorized(req, roomId)) {
          return sendJson(res, 401, { error: 'Password required.', locked: true });
        }
        const entry = getActiveRoom(roomId);
        return sendJson(res, 200, {
          room: entry.data,
          participants: getParticipantsList(entry),
          timer: getTimerSnapshot(entry.timer)
        });
      }
      if (req.method === 'DELETE') {
        if (!isRequestAuthorized(req, roomId)) {
          return sendJson(res, 401, { error: 'Password required.', locked: true });
        }
        const entry = activeRooms.get(roomId);
        if (entry) {
          if (entry.saveTimer) clearTimeout(entry.saveTimer);
          activeRooms.delete(roomId);
        }
        destroyVSCodeSession(roomId);
        deleteRoom(roomId);
        await fs.promises.rm(path.join(UPLOADS_DIR, roomId), { recursive: true, force: true });
        return sendJson(res, 200, { ok: true });
      }
    }

    // Room page route: /room/:id
    const roomPageMatch = pathname.match(/^\/room\/([a-zA-Z0-9_-]+)\/?$/);
    if (req.method === 'GET' && roomPageMatch) {
      const roomId = roomPageMatch[1];
      if (isRoomProtected(roomId)) {
        const inviteToken = parsedUrl.searchParams.get('invite');
        if (inviteToken && isValidInviteToken(roomId, inviteToken)) {
          appendRoomUnlockCookie(res, req, roomId, getRoomPasswordHash(roomId));
          res.writeHead(302, {
            Location: `/room/${roomId}`,
            'Cache-Control': 'no-store',
            'Referrer-Policy': 'no-referrer'
          });
          res.end();
          return;
        }
        if (!isRequestAuthorized(req, roomId)) {
          return serveStaticFile(res, path.join(PUBLIC_DIR, 'unlock.html'), MIME_TYPES['.html']);
        }
      }
      const room = getRoom(roomId);
      const html = room && room.layout === 'vscode-server' ? 'vsroom.html' : 'room.html';
      return serveStaticFile(res, path.join(PUBLIC_DIR, html), MIME_TYPES['.html']);
    }

    // Root lobby page
    if (req.method === 'GET' && pathname === '/') {
      return serveStaticFile(res, path.join(PUBLIC_DIR, 'index.html'), MIME_TYPES['.html']);
    }

    // Static assets in /public
    if (req.method === 'GET') {
      const safePath = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '');
      const fullPath = path.join(PUBLIC_DIR, safePath);
      if (fullPath.startsWith(PUBLIC_DIR) && fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
        const ext = path.extname(fullPath).toLowerCase();
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';
        return serveStaticFile(res, fullPath, contentType);
      }
    }

    sendJson(res, 404, { error: 'Not found' });
  } catch (err) {
    console.error('HTTP error:', err);
    sendJson(res, 500, { error: err.message || 'Internal Server Error' });
  }
});

const wss = new WebSocketServer({ noServer: true });

function sanitizeIdentity(id) {
  return String(id || '').trim().slice(0, 128).replace(/[^a-zA-Z0-9_-]/g, '');
}

wss.on('connection', (ws, req) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const rawRoomId = parsedUrl.searchParams.get('roomId') || '';
  const roomId = rawRoomId.trim().replace(/[^a-zA-Z0-9_-]/g, '');

  if (!roomId) {
    ws.close(1008, 'Missing roomId');
    return;
  }

  if (!isRequestAuthorized(req, roomId)) {
    ws.close(1008, 'Password required');
    return;
  }

  const entry = getActiveRoom(roomId);

  // Stable identity (from client localStorage) lets roles survive reconnects
  const identityId = sanitizeIdentity(parsedUrl.searchParams.get('id')) ||
    crypto.randomBytes(8).toString('hex');
  const wantRole = parsedUrl.searchParams.get('wantRole');

  // Determine role: sticky persisted role first, then sensible default
  const persisted = getRole(roomId, identityId);
  let role, name, color;

  if (persisted) {
    role = persisted.role;
    name = persisted.name;
    color = persisted.color;
  } else {
    const existingRoles = listRoles(roomId);
    const hasInterviewer = existingRoles.some((r) => r.role === 'interviewer');
    if (wantRole === 'interviewer' && !hasInterviewer) {
      role = 'interviewer';
    } else if (hasInterviewer) {
      role = 'interviewee';
    } else {
      role = 'interviewer'; // first person in the room becomes the interviewer
    }
    name = '';
    color = USER_COLORS[existingRoles.length % USER_COLORS.length];
    setRole(roomId, identityId, role, name, color);
  }

  const clientInfo = {
    id: crypto.randomBytes(6).toString('hex'),
    identityId,
    role,
    name: name || `User ${entry.clients.size + 1}`,
    color,
    cursor: null
  };

  entry.clients.set(ws, clientInfo);

  // Send initial room state to the newly connected client
  sendTo(ws, {
    type: 'init',
    selfId: identityId,
    selfRole: role,
    room: entry.data,
    participants: getParticipantsList(entry),
    isRunning: entry.isRunning,
    timer: getTimerSnapshot(entry.timer),
    agents: agentsSnapshot(roomId),
    messages: listMessages(roomId, { limit: 200 }),
    presets: PROBLEM_PRESETS.map((p) => ({
      id: p.id,
      title: p.title,
      difficulty: p.difficulty
    }))
  });

  // Notify others of new participant
  broadcast(
    entry,
    {
      type: 'participants',
      participants: getParticipantsList(entry)
    },
    ws
  );

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    // Server-side role enforcement for interviewer-only actions
    if (INTERVIEWER_ONLY_ACTIONS.has(msg.type) && !isInterviewer(clientInfo)) {
      sendTo(ws, {
        type: 'permission_denied',
        action: msg.type,
        message: 'Only the interviewer can perform this action.'
      });
      return;
    }

    // Code edits may finish saving to their original stage after a switch.
    // Other editor actions only apply while that stage is still active.
    if (['cursor_change', 'language_change', 'reset_template', 'run_code'].includes(msg.type)
        && msg.stageId && msg.stageId !== entry.data.activeStageId) return;

    switch (msg.type) {
      case 'upload_image': {
        const room = entry.data;
        const stage = room.stages.find((item) => item.id === msg.stageId);
        if (!stage || room.layout === 'vscode-server') {
          sendTo(ws, { type: 'image_upload_error', message: 'That stage no longer exists.' });
          break;
        }
        let saved;
        try {
          saved = await saveImage(roomId, msg.data);
          if (!isInterviewer(clientInfo) || !room.stages.includes(stage) || activeRooms.get(roomId) !== entry) {
            throw new Error('The stage or your interviewer permissions changed. Please try again.');
          }
          syncActiveStage(room);
          const alt = String(msg.filename || 'Question image').replace(/\.[^.]+$/, '')
            .replace(/[\[\]\\\r\n`*]/g, ' ').trim().slice(0, 100) || 'Question image';
          const markdown = `${stage.promptMarkdown.trimEnd()}\n\n![${alt}](${saved.url})\n`;
          if (markdown.length > 256 * 1024) throw new Error('The problem description is too long to add an image.');
          stage.promptMarkdown = markdown;
          if (stage.id === room.activeStageId) room.promptMarkdown = markdown;
          scheduleRoomSave(entry, true);
          broadcast(entry, { type: 'prompt_update', stageId: stage.id, promptMarkdown: markdown });
          sendTo(ws, { type: 'image_uploaded', stageId: stage.id, url: saved.url });
        } catch (err) {
          if (saved) await fs.promises.unlink(saved.filePath).catch(() => {});
          sendTo(ws, { type: 'image_upload_error', message: err.message || 'Image upload failed.' });
        }
        break;
      }

      case 'stage_add':
      case 'stage_change':
      case 'stage_rename':
      case 'stage_remove': {
        if (entry.data.layout === 'vscode-server') break;
        const room = entry.data;
        const title = typeof msg.title === 'string' ? msg.title.trim().slice(0, 80) : '';
        const target = room.stages.find((stage) => stage.id === msg.stageId);
        syncActiveStage(room);
        if (msg.type === 'stage_add') {
          if (room.stages.length >= MAX_STAGES) {
            sendTo(ws, { type: 'action_error', message: `A room can have at most ${MAX_STAGES} stages.` });
            break;
          }
          const stage = createStage(title || `Stage ${room.stages.length + 1}`, '', DEFAULT_TEMPLATES,
            room.layout === 'workspace' ? workspaceOps.starterWorkspace(room.language) : null);
          room.stages.push(stage);
          activateStage(room, stage);
        } else {
          if (!target) break;
          if (msg.type === 'stage_change') {
            activateStage(room, target);
          } else if (msg.type === 'stage_rename') {
            if (!title) break;
            target.title = title;
          } else {
            if (room.stages.length === 1) break;
            const index = room.stages.indexOf(target);
            room.stages.splice(index, 1);
            if (room.activeStageId === target.id) {
              const next = room.stages[Math.min(index, room.stages.length - 1)];
              activateStage(room, next);
            }
          }
        }
        scheduleRoomSave(entry, true);
        broadcast(entry, { type: 'stages_updated', ...getStageState(room), senderName: clientInfo.name });
        break;
      }

      case 'join':
      case 'rename_user': {
        const cleanName = String(msg.name || '').trim().slice(0, 32);
        if (cleanName) {
          clientInfo.name = cleanName;
          updateIdentity(entry, clientInfo.identityId, { name: cleanName });
          setRole(roomId, clientInfo.identityId, clientInfo.role, cleanName, clientInfo.color);
          broadcast(entry, {
            type: 'participants',
            participants: getParticipantsList(entry)
          });
        }
        break;
      }

      case 'role_change': {
        const targetIdentity = sanitizeIdentity(msg.identityId);
        const newRole = ROLES.includes(msg.role) ? msg.role : null;
        if (!targetIdentity || !newRole || targetIdentity === clientInfo.identityId) {
          break;
        }
        const target = Array.from(entry.clients.values()).find(
          (c) => c.identityId === targetIdentity
        );
        if (!target) break;
        updateIdentity(entry, targetIdentity, { role: newRole });
        setRole(roomId, targetIdentity, newRole, target.name, target.color);
        broadcast(entry, {
          type: 'participants',
          participants: getParticipantsList(entry)
        });
        broadcast(entry, {
          type: 'role_updated',
          identityId: targetIdentity,
          role: newRole,
          name: target.name,
          byName: clientInfo.name
        });
        break;
      }

      case 'claim_interviewer': {
        if (clientInfo.role === 'interviewer') break;

        // Only allow a takeover while nobody currently in the room is an
        // interviewer. The persisted role may still exist from someone who
        // has left, which is exactly the recovery case this handles.
        const hasActiveInterviewer = Array.from(entry.clients.values()).some(
          (c) => c.role === 'interviewer'
        );
        if (hasActiveInterviewer) {
          sendTo(ws, {
            type: 'permission_denied',
            action: 'claim_interviewer',
            message: 'An interviewer is already present.'
          });
          break;
        }

        updateIdentity(entry, clientInfo.identityId, { role: 'interviewer' });
        setRole(roomId, clientInfo.identityId, 'interviewer', clientInfo.name, clientInfo.color);
        broadcast(entry, {
          type: 'participants',
          participants: getParticipantsList(entry)
        });
        broadcast(entry, {
          type: 'role_updated',
          identityId: clientInfo.identityId,
          role: 'interviewer',
          name: clientInfo.name,
          byName: clientInfo.name,
          claimed: true
        });
        break;
      }

      case 'code_change': {
        const stage = entry.data.stages.find((item) => item.id === (msg.stageId || entry.data.activeStageId));
        if (!stage) break;
        const lang = LANGUAGES.includes(msg.language)
          ? msg.language
          : entry.data.language;
        if (typeof msg.code === 'string' && msg.code.length <= 512 * 1024) {
          stage.codes[lang] = msg.code;
          scheduleRoomSave(entry);
          broadcast(
            entry,
            {
              type: 'code_update',
              stageId: stage.id,
              language: lang,
              code: msg.code,
              senderId: clientInfo.identityId
            },
            ws
          );
        }
        break;
      }

      case 'cursor_change': {
        clientInfo.cursor = {
          stageId: entry.data.activeStageId,
          language: msg.language || entry.data.language,
          path: typeof msg.path === 'string' ? msg.path.slice(0, 200) : undefined,
          position: msg.position || null,
          selection: msg.selection || null
        };
        broadcast(
          entry,
          {
            type: 'cursor_update',
            userId: clientInfo.identityId,
            name: clientInfo.name,
            color: clientInfo.color,
            cursor: clientInfo.cursor
          },
          ws
        );
        break;
      }

      case 'language_change': {
        if (LANGUAGES.includes(msg.language)) {
          entry.data.language = msg.language;
          scheduleRoomSave(entry);
          broadcast(entry, {
            type: 'language_update',
            stageId: entry.data.activeStageId,
            language: entry.data.language,
            code: entry.data.codes[entry.data.language],
            senderId: clientInfo.identityId,
            senderName: clientInfo.name
          });
        }
        break;
      }

      case 'prompt_change': {
        if (msg.stageId && msg.stageId !== entry.data.activeStageId) break;
        if (typeof msg.promptMarkdown === 'string' && msg.promptMarkdown.length <= 256 * 1024) {
          entry.data.promptMarkdown = msg.promptMarkdown;
          scheduleRoomSave(entry);
          broadcast(
            entry,
            {
              type: 'prompt_update',
              promptMarkdown: entry.data.promptMarkdown,
              stageId: entry.data.activeStageId,
              senderId: clientInfo.identityId
            },
            ws
          );
        }
        break;
      }

      case 'stdin_change': {
        if (typeof msg.stdin === 'string' && msg.stdin.length <= 128 * 1024) {
          entry.data.stdin = msg.stdin;
          scheduleRoomSave(entry);
          broadcast(
            entry,
            {
              type: 'stdin_update',
              stdin: entry.data.stdin,
              senderId: clientInfo.identityId
            },
            ws
          );
        }
        break;
      }

      case 'title_change': {
        const cleanTitle = String(msg.title || '').trim().slice(0, 80);
        if (cleanTitle) {
          entry.data.title = cleanTitle;
          scheduleRoomSave(entry);
          broadcast(entry, {
            type: 'title_update',
            title: entry.data.title,
            senderId: clientInfo.identityId
          });
        }
        break;
      }

      case 'password_change': {
        const password = typeof msg.password === 'string' ? msg.password : '';
        if (password.length > 256) {
          sendTo(ws, {
            type: 'permission_denied',
            action: 'password_change',
            message: 'Password must be 256 characters or fewer.'
          });
          break;
        }
        setRoomPassword(roomId, password);
        entry.data.isProtected = Boolean(password);
        broadcast(entry, {
          type: 'password_updated',
          isProtected: entry.data.isProtected,
          byName: clientInfo.name
        });
        break;
      }

      case 'reset_template': {
        if (entry.data.layout === 'workspace') {
          const room = entry.data;
          const stage = room.stages.find((item) => item.id === room.activeStageId);
          setStageWorkspace(room, stage, workspaceOps.starterWorkspace(room.language));
          scheduleRoomSave(entry, true);
          broadcast(entry, { type: 'workspace_state', stageId: stage.id, workspace: room.workspace, senderName: clientInfo.name });
          break;
        }
        const lang = entry.data.language;
        const defaultCode = DEFAULT_TEMPLATES[lang] || '';
        entry.data.codes[lang] = defaultCode;
        scheduleRoomSave(entry, true);
        broadcast(entry, {
          type: 'code_update',
          stageId: entry.data.activeStageId,
          language: lang,
          code: defaultCode,
          senderId: clientInfo.identityId,
          forceReplace: true
        });
        break;
      }

      case 'load_preset': {
        if (msg.stageId && msg.stageId !== entry.data.activeStageId) break;
        const preset = getPresetById(msg.presetId);
        if (preset) {
          entry.data.promptMarkdown = preset.prompt;
          if (msg.replaceCode) {
            for (const lang of LANGUAGES) {
              entry.data.codes[lang] = preset.templates[lang];
            }
            if (entry.data.layout === 'workspace') {
              const room = entry.data;
              const stage = room.stages.find((item) => item.id === room.activeStageId);
              setStageWorkspace(room, stage, workspaceOps.presetWorkspace(preset, room.language));
              broadcast(entry, { type: 'workspace_state', stageId: stage.id, workspace: room.workspace, senderName: clientInfo.name });
            }
          }
          scheduleRoomSave(entry, true);
          broadcast(entry, {
            type: 'preset_loaded',
            presetId: preset.id,
            promptMarkdown: entry.data.promptMarkdown,
            stageId: entry.data.activeStageId,
            codes: entry.data.codes,
            language: entry.data.language,
            replaceCode: Boolean(msg.replaceCode),
            senderName: clientInfo.name
          });
        }
        break;
      }

      case 'clear_output': {
        entry.data.lastOutput = null;
        scheduleRoomSave(entry, true);
        broadcast(entry, {
          type: 'output_cleared',
          senderName: clientInfo.name
        });
        break;
      }

      case 'timer_action': {
        const now = Date.now();
        if (msg.action === 'start' && !entry.timer.running) {
          entry.timer.running = true;
          entry.timer.startedAt = now;
        } else if (msg.action === 'pause' && entry.timer.running) {
          entry.timer.elapsedMs += now - (entry.timer.startedAt || now);
          entry.timer.running = false;
          entry.timer.startedAt = null;
        } else if (msg.action === 'reset') {
          entry.timer.running = false;
          entry.timer.elapsedMs = 0;
          entry.timer.startedAt = null;
        }
        broadcast(entry, {
          type: 'timer_update',
          timer: getTimerSnapshot(entry.timer)
        });
        break;
      }

      case 'run_code': {
        if (entry.isRunning) break;
        if (entry.data.layout !== 'workspace') {
          const lang = LANGUAGES.includes(msg.language) ? msg.language : entry.data.language;
          if (typeof msg.code === 'string' && msg.code.length <= 512 * 1024) entry.data.codes[lang] = msg.code;
        }
        const stdin = typeof msg.stdin === 'string' && msg.stdin.length <= 128 * 1024 ? msg.stdin : undefined;
        try {
          await runRoomCode(entry, clientInfo.name, { language: msg.language, stdin });
        } catch (err) {
          sendTo(ws, { type: 'action_error', message: err.message });
        }
        break;
      }

      case 'file_change': {
        const room = entry.data;
        if (room.layout !== 'workspace') break;
        const stage = room.stages.find((item) => item.id === (msg.stageId || room.activeStageId));
        if (!stage || !stage.workspace || typeof msg.path !== 'string' || typeof msg.content !== 'string') break;
        if (!Object.hasOwn(stage.workspace.files, msg.path)) break; // deleted or renamed meanwhile
        if (Buffer.byteLength(msg.content, 'utf8') > workspaceOps.MAX_FILE_BYTES) {
          sendTo(ws, { type: 'action_error', message: 'Files must be 512 KiB or smaller.' });
          break;
        }
        stage.workspace.files[msg.path] = msg.content;
        scheduleRoomSave(entry);
        broadcast(entry, {
          type: 'file_update', stageId: stage.id, path: msg.path, content: msg.content, senderId: clientInfo.identityId
        }, ws);
        break;
      }

      case 'file_op': {
        if (entry.data.layout !== 'workspace') break;
        if (msg.stageId && msg.stageId !== entry.data.activeStageId) break;
        try {
          applyWorkspaceOp(entry, {
            op: msg.op, path: msg.path, to: msg.to, content: typeof msg.content === 'string' ? msg.content : ''
          }, { id: clientInfo.identityId, name: clientInfo.name });
        } catch (err) {
          sendTo(ws, { type: 'action_error', message: err.message });
        }
        break;
      }

      case 'workspace_sync': {
        if (entry.data.layout !== 'workspace') break;
        sendTo(ws, { type: 'workspace_state', stageId: entry.data.activeStageId, workspace: entry.data.workspace });
        break;
      }

      case 'chat_send': {
        const text = typeof msg.text === 'string' ? msg.text.trim() : '';
        if (!text || text.length > MAX_MESSAGE_LENGTH) break;
        postMessage(roomId, { kind: 'human', authorId: clientInfo.identityId, authorName: clientInfo.name, text });
        break;
      }

      case 'ai_policy_change': {
        if (!AI_POLICIES.includes(msg.policy)) break;
        entry.data.settings = { ...entry.data.settings, aiPolicy: msg.policy };
        scheduleRoomSave(entry, true);
        broadcast(entry, { type: 'settings_updated', settings: entry.data.settings, byName: clientInfo.name });
        const labels = { off: 'disabled AI agents', interviewer: 'allowed AI agents for interviewers only', everyone: 'allowed AI agents for everyone' };
        postMessage(roomId, { kind: 'system', authorName: clientInfo.name, text: `${clientInfo.name} ${labels[msg.policy]}.` });
        break;
      }

      case 'agent_create': {
        if (entry.data.layout === 'vscode-server') break;
        if (!aiAllowed(entry.data, clientInfo.role)) {
          sendTo(ws, { type: 'permission_denied', action: 'agent_create', message: 'The interviewer has not enabled AI agents for your role.' });
          break;
        }
        if (listAgents(roomId).length >= MAX_AGENTS_PER_ROOM) {
          sendTo(ws, { type: 'action_error', message: `A room can have at most ${MAX_AGENTS_PER_ROOM} agent connections. Revoke one first.` });
          break;
        }
        const label = (typeof msg.label === 'string' ? msg.label.trim().slice(0, 40) : '') || `${clientInfo.name}'s Claude`;
        const { id, token, tokenHash } = generateAgentToken();
        const agent = createAgent({
          id, roomId, tokenHash, ownerIdentity: clientInfo.identityId, ownerName: clientInfo.name, label
        });
        sendTo(ws, { type: 'agent_created', agentId: agent.id, label: agent.label, token });
        broadcastAgents(roomId);
        postMessage(roomId, { kind: 'system', authorName: clientInfo.name, text: `${clientInfo.name} created an agent connection: ${label}.` });
        break;
      }

      case 'agent_revoke': {
        const agent = getAgent(String(msg.agentId || ''));
        if (!agent || agent.roomId !== roomId) break;
        if (agent.ownerIdentity !== clientInfo.identityId && !isInterviewer(clientInfo)) {
          sendTo(ws, { type: 'permission_denied', action: 'agent_revoke', message: 'Only its owner or an interviewer can revoke an agent.' });
          break;
        }
        deleteAgent(agent.id);
        agentLastSeen.delete(agent.id);
        broadcastAgents(roomId);
        postMessage(roomId, { kind: 'system', authorName: clientInfo.name, text: `${clientInfo.name} revoked ${agent.label}.` });
        break;
      }
    }
  });

  ws.on('close', () => {
    entry.clients.delete(ws);

    if (entry.clients.size > 0) {
      broadcast(entry, {
        type: 'participants',
        participants: getParticipantsList(entry)
      });
    } else {
      // Flush pending save and clean up memory after last user leaves
      scheduleRoomSave(entry, true);
      scheduleIdleCleanup(roomId);
    }
  });
});

// Central upgrade handling: route /ws to the app's WebSocketServer, and
// /vsroom/* to the per-room VS Code server's WebSocket (via the proxy).
server.on('upgrade', (req, socket, head) => {
  const pathname = (req.url || '').split('?')[0];

  const vsMatch = pathname.match(VSROOM_PATH_RE);
  if (vsMatch) {
    if (!isRequestAuthorized(req, vsMatch[1])) {
      socket.destroy();
      return;
    }
    getVSCodeSession(vsMatch[1])
      .ensure()
      .then((port) => {
        vsProxy.ws(req, socket, head, { target: `http://127.0.0.1:${port}` });
      })
      .catch(() => {
        socket.destroy();
      });
    return;
  }

  if (pathname === '/ws') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
    return;
  }

  socket.destroy();
});

server.listen(PORT, HOST, () => {
  console.log(`WebCoder interview server running on http://${HOST}:${server.address().port}`);
  console.log(`Sandbox runtime: ${CONTAINER_RUNTIME || 'none'} (image: ${SANDBOX_IMAGE})`);
});
