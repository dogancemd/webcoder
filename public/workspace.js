// Multi-file Monaco workspace: file explorer, editor tabs and per-file models,
// synchronized through the room WebSocket (file_change / file_op messages).
((root) => {
  const FILE_ICONS = {
    py: '🐍', js: '🟨', mjs: '🟨', cjs: '🟨', ts: '🔷', cpp: '⚙️', cc: '⚙️', cxx: '⚙️', h: '📐', hpp: '📐',
    java: '☕', go: '🐹', rs: '🦀', md: '📝', json: '🧾', txt: '📄', mod: '📦'
  };
  const RUNNABLE = /\.(py|js|mjs|cjs|cpp|cc|cxx|java|go|rs)$/i;

  function iconFor(path) {
    const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
    return FILE_ICONS[ext] || '📄';
  }
  function baseName(path) { return path.slice(path.lastIndexOf('/') + 1); }
  function dirName(path) { return path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''; }
  function isWithin(child, parent) { return child === parent || child.startsWith(`${parent}/`); }

  function createWorkspaceController({ explorerEl, tabsEl, sendWs, showToast, onActiveFileChange }) {
    let editor = null;
    let monaco = null;
    let stageId = null;
    let tree = { paths: [], folders: [], entryFile: '' };
    const contents = new Map();
    const models = new Map();
    const viewStates = new Map();
    let openTabs = [];
    let activePath = null;
    const expanded = new Set();
    const pending = new Map();
    let flushTimer = null;
    let suppress = false;
    let selectedFolder = '';
    let contextMenu = null;

    // ---- Models ----
    function modelFor(path) {
      if (!monaco) return null;
      let model = models.get(path);
      if (!model) {
        const uri = monaco.Uri.from({ scheme: 'file', path: `/${stageId}/${path}` });
        model = monaco.editor.getModel(uri) || monaco.editor.createModel(contents.get(path) ?? '', undefined, uri);
        models.set(path, model);
      }
      return model;
    }

    function disposeModel(path) {
      const model = models.get(path);
      if (model) model.dispose();
      models.delete(path);
      viewStates.delete(path);
    }

    function setModelValue(model, value) {
      if (model.getValue() === value) return;
      suppress = true;
      try {
        const isActive = editor && editor.getModel() === model;
        const position = isActive ? editor.getPosition() : null;
        model.pushEditOperations([], [{ range: model.getFullModelRange(), text: value, forceMoveMarkers: true }], () => null);
        if (position) editor.setPosition(position);
      } finally {
        suppress = false;
      }
    }

    function showActive() {
      if (!editor) return;
      if (!activePath || !contents.has(activePath)) {
        editor.setModel(null);
        editor.updateOptions({ readOnly: true });
        return;
      }
      editor.updateOptions({ readOnly: false });
      const model = modelFor(activePath);
      if (editor.getModel() !== model) {
        const previous = editor.getModel();
        const previousPath = [...models.entries()].find(([, m]) => m === previous)?.[0];
        if (previousPath) viewStates.set(previousPath, editor.saveViewState());
        suppress = true;
        try { editor.setModel(model); } finally { suppress = false; }
        const state = viewStates.get(activePath);
        if (state) editor.restoreViewState(state);
      }
    }

    // ---- Sync ----
    function flush() {
      clearTimeout(flushTimer);
      flushTimer = null;
      for (const [path, content] of pending) sendWs({ type: 'file_change', stageId, path, content });
      pending.clear();
    }

    function attach(monacoEditor, monacoApi) {
      editor = monacoEditor;
      monaco = monacoApi;
      editor.onDidChangeModelContent(() => {
        if (suppress || !activePath) return;
        const value = editor.getValue();
        contents.set(activePath, value);
        pending.set(activePath, value);
        clearTimeout(flushTimer);
        flushTimer = setTimeout(flush, 80);
      });
      showActive();
    }

    function load(nextStageId, workspace) {
      flush();
      for (const path of [...models.keys()]) disposeModel(path);
      stageId = nextStageId;
      contents.clear();
      for (const [path, content] of Object.entries(workspace?.files || {})) contents.set(path, content);
      tree = {
        paths: Object.keys(workspace?.files || {}).sort(),
        folders: workspace?.folders || [],
        entryFile: workspace?.entryFile || ''
      };
      const keepTabs = openTabs.filter((path) => contents.has(path));
      openTabs = keepTabs.length ? keepTabs : [];
      if (!activePath || !contents.has(activePath)) activePath = tree.entryFile || tree.paths[0] || null;
      if (activePath && !openTabs.includes(activePath)) openTabs.unshift(activePath);
      for (const folder of tree.folders) if (activePath && isWithin(activePath, folder)) expanded.add(folder);
      showActive();
      render();
    }

    function applyFileUpdate(msg) {
      if (msg.stageId !== stageId || !contents.has(msg.path)) return;
      contents.set(msg.path, msg.content);
      pending.delete(msg.path); // last writer wins, as in the classic editor
      const model = models.get(msg.path);
      if (model) setModelValue(model, msg.content);
    }

    function applyOp(msg, selfId) {
      if (msg.stageId !== stageId) return;
      for (const [from, to] of msg.moved || []) {
        const content = models.get(from)?.getValue() ?? contents.get(from) ?? '';
        contents.delete(from);
        contents.set(to, content);
        if (pending.has(from)) { pending.set(to, pending.get(from)); pending.delete(from); }
        disposeModel(from);
        openTabs = openTabs.map((path) => (path === from ? to : path));
        if (activePath === from) activePath = to;
      }
      for (const path of msg.removed || []) {
        contents.delete(path);
        pending.delete(path);
        disposeModel(path);
        openTabs = openTabs.filter((tab) => tab !== path);
        if (activePath === path) activePath = openTabs[openTabs.length - 1] || null;
      }
      for (const [path, content] of Object.entries(msg.created || {})) contents.set(path, content);
      tree = { paths: msg.tree.paths, folders: msg.tree.folders, entryFile: msg.tree.entryFile };
      // Any file we have never seen (should not happen) triggers a full resync.
      if (tree.paths.some((path) => !contents.has(path))) sendWs({ type: 'workspace_sync' });
      if (msg.senderId === selfId) {
        if (msg.op === 'create_file') openFile(msg.path);
        if (msg.op === 'create_folder') expanded.add(msg.path);
        if (msg.op === 'rename' && msg.to) for (const folder of tree.folders) if (isWithin(msg.to, folder) && folder !== msg.to) expanded.add(folder);
      }
      if (msg.op === 'rename' && msg.to && expanded.has(msg.path)) { expanded.delete(msg.path); expanded.add(msg.to); }
      if (!activePath && tree.paths.length) activePath = tree.entryFile || tree.paths[0];
      if (activePath && !openTabs.includes(activePath)) openTabs.push(activePath);
      showActive();
      render();
      if (msg.senderId !== selfId && msg.senderName && msg.op !== 'set_entry') {
        const label = { create_file: 'created', create_folder: 'created folder', delete: 'deleted', rename: 'renamed' }[msg.op];
        if (label) showToast(`${msg.senderName} ${label} ${msg.path}${msg.to ? ` → ${msg.to}` : ''}`);
      }
    }

    // ---- Actions ----
    function openFile(path) {
      if (!contents.has(path)) return;
      if (!openTabs.includes(path)) openTabs.push(path);
      activePath = path;
      for (const folder of tree.folders) if (isWithin(path, folder) && folder !== path) expanded.add(folder);
      selectedFolder = dirName(path);
      showActive();
      render();
      if (editor) editor.focus();
    }

    function closeTab(path) {
      const index = openTabs.indexOf(path);
      if (index < 0) return;
      openTabs.splice(index, 1);
      if (activePath === path) activePath = openTabs[Math.min(index, openTabs.length - 1)] || null;
      showActive();
      render();
    }

    function op(payload) {
      flush();
      sendWs({ type: 'file_op', stageId, ...payload });
    }

    function promptNewFile(folder = selectedFolder) {
      const name = prompt('New file path (use "/" for folders):', folder ? `${folder}/` : '');
      if (name && name.trim() && !name.trim().endsWith('/')) op({ op: 'create_file', path: name.trim(), content: '' });
    }
    function promptNewFolder(folder = selectedFolder) {
      const name = prompt('New folder path:', folder ? `${folder}/` : '');
      if (name && name.trim()) op({ op: 'create_folder', path: name.trim() });
    }
    function promptRename(path) {
      const next = prompt(`Rename or move "${path}" to:`, path);
      if (next && next.trim() && next.trim() !== path) op({ op: 'rename', path, to: next.trim() });
    }
    function confirmDelete(path, isFolder) {
      if (confirm(isFolder ? `Delete folder "${path}" and everything in it?` : `Delete "${path}"?`)) op({ op: 'delete', path });
    }

    // ---- Rendering ----
    function buildTree() {
      const rootNode = { name: '', path: '', folders: new Map(), files: [] };
      const ensure = (folderPath) => {
        let node = rootNode;
        if (!folderPath) return node;
        let current = '';
        for (const part of folderPath.split('/')) {
          current = current ? `${current}/${part}` : part;
          if (!node.folders.has(part)) node.folders.set(part, { name: part, path: current, folders: new Map(), files: [] });
          node = node.folders.get(part);
        }
        return node;
      };
      for (const folder of tree.folders) ensure(folder);
      for (const path of tree.paths) ensure(dirName(path)).files.push(path);
      return rootNode;
    }

    function renderNode(node, depth, container) {
      const folders = [...node.folders.values()].sort((a, b) => a.name.localeCompare(b.name));
      for (const folder of folders) {
        const row = document.createElement('div');
        const open = expanded.has(folder.path);
        row.className = `ws-row ws-folder${selectedFolder === folder.path ? ' selected' : ''}`;
        row.style.paddingLeft = `${8 + depth * 14}px`;
        row.dataset.path = folder.path;
        row.dataset.kind = 'folder';
        row.draggable = true;
        row.innerHTML = `<span class="ws-twisty">${open ? '▾' : '▸'}</span><span class="ws-icon">${open ? '📂' : '📁'}</span><span class="ws-name"></span>`;
        row.querySelector('.ws-name').textContent = folder.name;
        row.title = folder.path;
        container.appendChild(row);
        if (open) renderNode(folder, depth + 1, container);
      }
      for (const path of node.files.sort((a, b) => baseName(a).localeCompare(baseName(b)))) {
        const row = document.createElement('div');
        row.className = `ws-row ws-file${path === activePath ? ' active' : ''}`;
        row.style.paddingLeft = `${22 + depth * 14}px`;
        row.dataset.path = path;
        row.dataset.kind = 'file';
        row.draggable = true;
        row.innerHTML = `<span class="ws-icon">${iconFor(path)}</span><span class="ws-name"></span>${path === tree.entryFile ? '<span class="ws-entry" title="Entry file: Run starts here">▶</span>' : ''}`;
        row.querySelector('.ws-name').textContent = baseName(path);
        row.title = path;
        container.appendChild(row);
      }
    }

    function render() {
      const list = explorerEl.querySelector('.ws-tree');
      list.replaceChildren();
      renderNode(buildTree(), 0, list);
      if (!tree.paths.length && !tree.folders.length) {
        const empty = document.createElement('div');
        empty.className = 'ws-empty';
        empty.textContent = 'No files yet. Create one with the + buttons.';
        list.appendChild(empty);
      }
      tabsEl.replaceChildren(...openTabs.map((path) => {
        const tab = document.createElement('div');
        tab.className = `ws-tab${path === activePath ? ' active' : ''}`;
        tab.dataset.path = path;
        tab.title = path;
        tab.innerHTML = `<span class="ws-icon">${iconFor(path)}</span><span class="ws-tab-name"></span>${path === tree.entryFile ? '<span class="ws-entry">▶</span>' : ''}<button type="button" class="ws-tab-close" title="Close">×</button>`;
        tab.querySelector('.ws-tab-name').textContent = baseName(path);
        return tab;
      }));
      onActiveFileChange(activePath, tree.entryFile);
    }

    function closeContextMenu() {
      if (contextMenu) contextMenu.remove();
      contextMenu = null;
    }

    function showContextMenu(event, path, kind) {
      event.preventDefault();
      closeContextMenu();
      const folder = kind === 'folder' ? path : (path ? dirName(path) : '');
      const items = [
        ['New File…', () => promptNewFile(folder)],
        ['New Folder…', () => promptNewFolder(folder)]
      ];
      if (path) {
        if (kind === 'file' && RUNNABLE.test(path) && path !== tree.entryFile) items.push(['Set as Entry File', () => op({ op: 'set_entry', path })]);
        items.push(['Rename / Move…', () => promptRename(path)], ['Delete', () => confirmDelete(path, kind === 'folder')]);
      }
      contextMenu = document.createElement('div');
      contextMenu.className = 'ws-context-menu';
      for (const [label, action] of items) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = label;
        button.addEventListener('click', () => { closeContextMenu(); action(); });
        contextMenu.appendChild(button);
      }
      document.body.appendChild(contextMenu);
      const { innerWidth, innerHeight } = window;
      const rect = contextMenu.getBoundingClientRect();
      contextMenu.style.left = `${Math.min(event.clientX, innerWidth - rect.width - 4)}px`;
      contextMenu.style.top = `${Math.min(event.clientY, innerHeight - rect.height - 4)}px`;
    }

    // ---- Events ----
    const list = explorerEl.querySelector('.ws-tree');
    list.addEventListener('click', (event) => {
      const row = event.target.closest('.ws-row');
      if (!row) { selectedFolder = ''; render(); return; }
      if (row.dataset.kind === 'folder') {
        const path = row.dataset.path;
        selectedFolder = path;
        if (expanded.has(path)) expanded.delete(path); else expanded.add(path);
        render();
      } else {
        openFile(row.dataset.path);
      }
    });
    list.addEventListener('contextmenu', (event) => {
      const row = event.target.closest('.ws-row');
      showContextMenu(event, row?.dataset.path || '', row?.dataset.kind || 'root');
    });
    let dragPath = null;
    list.addEventListener('dragstart', (event) => {
      const row = event.target.closest('.ws-row');
      dragPath = row?.dataset.path || null;
      if (dragPath) event.dataTransfer.setData('text/plain', dragPath);
    });
    list.addEventListener('dragover', (event) => {
      if (!dragPath) return;
      event.preventDefault();
      list.querySelectorAll('.drop-target').forEach((el) => el.classList.remove('drop-target'));
      const row = event.target.closest('.ws-row');
      (row?.dataset.kind === 'folder' ? row : list).classList.add('drop-target');
    });
    list.addEventListener('dragleave', () => list.querySelectorAll('.drop-target').forEach((el) => el.classList.remove('drop-target')));
    list.addEventListener('drop', (event) => {
      event.preventDefault();
      list.classList.remove('drop-target');
      list.querySelectorAll('.drop-target').forEach((el) => el.classList.remove('drop-target'));
      const row = event.target.closest('.ws-row');
      const targetFolder = row?.dataset.kind === 'folder' ? row.dataset.path : (row ? dirName(row.dataset.path) : '');
      const from = dragPath;
      dragPath = null;
      if (!from || isWithin(targetFolder, from)) return;
      const to = targetFolder ? `${targetFolder}/${baseName(from)}` : baseName(from);
      if (to !== from) op({ op: 'rename', path: from, to });
    });
    list.addEventListener('dragend', () => { dragPath = null; });

    tabsEl.addEventListener('click', (event) => {
      const tab = event.target.closest('.ws-tab');
      if (!tab) return;
      if (event.target.closest('.ws-tab-close')) closeTab(tab.dataset.path);
      else openFile(tab.dataset.path);
    });
    tabsEl.addEventListener('auxclick', (event) => {
      const tab = event.target.closest('.ws-tab');
      if (tab && event.button === 1) closeTab(tab.dataset.path);
    });
    explorerEl.querySelector('[data-action="new-file"]').addEventListener('click', () => promptNewFile());
    explorerEl.querySelector('[data-action="new-folder"]').addEventListener('click', () => promptNewFolder());
    explorerEl.querySelector('[data-action="collapse"]').addEventListener('click', () => { expanded.clear(); render(); });
    document.addEventListener('click', (event) => { if (contextMenu && !contextMenu.contains(event.target)) closeContextMenu(); });
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeContextMenu(); });

    return {
      attach,
      load,
      flush,
      applyFileUpdate,
      applyOp,
      activePath: () => activePath,
      entryFile: () => tree.entryFile,
      stageId: () => stageId
    };
  }

  root.WebCoderWorkspace = { createWorkspaceController };
})(window);
