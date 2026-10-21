(() => {
  const pathParts = window.location.pathname.split('/').filter(Boolean);
  const roomId = pathParts[1] || 'default-room';

  const LANG_META = {
    python: { label: 'Python', file: 'main.py', monaco: 'python' },
    javascript: { label: 'JavaScript', file: 'main.js', monaco: 'javascript' },
    cpp: { label: 'C++', file: 'main.cpp', monaco: 'cpp' },
    java: { label: 'Java', file: 'Solution.java', monaco: 'java' },
    go: { label: 'Go', file: 'main.go', monaco: 'go' },
    rust: { label: 'Rust', file: 'main.rs', monaco: 'rust' }
  };
  const langMeta = (id) => LANG_META[id] || LANG_META.python;
  const getFileNameForLang = (id) => langMeta(id).file;
  const getMonacoLang = (id) => langMeta(id).monaco;

  function getOrCreateIdentity() {
    let id = localStorage.getItem('webcoder_identity');
    if (!id) {
      id = (window.crypto && crypto.randomUUID)
        ? crypto.randomUUID()
        : 'id-' + Date.now().toString(36) + Math.random().toString(36).slice(2);
      try { localStorage.setItem('webcoder_identity', id); } catch {}
    }
    return id;
  }
  const identityId = getOrCreateIdentity();

  let wantRole = null;
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get('role') === 'interviewer') {
    wantRole = 'interviewer';
  } else {
    try {
      const hint = JSON.parse(localStorage.getItem('webcoder_role_hint') || 'null');
      if (hint && hint.roomId === roomId && Date.now() - (hint.t || 0) < 60000) {
        wantRole = hint.role;
        localStorage.removeItem('webcoder_role_hint');
      }
    } catch {}
  }

  const $ = (id) => document.getElementById(id);
  const roomTitleInput = $('roomTitleInput');
  const selfRoleBadge = $('selfRoleBadge');
  const togglePromptBtn = $('togglePromptBtn');
  const toggleOutputBtn = $('toggleOutputBtn');
  const collapsePromptBtn = $('collapsePromptBtn');
  const collapseOutputBtn = $('collapseOutputBtn');
  const languageSelect = $('languageSelect');
  const runBtn = $('runBtn');
  const runBtnIcon = $('runBtnIcon');
  const runBtnLabel = $('runBtnLabel');
  const timerDisplay = $('timerDisplay');
  const timerStartPauseBtn = $('timerStartPauseBtn');
  const timerResetBtn = $('timerResetBtn');
  const usersMenu = $('usersMenu');
  const usersBtn = $('usersBtn');
  const usersCount = $('usersCount');
  const usersDropdown = $('usersDropdown');
  const inviteBtn = $('inviteBtn');
  const roomLockBtn = $('roomLockBtn');

  const promptPane = $('promptPane');
  const resizerLeft = $('resizerLeft');
  const resizerRight = $('resizerRight');
  const outputPane = $('outputPane');
  const promptPreviewTab = $('promptPreviewTab');
  const promptEditTab = $('promptEditTab');
  const presetPicker = $('presetPicker');
  const roleNotice = $('roleNotice');
  const promptPreview = $('promptPreview');
  const promptEditor = $('promptEditor');
  const fileNameLabel = $('fileNameLabel');
  const syncIndicator = $('syncIndicator');
  const fontSizeSelect = $('fontSizeSelect');
  const resetTemplateBtn = $('resetTemplateBtn');
  const editorContainer = $('editorContainer');
  const clearOutputBtn = $('clearOutputBtn');
  const outputScroll = $('outputScroll');
  const stdinSection = $('stdinSection');
  const stdinToggle = $('stdinToggle');
  const stdinArrow = $('stdinArrow');
  const stdinTextarea = $('stdinTextarea');
  const toastEl = $('toast');
  const remoteCursorStyles = $('remoteCursorStyles');

  let ws = null;
  let selfId = null;
  let selfRole = null;
  let currentLanguage = 'python';
  let codes = { python: '', cpp: '', java: '', rust: '', go: '', javascript: '' };
  let participants = [];
  let remoteCursors = new Map();
  let decorationIds = [];
  let editor = null;
  let fallbackTextarea = null;
  let suppressEditorChange = false;
  let isRunning = false;
  let roomIsProtected = false;
  let pendingPasswordCookie = null;

  let timerState = { running: false, elapsedMs: 0, syncedAt: Date.now() };

  function showToast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    setTimeout(() => toastEl.classList.remove('show'), 2800);
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = String(str ?? '');
    return div.innerHTML;
  }

  function renderMarkdown(md) {
    const raw = String(md || '');
    const lines = raw.split(/\r?\n/);
    let html = '';
    let inCodeBlock = false;
    let codeBlockLines = [];
    let inList = false;
    const formatInline = (text) => {
      let s = escapeHtml(text);
      s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
      s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
      s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');
      return s;
    };
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim().startsWith('```')) {
        if (inList) { html += '</ul>'; inList = false; }
        if (!inCodeBlock) { inCodeBlock = true; codeBlockLines = []; }
        else { html += `<pre><code>${escapeHtml(codeBlockLines.join('\n'))}</code></pre>`; inCodeBlock = false; }
        continue;
      }
      if (inCodeBlock) { codeBlockLines.push(line); continue; }
      const trimmed = line.trim();
      if (!trimmed) { if (inList) { html += '</ul>'; inList = false; } continue; }
      if (/^---+$/.test(trimmed)) { if (inList) { html += '</ul>'; inList = false; } html += '<hr />'; continue; }
      if (trimmed.startsWith('### ')) { if (inList) { html += '</ul>'; inList = false; } html += `<h3>${formatInline(trimmed.slice(4))}</h3>`; }
      else if (trimmed.startsWith('## ')) { if (inList) { html += '</ul>'; inList = false; } html += `<h2>${formatInline(trimmed.slice(3))}</h2>`; }
      else if (trimmed.startsWith('# ')) { if (inList) { html += '</ul>'; inList = false; } html += `<h1>${formatInline(trimmed.slice(2))}</h1>`; }
      else if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) { if (!inList) { html += '<ul>'; inList = true; } html += `<li>${formatInline(trimmed.slice(2))}</li>`; }
      else { if (inList) { html += '</ul>'; inList = false; } html += `<p>${formatInline(trimmed)}</p>`; }
    }
    if (inList) html += '</ul>';
    if (inCodeBlock) html += `<pre><code>${escapeHtml(codeBlockLines.join('\n'))}</code></pre>`;
    return html || '<p style="color: var(--text-muted);">No problem prompt written yet.</p>';
  }

  function updatePromptUI(markdown, updateTextarea = true) {
    if (updateTextarea) promptEditor.value = markdown;
    promptPreview.innerHTML = renderMarkdown(markdown);
  }

  function getEditorValue() {
    if (editor) return editor.getValue();
    if (fallbackTextarea) return fallbackTextarea.value;
    return codes[currentLanguage] || '';
  }

  function setEditorValue(newCode, lang = currentLanguage) {
    suppressEditorChange = true;
    try {
      if (editor) {
        const model = editor.getModel();
        if (window.monaco && model) window.monaco.editor.setModelLanguage(model, getMonacoLang(lang));
        if (editor.getValue() !== newCode) {
          const pos = editor.getPosition();
          editor.executeEdits('remote-sync', [{ range: model.getFullModelRange(), text: newCode, forceMoveMarkers: true }]);
          if (pos) editor.setPosition(pos);
        }
      } else if (fallbackTextarea) {
        fallbackTextarea.value = newCode;
      }
    } finally {
      suppressEditorChange = false;
    }
  }

  function sendWs(payload) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
  }

  function initEditor() {
    if (typeof window.require === 'function') {
      window.require.config({ paths: { vs: 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.52.2/min/vs' } });
      window.require(['vs/editor/editor.main'], () => {
        window.monaco.editor.defineTheme('webcoder-dark', {
          base: 'vs-dark', inherit: true, rules: [],
          colors: { 'editor.background': '#1e1e1e', 'editor.lineHighlightBackground': '#2d2d30', 'editorLineNumber.foreground': '#6e6e6e', 'editorGutter.background': '#1e1e1e' }
        });
        editor = window.monaco.editor.create(editorContainer, {
          value: codes[currentLanguage] || '',
          language: getMonacoLang(currentLanguage),
          theme: 'webcoder-dark',
          fontSize: Number(fontSizeSelect.value) || 14,
          fontFamily: '"JetBrains Mono", "Fira Code", Consolas, monospace',
          minimap: { enabled: false },
          automaticLayout: true,
          tabSize: 4,
          insertSpaces: true,
          scrollBeyondLastLine: false,
          padding: { top: 14, bottom: 14 },
          bracketPairColorization: { enabled: true }
        });
        editor.addCommand(window.monaco.KeyMod.CtrlCmd | window.monaco.KeyCode.Enter, () => triggerRunCode());

        let codeDebounce = null;
        editor.onDidChangeModelContent(() => {
          if (suppressEditorChange) return;
          const val = editor.getValue();
          const language = currentLanguage;
          codes[language] = val;
          if (codeDebounce) clearTimeout(codeDebounce);
          codeDebounce = setTimeout(() => sendWs({ type: 'code_change', language, code: val }), 60);
        });

        let cursorDebounce = null;
        editor.onDidChangeCursorSelection((e) => {
          if (cursorDebounce) clearTimeout(cursorDebounce);
          cursorDebounce = setTimeout(() => {
            sendWs({
              type: 'cursor_change', language: currentLanguage,
              position: e.selection.getPosition(),
              selection: {
                startLineNumber: e.selection.startLineNumber, startColumn: e.selection.startColumn,
                endLineNumber: e.selection.endLineNumber, endColumn: e.selection.endColumn
              }
            });
          }, 50);
        });

        renderRemoteCursors();
      });
    } else {
      fallbackTextarea = document.createElement('textarea');
      fallbackTextarea.className = 'prompt-editor';
      fallbackTextarea.value = codes[currentLanguage] || '';
      editorContainer.appendChild(fallbackTextarea);
      fallbackTextarea.addEventListener('input', () => {
        if (suppressEditorChange) return;
        codes[currentLanguage] = fallbackTextarea.value;
        sendWs({ type: 'code_change', language: currentLanguage, code: fallbackTextarea.value });
      });
    }
  }

  function renderRemoteCursors() {
    if (!editor || !window.monaco) return;
    let dynamicCss = '';
    const newDecorations = [];
    for (const [uid, info] of remoteCursors.entries()) {
      if (uid === selfId) continue;
      if (!info.cursor || info.cursor.language !== currentLanguage) continue;
      const safeUid = uid.replace(/[^a-zA-Z0-9]/g, '');
      const color = info.color || '#38bdf8';
      dynamicCss += `.remote-cursor-${safeUid} { border-left: 2px solid ${color} !important; }\n`;
      dynamicCss += `.remote-selection-${safeUid} { background-color: ${color}33 !important; }\n`;
      const pos = info.cursor.position;
      if (pos && pos.lineNumber && pos.column) {
        newDecorations.push({
          range: new window.monaco.Range(pos.lineNumber, pos.column, pos.lineNumber, pos.column),
          options: { className: `remote-cursor-${safeUid}`, stickiness: window.monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges }
        });
      }
      const sel = info.cursor.selection;
      if (sel && (sel.startLineNumber !== sel.endLineNumber || sel.startColumn !== sel.endColumn)) {
        newDecorations.push({
          range: new window.monaco.Range(sel.startLineNumber, sel.startColumn, sel.endLineNumber, sel.endColumn),
          options: { className: `remote-selection-${safeUid}` }
        });
      }
    }
    remoteCursorStyles.textContent = dynamicCss;
    decorationIds = editor.deltaDecorations(decorationIds, newDecorations);
  }

  function updateRoleBadge() {
    if (!selfRole) { selfRoleBadge.style.display = 'none'; return; }
    selfRoleBadge.style.display = '';
    selfRoleBadge.className = 'role-badge ' + (selfRole === 'interviewer' ? 'interviewer' : 'interviewee');
    selfRoleBadge.textContent = selfRole === 'interviewer' ? 'Interviewer' : 'Interviewee';
  }

  function updateLockButton() {
    if (!roomLockBtn) return;
    if (selfRole !== 'interviewer') {
      roomLockBtn.style.display = 'none';
      return;
    }
    roomLockBtn.style.display = '';
    roomLockBtn.textContent = roomIsProtected ? '🔒 Protected' : '🔓 Set Password';
    roomLockBtn.title = roomIsProtected
      ? 'Change or remove the room password'
      : 'Protect this room with a password';
  }

  function applyRolePermissions() {
    const isInt = selfRole === 'interviewer';
    promptEditTab.style.display = isInt ? '' : 'none';
    presetPicker.style.display = isInt ? '' : 'none';
    roomTitleInput.readOnly = !isInt;
    timerStartPauseBtn.disabled = !isInt;
    timerResetBtn.disabled = !isInt;
    resetTemplateBtn.disabled = !isInt;

    if (!isInt) {
      if (localStorage.getItem('webcoder_role_notice_dismissed') === '1') {
        roleNotice.style.display = 'none';
        roleNotice.innerHTML = '';
      } else {
        roleNotice.style.display = '';
        roleNotice.innerHTML = `
          <span class="role-notice-text">You are the interviewee. Only the interviewer can edit the problem prompt, load presets, rename the room, reset starter code, and control the timer.</span>
          <button type="button" class="role-notice-close" title="Dismiss">×</button>
        `;
        const closeBtn = roleNotice.querySelector('.role-notice-close');
        if (closeBtn) closeBtn.addEventListener('click', () => {
          roleNotice.style.display = 'none';
          roleNotice.innerHTML = '';
          try { localStorage.setItem('webcoder_role_notice_dismissed', '1'); } catch {}
        });
      }
      promptPreviewTab.classList.add('active');
      promptEditTab.classList.remove('active');
      promptPreview.style.display = '';
      promptEditor.style.display = 'none';
    } else {
      roleNotice.style.display = 'none';
    }
    updateLockButton();
    renderParticipants();
  }

  function renderParticipants() {
    const isInt = selfRole === 'interviewer';
    usersCount.textContent = String(participants.length);
    usersDropdown.innerHTML = participants.map((p) => {
      const isSelf = p.id === selfId;
      const nameLabel = isSelf ? `${escapeHtml(p.name)} (You)` : escapeHtml(p.name);
      const roleTag = `<span class="participant-role ${escapeHtml(p.role)}">${escapeHtml(p.role)}</span>`;
      const manageable = isInt && !isSelf ? 'manageable' : '';
      const title = isSelf ? 'Click to change your display name' : isInt ? `Click to ${p.role === 'interviewer' ? 'demote' : 'promote'} ${p.name}` : '';
      return `
        <div class="user-row ${isSelf ? 'self' : ''} ${manageable}" data-identity="${escapeHtml(p.id)}" data-role="${escapeHtml(p.role)}" title="${escapeHtml(title)}">
          <span class="participant-dot" style="background: ${escapeHtml(p.color)}; box-shadow: 0 0 6px ${escapeHtml(p.color)};"></span>
          <span class="user-row-name">${nameLabel}</span>
          ${roleTag}
        </div>
      `;
    }).join('');

    const selfRow = usersDropdown.querySelector('.user-row.self');
    if (selfRow) selfRow.addEventListener('click', () => {
      const me = participants.find((p) => p.id === selfId);
      const nextName = prompt('Enter your display name:', me ? me.name : '');
      if (nextName && nextName.trim()) {
        const clean = nextName.trim().slice(0, 32);
        localStorage.setItem('webcoder_username', clean);
        sendWs({ type: 'rename_user', name: clean });
      }
    });

    usersDropdown.querySelectorAll('.user-row.manageable').forEach((el) => {
      el.addEventListener('click', () => {
        const targetIdentity = el.dataset.identity;
        const targetRole = el.dataset.role;
        const p = participants.find((x) => x.id === targetIdentity);
        if (!p) return;
        const newRole = targetRole === 'interviewer' ? 'interviewee' : 'interviewer';
        const actionWord = newRole === 'interviewer' ? 'Promote' : 'Demote';
        if (confirm(`${actionWord} ${p.name} to ${newRole}?`)) {
          sendWs({ type: 'role_change', identityId: targetIdentity, role: newRole });
        }
      });
    });
  }

  function setRunningUI(running, triggeredBy = '') {
    isRunning = running;
    runBtn.disabled = running;
    if (running) {
      runBtnIcon.textContent = '⏳';
      runBtnLabel.textContent = 'Running...';
      outputScroll.innerHTML = `
        <div class="output-meta">
          <span class="status-badge running">● Executing in isolated container...</span>
          <span style="color: var(--text-secondary);">Triggered by ${escapeHtml(triggeredBy || 'User')}</span>
        </div>
      `;
    } else {
      runBtnIcon.textContent = '▶';
      runBtnLabel.textContent = 'Run Code';
    }
  }

  function renderOutputResult(result) {
    if (!result) {
      outputScroll.innerHTML = `
        <div class="output-placeholder">
          <div style="font-size: 22px; opacity: 0.5;">▶</div>
          <div>Press <strong>Run Code</strong> or <code>Ctrl+Enter</code> to execute in the sandbox.</div>
          <div style="font-size: 12px;">Output is shared in real time with everyone in the room.</div>
        </div>
      `;
      return;
    }
    const statusClass = result.ok ? 'success' : 'error';
    const statusLabel = result.timedOut ? 'Timed Out' : result.ok ? 'Exited 0' : `Exited ${result.exitCode}`;
    const stdoutHtml = result.stdout ? `<pre class="output-pre">${escapeHtml(result.stdout)}</pre>` : '';
    const stderrHtml = result.stderr ? `<pre class="output-stderr">${escapeHtml(result.stderr)}</pre>` : '';
    const emptyNotice = !result.stdout && !result.stderr ? `<div style="color: var(--text-muted); font-style: italic;">Program finished with no output.</div>` : '';
    outputScroll.innerHTML = `
      <div class="output-meta">
        <span class="status-badge ${statusClass}">${result.ok ? '✓' : '✕'} ${escapeHtml(statusLabel)} • ${Number(result.durationMs || 0)} ms</span>
        <span style="color: var(--text-secondary);">Ran by <strong>${escapeHtml(result.triggeredBy || 'Participant')}</strong></span>
      </div>
      ${stdoutHtml}${stderrHtml}${emptyNotice}
    `;
  }

  function triggerRunCode() {
    if (isRunning) return;
    const currentCode = getEditorValue();
    codes[currentLanguage] = currentCode;
    sendWs({ type: 'run_code', language: currentLanguage, code: currentCode, stdin: stdinTextarea.value });
  }

  function updateTimerDisplay() {
    const extra = timerState.running ? Date.now() - timerState.syncedAt : 0;
    const totalSec = Math.floor((timerState.elapsedMs + extra) / 1000);
    const hrs = Math.floor(totalSec / 3600);
    const mins = Math.floor((totalSec % 3600) / 60);
    const secs = totalSec % 60;
    const pad = (n) => String(n).padStart(2, '0');
    timerDisplay.textContent = hrs > 0 ? `${pad(hrs)}:${pad(mins)}:${pad(secs)}` : `${pad(mins)}:${pad(secs)}`;
    timerDisplay.classList.toggle('running', timerState.running);
    timerStartPauseBtn.textContent = timerState.running ? 'Pause' : 'Start';
  }

  function connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const params = new URLSearchParams();
    params.set('roomId', roomId);
    params.set('id', identityId);
    if (wantRole === 'interviewer') params.set('wantRole', 'interviewer');
    ws = new WebSocket(`${protocol}//${window.location.host}/ws?${params.toString()}`);

    ws.addEventListener('open', () => {
      syncIndicator.textContent = '● Live';
      syncIndicator.style.color = '#2fbf8f';
      const savedName = localStorage.getItem('webcoder_username');
      if (savedName) sendWs({ type: 'join', name: savedName });
    });

    ws.addEventListener('message', (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }

      switch (msg.type) {
        case 'init': {
          selfId = msg.selfId;
          selfRole = msg.selfRole;
          const room = msg.room;
          document.title = `${room.title} — WebCoder`;
          roomTitleInput.value = room.title;
          roomIsProtected = Boolean(room.isProtected);
          currentLanguage = room.language || 'python';
          codes = room.codes || codes;
          languageSelect.value = currentLanguage;
          fileNameLabel.textContent = getFileNameForLang(currentLanguage);
          stdinTextarea.value = room.stdin || '';

          setEditorValue(codes[currentLanguage] || '', currentLanguage);
          updatePromptUI(room.promptMarkdown || '', true);

          participants = msg.participants || [];
          remoteCursors.clear();
          for (const p of participants) {
            if (p.id !== selfId && p.cursor) remoteCursors.set(p.id, { name: p.name, color: p.color, cursor: p.cursor });
          }
          updateRoleBadge();
          applyRolePermissions();
          renderRemoteCursors();

          if (msg.timer) {
            timerState = { running: msg.timer.running, elapsedMs: msg.timer.elapsedMs || 0, syncedAt: Date.now() };
            updateTimerDisplay();
          }
          if (msg.isRunning) setRunningUI(true, 'Participant');
          else renderOutputResult(room.lastOutput);

          showToast(selfRole === 'interviewer' ? 'You joined as the Interviewer.' : 'You joined as the Interviewee.');
          break;
        }

        case 'participants': {
          participants = msg.participants || [];
          const me = participants.find((p) => p.id === selfId);
          if (me && me.role !== selfRole) { selfRole = me.role; updateRoleBadge(); applyRolePermissions(); }
          const activeIds = new Set(participants.map((p) => p.id));
          for (const uid of remoteCursors.keys()) if (!activeIds.has(uid)) remoteCursors.delete(uid);
          for (const p of participants) if (p.id !== selfId && p.cursor) remoteCursors.set(p.id, { name: p.name, color: p.color, cursor: p.cursor });
          renderParticipants();
          renderRemoteCursors();
          break;
        }

        case 'role_updated': {
          if (msg.identityId === selfId) {
            selfRole = msg.role;
            updateRoleBadge();
            applyRolePermissions();
            showToast(`${msg.byName} made you the ${msg.role}.`);
          } else {
            showToast(`${msg.byName} made ${msg.name} the ${msg.role}.`);
          }
          break;
        }

        case 'permission_denied':
          pendingPasswordCookie = null;
          showToast(msg.message || 'Only the interviewer can perform this action.');
          break;

        case 'code_update':
          codes[msg.language] = msg.code;
          if (msg.language === currentLanguage) setEditorValue(msg.code, currentLanguage);
          break;

        case 'cursor_update':
          remoteCursors.set(msg.userId, { name: msg.name, color: msg.color, cursor: msg.cursor });
          renderRemoteCursors();
          break;

        case 'language_update': {
          currentLanguage = msg.language;
          codes[currentLanguage] = msg.code;
          languageSelect.value = currentLanguage;
          fileNameLabel.textContent = getFileNameForLang(currentLanguage);
          setEditorValue(codes[currentLanguage] || '', currentLanguage);
          renderRemoteCursors();
          if (msg.senderId !== selfId && msg.senderName) showToast(`${msg.senderName} switched language to ${langMeta(currentLanguage).label}`);
          break;
        }

        case 'prompt_update': updatePromptUI(msg.promptMarkdown, true); break;
        case 'stdin_update': stdinTextarea.value = msg.stdin; break;

        case 'title_update':
          roomTitleInput.value = msg.title;
          document.title = `${msg.title} — WebCoder`;
          break;

        case 'password_updated': {
          roomIsProtected = Boolean(msg.isProtected);
          updateLockButton();
          showToast(msg.isProtected
            ? 'This room is now password protected.'
            : 'Room password removed.');

          // The setter's old cookie is now invalid; refresh it with the new
          // password so a reload doesn't lock them out.
          if (pendingPasswordCookie) {
            const password = pendingPasswordCookie;
            pendingPasswordCookie = null;
            fetch(`/api/rooms/${encodeURIComponent(roomId)}/unlock`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ password })
            }).catch(() => {});
          }
          break;
        }

        case 'preset_loaded':
          updatePromptUI(msg.promptMarkdown, true);
          if (msg.replaceCode && msg.codes) {
            codes = msg.codes;
            setEditorValue(codes[currentLanguage] || '', currentLanguage);
          }
          showToast(`Loaded problem preset (${msg.presetId})`);
          break;

        case 'output_cleared': renderOutputResult(null); break;

        case 'timer_update':
          timerState = { running: msg.timer.running, elapsedMs: msg.timer.elapsedMs || 0, syncedAt: Date.now() };
          updateTimerDisplay();
          break;

        case 'run_started': setRunningUI(true, msg.triggeredBy); break;
        case 'run_finished': setRunningUI(false); renderOutputResult(msg.result); break;
      }
    });

    ws.addEventListener('close', (event) => {
      if (event.code === 1008 && /password/i.test(event.reason || '')) {
        syncIndicator.textContent = '● Password required';
        syncIndicator.style.color = '#d29922';
        showToast('Room password required. Reloading...');
        setTimeout(() => window.location.reload(), 1200);
        return;
      }
      syncIndicator.textContent = '● Reconnecting...';
      syncIndicator.style.color = '#d29922';
      setTimeout(connectWebSocket, 1500);
    });
  }

  // ---- Event wiring ----
  runBtn.addEventListener('click', triggerRunCode);
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); triggerRunCode(); }
  });

  timerStartPauseBtn.addEventListener('click', () => sendWs({ type: 'timer_action', action: timerState.running ? 'pause' : 'start' }));
  timerResetBtn.addEventListener('click', () => sendWs({ type: 'timer_action', action: 'reset' }));

  languageSelect.addEventListener('change', () => {
    const nextLang = languageSelect.value;
    codes[currentLanguage] = getEditorValue();
    sendWs({ type: 'code_change', language: currentLanguage, code: codes[currentLanguage] });
    currentLanguage = nextLang;
    fileNameLabel.textContent = getFileNameForLang(currentLanguage);
    setEditorValue(codes[currentLanguage] || '', currentLanguage);
    sendWs({ type: 'language_change', language: nextLang });
  });

  fontSizeSelect.addEventListener('change', () => {
    const size = Number(fontSizeSelect.value) || 14;
    if (editor) editor.updateOptions({ fontSize: size });
  });

  resetTemplateBtn.addEventListener('click', () => {
    if (!confirm(`Reset ${langMeta(currentLanguage).label} code to default starter template?`)) return;
    sendWs({ type: 'reset_template' });
  });

  clearOutputBtn.addEventListener('click', () => sendWs({ type: 'clear_output' }));

  roomTitleInput.addEventListener('change', () => {
    const val = roomTitleInput.value.trim();
    if (val) sendWs({ type: 'title_change', title: val });
  });

  inviteBtn.addEventListener('click', async () => {
    const url = window.location.href;
    try { await navigator.clipboard.writeText(url); showToast('Room invite link copied to clipboard!'); }
    catch { prompt('Copy room invite link:', url); }
  });

  if (roomLockBtn) {
    roomLockBtn.addEventListener('click', () => {
      if (selfRole !== 'interviewer') return;

      const promptText = roomIsProtected
        ? 'Enter a new room password (leave blank to remove protection):'
        : 'Enter a password to protect this room:';
      const nextPassword = prompt(promptText, '');
      if (nextPassword === null) return;
      if (nextPassword.length > 256) {
        showToast('Password must be 256 characters or fewer.');
        return;
      }
      if (!roomIsProtected && !nextPassword) return;

      pendingPasswordCookie = nextPassword || null;
      sendWs({ type: 'password_change', password: nextPassword });
    });
  }

  usersBtn.addEventListener('click', (e) => { e.stopPropagation(); usersMenu.classList.toggle('open'); });
  document.addEventListener('click', (e) => { if (!usersMenu.contains(e.target)) usersMenu.classList.remove('open'); });

  // Panel collapse/expand (left = prompt, right = output)
  function setPaneCollapsed(side, collapsed) {
    if (side === 'left') {
      promptPane.classList.toggle('collapsed', collapsed);
      resizerLeft.style.display = collapsed ? 'none' : '';
      togglePromptBtn.classList.toggle('active', !collapsed);
    } else {
      outputPane.classList.toggle('collapsed', collapsed);
      resizerRight.style.display = collapsed ? 'none' : '';
      toggleOutputBtn.classList.toggle('active', !collapsed);
    }
    if (editor) editor.layout();
  }
  function togglePane(side) {
    const pane = side === 'left' ? promptPane : outputPane;
    setPaneCollapsed(side, !pane.classList.contains('collapsed'));
  }
  togglePromptBtn.addEventListener('click', () => togglePane('left'));
  toggleOutputBtn.addEventListener('click', () => togglePane('right'));
  collapsePromptBtn.addEventListener('click', () => setPaneCollapsed('left', true));
  collapseOutputBtn.addEventListener('click', () => setPaneCollapsed('right', true));

  // Prompt tabs
  promptPreviewTab.addEventListener('click', () => {
    promptPreviewTab.classList.add('active');
    promptEditTab.classList.remove('active');
    promptPreview.style.display = '';
    promptEditor.style.display = 'none';
  });
  promptEditTab.addEventListener('click', () => {
    promptEditTab.classList.add('active');
    promptPreviewTab.classList.remove('active');
    promptEditor.style.display = '';
    promptPreview.style.display = 'none';
    promptEditor.focus();
  });

  let promptDebounce = null;
  promptEditor.addEventListener('input', () => {
    const md = promptEditor.value;
    updatePromptUI(md, false);
    if (promptDebounce) clearTimeout(promptDebounce);
    promptDebounce = setTimeout(() => sendWs({ type: 'prompt_change', promptMarkdown: md }), 120);
  });

  presetPicker.addEventListener('change', () => {
    const presetId = presetPicker.value;
    if (!presetId) return;
    const replaceCode = confirm('Also replace the code editor with this problem’s starter template? (Cancel = only update the Problem Prompt)');
    sendWs({ type: 'load_preset', presetId, replaceCode });
    presetPicker.value = '';
  });

  // Stdin drawer
  stdinToggle.addEventListener('click', () => {
    const collapsed = stdinSection.classList.toggle('collapsed');
    stdinArrow.textContent = collapsed ? '▲' : '▼';
  });
  let stdinDebounce = null;
  stdinTextarea.addEventListener('input', () => {
    if (stdinDebounce) clearTimeout(stdinDebounce);
    stdinDebounce = setTimeout(() => sendWs({ type: 'stdin_change', stdin: stdinTextarea.value }), 150);
  });

  // Resizable panes
  function setupResizer(resizerEl, side) {
    let dragging = false;
    resizerEl.addEventListener('mousedown', (e) => { e.preventDefault(); dragging = true; resizerEl.classList.add('dragging'); document.body.style.cursor = 'col-resize'; });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const totalWidth = window.innerWidth;
      if (side === 'left') {
        const w = Math.max(200, Math.min(totalWidth * 0.45, e.clientX));
        promptPane.style.width = `${w}px`;
      } else {
        const w = Math.max(220, Math.min(totalWidth * 0.5, totalWidth - e.clientX));
        outputPane.style.width = `${w}px`;
      }
      if (editor) editor.layout();
    });
    window.addEventListener('mouseup', () => {
      if (dragging) { dragging = false; resizerEl.classList.remove('dragging'); document.body.style.cursor = ''; if (editor) editor.layout(); }
    });
  }
  setupResizer(resizerLeft, 'left');
  setupResizer(resizerRight, 'right');

  setInterval(updateTimerDisplay, 500);

  initEditor();
  connectWebSocket();
})();
