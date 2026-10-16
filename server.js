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
  getRole,
  setRole,
  listRoles,
  hasRole
} = require('./src/db');
const { LANGUAGES, DEFAULT_TEMPLATES, PROBLEM_PRESETS, getPresetById } = require('./src/presets');
const { executeCode, CONTAINER_RUNTIME, SANDBOX_IMAGE } = require('./src/runner');
const { getVSCodeSession, destroyVSCodeSession } = require('./src/vscode');
const httpProxy = require('http-proxy');

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
  'load_preset',
  'title_change',
  'reset_template',
  'timer_action',
  'role_change'
]);

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

const server = http.createServer(async (req, res) => {
  try {
    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname;

    // Per-room VS Code server reverse proxy
    const vsMatch = pathname.match(VSROOM_PATH_RE);
    if (vsMatch) {
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
      const room = createRoom({
        id: body.customId,
        title: body.title,
        language: body.language || 'python',
        layout: body.layout || 'legacy',
        presetId: body.presetId || 'blank'
      });
      return sendJson(res, 201, { room });
    }

    // Get or delete a specific room
    const roomApiMatch = pathname.match(/^\/api\/rooms\/([a-zA-Z0-9_-]+)$/);
    if (roomApiMatch) {
      const roomId = roomApiMatch[1];
      if (req.method === 'GET') {
        const entry = getActiveRoom(roomId);
        return sendJson(res, 200, {
          room: entry.data,
          participants: getParticipantsList(entry),
          timer: getTimerSnapshot(entry.timer)
        });
      }
      if (req.method === 'DELETE') {
        const entry = activeRooms.get(roomId);
        if (entry) {
          if (entry.saveTimer) clearTimeout(entry.saveTimer);
          activeRooms.delete(roomId);
        }
        destroyVSCodeSession(roomId);
        deleteRoom(roomId);
        return sendJson(res, 200, { ok: true });
      }
    }

    // Room page route: /room/:id
    const roomPageMatch = pathname.match(/^\/room\/([a-zA-Z0-9_-]+)\/?$/);
    if (req.method === 'GET' && roomPageMatch) {
      const room = getRoom(roomPageMatch[1]);
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

    switch (msg.type) {
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

      case 'code_change': {
        const lang = LANGUAGES.includes(msg.language)
          ? msg.language
          : entry.data.language;
        if (typeof msg.code === 'string' && msg.code.length <= 512 * 1024) {
          entry.data.codes[lang] = msg.code;
          scheduleRoomSave(entry);
          broadcast(
            entry,
            {
              type: 'code_update',
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
          language: msg.language || entry.data.language,
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
            language: entry.data.language,
            code: entry.data.codes[entry.data.language],
            senderId: clientInfo.identityId,
            senderName: clientInfo.name
          });
        }
        break;
      }

      case 'prompt_change': {
        if (typeof msg.promptMarkdown === 'string' && msg.promptMarkdown.length <= 256 * 1024) {
          entry.data.promptMarkdown = msg.promptMarkdown;
          scheduleRoomSave(entry);
          broadcast(
            entry,
            {
              type: 'prompt_update',
              promptMarkdown: entry.data.promptMarkdown,
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

      case 'reset_template': {
        const lang = entry.data.language;
        const defaultCode = DEFAULT_TEMPLATES[lang] || '';
        entry.data.codes[lang] = defaultCode;
        scheduleRoomSave(entry, true);
        broadcast(entry, {
          type: 'code_update',
          language: lang,
          code: defaultCode,
          senderId: clientInfo.identityId,
          forceReplace: true
        });
        break;
      }

      case 'load_preset': {
        const preset = getPresetById(msg.presetId);
        if (preset) {
          entry.data.promptMarkdown = preset.prompt;
          if (msg.replaceCode) {
            for (const lang of LANGUAGES) {
              entry.data.codes[lang] = preset.templates[lang];
            }
          }
          scheduleRoomSave(entry, true);
          broadcast(entry, {
            type: 'preset_loaded',
            presetId: preset.id,
            promptMarkdown: entry.data.promptMarkdown,
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
        if (entry.isRunning) {
          return;
        }
        const lang = LANGUAGES.includes(msg.language)
          ? msg.language
          : entry.data.language;
        if (typeof msg.code === 'string') {
          entry.data.codes[lang] = msg.code;
        }
        if (typeof msg.stdin === 'string') {
          entry.data.stdin = msg.stdin;
        }

        entry.isRunning = true;
        const runStartedAt = Date.now();
        broadcast(entry, {
          type: 'run_started',
          language: lang,
          triggeredBy: clientInfo.name,
          timestamp: runStartedAt
        });

        try {
          const execResult = await executeCode({
            language: lang,
            code: entry.data.codes[lang],
            stdin: entry.data.stdin
          });

          const outputRecord = {
            ...execResult,
            triggeredBy: clientInfo.name,
            timestamp: Date.now()
          };

          entry.data.lastOutput = outputRecord;
          scheduleRoomSave(entry, true);

          broadcast(entry, {
            type: 'run_finished',
            result: outputRecord
          });
        } finally {
          entry.isRunning = false;
        }
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
      setTimeout(() => {
        const current = activeRooms.get(roomId);
        if (current && current.clients.size === 0 && !current.isRunning) {
          activeRooms.delete(roomId);
        }
      }, 30000);
    }
  });
});

// Central upgrade handling: route /ws to the app's WebSocketServer, and
// /vsroom/* to the per-room VS Code server's WebSocket (via the proxy).
server.on('upgrade', (req, socket, head) => {
  const pathname = (req.url || '').split('?')[0];

  const vsMatch = pathname.match(VSROOM_PATH_RE);
  if (vsMatch) {
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
  console.log(`WebCoder interview server running on http://${HOST}:${PORT}`);
  console.log(`Sandbox runtime: ${CONTAINER_RUNTIME || 'none'} (image: ${SANDBOX_IMAGE})`);
});
