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

// Exercises the participant-facing MCP endpoint, chat and workspace sync
// against the real server with an isolated database.
test('room agents, chat and Monaco workspaces', async (t) => {
  const root = path.resolve(__dirname, '..');
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'webcoder-agents-'));
  let child, base;
  const sockets = [];
  const clients = [];
  async function stop() {
    for (const client of clients.splice(0)) await client.close().catch(() => {});
    sockets.splice(0).forEach((socket) => socket.terminate());
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

  async function start() {
    child = spawn(process.execPath, ['server.js'], {
      cwd: fixture,
      env: { ...process.env, HOST: '127.0.0.1', PORT: '0', MCP_TOKEN: '', MCP_ALLOWED_ORIGINS: '' },
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
  }

  // A browser participant: a WebSocket with an event queue.
  async function join(roomId, identity, name) {
    const socket = new WebSocket(`${base.replace('http:', 'ws:')}/ws?roomId=${roomId}&id=${identity}`);
    sockets.push(socket);
    const queue = [];
    const waiters = [];
    socket.on('message', (raw) => {
      const event = JSON.parse(raw);
      const index = waiters.findIndex((waiter) => waiter.match(event));
      if (index < 0) queue.push(event);
      else waiters.splice(index, 1)[0].resolve(event);
    });
    const participant = {
      send: (payload) => socket.send(JSON.stringify(payload)),
      next(type, predicate = () => true) {
        const match = (event) => event.type === type && predicate(event);
        const index = queue.findIndex(match);
        if (index >= 0) return Promise.resolve(queue.splice(index, 1)[0]);
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`No ${type} event for ${name}`)), 4000);
          waiters.push({ match, resolve(event) { clearTimeout(timer); resolve(event); } });
        });
      }
    };
    participant.init = await participant.next('init');
    participant.send({ type: 'join', name });
    await participant.next('participants', (event) => event.participants.some((p) => p.name === name));
    return participant;
  }

  async function connectAgent(participant, label) {
    participant.send({ type: 'agent_create', label });
    const { token, agentId } = await participant.next('agent_created');
    assert.match(token, /^wca_[a-f0-9]{16}\.[A-Za-z0-9_-]{43}$/);
    const client = new Client({ name: 'room-agent-test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp/agent`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } }
    }));
    clients.push(client);
    const call = async (name, args = {}) => {
      const result = await client.callTool({ name, arguments: args });
      assert.ok(!result.isError, `${name}: ${JSON.stringify(result.content)}`);
      return result.structuredContent;
    };
    const fails = async (name, args = {}) => {
      const result = await client.callTool({ name, arguments: args });
      assert.equal(result.isError, true, JSON.stringify(result));
      return result.content[0].text;
    };
    return { client, call, fails, token, agentId };
  }

  async function createRoom(body) {
    const response = await fetch(`${base}/api/rooms`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    return (await response.json()).room;
  }

  function rpc(url, headers = {}) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    });
  }

  await start();
  let roomId, host, guest, hostAgent, guestAgent, firstStage;

  await t.test('workspace rooms start with a multi-file project per stage', async () => {
    const room = await createRoom({ title: 'Workspace', layout: 'workspace', language: 'go' });
    roomId = room.id;
    firstStage = room.activeStageId;
    assert.equal(room.layout, 'workspace');
    assert.deepEqual(Object.keys(room.workspace.files).sort(), ['go.mod', 'main.go', 'solver/solver.go']);
    assert.equal(room.workspace.entryFile, 'main.go');
    host = await join(roomId, 'host-identity', 'Ivy');
    guest = await join(roomId, 'guest-identity', 'Cam');
    assert.equal(host.init.selfRole, 'interviewer');
    assert.equal(guest.init.selfRole, 'interviewee');
    assert.equal(host.init.room.settings.aiPolicy, 'interviewer');
    assert.deepEqual(host.init.messages, []);
  });

  await t.test('file operations and edits synchronize between participants', async () => {
    guest.send({ type: 'file_op', stageId: firstStage, op: 'create_folder', path: 'internal/util' });
    const folder = await host.next('workspace_op', (event) => event.op === 'create_folder');
    assert.equal(folder.path, 'internal/util');
    assert.ok(folder.tree.folders.includes('internal'));
    guest.send({ type: 'file_op', stageId: firstStage, op: 'create_file', path: 'internal/util/math.go', content: 'package util\n' });
    const created = await host.next('workspace_op', (event) => event.op === 'create_file');
    assert.equal(created.created['internal/util/math.go'], 'package util\n');
    guest.send({ type: 'file_change', stageId: firstStage, path: 'internal/util/math.go', content: 'package util\n\nfunc Add(a, b int) int { return a + b }\n' });
    assert.match((await host.next('file_update')).content, /func Add/);
    host.send({ type: 'file_op', stageId: firstStage, op: 'rename', path: 'internal', to: 'pkg' });
    const moved = await guest.next('workspace_op', (event) => event.op === 'rename');
    assert.deepEqual(moved.moved, [['internal/util/math.go', 'pkg/util/math.go']]);
    host.send({ type: 'file_op', stageId: firstStage, op: 'create_file', path: '../escape.go' });
    assert.match((await host.next('action_error')).message, /Invalid name/);
    host.send({ type: 'file_op', stageId: firstStage, op: 'delete', path: 'pkg' });
    assert.deepEqual((await guest.next('workspace_op', (event) => event.op === 'delete')).removed, ['pkg/util/math.go']);
  });

  await t.test('stages keep independent workspaces', async () => {
    host.send({ type: 'stage_add', title: 'Second' });
    const added = await guest.next('stages_updated');
    const second = added.stages[1];
    assert.equal(added.activeStageId, second.id);
    assert.equal(second.workspace.entryFile, 'main.go');
    guest.send({ type: 'file_op', stageId: second.id, op: 'create_file', path: 'second.go', content: 'package main\n' });
    await host.next('workspace_op', (event) => event.path === 'second.go');
    host.send({ type: 'stage_change', stageId: firstStage });
    const back = await guest.next('stages_updated');
    const first = back.stages.find((stage) => stage.id === firstStage);
    assert.ok(!Object.hasOwn(first.workspace.files, 'second.go'));
    assert.ok(Object.hasOwn(back.stages[1].workspace.files, 'second.go'));
  });

  await t.test('AI policy controls who can create and use agent connections', async () => {
    guest.send({ type: 'agent_create', label: 'Too early' });
    assert.equal((await guest.next('permission_denied')).action, 'agent_create');
    hostAgent = await connectAgent(host, 'Interviewer Claude');
    const { agents } = await guest.next('agents_updated', (event) => event.agents.length === 1);
    assert.equal(agents[0].label, 'Interviewer Claude');
    assert.ok(!JSON.stringify(agents).includes(hostAgent.token.split('.')[1]), 'tokens are never broadcast');
    guest.send({ type: 'ai_policy_change', policy: 'everyone' });
    assert.equal((await guest.next('permission_denied')).action, 'ai_policy_change');
    host.send({ type: 'ai_policy_change', policy: 'everyone' });
    assert.equal((await guest.next('settings_updated')).settings.aiPolicy, 'everyone');
    guestAgent = await connectAgent(guest, "Cam's Claude");
    const tools = (await guestAgent.client.listTools()).tools.map((tool) => tool.name);
    assert.ok(tools.includes('write_file') && tools.includes('wait_for_messages'));
    assert.ok(!tools.includes('set_question'), 'only interviewer agents can change the question');
    assert.ok((await hostAgent.client.listTools()).tools.some((tool) => tool.name === 'set_question'));
  });

  await t.test('agents read context and chat with the room', async () => {
    const context = await guestAgent.call('get_context');
    assert.equal(context.you.actingFor.role, 'interviewee');
    assert.equal(context.question.stageId, firstStage);
    assert.ok(context.workspace.files.includes('solver/solver.go'));
    const waiting = guestAgent.call('wait_for_messages', { afterId: context.latestMessageId, timeoutSeconds: 5 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    guest.send({ type: 'chat_send', text: 'Can you explain solver.go?' });
    const { messages } = await waiting;
    assert.deepEqual(messages.map((message) => [message.kind, message.authorName, message.text]),
      [['human', 'Cam', 'Can you explain solver.go?']]);
    await guestAgent.call('send_message', { text: 'It uses a **hash map**.' });
    const chat = await host.next('chat_message', (event) => event.message.kind === 'agent');
    assert.equal(chat.message.authorName, "Cam's Claude");
    const quiet = await guestAgent.call('wait_for_messages', { afterId: chat.message.id, timeoutSeconds: 1 });
    assert.deepEqual(quiet.messages, [], 'own messages do not wake the agent');
  });

  await t.test('agent file edits are broadcast and logged', async () => {
    await guestAgent.call('write_file', { path: 'solver/solver_test.go', content: 'package solver\n' });
    const op = await host.next('workspace_op', (event) => event.path === 'solver/solver_test.go');
    assert.equal(op.senderName, "Cam's Claude");
    await guestAgent.call('edit_file', { path: 'main.go', oldText: 'fmt.Println', newText: 'fmt.Print' });
    assert.match((await host.next('file_update', (event) => event.path === 'main.go')).content, /fmt\.Print\(/);
    assert.match(await guestAgent.fails('read_file', { path: 'missing.go' }), /does not exist/);
    assert.match(await guestAgent.fails('write_file', { path: '../../etc/passwd', content: 'x' }), /Invalid name/);
    const activity = await host.next('chat_message', (event) => event.message.kind === 'activity' && /edited/.test(event.message.text));
    assert.equal(activity.message.text, 'edited `main.go`');
    await hostAgent.call('set_question', { promptMarkdown: '# Follow-up' });
    assert.equal((await guest.next('prompt_update')).promptMarkdown, '# Follow-up');
  });

  await t.test('revocation, policy changes and bad tokens deny access', async () => {
    assert.equal((await rpc(`${base}/mcp/agent`)).status, 401);
    assert.equal((await rpc(`${base}/mcp/agent`, { Authorization: 'Bearer wca_0000000000000000.' + 'x'.repeat(43) })).status, 401);
    assert.equal((await rpc(`${base}/mcp/agent/${guestAgent.token}`, { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await rpc(`${base}/mcp/agent/${guestAgent.token}`)).status, 200, 'URL tokens work for header-less clients');
    host.send({ type: 'ai_policy_change', policy: 'interviewer' });
    await guest.next('settings_updated');
    assert.equal((await rpc(`${base}/mcp/agent`, { Authorization: `Bearer ${guestAgent.token}` })).status, 403);
    assert.equal((await rpc(`${base}/mcp/agent`, { Authorization: `Bearer ${hostAgent.token}` })).status, 200);
    guest.send({ type: 'agent_revoke', agentId: hostAgent.agentId });
    assert.equal((await guest.next('permission_denied')).action, 'agent_revoke');
    host.send({ type: 'agent_revoke', agentId: guestAgent.agentId });
    await guest.next('agents_updated', (event) => event.agents.length === 1);
    host.send({ type: 'ai_policy_change', policy: 'everyone' });
    await guest.next('settings_updated');
    assert.equal((await rpc(`${base}/mcp/agent`, { Authorization: `Bearer ${guestAgent.token}` })).status, 401);
  });

  await t.test('workspaces, chat and agents survive a restart', async () => {
    await stop();
    await start();
    const response = await fetch(`${base}/api/rooms/${roomId}`);
    const { room } = await response.json();
    assert.equal(room.settings.aiPolicy, 'everyone');
    assert.ok(Object.hasOwn(room.workspace.files, 'solver/solver_test.go'));
    assert.match(room.workspace.files['main.go'], /fmt\.Print\(/);
    const again = await join(roomId, 'host-identity', 'Ivy');
    assert.deepEqual(again.init.agents.map((agent) => agent.label), ['Interviewer Claude']);
    assert.ok(again.init.messages.some((message) => message.text === 'It uses a **hash map**.'));
    assert.equal((await rpc(`${base}/mcp/agent`, { Authorization: `Bearer ${hostAgent.token}` })).status, 200);
  });
});
