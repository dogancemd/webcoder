const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const WebSocket = require('ws');
const { DEFAULT_TEMPLATES, getPresetById } = require('../src/presets');

test('interview stages', async (t) => {
  // Run the real server against an isolated database, including a pre-stage room.
  const root = path.resolve(__dirname, '..');
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'webcoder-stages-'));
  let server;
  const sockets = [];
  t.after(async () => {
    sockets.forEach((socket) => socket.terminate());
    await stopServer();
    await fs.rm(fixture, { recursive: true, force: true });
  });
  await fs.cp(path.join(root, 'src'), path.join(fixture, 'src'), { recursive: true });
  await fs.cp(path.join(root, 'public'), path.join(fixture, 'public'), { recursive: true });
  await fs.copyFile(path.join(root, 'server.js'), path.join(fixture, 'server.js'));
  await fs.symlink(path.join(root, 'node_modules'), path.join(fixture, 'node_modules'), 'dir');
  await fs.mkdir(path.join(fixture, 'data'));
  const db = new DatabaseSync(path.join(fixture, 'data', 'webcoder.db'));
  db.exec(`
    CREATE TABLE rooms (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, language TEXT NOT NULL,
      layout TEXT NOT NULL, password_hash TEXT NOT NULL DEFAULT '',
      code_python TEXT NOT NULL, code_cpp TEXT NOT NULL, code_java TEXT NOT NULL,
      code_rust TEXT NOT NULL, code_go TEXT NOT NULL, code_javascript TEXT NOT NULL,
      prompt_markdown TEXT NOT NULL, stdin TEXT NOT NULL DEFAULT '',
      last_output_json TEXT NOT NULL DEFAULT 'null', created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    INSERT INTO rooms VALUES (
      'legacy-room', 'Existing interview', 'python', 'legacy', '',
      'print("existing code")', '', '', '', '', '', '# Existing question',
      'existing input', 'null', 1, 1
    );
  `);
  db.close();

  const portReservation = net.createServer();
  portReservation.listen(0, '127.0.0.1');
  await once(portReservation, 'listening');
  const port = portReservation.address().port;
  await new Promise((resolve) => portReservation.close(resolve));

  async function startServer() {
    server = spawn(process.execPath, ['server.js'], {
      cwd: fixture,
      env: { ...process.env, HOST: '127.0.0.1', PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    server.stderr.on('data', (chunk) => { output += chunk; });
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Server startup timed out: ${output}`)), 10000);
      server.once('exit', () => {
        clearTimeout(timeout);
        reject(new Error(`Server exited: ${output}`));
      });
      server.stdout.on('data', (chunk) => {
        output += chunk;
        if (output.includes('WebCoder interview server running')) {
          clearTimeout(timeout);
          resolve();
        }
      });
    });
  }

  async function stopServer() {
    if (!server || server.exitCode !== null) return;
    const closed = once(server, 'exit');
    server.kill();
    await closed;
    server = null;
  }

  function connect(id, roomId = 'legacy-room', options = {}) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?roomId=${roomId}&id=${id}`, options);
    sockets.push(ws);
    const queue = [];
    const pending = [];
    ws.on('error', () => {});
    ws.on('message', (raw) => {
      const message = JSON.parse(raw);
      const index = pending.findIndex((item) => item.type === message.type);
      if (index < 0) queue.push(message);
      else pending.splice(index, 1)[0].resolve(message);
    });
    return {
      send(message) { ws.send(JSON.stringify(message)); },
      next(type) {
        const index = queue.findIndex((message) => message.type === type);
        if (index >= 0) return Promise.resolve(queue.splice(index, 1)[0]);
        return new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${type}`)), 4000);
          pending.push({ type, resolve(message) { clearTimeout(timeout); resolve(message); } });
        });
      }
    };
  }

  await startServer();
  let interviewer = connect('interviewer');
  const initial = await interviewer.next('init');
  let candidate = connect('candidate');
  const candidateInitial = await candidate.next('init');
  const firstStageId = initial.room.activeStageId;
  let secondStageId;

  async function stageAction(message) {
    interviewer.send(message);
    const [hostState, candidateState] = await Promise.all([
      interviewer.next('stages_updated'), candidate.next('stages_updated')
    ]);
    assert.deepEqual(hostState, candidateState);
    return hostState;
  }

  await t.test('existing rooms become Stage 1 without losing content', () => {
    assert.equal(initial.selfRole, 'interviewer');
    assert.equal(candidateInitial.selfRole, 'interviewee');
    assert.equal(initial.room.stages.length, 1);
    assert.equal(initial.room.stages[0].promptMarkdown, '# Existing question');
    assert.equal(initial.room.codes.python, 'print("existing code")');
    assert.equal(initial.room.stages[0].codes.python, 'print("existing code")');
    assert.equal(initial.room.stdin, 'existing input');
    assert.equal(candidateInitial.room.activeStageId, firstStageId);
  });

  await t.test('interviewees cannot add, switch, rename, or remove stages', async () => {
    for (const type of ['stage_add', 'stage_change', 'stage_rename', 'stage_remove']) {
      candidate.send({ type, stageId: firstStageId, title: 'Unauthorized stage' });
      assert.equal((await candidate.next('permission_denied')).action, type);
    }
  });

  await t.test('stages synchronize with independent code buffers for every language', async () => {
    const added = await stageAction({ type: 'stage_add', title: 'Follow-up' });
    secondStageId = added.activeStageId;
    assert.equal(added.stages.length, 2);
    assert.equal(added.stages[1].promptMarkdown, '');
    assert.deepEqual(added.stages[1].codes, DEFAULT_TEMPLATES);
    assert.equal(added.stages[0].codes.python, 'print("existing code")');
    interviewer.send({ type: 'prompt_change', stageId: secondStageId, promptMarkdown: '# Follow-up question' });
    assert.equal((await candidate.next('prompt_update')).promptMarkdown, '# Follow-up question');
    candidate.send({ type: 'code_change', stageId: secondStageId, language: 'python', code: 'print("candidate solution")' });
    assert.equal((await interviewer.next('code_update')).code, 'print("candidate solution")');
    candidate.send({ type: 'code_change', stageId: secondStageId, language: 'javascript', code: 'console.log("stage two")' });
    assert.equal((await interviewer.next('code_update')).stageId, secondStageId);
    const first = await stageAction({ type: 'stage_change', stageId: firstStageId });
    assert.equal(first.stages[0].promptMarkdown, '# Existing question');
    assert.equal(first.stages[1].promptMarkdown, '# Follow-up question');
    assert.equal(first.stages[0].codes.python, 'print("existing code")');
    assert.equal(first.stages[0].codes.javascript, '');
    assert.equal(first.stages[1].codes.python, 'print("candidate solution")');
    assert.equal(first.stages[1].codes.javascript, 'console.log("stage two")');
    const second = await stageAction({ type: 'stage_change', stageId: secondStageId });
    assert.equal(second.activeStageId, secondStageId);
    const observer = connect('observer');
    assert.equal((await observer.next('init')).room.codes.python, 'print("candidate solution")');
  });

  await t.test('delayed edits and presets cannot overwrite another stage', async () => {
    interviewer.send({ type: 'prompt_change', stageId: firstStageId, promptMarkdown: 'Stale edit' });
    interviewer.send({ type: 'load_preset', stageId: firstStageId, presetId: 'two-sum', replaceCode: true });
    interviewer.send({ type: 'reset_template', stageId: firstStageId });
    interviewer.send({ type: 'run_code', stageId: firstStageId, language: 'python', code: 'stale run' });
    interviewer.send({ type: 'language_change', stageId: firstStageId, language: 'javascript' });
    const renamed = await stageAction({ type: 'stage_rename', stageId: secondStageId, title: 'Optimization' });
    assert.equal(renamed.stages[1].title, 'Optimization');
    assert.equal(renamed.stages[1].promptMarkdown, '# Follow-up question');
    const observer = connect('observer-stale');
    assert.equal((await observer.next('init')).room.codes.python, 'print("candidate solution")');
  });

  await t.test('pending code edits save to their original stage after a switch', async () => {
    candidate.send({ type: 'code_change', stageId: firstStageId, language: 'python', code: 'print("late stage one edit")' });
    const update = await interviewer.next('code_update');
    assert.equal(update.stageId, firstStageId);
    const checkpoint = await stageAction({ type: 'stage_rename', stageId: secondStageId, title: 'Optimization' });
    assert.equal(checkpoint.activeStageId, secondStageId);
    assert.equal(checkpoint.stages[0].codes.python, 'print("late stage one edit")');
    assert.equal(checkpoint.stages[1].codes.python, 'print("candidate solution")');
  });

  await t.test('active-stage presets persist without changing other prompts', async () => {
    interviewer.send({ type: 'load_preset', stageId: secondStageId, presetId: 'two-sum', replaceCode: false });
    const preset = await candidate.next('preset_loaded');
    await interviewer.next('preset_loaded');
    assert.match(preset.promptMarkdown, /Two Sum/);
    assert.equal(preset.stageId, secondStageId);
    const first = await stageAction({ type: 'stage_change', stageId: firstStageId });
    assert.equal(first.stages[0].promptMarkdown, '# Existing question');
    assert.match(first.stages[1].promptMarkdown, /Two Sum/);
    await stageAction({ type: 'stage_change', stageId: secondStageId });
  });

  await t.test('stages, active selection, code, and roles survive a server restart', async () => {
    await stopServer();
    await startServer();
    interviewer = connect('interviewer');
    const restored = await interviewer.next('init');
    candidate = connect('candidate');
    assert.equal((await candidate.next('init')).selfRole, 'interviewee');
    assert.equal(restored.selfRole, 'interviewer');
    assert.equal(restored.room.activeStageId, secondStageId);
    assert.equal(restored.room.stages[1].title, 'Optimization');
    assert.equal(restored.room.stages[0].promptMarkdown, '# Existing question');
    assert.match(restored.room.promptMarkdown, /Two Sum/);
    assert.equal(restored.room.codes.python, 'print("candidate solution")');
    assert.equal(restored.room.stages[0].codes.python, 'print("late stage one edit")');
    assert.equal(restored.room.stages[1].codes.javascript, 'console.log("stage two")');
    const first = await stageAction({ type: 'stage_change', stageId: firstStageId });
    assert.equal(first.stages[0].codes.python, 'print("late stage one edit")');
    await stageAction({ type: 'stage_change', stageId: secondStageId });
  });

  await t.test('preset replacement and starter resets affect only the active stage', async () => {
    const added = await stageAction({ type: 'stage_add', title: 'Temporary exercise' });
    const thirdStageId = added.activeStageId;
    interviewer.send({ type: 'load_preset', stageId: thirdStageId, presetId: 'two-sum', replaceCode: true });
    const preset = await candidate.next('preset_loaded');
    await interviewer.next('preset_loaded');
    assert.deepEqual(preset.codes, getPresetById('two-sum').templates);
    interviewer.send({ type: 'reset_template', stageId: thirdStageId });
    const reset = await candidate.next('code_update');
    await interviewer.next('code_update');
    assert.equal(reset.stageId, thirdStageId);
    assert.equal(reset.code, DEFAULT_TEMPLATES.python);
    const removed = await stageAction({ type: 'stage_remove', stageId: thirdStageId });
    assert.equal(removed.activeStageId, secondStageId);
    assert.equal(removed.stages[0].codes.python, 'print("late stage one edit")');
    assert.equal(removed.stages[1].codes.python, 'print("candidate solution")');
    assert.equal(removed.stages[1].codes.javascript, 'console.log("stage two")');
  });

  await t.test('stage management follows role changes immediately', async () => {
    interviewer.send({ type: 'role_change', identityId: 'candidate', role: 'interviewer' });
    await candidate.next('role_updated');
    candidate.send({ type: 'stage_rename', stageId: secondStageId, title: 'Promoted interviewer' });
    assert.equal((await interviewer.next('stages_updated')).stages[1].title, 'Promoted interviewer');
    await candidate.next('stages_updated');
    interviewer.send({ type: 'role_change', identityId: 'candidate', role: 'interviewee' });
    await candidate.next('role_updated');
    candidate.send({ type: 'stage_change', stageId: firstStageId });
    assert.equal((await candidate.next('permission_denied')).action, 'stage_change');
  });

  await t.test('removing the active stage restores the remaining stage code', async () => {
    const removed = await stageAction({ type: 'stage_remove', stageId: secondStageId });
    assert.equal(removed.stages.length, 1);
    assert.equal(removed.activeStageId, firstStageId);
    interviewer.send({ type: 'stage_remove', stageId: firstStageId });
    const observer = connect('observer-remove');
    const room = (await observer.next('init')).room;
    assert.equal(room.stages.length, 1);
    assert.equal(room.promptMarkdown, '# Existing question');
    assert.equal(room.codes.python, 'print("late stage one edit")');
  });

  await t.test('new rooms start with their preset in Stage 1', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/rooms`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ presetId: 'two-sum' })
    });
    assert.equal(response.status, 201);
    const { room } = await response.json();
    assert.equal(room.stages.length, 1);
    assert.match(room.stages[0].promptMarkdown, /Two Sum/);
    assert.deepEqual(room.stages[0].codes, getPresetById('two-sum').templates);
    const host = connect('new-room-host', room.id);
    assert.equal((await host.next('init')).room.activeStageId, room.activeStageId);
  });

  await t.test('existing multi-stage rooms retain previously shared code during migration', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/rooms`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ presetId: 'two-sum' })
    });
    const { room } = await response.json();
    const oldState = {
      stages: [
        { id: 'old-stage-one', title: 'First question', promptMarkdown: '# First question' },
        { id: 'old-stage-two', title: 'Second question', promptMarkdown: '# Second question' }
      ],
      activeStageId: 'old-stage-two'
    };
    const migrationDb = new DatabaseSync(path.join(fixture, 'data', 'webcoder.db'));
    migrationDb.prepare('UPDATE rooms SET stages_json = ?, prompt_markdown = ? WHERE id = ?')
      .run(JSON.stringify(oldState), '# Second question', room.id);
    migrationDb.close();
    const host = connect('migration-host', room.id);
    const migrated = (await host.next('init')).room;
    assert.equal(migrated.activeStageId, 'old-stage-two');
    assert.deepEqual(migrated.stages[0].codes, room.codes);
    assert.deepEqual(migrated.stages[1].codes, room.codes);
    host.send({ type: 'code_change', stageId: 'old-stage-two', language: 'python', code: 'new independent code' });
    host.send({ type: 'stage_change', stageId: 'old-stage-one' });
    const changed = await host.next('stages_updated');
    assert.equal(changed.stages[0].codes.python, room.codes.python);
    assert.equal(changed.stages[1].codes.python, 'new independent code');
  });

  await t.test('question images synchronize, remain stage-specific, and follow room passwords', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/rooms`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'image-secret' })
    });
    const cookie = response.headers.get('set-cookie').split(';')[0];
    const { room } = await response.json();
    let host = connect('image-host', room.id, { headers: { Cookie: cookie } });
    await host.next('init');
    const viewer = connect('image-viewer', room.id, { headers: { Cookie: cookie } });
    await viewer.next('init');
    const imageData = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4VQAAAAASUVORK5CYII=';
    viewer.send({ type: 'upload_image', stageId: room.activeStageId, data: imageData });
    assert.equal((await viewer.next('permission_denied')).action, 'upload_image');
    host.send({ type: 'upload_image', stageId: room.activeStageId, data: Buffer.from('<svg></svg>').toString('base64') });
    assert.match((await host.next('image_upload_error')).message, /PNG, JPEG, GIF, or WebP/);

    host.send({ type: 'upload_image', stageId: room.activeStageId, filename: 'Diagram.png', data: imageData });
    host.send({ type: 'stage_add', title: 'Another question' });
    await host.next('stages_updated');
    await viewer.next('stages_updated');
    const uploaded = await host.next('image_uploaded');
    const prompt = await host.next('prompt_update');
    assert.deepEqual(prompt, await viewer.next('prompt_update'));
    assert.equal(uploaded.stageId, room.activeStageId);
    assert.ok(prompt.promptMarkdown.includes(`![Diagram](${uploaded.url})`));
    const snapshot = await fetch(`http://127.0.0.1:${port}/api/rooms/${room.id}`, { headers: { Cookie: cookie } });
    const savedRoom = (await snapshot.json()).room;
    assert.equal(savedRoom.stages[0].promptMarkdown, prompt.promptMarkdown);
    assert.equal(savedRoom.stages[1].promptMarkdown, '');
    assert.notEqual(savedRoom.activeStageId, room.activeStageId);

    assert.equal((await fetch(`http://127.0.0.1:${port}${uploaded.url}`)).status, 401);
    const image = await fetch(`http://127.0.0.1:${port}${uploaded.url}`, { headers: { Cookie: cookie } });
    assert.equal(image.status, 200);
    assert.equal(image.headers.get('content-type'), 'image/png');
    assert.equal(image.headers.get('x-content-type-options'), 'nosniff');
    assert.match(image.headers.get('cache-control'), /no-store/);
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), Buffer.from(imageData, 'base64'));

    await stopServer();
    await startServer();
    host = connect('image-host', room.id, { headers: { Cookie: cookie } });
    const restored = await host.next('init');
    assert.equal(restored.room.stages[0].promptMarkdown, prompt.promptMarkdown);
    assert.equal((await fetch(`http://127.0.0.1:${port}${uploaded.url}`, { headers: { Cookie: cookie } })).status, 200);
    host.send({ type: 'password_change', password: 'changed-image-password' });
    await host.next('password_updated');
    assert.equal((await fetch(`http://127.0.0.1:${port}${uploaded.url}`, { headers: { Cookie: cookie } })).status, 401);
  });
});
