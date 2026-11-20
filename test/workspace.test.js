const test = require('node:test');
const assert = require('node:assert/strict');
const ws = require('../src/workspace');
const { buildWorkspaceScript } = require('../src/runner');

const empty = { files: {}, folders: [], entryFile: '' };

test('normalizes paths and rejects traversal or invalid names', () => {
  assert.equal(ws.normalizePath('./src//a.py'.replace('//', '/')), 'src/a.py');
  assert.equal(ws.normalizePath('/lib/util.js/'), 'lib/util.js');
  for (const bad of ['', '..', 'a/../b', 'a/./b', '.hidden', 'a/b"c', "x'y", 'a\u0000b', 'a/b;rm', 'dir/ trailing ', 'end.']) {
    assert.throws(() => ws.normalizePath(bad), undefined, bad);
  }
  assert.throws(() => ws.normalizePath('a/b/c/d/e/f/g/h/i'), /nested/);
  assert.throws(() => ws.normalizePath('x'.repeat(201)), /200/);
});

test('creates files and folders, adding parents and choosing an entry file', () => {
  let { workspace } = ws.createFile(empty, 'src/lib/util.py', 'x = 1');
  assert.deepEqual(workspace.folders, ['src', 'src/lib']);
  assert.equal(workspace.entryFile, 'src/lib/util.py');
  ({ workspace } = ws.createFile(workspace, 'main.py', 'print(1)'));
  assert.equal(workspace.entryFile, 'src/lib/util.py', 'an existing entry file is kept');
  assert.throws(() => ws.createFile(workspace, 'main.py'), /already exists/);
  assert.throws(() => ws.createFolder(workspace, 'src'), /already exists/);
  assert.throws(() => ws.createFile(workspace, 'main.py/inner.py'), /is a file/);
  assert.equal(empty.folders.length, 0, 'operations never mutate their input');
});

test('renames folders with their contents and keeps the entry file', () => {
  let { workspace } = ws.createFile(empty, 'pkg/a.py', 'a');
  ({ workspace } = ws.createFile(workspace, 'pkg/sub/b.py', 'b'));
  ({ workspace } = ws.setEntryFile(workspace, 'pkg/sub/b.py'));
  const result = ws.renamePath(workspace, 'pkg', 'lib/pkg2');
  assert.deepEqual(Object.keys(result.workspace.files).sort(), ['lib/pkg2/a.py', 'lib/pkg2/sub/b.py']);
  assert.deepEqual(result.workspace.folders, ['lib', 'lib/pkg2', 'lib/pkg2/sub']);
  assert.equal(result.workspace.entryFile, 'lib/pkg2/sub/b.py');
  assert.deepEqual(result.moved, [['pkg/a.py', 'lib/pkg2/a.py'], ['pkg/sub/b.py', 'lib/pkg2/sub/b.py']]);
  assert.throws(() => ws.renamePath(workspace, 'pkg', 'pkg/inner'), /inside itself/);
  assert.throws(() => ws.renamePath(workspace, 'missing', 'x'), /does not exist/);
});

test('deletes folders recursively and repairs a removed entry file', () => {
  let { workspace } = ws.createFile(empty, 'main.py', 'm');
  ({ workspace } = ws.createFile(workspace, 'tests/t.py', 't'));
  ({ workspace } = ws.setEntryFile(workspace, 'tests/t.py'));
  const result = ws.deletePath(workspace, 'tests');
  assert.deepEqual(Object.keys(result.workspace.files), ['main.py']);
  assert.deepEqual(result.workspace.folders, []);
  assert.deepEqual(result.removed, ['tests/t.py']);
  assert.equal(result.workspace.entryFile, 'main.py');
});

test('edit_file replaces exactly one match unless replaceAll is set', () => {
  const { workspace } = ws.createFile(empty, 'a.py', 'x = 1\nx = 1\ny = 2\n');
  assert.throws(() => ws.editFile(workspace, 'a.py', 'x = 1', 'x = 3'), /occurs 2 times/);
  assert.throws(() => ws.editFile(workspace, 'a.py', 'z', 'q'), /not found/);
  assert.equal(ws.editFile(workspace, 'a.py', 'y = 2', 'y = $&').workspace.files['a.py'], 'x = 1\nx = 1\ny = $&\n');
  assert.equal(ws.editFile(workspace, 'a.py', 'x = 1', 'x = 3', true).workspace.files['a.py'], 'x = 3\nx = 3\ny = 2\n');
});

test('enforces file, count and size limits', () => {
  assert.throws(() => ws.createFile(empty, 'big.txt', 'x'.repeat(ws.MAX_FILE_BYTES + 1)), /512 KiB/);
  let workspace = empty;
  for (let i = 0; i < ws.MAX_FILES; i++) workspace = ws.createFile(workspace, `f${i}.txt`, '').workspace;
  assert.throws(() => ws.createFile(workspace, 'one-more.txt', ''), /at most/);
  assert.throws(() => ws.setEntryFile(workspace, 'f1.txt'), /entry file must be/);
});

test('sanitizes stored workspaces and provides runnable starters', () => {
  const clean = ws.sanitizeWorkspace({ files: { '../evil.py': 'x', 'ok.py': 'y' }, folders: ['a/../b', 'docs'], entryFile: '../evil.py' });
  assert.deepEqual(clean, { files: { 'ok.py': 'y' }, folders: ['docs'], entryFile: 'ok.py' });
  for (const language of ['python', 'javascript', 'cpp', 'java', 'go', 'rust']) {
    const starter = ws.starterWorkspace(language);
    assert.ok(Object.keys(starter.files).length >= 2, language);
    assert.equal(ws.languageForPath(starter.entryFile), language);
  }
});

test('workspace run scripts quote paths and derive the Java main class', () => {
  const script = buildWorkspaceScript('python', 'my dir/main file.py', {});
  assert.match(script, /exec python3 -u 'my dir\/main file\.py'/);
  const java = buildWorkspaceScript('java', 'app/Main.java', { 'app/Main.java': 'package com.example.app;\nclass Main {}' });
  assert.match(java, /'com\.example\.app\.Main'/);
  assert.match(buildWorkspaceScript('go', 'cmd/main.go', { 'go.mod': 'module x' }), /go build -o \/workspace\/build\/main '\.\/cmd'/);
});
