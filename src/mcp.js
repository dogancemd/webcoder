const crypto = require('node:crypto');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { z } = require('zod');
const { LANGUAGES, DEFAULT_TEMPLATES } = require('./presets');
const { MAX_STAGES, createStage, syncActiveStage, activateStage } = require('./stages');

const roomId = z.string().regex(/^[a-zA-Z0-9_-]+$/).max(128);
const stageId = z.string().min(1).max(128);
const title = z.string().trim().min(1).max(80);
const promptMarkdown = z.string().max(256 * 1024);
const code = z.string().max(512 * 1024);
const starterCode = z.object(Object.fromEntries(LANGUAGES.map((language) => [language, code.optional()]))).strict();

// All mutations run synchronously against a copy of the current live state.
// A failed validation or database write cannot partially modify a live room.
function createMcpServer(api) {
  const server = new McpServer({ name: 'webcoder', version: '1.0.0' });
  function tool(name, description, inputSchema, handler, destructive = false, readOnly = false) {
    server.registerTool(name, {
      description, inputSchema,
      annotations: { readOnlyHint: readOnly, destructiveHint: destructive, openWorldHint: false }
    }, async (args) => {
      try {
        const result = handler(args);
        return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: error.message }] };
      }
    });
  }
  function mutate(id, action) {
    const room = structuredClone(api.getRoom(id));
    if (room.layout !== 'legacy') throw new Error('Question tools require a Classic CoderPad room.');
    syncActiveStage(room);
    const events = [];
    action(room, events);
    api.commitRoom(room, events);
    return { room };
  }
  function question(room, id) {
    const stage = room.stages.find((item) => item.id === id);
    if (!stage) throw new Error('Question not found. Use get_room to find stage IDs.');
    return stage;
  }

  tool('list_rooms', 'List recent rooms. The MCP token has administrator access to all rooms.', {
    limit: z.number().int().min(1).max(100).default(30)
  }, ({ limit }) => ({ rooms: api.listRooms(limit) }), false, true);
  tool('get_room', 'Read a room, its questions, active stage and current code buffers.', { roomId },
    ({ roomId }) => ({ room: api.getRoom(roomId) }), false, true);
  tool('create_room', 'Create a Classic CoderPad room and return its relative browser link. No container is started.', {
    title, language: z.enum(LANGUAGES).default('python'), password: z.string().max(256).optional()
  }, (args) => {
    const room = api.createRoom(args);
    return { room, path: `/room/${room.id}` };
  });
  tool('rename_room', 'Change the room title.', { roomId, title }, ({ roomId, title }) => {
    const room = structuredClone(api.getRoom(roomId));
    room.title = title;
    api.commitRoom(room, [{ type: 'title_update', title }], false);
    return { room };
  });
  tool('add_question', 'Append a question as a new stage. By default it stays inactive. starterCode supplies initial buffers for the new question only.', {
    roomId, title, promptMarkdown, starterCode: starterCode.optional(), activate: z.boolean().default(false)
  }, ({ roomId, title, promptMarkdown, starterCode, activate }) => mutate(roomId, (room) => {
    if (room.stages.length >= MAX_STAGES) throw new Error(`A room can have at most ${MAX_STAGES} stages.`);
    const stage = createStage(title, promptMarkdown, { ...DEFAULT_TEMPLATES, ...starterCode });
    room.stages.push(stage);
    if (activate) activateStage(room, stage);
  }));
  tool('edit_question', 'Edit a question title and/or Markdown. Omitted fields and all candidate code are preserved.', {
    roomId, stageId, title: title.optional(), promptMarkdown: promptMarkdown.optional()
  }, ({ roomId, stageId, title, promptMarkdown }) => mutate(roomId, (room, events) => {
    if (title === undefined && promptMarkdown === undefined) throw new Error('Supply title or promptMarkdown.');
    const stage = question(room, stageId);
    if (title !== undefined) stage.title = title;
    if (promptMarkdown !== undefined) {
      stage.promptMarkdown = promptMarkdown;
      if (stage.id === room.activeStageId) room.promptMarkdown = promptMarkdown;
      events.push({ type: 'prompt_update', stageId, promptMarkdown: stage.promptMarkdown });
    }
  }));
  tool('set_question_code', 'Explicitly REPLACE the current code buffer for one language in a question, including candidate work. Use edit_question for prompt-only edits.', {
    roomId, stageId, language: z.enum(LANGUAGES), code
  }, ({ roomId, stageId, language, code }) => mutate(roomId, (room, events) => {
    question(room, stageId).codes[language] = code;
    events.push({ type: 'code_update', stageId, language, code });
  }), true);
  tool('switch_question', 'Switch the active question for everyone, preserving each stage’s code.', { roomId, stageId },
    ({ roomId, stageId }) => mutate(roomId, (room) => activateStage(room, question(room, stageId))));
  tool('delete_question', 'Permanently delete a question and its code. The last question cannot be deleted.', { roomId, stageId },
    ({ roomId, stageId }) => mutate(roomId, (room) => {
      const stage = question(room, stageId);
      if (room.stages.length === 1) throw new Error('Cannot delete the last question.');
      const index = room.stages.indexOf(stage);
      room.stages.splice(index, 1);
      if (room.activeStageId === stageId) activateStage(room, room.stages[Math.min(index, room.stages.length - 1)]);
    }), true);
  tool('reorder_questions', 'Reorder questions using every existing stage ID exactly once. Keeps the active question unchanged.', {
    roomId, stageIds: z.array(stageId).min(1).max(MAX_STAGES)
  }, ({ roomId, stageIds }) => mutate(roomId, (room) => {
    if (stageIds.length !== room.stages.length || new Set(stageIds).size !== room.stages.length) {
      throw new Error('Include every stage ID exactly once.');
    }
    room.stages = stageIds.map((id) => question(room, id));
  }));
  return server;
}

function createMcpHandler(api, { token = process.env.MCP_TOKEN || '', origins = process.env.MCP_ALLOWED_ORIGINS || '' } = {}) {
  const expected = crypto.createHash('sha256').update(token).digest();
  const allowedOrigins = new Set(origins.split(',').map((origin) => origin.trim()).filter(Boolean));
  return async (req, res) => {
    function reject(status, message) {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: message }));
    }
    if (!token) return reject(404, 'MCP is disabled.');
    const authorization = req.headers.authorization || '';
    const supplied = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    if (!crypto.timingSafeEqual(expected, crypto.createHash('sha256').update(supplied).digest())) {
      res.setHeader('WWW-Authenticate', 'Bearer realm="webcoder-mcp"');
      return reject(401, 'A valid MCP bearer token is required.');
    }
    // Browser clients must be explicitly trusted; native MCP clients omit Origin.
    if (req.headers.origin && !allowedOrigins.has(req.headers.origin)) return reject(403, 'Origin is not allowed.');
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return reject(405, 'Use POST for stateless MCP requests.');
    }
    const server = createMcpServer(api);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, enableJsonResponse: true, maxRequestBodySize: 4 * 1024 * 1024
    });
    res.setHeader('Cache-Control', 'no-store');
    res.once('close', () => { void server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      console.error('MCP request failed:', error);
      if (!res.headersSent) reject(500, 'MCP request failed.');
      else if (!res.writableEnded) res.end();
      await server.close();
    }
  };
}

module.exports = { createMcpHandler };
