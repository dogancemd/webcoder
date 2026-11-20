// AI panel: room chat shared by participants and their connected AI agents,
// agent connection management and the interviewer's AI policy.
((root) => {
  const POLICY_LABELS = {
    off: 'AI agents are disabled in this room.',
    interviewer: 'Only interviewers may connect AI agents.',
    everyone: 'Everyone may connect AI agents (AI-enabled interview).'
  };

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function formatTime(ts) {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function createAiPanel({ sendWs, showToast, renderMarkdown, onUnreadChange }) {
    const $ = (id) => document.getElementById(id);
    const policySelect = $('aiPolicySelect');
    const policyLabel = $('aiPolicyLabel');
    const agentList = $('aiAgentList');
    const connectBtn = $('aiConnectBtn');
    const messagesEl = $('aiMessages');
    const chatForm = $('aiChatForm');
    const chatInput = $('aiChatInput');
    const dialog = $('aiConnectDialog');
    const dialogCreate = $('aiConnectCreate');
    const dialogResult = $('aiConnectResult');
    const labelInput = $('aiAgentLabelInput');

    let selfId = null;
    let selfRole = null;
    let policy = 'interviewer';
    let agents = [];
    let messages = [];
    let visible = false;
    let unread = 0;

    const allowed = () => policy === 'everyone' || (policy === 'interviewer' && selfRole === 'interviewer');

    function renderPolicy() {
      const isInterviewer = selfRole === 'interviewer';
      policySelect.hidden = !isInterviewer;
      policySelect.value = policy;
      policyLabel.textContent = POLICY_LABELS[policy];
      connectBtn.disabled = !allowed();
      connectBtn.title = allowed() ? 'Create a private connection for Claude Code, Claude Desktop or claude.ai' : POLICY_LABELS[policy];
    }

    function renderAgents() {
      agentList.replaceChildren();
      if (!agents.length) {
        agentList.appendChild(el('div', 'ai-empty', 'No agents connected yet.'));
        return;
      }
      for (const agent of agents) {
        const row = el('div', 'ai-agent');
        const dot = el('span', `ai-agent-dot${agent.online ? ' online' : ''}`);
        dot.title = agent.online ? 'Active in the last 90 seconds' : 'Not active';
        const name = el('span', 'ai-agent-name', agent.label);
        const owner = el('span', 'ai-agent-owner', agent.ownerId === selfId ? 'yours' : `by ${agent.ownerName || 'participant'}`);
        row.append(dot, name, owner);
        if (agent.ownerId === selfId || selfRole === 'interviewer') {
          const revoke = el('button', 'btn btn-subtle ai-revoke', 'Revoke');
          revoke.type = 'button';
          revoke.addEventListener('click', () => {
            if (confirm(`Revoke ${agent.label}? Its token stops working immediately.`)) sendWs({ type: 'agent_revoke', agentId: agent.id });
          });
          row.appendChild(revoke);
        }
        agentList.appendChild(row);
      }
    }

    function renderMessage(message) {
      const item = el('div', `ai-msg ai-msg-${message.kind}${message.authorId === selfId ? ' self' : ''}`);
      if (message.kind === 'system' || message.kind === 'activity') {
        const line = el('div', 'ai-msg-line');
        if (message.kind === 'activity') line.appendChild(el('strong', '', `🤖 ${message.authorName} `));
        const body = el('span');
        // Activity lines use `code` spans for paths.
        body.innerHTML = renderMarkdown(message.text, { images: false }).replace(/^<p>|<\/p>$/g, '');
        line.appendChild(body);
        line.appendChild(el('span', 'ai-msg-time', formatTime(message.createdAt)));
        item.appendChild(line);
        return item;
      }
      const head = el('div', 'ai-msg-head');
      head.append(el('span', 'ai-msg-author', `${message.kind === 'agent' ? '🤖 ' : ''}${message.authorName}`), el('span', 'ai-msg-time', formatTime(message.createdAt)));
      const body = el('div', 'ai-msg-body markdown-view');
      if (message.kind === 'agent') body.innerHTML = renderMarkdown(message.text, { images: false });
      else { body.classList.add('plain'); body.textContent = message.text; }
      item.append(head, body);
      return item;
    }

    function renderMessages() {
      messagesEl.replaceChildren(...messages.map(renderMessage));
      if (!messages.length) {
        messagesEl.appendChild(el('div', 'ai-empty ai-intro',
          'Chat with everyone in the room and their connected AI agents. Agents see these messages through the WebCoder MCP tools; everything here is visible to all participants.'));
      }
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function addMessage(message) {
      if (messages.some((item) => item.id === message.id)) return;
      const nearBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 60;
      messages.push(message);
      if (messages.length > 500) messages = messages.slice(-500);
      if (messages.length === 1) renderMessages();
      else {
        messagesEl.appendChild(renderMessage(message));
        if (nearBottom || message.authorId === selfId) messagesEl.scrollTop = messagesEl.scrollHeight;
      }
      if (!visible && message.authorId !== selfId && message.kind !== 'activity') {
        unread += 1;
        onUnreadChange(unread);
      }
    }

    function showConnectionDetails(agentId, label, token) {
      const origin = window.location.origin;
      const headerUrl = `${origin}/mcp/agent`;
      const tokenUrl = `${origin}/mcp/agent/${token}`;
      const serverName = 'webcoder-room';
      const snippets = [
        ['Claude Code', `claude mcp add --transport http ${serverName} ${headerUrl} --header "Authorization: Bearer ${token}"`,
          'Run this in a terminal, start claude, then ask it to join the interview room (see the prompt below).'],
        ['Claude Desktop / claude.ai (custom connector URL)', tokenUrl,
          'Add a custom connector with this URL. It contains the secret, so treat it like a password. claude.ai needs a public HTTPS address for this server.'],
        ['Other MCP clients (JSON)', JSON.stringify({ mcpServers: { [serverName]: { type: 'http', url: headerUrl, headers: { Authorization: `Bearer ${token}` } } } }, null, 2),
          'For clients that support Streamable HTTP with custom headers.'],
        ['Prompt to start with', 'Use the webcoder-room MCP tools: call get_context, introduce yourself with send_message, then keep listening with wait_for_messages and reply to what people ask in the room.',
          'Paste this into Claude after connecting.']
      ];
      dialogResult.replaceChildren();
      dialogResult.appendChild(el('p', 'ai-dialog-warning',
        `Connection for "${label}" created. Copy it now: the token is shown only once. It acts as you in this room; revoke it from the AI panel when done.`));
      for (const [title, value, hint] of snippets) {
        const block = el('div', 'ai-snippet');
        const head = el('div', 'ai-snippet-head');
        const copy = el('button', 'btn btn-subtle', 'Copy');
        copy.type = 'button';
        copy.addEventListener('click', async () => {
          try { await navigator.clipboard.writeText(value); showToast(`${title} copied.`); }
          catch { prompt('Copy:', value); }
        });
        head.append(el('strong', '', title), copy);
        block.append(head, el('pre', 'ai-snippet-code', value), el('div', 'ai-snippet-hint', hint));
        dialogResult.appendChild(block);
      }
      dialogCreate.hidden = true;
      dialogResult.hidden = false;
    }

    // ---- Events ----
    policySelect.addEventListener('change', () => sendWs({ type: 'ai_policy_change', policy: policySelect.value }));
    connectBtn.addEventListener('click', () => {
      if (!allowed()) { showToast(POLICY_LABELS[policy]); return; }
      dialogCreate.hidden = false;
      dialogResult.hidden = true;
      labelInput.value = '';
      dialog.showModal();
      labelInput.focus();
    });
    $('aiConnectSubmit').addEventListener('click', (event) => {
      event.preventDefault();
      sendWs({ type: 'agent_create', label: labelInput.value.trim() });
    });
    for (const button of dialog.querySelectorAll('[data-close]')) button.addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => dialogResult.replaceChildren());

    chatForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const text = chatInput.value.trim();
      if (!text) return;
      if (text.length > 8000) { showToast('Messages must be 8000 characters or fewer.'); return; }
      sendWs({ type: 'chat_send', text });
      chatInput.value = '';
    });
    chatInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        chatForm.requestSubmit();
      }
    });

    return {
      setSelf(id, role) {
        selfId = id;
        selfRole = role;
        renderPolicy();
        renderAgents();
      },
      setVisible(isVisible) {
        visible = isVisible;
        if (visible) {
          unread = 0;
          onUnreadChange(0);
          messagesEl.scrollTop = messagesEl.scrollHeight;
        }
      },
      init(msg) {
        policy = msg.room?.settings?.aiPolicy || 'interviewer';
        agents = msg.agents || [];
        messages = msg.messages || [];
        renderPolicy();
        renderAgents();
        renderMessages();
      },
      // Returns true when the WebSocket message belonged to the AI panel.
      handle(msg) {
        switch (msg.type) {
          case 'chat_message': addMessage(msg.message); return true;
          case 'agents_updated': agents = msg.agents || []; renderAgents(); return true;
          case 'settings_updated': policy = msg.settings.aiPolicy; renderPolicy(); return true;
          case 'agent_created': showConnectionDetails(msg.agentId, msg.label, msg.token); return true;
          default: return false;
        }
      }
    };
  }

  root.WebCoderAI = { createAiPanel };
})(window);
