// Room-scoped MCP endpoint for participants' own AI agents (Claude Code,
// Claude Desktop, claude.ai, ...). Each token belongs to one room and acts on
// behalf of the participant who created it, with that participant's role.
const crypto = require('node:crypto');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { z } = require('zod');
const { LANGUAGES } = require('./presets');

const TOKEN_RE = /^wca_([a-f0-9]{16})\.([A-Za-z0-9_-]{43})$/;
const MAX_MESSAGE_LENGTH = 8000;

function hashSecret(secret) {
  return crypto.createHash('sha256').update(secret).digest('hex');
}

function generateAgentToken() {
  const id = crypto.randomBytes(8).toString('hex');
  const secret = crypto.randomBytes(32).toString('base64url');
  return { id, token: `wca_${id}.${secret}`, tokenHash: hashSecret(secret) };
}

// Returns the agent id when the token's secret matches, otherwise null.
function verifyAgentToken(token, lookup) {
  const match = TOKEN_RE.exec(String(token || ''));
  if (!match) return null;
  const agent = lookup(match[1]);
  if (!agent) return null;
  const expected = Buffer.from(agent.tokenHash, 'hex');
  const given = Buffer.from(hashSecret(match[2]), 'hex');
  return expected.length === given.length && crypto.timingSafeEqual(expected, given) ? agent : null;
}

const INSTRUCTIONS = `You are connected to a live WebCoder technical-interview room as an AI agent.
Everything you do is visible to everyone in the room, including the interviewer: chat messages,
file edits and code runs are shown in the room's AI panel.

Start with get_context. To talk with the people in the room, use send_message, and use
wait_for_messages (pass the latest message id you have seen as afterId) to receive their replies;
call it again whenever it times out without messages while the conversation is ongoing.
Keep chat replies concise and use Markdown code fences for code. Respect the interviewer's rules
for the interview: if they ask you not to write code for the candidate, do not.`;

function createRoomMcpServer(session) {
  const server = new McpServer({ name: 'webcoder-room', version: '1.0.0' }, { instructions: INSTRUCTIONS });
  function tool(name, description, inputSchema, handler, { readOnly = false, destructive = false } = {}) {
    server.registerTool(name, {
      description,
      inputSchema,
      annotations: { readOnlyHint: readOnly, destructiveHint: destructive, openWorldHint: false }
    }, async (args, extra) => {
      try {
        const result = await handler(args, extra);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 1) }], structuredContent: result };
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: error.message }] };
      }
    });
  }
  const read = { readOnly: true };
  const afterId = z.number().int().min(0).default(0)
    .describe('Only return messages with an id greater than this. Use the latest id you have seen.');

  tool('get_context', 'Read the room: the active interview question, the candidate\'s current code or file tree, the last program output, participants, and the latest chat message id.',
    {}, () => session.context(), read);

  tool('send_message', 'Post a chat message in the room\'s AI panel. Everyone in the room sees it. Markdown is supported.', {
    text: z.string().trim().min(1).max(MAX_MESSAGE_LENGTH)
  }, ({ text }) => ({ message: session.sendMessage(text) }));

  tool('read_messages', 'Read chat messages from the room, oldest first.', {
    afterId, limit: z.number().int().min(1).max(200).default(50)
  }, ({ afterId, limit }) => ({ messages: session.readMessages(afterId, limit) }), read);

  tool('wait_for_messages', 'Wait until someone else posts a chat message after afterId, then return the new messages. Returns an empty list after timeoutSeconds if nobody writes.', {
    afterId, timeoutSeconds: z.number().int().min(1).max(55).default(25)
  }, async ({ afterId, timeoutSeconds }, extra) => ({
    messages: await session.waitForMessages(afterId, timeoutSeconds * 1000, extra.signal)
  }), read);

  tool('run_code', 'Run the current code in the sandbox exactly like the room\'s Run button. The output is shown to everyone and returned here.', {
    stdin: z.string().max(128 * 1024).optional().describe('Standard input. Defaults to the room\'s shared stdin.')
  }, ({ stdin }) => session.run(stdin));

  if (session.layout === 'workspace') {
    const filePath = z.string().min(1).max(200).describe('Workspace-relative path such as "src/solution.py".');
    tool('list_files', 'List the workspace files and folders of the active question, with the entry file used by run_code.',
      {}, () => session.listFiles(), read);
    tool('read_file', 'Read a workspace file.', { path: filePath }, ({ path }) => session.readFile(path), read);
    tool('write_file', 'Create a file or replace its entire content. Missing parent folders are created. Overwrites collaborators\' work, so prefer edit_file for changes.', {
      path: filePath, content: z.string().max(512 * 1024)
    }, ({ path, content }) => session.writeFile(path, content), { destructive: true });
    tool('edit_file', 'Replace oldText with newText in a file. oldText must match exactly once unless replaceAll is true.', {
      path: filePath, oldText: z.string().min(1), newText: z.string(), replaceAll: z.boolean().default(false)
    }, ({ path, oldText, newText, replaceAll }) => session.editFile(path, oldText, newText, replaceAll));
    tool('create_folder', 'Create a folder (and any missing parents).', { path: filePath },
      ({ path }) => session.fileOp('create_folder', path));
    tool('rename_path', 'Rename or move a file or folder.', { from: filePath, to: filePath },
      ({ from, to }) => session.fileOp('rename', from, to));
    tool('delete_path', 'Delete a file, or a folder with everything inside it.', { path: filePath },
      ({ path }) => session.fileOp('delete', path), { destructive: true });
    tool('set_entry_file', 'Choose the file that run_code executes (.py, .js, .cpp, .java, .go or .rs).', { path: filePath },
      ({ path }) => session.fileOp('set_entry', path));
  } else {
    const language = z.enum(LANGUAGES).optional().describe('Defaults to the room\'s current language.');
    tool('read_code', 'Read the code buffer of the active question.', { language },
      ({ language }) => session.readCode(language), read);
    tool('write_code', 'Replace the entire code buffer. Overwrites collaborators\' work, so prefer edit_code for changes.', {
      code: z.string().max(512 * 1024), language
    }, ({ code, language }) => session.writeCode(code, language), { destructive: true });
    tool('edit_code', 'Replace oldText with newText in the code buffer. oldText must match exactly once unless replaceAll is true.', {
      oldText: z.string().min(1), newText: z.string(), replaceAll: z.boolean().default(false), language
    }, ({ oldText, newText, replaceAll, language }) => session.editCode(oldText, newText, replaceAll, language));
  }

  if (session.ownerRole() === 'interviewer') {
    tool('set_question', 'Interviewer only: replace the Markdown problem statement of the active question.', {
      promptMarkdown: z.string().max(256 * 1024)
    }, ({ promptMarkdown }) => session.setQuestion(promptMarkdown), { destructive: true });
  }
  return server;
}

// api.resolve(token) returns { session } or { status, error }.
function createRoomMcpHandler(api, { origins = process.env.MCP_ALLOWED_ORIGINS || '' } = {}) {
  const allowedOrigins = new Set(origins.split(',').map((origin) => origin.trim()).filter(Boolean));
  return async (req, res, pathToken = '') => {
    function reject(status, message) {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
      res.end(JSON.stringify({ error: message }));
    }
    const authorization = req.headers.authorization || '';
    const token = pathToken || (authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '');
    const resolved = token ? api.resolve(token) : { status: 401, error: 'A room agent token is required.' };
    if (!resolved.session) {
      if (resolved.status === 401) res.setHeader('WWW-Authenticate', 'Bearer realm="webcoder-room"');
      return reject(resolved.status, resolved.error);
    }
    if (req.headers.origin && !allowedOrigins.has(req.headers.origin)) return reject(403, 'Origin is not allowed.');
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return reject(405, 'Use POST for stateless MCP requests.');
    }
    const server = createRoomMcpServer(resolved.session);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, enableJsonResponse: true, maxRequestBodySize: 4 * 1024 * 1024
    });
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.once('close', () => { void server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      console.error('Room MCP request failed:', error);
      if (!res.headersSent) reject(500, 'MCP request failed.');
      else if (!res.writableEnded) res.end();
      await server.close();
    }
  };
}

module.exports = { createRoomMcpHandler, generateAgentToken, verifyAgentToken, MAX_MESSAGE_LENGTH };
