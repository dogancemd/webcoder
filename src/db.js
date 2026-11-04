const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { getPresetById, LANGUAGES } = require('./presets');
const { hashPassword } = require('./auth');
const { createStage, getStageState } = require('./stages');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DB_PATH = path.join(DATA_DIR, 'webcoder.db');
const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;

  CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    language TEXT NOT NULL DEFAULT 'python',
    layout TEXT NOT NULL DEFAULT 'legacy',
    password_hash TEXT NOT NULL DEFAULT '',
    code_python TEXT NOT NULL,
    code_cpp TEXT NOT NULL,
    code_java TEXT NOT NULL,
    code_rust TEXT NOT NULL,
    code_go TEXT NOT NULL,
    code_javascript TEXT NOT NULL,
    prompt_markdown TEXT NOT NULL,
    stdin TEXT NOT NULL DEFAULT '',
    last_output_json TEXT NOT NULL DEFAULT 'null',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS room_roles (
    room_id TEXT NOT NULL,
    identity_id TEXT NOT NULL,
    role TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    color TEXT NOT NULL DEFAULT '#38bdf8',
    PRIMARY KEY (room_id, identity_id)
  );

  CREATE TABLE IF NOT EXISTS app_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

// Migration: add language/layout columns to databases created before later versions
const existingCols = db.prepare('PRAGMA table_info(rooms)').all().map((c) => c.name);
for (const col of ['code_rust', 'code_go', 'code_javascript', 'layout', 'password_hash']) {
  if (!existingCols.includes(col)) {
    db.exec(`ALTER TABLE rooms ADD COLUMN ${col} TEXT NOT NULL DEFAULT ''`);
  }
}
if (!existingCols.includes('stages_json')) {
  db.exec("ALTER TABLE rooms ADD COLUMN stages_json TEXT NOT NULL DEFAULT 'null'");
}

// Retire the custom VS Code layout without changing saved room content.
db.exec("UPDATE rooms SET layout = 'legacy' WHERE layout != 'vscode-server' AND layout != 'legacy'");

const stmts = {
  getRoom: db.prepare('SELECT * FROM rooms WHERE id = ?'),
  insertRoom: db.prepare(`
    INSERT INTO rooms (
      id, title, language, layout, password_hash, code_python, code_cpp, code_java, code_rust, code_go, code_javascript,
      prompt_markdown, stdin, last_output_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  updateRoom: db.prepare(`
    UPDATE rooms
    SET title = ?,
        language = ?,
        code_python = ?,
        code_cpp = ?,
        code_java = ?,
        code_rust = ?,
        code_go = ?,
        code_javascript = ?,
        prompt_markdown = ?,
        stdin = ?,
        last_output_json = ?,
        stages_json = ?,
        updated_at = ?
    WHERE id = ?
  `),
  listRecentRooms: db.prepare(`
    SELECT id, title, language, created_at, updated_at, (password_hash != '') AS is_protected
    FROM rooms
    ORDER BY updated_at DESC
    LIMIT ?
  `),
  deleteRoom: db.prepare('DELETE FROM rooms WHERE id = ?'),
  deleteRoomRoles: db.prepare('DELETE FROM room_roles WHERE room_id = ?'),

  getRoomPasswordHash: db.prepare('SELECT password_hash FROM rooms WHERE id = ?'),
  setRoomPassword: db.prepare('UPDATE rooms SET password_hash = ? WHERE id = ?'),

  getMeta: db.prepare('SELECT value FROM app_meta WHERE key = ?'),
  setMeta: db.prepare('INSERT INTO app_meta (key, value) VALUES (?, ?)'),

  getRole: db.prepare(
    'SELECT role, name, color FROM room_roles WHERE room_id = ? AND identity_id = ?'
  ),
  upsertRole: db.prepare(`
    INSERT INTO room_roles (room_id, identity_id, role, name, color)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(room_id, identity_id)
    DO UPDATE SET role = excluded.role, name = excluded.name, color = excluded.color
  `),
  listRoles: db.prepare(
    'SELECT identity_id, role, name, color FROM room_roles WHERE room_id = ?'
  ),
  hasRole: db.prepare(
    'SELECT 1 FROM room_roles WHERE room_id = ? AND role = ? LIMIT 1'
  )
};

function generateRoomId() {
  // Friendly 3-part interview slug e.g. "abc-def-ghi" or 8-char alphanumeric
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  const part = (len) => {
    let out = '';
    const bytes = crypto.randomBytes(len);
    for (let i = 0; i < len; i++) {
      out += chars[bytes[i] % chars.length];
    }
    return out;
  };
  return `${part(3)}-${part(4)}-${part(3)}`;
}

function hydrateRoomRow(row) {
  if (!row) return null;
  let lastOutput = null;
  try {
    lastOutput = JSON.parse(row.last_output_json || 'null');
  } catch {
    lastOutput = null;
  }
  let stageState;
  const codes = {
    python: row.code_python,
    cpp: row.code_cpp,
    java: row.code_java,
    rust: row.code_rust,
    go: row.code_go,
    javascript: row.code_javascript
  };
  try { stageState = JSON.parse(row.stages_json || 'null'); } catch {}
  let migratedStages = false;
  if (!stageState || !Array.isArray(stageState.stages) || !stageState.stages.length) {
    const stage = createStage('Stage 1', row.prompt_markdown, codes);
    stageState = { stages: [stage], activeStageId: stage.id };
    migratedStages = true;
  }
  for (const stage of stageState.stages) {
    if (!stage.codes) {
      // Previously all stages shared these buffers. Preserve that code in each
      // existing stage when migrating to independent buffers.
      stage.codes = { ...codes };
      migratedStages = true;
    }
  }
  if (migratedStages) {
    db.prepare('UPDATE rooms SET stages_json = ? WHERE id = ?').run(JSON.stringify(stageState), row.id);
  }
  return {
    id: row.id,
    title: row.title,
    language: row.language,
    layout: row.layout === 'vscode-server' ? 'vscode-server' : 'legacy',
    isProtected: Boolean(row.password_hash),
    codes: stageState.stages.find((stage) => stage.id === stageState.activeStageId)?.codes || codes,
    promptMarkdown: row.prompt_markdown,
    ...stageState,
    stdin: row.stdin || '',
    lastOutput,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function createRoom({ id, title, language = 'python', layout = 'legacy', presetId = 'blank', password = '' } = {}) {
  const roomId = (id && String(id).trim().replace(/[^a-zA-Z0-9_-]/g, '')) || generateRoomId();
  const existing = getRoom(roomId);
  if (existing) return existing;

  const preset = getPresetById(presetId);
  const validLang = LANGUAGES.includes(language) ? language : 'python';
  const validLayout = layout === 'vscode-server' ? 'vscode-server' : 'legacy';
  const roomTitle = (title && String(title).trim()) || `${preset.title} Interview`;
  const passwordHash = password ? hashPassword(String(password)) : '';
  const now = Date.now();

  stmts.insertRoom.run(
    roomId,
    roomTitle,
    validLang,
    validLayout,
    passwordHash,
    preset.templates.python,
    preset.templates.cpp,
    preset.templates.java,
    preset.templates.rust,
    preset.templates.go,
    preset.templates.javascript,
    preset.prompt,
    '',
    'null',
    now,
    now
  );

  return getRoom(roomId);
}

function getRoom(id) {
  const row = stmts.getRoom.get(id);
  return hydrateRoomRow(row);
}

function getOrCreateRoom(id) {
  const cleanId = String(id || '').trim().replace(/[^a-zA-Z0-9_-]/g, '');
  if (!cleanId) return createRoom();
  const existing = getRoom(cleanId);
  if (existing) return existing;
  return createRoom({ id: cleanId, title: `Interview Room (${cleanId})`, presetId: 'blank' });
}

function saveRoomState(room) {
  const now = Date.now();
  room.updatedAt = now;
  stmts.updateRoom.run(
    room.title,
    room.language,
    room.codes.python,
    room.codes.cpp,
    room.codes.java,
    room.codes.rust,
    room.codes.go,
    room.codes.javascript,
    room.promptMarkdown,
    room.stdin || '',
    JSON.stringify(room.lastOutput || null),
    JSON.stringify(getStageState(room)),
    now,
    room.id
  );
  return room;
}

function listRecentRooms(limit = 20) {
  return stmts.listRecentRooms.all(limit).map((r) => ({
    id: r.id,
    title: r.title,
    language: r.language,
    isProtected: Boolean(r.is_protected),
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }));
}

// ---- Room password management ----

function getRoomPasswordHash(roomId) {
  const row = stmts.getRoomPasswordHash.get(roomId);
  return (row && row.password_hash) || '';
}

function setRoomPassword(roomId, password) {
  const passwordHash = password ? hashPassword(String(password)) : '';
  stmts.setRoomPassword.run(passwordHash, roomId);
  return passwordHash;
}

// Stable server-side secret used to sign room unlock cookies. Persisted in the
// database so unlocks survive server restarts.
let cachedSessionSecret = null;
function getSessionSecret() {
  if (cachedSessionSecret) return cachedSessionSecret;

  const row = stmts.getMeta.get('session_secret');
  if (row && row.value) {
    cachedSessionSecret = row.value;
    return cachedSessionSecret;
  }

  cachedSessionSecret = crypto.randomBytes(32).toString('hex');
  stmts.setMeta.run('session_secret', cachedSessionSecret);
  return cachedSessionSecret;
}

// ---- Role management (sticky across reconnects & restarts) ----

function getRole(roomId, identityId) {
  const row = stmts.getRole.get(roomId, identityId);
  return row || null; // { role, name, color }
}

function setRole(roomId, identityId, role, name, color) {
  stmts.upsertRole.run(roomId, identityId, role, name || '', color || '#38bdf8');
}

function listRoles(roomId) {
  return stmts.listRoles.all(roomId).map((r) => ({
    identityId: r.identity_id,
    role: r.role,
    name: r.name,
    color: r.color
  }));
}

function hasRole(roomId, role) {
  return Boolean(stmts.hasRole.get(roomId, role));
}

function deleteRoom(id) {
  stmts.deleteRoom.run(id);
  stmts.deleteRoomRoles.run(id);
}

module.exports = {
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
  hasRole
};
