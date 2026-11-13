const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const WebSocket = require('ws');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

// Exercise the real HTTP server and SDK protocol, never the user's database.
test('MCP room and question management', async (t) => {
  const root = path.resolve(__dirname, '..');
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'webcoder-mcp-'));
  const token = 'test-only-admin-token';
  let child, base, client, socket;
  async function stop() {
    if (client) await client.close();
    client = null;
    socket?.terminate();
    socket = null;
    if (child && child.exitCode === null) {
      const exit = once(child, 'exit');
      child.kill();
      await exit;
    }
  }
  t.after(async () => { await stop(); await fs.rm(fixture, { recursive: true, force: true }); });
  await fs.cp(path.join(root, 'src'), path.join(fixture, 'src'), { recursive: true });
  await fs.copyFile(path.join(root, 'server.js'), path.join(fixture, 'server.js'));
  await fs.symlink(path.join(root, 'node_modules'), path.join(fixture, 'node_modules'), 'dir');
  async function start(enabled = true) {
    child = spawn(process.execPath, ['server.js'], {
      cwd: fixture,
      env: { ...process.env, HOST: '127.0.0.1', PORT: '0', MCP_TOKEN: enabled ? token : '', MCP_ALLOWED_ORIGINS: 'https://trusted.example' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let logs = '';
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(logs)), 10000);
      child.on('exit', () => { clearTimeout(timeout); reject(new Error(logs)); });
      child.stderr.on('data', (data) => { logs += data; });
      child.stdout.on('data', (data) => {
        logs += data;
        const match = logs.match(/running on (http:\/\/127\.0\.0\.1:\d+)/);
        if (match) { base = match[1]; clearTimeout(timeout); resolve(); }
      });
    });
    if (enabled) {
      client = new Client({ name: 'webcoder-test', version: '1.0.0' });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } }
      }));
    }
  }
  const queue = [];
  const waiters = [];
  function next(type) {
    const index = queue.findIndex((event) => event.type === type);
    if (index >= 0) return Promise.resolve(queue.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`No ${type} event`)), 3000);
      waiters.push({ type, resolve(event) { clearTimeout(timer); resolve(event); } });
    });
  }
  async function call(name, args = {}) {
    const result = await client.callTool({ name, arguments: args });
    assert.ok(!result.isError, JSON.stringify(result.content));
    return result.structuredContent;
  }
  async function fails(name, args) {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, true, JSON.stringify(result));
  }
  await start();
  let id, first, second;
  await t.test('rejects unauthenticated requests and untrusted browser origins', async () => {
    const url = `${base}/mcp`;
    assert.equal((await fetch(url)).status, 401);
    assert.equal((await fetch(url, { headers: { Authorization: 'Bearer incorrect' } })).status, 401);
    assert.equal((await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, Origin: 'https://evil.example' } })).status, 403);
    assert.equal((await fetch(url, { headers: { Authorization: `Bearer ${token}`, Origin: 'https://trusted.example' } })).status, 405);
    const { tools } = await client.listTools();
    assert.equal(tools.length, 10);
    assert.equal(tools.find((tool) => tool.name === 'delete_question').annotations.destructiveHint, true);
  });
  await t.test('creates rooms without exposing password secrets', async () => {
    const { room, path } = await call('create_room', { title: 'Agent interview', password: 'room-password' });
    id = room.id; first = room.activeStageId;
    assert.equal(path, `/room/${id}`);
    assert.equal(room.isProtected, true);
    assert.ok(!JSON.stringify(room).includes('room-password'));
    assert.equal((await fetch(`${base}/api/rooms/${id}`)).status, 401);
    const unlock = await fetch(`${base}/api/rooms/${id}/unlock`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'room-password' })
    });
    assert.equal(unlock.status, 200);
    socket = new WebSocket(`${base.replace('http:', 'ws:')}/ws?roomId=${id}&id=test-host`, {
      headers: { Cookie: unlock.headers.get('set-cookie').split(';')[0] }
    });
    socket.on('message', (raw) => {
      const event = JSON.parse(raw);
      const index = waiters.findIndex((waiter) => waiter.type === event.type);
      if (index < 0) queue.push(event);
      else waiters.splice(index, 1)[0].resolve(event);
    });
    await next('init');
    assert.ok((await call('list_rooms')).rooms.some((room) => room.id === id));
    await call('rename_room', { roomId: id, title: 'Renamed interview' });
    assert.equal((await next('title_update')).title, 'Renamed interview');
  });
  await t.test('reads pending live edits and preserves candidate code when editing prompts', async () => {
    socket.send(JSON.stringify({ type: 'code_change', stageId: first, language: 'python', code: 'candidate solution' }));
    // A following message on the same socket acts as a processing barrier.
    socket.send(JSON.stringify({ type: 'title_change', title: 'Live state' }));
    await next('title_update');
    assert.equal((await call('get_room', { roomId: id })).room.codes.python, 'candidate solution');
    await call('edit_question', { roomId: id, stageId: first, promptMarkdown: '# Clarified question' });
    assert.equal((await next('prompt_update')).promptMarkdown, '# Clarified question');
    const update = await next('stages_updated');
    assert.equal(update.stages[0].codes.python, 'candidate solution');
    await call('add_question', { roomId: id, title: 'Follow-up', promptMarkdown: '# Follow-up', starterCode: { python: 'initial code' } });
    const added = await next('stages_updated');
    second = added.stages[1].id;
    assert.equal(added.activeStageId, first);
    assert.equal(added.stages[1].codes.python, 'initial code');
    await call('edit_question', { roomId: id, stageId: second, title: 'Harder follow-up', promptMarkdown: '# Harder' });
    assert.equal((await next('prompt_update')).stageId, second);
    await next('stages_updated');
    await call('set_question_code', { roomId: id, stageId: second, language: 'python', code: 'new starter' });
    assert.equal((await next('code_update')).code, 'new starter');
    await next('stages_updated');
  });
  await t.test('switches and reorders questions without losing independent code', async () => {
    await call('switch_question', { roomId: id, stageId: second });
    assert.equal((await next('stages_updated')).activeStageId, second);
    await call('reorder_questions', { roomId: id, stageIds: [second, first] });
    const update = await next('stages_updated');
    assert.equal(update.activeStageId, second);
    assert.equal(update.stages[0].id, second);
    assert.equal(update.stages[1].codes.python, 'candidate solution');
  });
  await t.test('invalid tools and inputs leave room state intact', async () => {
    const before = await call('get_room', { roomId: id });
    await fails('edit_question', { roomId: id, stageId: first });
    await fails('edit_question', { roomId: id, stageId: first, promptMarkdown: 'x'.repeat(256 * 1024 + 1) });
    await fails('edit_question', { roomId: id, stageId: 'missing', title: 'Bad' });
    await fails('switch_question', { roomId: 'missing', stageId: first });
    await fails('reorder_questions', { roomId: id, stageIds: [first, first] });
    await fails('reorder_questions', { roomId: id, stageIds: [first, 'missing'] });
    assert.deepEqual(await call('get_room', { roomId: id }), before);
  });
  await t.test('changes survive restart and deletion restores the remaining code', async () => {
    await stop(); await start();
    const { room } = await call('get_room', { roomId: id });
    assert.equal(room.activeStageId, second);
    assert.equal(room.stages[0].title, 'Harder follow-up');
    assert.equal(room.codes.python, 'new starter');
    assert.equal(room.stages[1].codes.python, 'candidate solution');
    const deleted = await call('delete_question', { roomId: id, stageId: second });
    assert.equal(deleted.room.activeStageId, first);
    assert.equal(deleted.room.codes.python, 'candidate solution');
    await fails('delete_question', { roomId: id, stageId: first });
    await fails('delete_question', { roomId: id, stageId: 'missing' });
  });
  await t.test('caps question count and supports adding an active question', async () => {
    for (let i = 1; i < 20; i++) {
      await call('add_question', { roomId: id, title: `Stage ${i}`, promptMarkdown: '', activate: true });
    }
    const { room } = await call('get_room', { roomId: id });
    assert.equal(room.activeStageId, room.stages[19].id);
    await fails('add_question', { roomId: id, title: 'Too many', promptMarkdown: '' });
  });
  await t.test('MCP is disabled when no token is configured', async () => {
    await stop(); await start(false);
    assert.equal((await fetch(`${base}/mcp`)).status, 404);
  });
});
