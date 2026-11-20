// Multi-file workspace model used by the Monaco Workspace layout.
// A workspace is { files: { [path]: content }, folders: [path], entryFile }.
// Paths are relative, '/'-separated and never contain '.' or '..' segments.

const MAX_FILES = 200;
const MAX_FOLDERS = 200;
const MAX_PATH_LENGTH = 200;
const MAX_DEPTH = 8;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_WORKSPACE_BYTES = 4 * 1024 * 1024;

const SEGMENT_RE = /^[A-Za-z0-9_][A-Za-z0-9._ -]{0,63}$/;

const EXTENSION_LANGUAGES = {
  '.py': 'python',
  '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.cpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp',
  '.java': 'java',
  '.go': 'go',
  '.rs': 'rust'
};

function extensionOf(filePath) {
  const base = filePath.slice(filePath.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot).toLowerCase() : '';
}

function languageForPath(filePath) {
  return EXTENSION_LANGUAGES[extensionOf(filePath)] || null;
}

// Returns a normalized path or throws a user-facing error.
function normalizePath(input) {
  if (typeof input !== 'string') throw new Error('A path is required.');
  const trimmed = input.trim().replace(/\\/g, '/').replace(/^\.?\/+/, '').replace(/\/+$/, '');
  if (!trimmed) throw new Error('A path is required.');
  if (trimmed.length > MAX_PATH_LENGTH) throw new Error(`Paths must be ${MAX_PATH_LENGTH} characters or fewer.`);
  const segments = trimmed.split('/');
  if (segments.length > MAX_DEPTH) throw new Error(`Folders can be nested at most ${MAX_DEPTH} levels deep.`);
  for (const segment of segments) {
    if (!SEGMENT_RE.test(segment) || segment.endsWith(' ') || segment.endsWith('.')) {
      throw new Error(`Invalid name "${segment}". Use letters, numbers, spaces, dots, dashes and underscores.`);
    }
  }
  return segments.join('/');
}

function parentsOf(filePath) {
  const parts = filePath.split('/');
  const parents = [];
  for (let i = 1; i < parts.length; i++) parents.push(parts.slice(0, i).join('/'));
  return parents;
}

function isWithin(child, parent) {
  return child === parent || child.startsWith(`${parent}/`);
}

function workspaceBytes(files) {
  let total = 0;
  for (const content of Object.values(files)) total += Buffer.byteLength(content, 'utf8');
  return total;
}

function clone(workspace) {
  return {
    files: { ...(workspace.files || {}) },
    folders: [...(workspace.folders || [])],
    entryFile: workspace.entryFile || ''
  };
}

function checkLimits(ws) {
  if (Object.keys(ws.files).length > MAX_FILES) throw new Error(`A workspace can contain at most ${MAX_FILES} files.`);
  if (ws.folders.length > MAX_FOLDERS) throw new Error(`A workspace can contain at most ${MAX_FOLDERS} folders.`);
  if (workspaceBytes(ws.files) > MAX_WORKSPACE_BYTES) throw new Error('The workspace exceeds its 4 MiB size limit.');
}

function addFolders(ws, paths) {
  const set = new Set(ws.folders);
  for (const p of paths) set.add(p);
  ws.folders = [...set].sort();
}

function assertNoConflict(ws, target) {
  if (Object.hasOwn(ws.files, target)) throw new Error(`A file named "${target}" already exists.`);
  if (ws.folders.includes(target)) throw new Error(`A folder named "${target}" already exists.`);
  for (const parent of parentsOf(target)) {
    if (Object.hasOwn(ws.files, parent)) throw new Error(`"${parent}" is a file, not a folder.`);
  }
}

function fixEntry(ws) {
  if (ws.entryFile && Object.hasOwn(ws.files, ws.entryFile)) return;
  ws.entryFile = pickDefaultEntry(ws.files);
}

function pickDefaultEntry(files) {
  const paths = Object.keys(files).sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
  const preferred = paths.find((p) => /^(main|Main|index|app)\.[a-z]+$/.test(p.slice(p.lastIndexOf('/') + 1)) && languageForPath(p));
  return preferred || paths.find((p) => languageForPath(p)) || '';
}

// ---- Operations: each returns a new workspace or throws, never mutating input ----

function createFile(workspace, rawPath, content = '') {
  const ws = clone(workspace);
  const filePath = normalizePath(rawPath);
  if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) {
    throw new Error('Files must be 512 KiB or smaller.');
  }
  assertNoConflict(ws, filePath);
  ws.files[filePath] = content;
  addFolders(ws, parentsOf(filePath));
  fixEntry(ws);
  checkLimits(ws);
  return { workspace: ws, path: filePath };
}

function createFolder(workspace, rawPath) {
  const ws = clone(workspace);
  const folderPath = normalizePath(rawPath);
  assertNoConflict(ws, folderPath);
  addFolders(ws, [...parentsOf(folderPath), folderPath]);
  checkLimits(ws);
  return { workspace: ws, path: folderPath };
}

function writeFile(workspace, rawPath, content) {
  const ws = clone(workspace);
  const filePath = normalizePath(rawPath);
  if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) {
    throw new Error('Files must be 512 KiB or smaller.');
  }
  if (!Object.hasOwn(ws.files, filePath)) {
    if (ws.folders.includes(filePath)) throw new Error(`"${filePath}" is a folder.`);
    return createFile(workspace, filePath, content);
  }
  ws.files[filePath] = content;
  checkLimits(ws);
  return { workspace: ws, path: filePath, created: false };
}

// Deletes a file, or a folder with everything inside it.
function deletePath(workspace, rawPath) {
  const ws = clone(workspace);
  const target = normalizePath(rawPath);
  const isFile = Object.hasOwn(ws.files, target);
  const isFolder = ws.folders.includes(target);
  if (!isFile && !isFolder) throw new Error(`"${target}" does not exist.`);
  const removed = [];
  for (const filePath of Object.keys(ws.files)) {
    if (isWithin(filePath, target)) { delete ws.files[filePath]; removed.push(filePath); }
  }
  ws.folders = ws.folders.filter((folder) => !isWithin(folder, target));
  fixEntry(ws);
  return { workspace: ws, path: target, removed };
}

// Renames or moves a file or folder (including its contents).
function renamePath(workspace, rawFrom, rawTo) {
  const ws = clone(workspace);
  const from = normalizePath(rawFrom);
  const to = normalizePath(rawTo);
  if (from === to) return { workspace: ws, from, to, moved: [] };
  const isFile = Object.hasOwn(ws.files, from);
  const isFolder = ws.folders.includes(from);
  if (!isFile && !isFolder) throw new Error(`"${from}" does not exist.`);
  if (isFolder && isWithin(to, from)) throw new Error('A folder cannot be moved inside itself.');
  assertNoConflict(ws, to);
  const moved = [];
  const files = {};
  for (const [filePath, content] of Object.entries(ws.files)) {
    if (isWithin(filePath, from)) {
      const next = to + filePath.slice(from.length);
      files[next] = content;
      moved.push([filePath, next]);
    } else {
      files[filePath] = content;
    }
  }
  ws.files = files;
  ws.folders = ws.folders.map((folder) => (isWithin(folder, from) ? to + folder.slice(from.length) : folder));
  addFolders(ws, parentsOf(to));
  for (const [oldPath, newPath] of moved) {
    if (ws.entryFile === oldPath) ws.entryFile = newPath;
  }
  fixEntry(ws);
  for (const filePath of Object.keys(ws.files)) normalizePath(filePath); // depth/length checks
  checkLimits(ws);
  return { workspace: ws, from, to, moved };
}

function setEntryFile(workspace, rawPath) {
  const ws = clone(workspace);
  const filePath = normalizePath(rawPath);
  if (!Object.hasOwn(ws.files, filePath)) throw new Error(`"${filePath}" does not exist.`);
  if (!languageForPath(filePath)) throw new Error('The entry file must be a .py, .js, .cpp, .java, .go or .rs file.');
  ws.entryFile = filePath;
  return { workspace: ws, path: filePath };
}

// Search-and-replace edit for agents; old text must match exactly once unless replaceAll.
function editFile(workspace, rawPath, oldText, newText, replaceAll = false) {
  const filePath = normalizePath(rawPath);
  const current = workspace.files?.[filePath];
  if (current === undefined) throw new Error(`"${filePath}" does not exist.`);
  if (!oldText) throw new Error('oldText must not be empty.');
  const count = current.split(oldText).length - 1;
  if (count === 0) throw new Error('oldText was not found in the file. Read the file again and copy the text exactly.');
  if (count > 1 && !replaceAll) throw new Error(`oldText occurs ${count} times. Add surrounding context or set replaceAll.`);
  const next = replaceAll ? current.split(oldText).join(newText) : current.replace(oldText, () => newText);
  return writeFile(workspace, filePath, next);
}

// Validates and normalizes an untrusted workspace (e.g. from the database or an agent).
function sanitizeWorkspace(input) {
  let ws = { files: {}, folders: [], entryFile: '' };
  if (!input || typeof input !== 'object') return ws;
  for (const folder of Array.isArray(input.folders) ? input.folders : []) {
    try { ws = createFolder(ws, folder).workspace; } catch {}
  }
  for (const [filePath, content] of Object.entries(input.files || {})) {
    try { ws = writeFile(ws, filePath, String(content)).workspace; } catch {}
  }
  if (input.entryFile) {
    try { ws = setEntryFile(ws, input.entryFile).workspace; } catch {}
  }
  fixEntry(ws);
  return ws;
}

const STARTER_WORKSPACES = {
  python: {
    files: {
      'main.py': 'from solution import solve\n\n\nif __name__ == "__main__":\n    print(solve([2, 7, 11, 15], 9))\n',
      'solution.py': 'def solve(nums, target):\n    seen = {}\n    for i, num in enumerate(nums):\n        if target - num in seen:\n            return [seen[target - num], i]\n        seen[num] = i\n    return []\n',
      'tests/test_solution.py': 'import sys\nsys.path.insert(0, ".")\n\nfrom solution import solve\n\nassert solve([3, 2, 4], 6) == [1, 2]\nprint("tests passed")\n'
    },
    entryFile: 'main.py'
  },
  javascript: {
    files: {
      'index.js': "const { solve } = require('./lib/solution');\n\nconsole.log(solve([2, 7, 11, 15], 9));\n",
      'lib/solution.js': 'function solve(nums, target) {\n  const seen = new Map();\n  for (let i = 0; i < nums.length; i++) {\n    if (seen.has(target - nums[i])) return [seen.get(target - nums[i]), i];\n    seen.set(nums[i], i);\n  }\n  return [];\n}\n\nmodule.exports = { solve };\n'
    },
    entryFile: 'index.js'
  },
  cpp: {
    files: {
      'main.cpp': '#include <iostream>\n#include "solution.h"\n\nint main() {\n    for (int x : solve({2, 7, 11, 15}, 9)) std::cout << x << " ";\n    std::cout << std::endl;\n}\n',
      'solution.h': '#pragma once\n#include <vector>\n\nstd::vector<int> solve(const std::vector<int>& nums, int target);\n',
      'solution.cpp': '#include "solution.h"\n#include <unordered_map>\n\nstd::vector<int> solve(const std::vector<int>& nums, int target) {\n    std::unordered_map<int, int> seen;\n    for (int i = 0; i < (int)nums.size(); ++i) {\n        auto it = seen.find(target - nums[i]);\n        if (it != seen.end()) return {it->second, i};\n        seen[nums[i]] = i;\n    }\n    return {};\n}\n'
    },
    entryFile: 'main.cpp'
  },
  java: {
    files: {
      'Main.java': 'import solver.Solution;\nimport java.util.Arrays;\n\npublic class Main {\n    public static void main(String[] args) {\n        System.out.println(Arrays.toString(Solution.solve(new int[]{2, 7, 11, 15}, 9)));\n    }\n}\n',
      'solver/Solution.java': 'package solver;\n\nimport java.util.HashMap;\nimport java.util.Map;\n\npublic class Solution {\n    public static int[] solve(int[] nums, int target) {\n        Map<Integer, Integer> seen = new HashMap<>();\n        for (int i = 0; i < nums.length; i++) {\n            Integer j = seen.get(target - nums[i]);\n            if (j != null) return new int[]{j, i};\n            seen.put(nums[i], i);\n        }\n        return new int[0];\n    }\n}\n'
    },
    entryFile: 'Main.java'
  },
  go: {
    files: {
      'go.mod': 'module interview\n\ngo 1.19\n',
      'main.go': 'package main\n\nimport (\n\t"fmt"\n\n\t"interview/solver"\n)\n\nfunc main() {\n\tfmt.Println(solver.Solve([]int{2, 7, 11, 15}, 9))\n}\n',
      'solver/solver.go': 'package solver\n\nfunc Solve(nums []int, target int) []int {\n\tseen := map[int]int{}\n\tfor i, n := range nums {\n\t\tif j, ok := seen[target-n]; ok {\n\t\t\treturn []int{j, i}\n\t\t}\n\t\tseen[n] = i\n\t}\n\treturn nil\n}\n'
    },
    entryFile: 'main.go'
  },
  rust: {
    files: {
      'main.rs': 'mod solution;\n\nfn main() {\n    println!("{:?}", solution::solve(&[2, 7, 11, 15], 9));\n}\n',
      'solution.rs': 'use std::collections::HashMap;\n\npub fn solve(nums: &[i32], target: i32) -> Vec<usize> {\n    let mut seen = HashMap::new();\n    for (i, n) in nums.iter().enumerate() {\n        if let Some(&j) = seen.get(&(target - n)) {\n            return vec![j, i];\n        }\n        seen.insert(*n, i);\n    }\n    vec![]\n}\n'
    },
    entryFile: 'main.rs'
  }
};

function starterWorkspace(language = 'python') {
  return sanitizeWorkspace(STARTER_WORKSPACES[language] || STARTER_WORKSPACES.python);
}

const PRESET_FILE_NAMES = {
  python: 'main.py', javascript: 'main.js', cpp: 'main.cpp', go: 'main.go', rust: 'main.rs'
};

// Blank presets get a small multi-file project; other presets start from the
// preset's single-file starter code.
function presetWorkspace(preset, language) {
  if (!preset || preset.id === 'blank') return starterWorkspace(language);
  const code = preset.templates[language] || '';
  const javaClass = (code.match(/public\s+class\s+([A-Za-z_$][\w$]*)/) || [])[1] || 'Main';
  const fileName = language === 'java' ? `${javaClass}.java` : (PRESET_FILE_NAMES[language] || 'main.py');
  return createFile({ files: {}, folders: [] }, fileName, code).workspace;
}

module.exports = {
  MAX_FILES,
  MAX_FILE_BYTES,
  MAX_WORKSPACE_BYTES,
  normalizePath,
  languageForPath,
  createFile,
  createFolder,
  writeFile,
  editFile,
  deletePath,
  renamePath,
  setEntryFile,
  sanitizeWorkspace,
  starterWorkspace,
  presetWorkspace,
  pickDefaultEntry
};
