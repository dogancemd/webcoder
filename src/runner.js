const { spawn, execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const { LANGUAGES } = require('./presets');
const { languageForPath } = require('./workspace');

const MAX_OUTPUT_BYTES = 128 * 1024; // 128 KB max stdout/stderr
const MAX_CONCURRENT_RUNS = 4;

// Compiled languages need extra time (for compilation) and memory (for the compiler)
const COMPILED_LANGUAGES = new Set(['cpp', 'java', 'rust', 'go']);
const TIMEOUT_COMPILED_MS = 20000; // 20s (compile + run)
const TIMEOUT_FAST_MS = 10000;     // 10s (interpreted: run only)
const MEMORY_COMPILED = '512m';
const MEMORY_FAST = '256m';

let activeRuns = 0;

function detectContainerRuntime() {
  for (const bin of ['podman', 'docker']) {
    try {
      execFileSync(bin, ['--version'], { stdio: 'ignore' });
      return bin;
    } catch {
      // try next
    }
  }
  return null;
}

const CONTAINER_RUNTIME = detectContainerRuntime();
const SANDBOX_IMAGE = process.env.SANDBOX_IMAGE || 'webcoder-sandbox:latest';

function detectJavaClassName(code) {
  const publicMatch = code.match(/public\s+class\s+([A-Za-z_$][A-Za-z0-9_$]*)/);
  if (publicMatch && publicMatch[1]) {
    return publicMatch[1];
  }
  const classMatch = code.match(/class\s+([A-Za-z_$][A-Za-z0-9_$]*)/);
  if (classMatch && classMatch[1]) {
    return classMatch[1];
  }
  return 'Solution';
}

function buildContainerScript(language, javaClassName) {
  if (language === 'python') {
    return `
read -r CODE_B64
read -r STDIN_B64
printf '%s' "$CODE_B64" | base64 -d > /workspace/main.py
printf '%s' "$STDIN_B64" | base64 -d > /workspace/stdin.txt
export PYTHONIOENCODING=utf-8
exec python3 -u /workspace/main.py < /workspace/stdin.txt
`.trim();
  }

  if (language === 'javascript') {
    return `
read -r CODE_B64
read -r STDIN_B64
printf '%s' "$CODE_B64" | base64 -d > /workspace/main.js
printf '%s' "$STDIN_B64" | base64 -d > /workspace/stdin.txt
export NODE_DISABLE_COLORS=1
exec node /workspace/main.js < /workspace/stdin.txt
`.trim();
  }

  if (language === 'cpp') {
    return `
read -r CODE_B64
read -r STDIN_B64
printf '%s' "$CODE_B64" | base64 -d > /workspace/main.cpp
printf '%s' "$STDIN_B64" | base64 -d > /workspace/stdin.txt
g++ -O2 -std=c++20 -pthread /workspace/main.cpp -o /workspace/main
COMPILE_EXIT=$?
if [ $COMPILE_EXIT -ne 0 ]; then
  exit $COMPILE_EXIT
fi
exec /workspace/main < /workspace/stdin.txt
`.trim();
  }

  if (language === 'java') {
    const safeClass = javaClassName.replace(/[^A-Za-z0-9_$]/g, '') || 'Solution';
    return `
read -r CODE_B64
read -r STDIN_B64
printf '%s' "$CODE_B64" | base64 -d > /workspace/${safeClass}.java
printf '%s' "$STDIN_B64" | base64 -d > /workspace/stdin.txt
javac -encoding UTF-8 -J-Xms32m -J-Xmx128m /workspace/${safeClass}.java
COMPILE_EXIT=$?
if [ $COMPILE_EXIT -ne 0 ]; then
  exit $COMPILE_EXIT
fi
exec java -Xms16m -Xmx160m -cp /workspace ${safeClass} < /workspace/stdin.txt
`.trim();
  }

  if (language === 'go') {
    return `
read -r CODE_B64
read -r STDIN_B64
printf '%s' "$CODE_B64" | base64 -d > /workspace/main.go
printf '%s' "$STDIN_B64" | base64 -d > /workspace/stdin.txt
export GOCACHE=/tmp/gocache
export GOPATH=/tmp/gopath
export GO111MODULE=off
go build -o /workspace/main /workspace/main.go
COMPILE_EXIT=$?
if [ $COMPILE_EXIT -ne 0 ]; then
  exit $COMPILE_EXIT
fi
exec /workspace/main < /workspace/stdin.txt
`.trim();
  }

  if (language === 'rust') {
    return `
read -r CODE_B64
read -r STDIN_B64
printf '%s' "$CODE_B64" | base64 -d > /workspace/main.rs
printf '%s' "$STDIN_B64" | base64 -d > /workspace/stdin.txt
rustc --edition 2021 -O /workspace/main.rs -o /workspace/main
COMPILE_EXIT=$?
if [ $COMPILE_EXIT -ne 0 ]; then
  exit $COMPILE_EXIT
fi
exec /workspace/main < /workspace/stdin.txt
`.trim();
  }

  throw new Error(`Unsupported language: ${language}`);
}

async function executeCode({ language, code, stdin = '' }) {
  if (!LANGUAGES.includes(language)) {
    return {
      ok: false,
      exitCode: 1,
      stdout: '',
      stderr: `Unsupported language "${language}". Supported: ${LANGUAGES.join(', ')}.`,
      durationMs: 0,
      timedOut: false
    };
  }

  if (!CONTAINER_RUNTIME) {
    return {
      ok: false,
      exitCode: 1,
      stdout: '',
      stderr: 'No container runtime (podman or docker) found on host.',
      durationMs: 0,
      timedOut: false
    };
  }

  const isCompiled = COMPILED_LANGUAGES.has(language);
  const javaClassName = language === 'java' ? detectJavaClassName(code || '') : 'Solution';
  const codeB64 = Buffer.from(String(code || ''), 'utf8').toString('base64');
  const stdinB64 = Buffer.from(String(stdin || ''), 'utf8').toString('base64');
  return runInSandbox({
    language,
    script: buildContainerScript(language, javaClassName),
    input: `${codeB64}\n${stdinB64}\n`,
    timeoutMs: isCompiled ? TIMEOUT_COMPILED_MS : TIMEOUT_FAST_MS,
    memoryLimit: isCompiled ? MEMORY_COMPILED : MEMORY_FAST
  });
}

function unavailable(stderr) {
  return { ok: false, exitCode: 1, stdout: '', stderr, durationMs: 0, timedOut: false };
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

// Writes the JSON payload's files into /workspace/project and stdin into /tmp.
const UNPACK_WORKSPACE = `python3 -c '
import json, os, sys
data = json.load(sys.stdin)
root = "/workspace/project"
os.makedirs(root, exist_ok=True)
for folder in data["folders"]:
    full = os.path.normpath(os.path.join(root, folder))
    if not full.startswith(root + "/"): sys.exit("invalid folder path")
    os.makedirs(full, exist_ok=True)
for name, content in data["files"].items():
    full = os.path.normpath(os.path.join(root, name))
    if not full.startswith(root + "/"): sys.exit("invalid file path")
    os.makedirs(os.path.dirname(full), exist_ok=True)
    with open(full, "w", encoding="utf-8") as handle: handle.write(content)
with open("/tmp/stdin.txt", "w", encoding="utf-8") as handle: handle.write(data["stdin"])
' || exit 70
mkdir -p /workspace/build
cd /workspace/project`;

function buildWorkspaceScript(language, entryFile, files) {
  const entry = shellQuote(entryFile);
  const entryDir = shellQuote(entryFile.includes('/') ? entryFile.slice(0, entryFile.lastIndexOf('/')) : '.');
  const run = (command) => `${UNPACK_WORKSPACE}\n${command}`;
  if (language === 'python') {
    return run(`export PYTHONIOENCODING=utf-8 PYTHONDONTWRITEBYTECODE=1\nexec python3 -u ${entry} < /tmp/stdin.txt`);
  }
  if (language === 'javascript') {
    return run(`export NODE_DISABLE_COLORS=1\nexec node ${entry} < /tmp/stdin.txt`);
  }
  if (language === 'cpp') {
    // Compile the entry plus every other source file that does not define its own main().
    return run(`SOURCES=(${entry})
while IFS= read -r -d '' source; do
  [ "$source" = ${entry} ] && continue
  grep -qE '\\bint[[:space:]]+main[[:space:]]*\\(' "$source" || SOURCES+=("$source")
done < <(find . -type f \\( -name '*.cpp' -o -name '*.cc' -o -name '*.cxx' \\) -printf '%P\\0')
g++ -O2 -std=c++20 -pthread -I. "\${SOURCES[@]}" -o /workspace/build/main || exit $?
exec /workspace/build/main < /tmp/stdin.txt`);
  }
  if (language === 'java') {
    const source = files[entryFile] || '';
    const pkg = (source.match(/^\s*package\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*;/m) || [])[1];
    const base = entryFile.slice(entryFile.lastIndexOf('/') + 1).replace(/\.java$/, '');
    const mainClass = shellQuote(pkg ? `${pkg}.${base}` : base);
    return run(`find . -type f -name '*.java' -exec javac -encoding UTF-8 -J-Xms32m -J-Xmx192m -d /workspace/build {} + || exit $?
exec java -Xms16m -Xmx192m -cp /workspace/build ${mainClass} < /tmp/stdin.txt`);
  }
  if (language === 'go') {
    const hasModule = Object.hasOwn(files, 'go.mod');
    const packageDir = entryFile.includes('/') ? `./${entryFile.slice(0, entryFile.lastIndexOf('/'))}` : '.';
    const build = hasModule
      ? `export GO111MODULE=on GOFLAGS="-p=1 -mod=mod" GOPROXY=off\ngo build -o /workspace/build/main ${shellQuote(packageDir)} || exit $?`
      : `export GO111MODULE=off\ncd ${entryDir} && go build -o /workspace/build/main . || exit $?`;
    // One build job keeps the toolchain within the sandbox process limit.
    return run(`export GOCACHE=/tmp/gocache GOPATH=/tmp/gopath GOMAXPROCS=1 GOFLAGS="-p=1"\n${build}\nunset GOMAXPROCS\nexec /workspace/build/main < /tmp/stdin.txt`);
  }
  if (language === 'rust') {
    return run(`rustc --edition 2021 -O ${entry} -o /workspace/build/main || exit $?\nexec /workspace/build/main < /tmp/stdin.txt`);
  }
  throw new Error(`Unsupported language: ${language}`);
}

// Runs a multi-file workspace starting from workspace.entryFile.
async function executeWorkspace({ workspace, stdin = '' }) {
  const entryFile = workspace && workspace.entryFile;
  const language = entryFile ? languageForPath(entryFile) : null;
  if (!entryFile || !Object.hasOwn(workspace.files || {}, entryFile)) {
    return unavailable('No entry file is set. Right-click a source file and choose "Set as Entry File".');
  }
  if (!language) return unavailable('The entry file must be a .py, .js, .cpp, .java, .go or .rs file.');
  if (!CONTAINER_RUNTIME) return unavailable('No container runtime (podman or docker) found on host.');
  return runInSandbox({
    language,
    script: buildWorkspaceScript(language, entryFile, workspace.files),
    input: JSON.stringify({ files: workspace.files, folders: workspace.folders || [], stdin: String(stdin || '') }),
    timeoutMs: TIMEOUT_COMPILED_MS,
    memoryLimit: MEMORY_COMPILED,
    workspaceSize: '160m'
  });
}

function runInSandbox({ language, script, input, timeoutMs, memoryLimit, workspaceSize = '128m' }) {
  if (activeRuns >= MAX_CONCURRENT_RUNS) {
    return Promise.resolve(unavailable('Server is currently busy running maximum concurrent executions. Please try again in a moment.'));
  }
  activeRuns++;
  const startTime = Date.now();
  const runId = crypto.randomBytes(6).toString('hex');
  const containerName = `webcoder-run-${runId}`;
  const args = [
    'run',
    '--rm',
    '-i',
    '--name', containerName,
    '--network=none',
    '--memory=' + memoryLimit,
    '--memory-swap=' + memoryLimit,
    '--cpus=1.0',
    '--pids-limit=64',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges',
    '--read-only',
    '--tmpfs', `/workspace:rw,exec,nosuid,size=${workspaceSize}`,
    '--tmpfs', '/tmp:rw,nosuid,size=64m',
    SANDBOX_IMAGE,
    '/bin/bash',
    '-c',
    script
  ];

  return new Promise((resolve) => {
    let stdoutBuf = Buffer.alloc(0);
    let stderrBuf = Buffer.alloc(0);
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let finished = false;

    const child = spawn(CONTAINER_RUNTIME, args, {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {}
      // Force kill container in case child process was detached
      const killer = spawn(CONTAINER_RUNTIME, ['rm', '-f', '-t', '0', containerName], {
        stdio: 'ignore'
      });
      killer.on('error', () => {});
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      if (stdoutBuf.length < MAX_OUTPUT_BYTES) {
        const remaining = MAX_OUTPUT_BYTES - stdoutBuf.length;
        stdoutBuf = Buffer.concat([stdoutBuf, chunk.subarray(0, remaining)]);
        if (chunk.length > remaining) stdoutTruncated = true;
      } else {
        stdoutTruncated = true;
      }
    });

    child.stderr.on('data', (chunk) => {
      if (stderrBuf.length < MAX_OUTPUT_BYTES) {
        const remaining = MAX_OUTPUT_BYTES - stderrBuf.length;
        stderrBuf = Buffer.concat([stderrBuf, chunk.subarray(0, remaining)]);
        if (chunk.length > remaining) stderrTruncated = true;
      } else {
        stderrTruncated = true;
      }
    });

    const finalize = (exitCode) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeoutHandle);
      activeRuns = Math.max(0, activeRuns - 1);

      const durationMs = Date.now() - startTime;
      let stdout = stdoutBuf.toString('utf8');
      let stderr = stderrBuf.toString('utf8');

      if (stdoutTruncated) {
        stdout += '\n\n[Output truncated at 128 KB limit]';
      }
      if (stderrTruncated) {
        stderr += '\n\n[Error output truncated at 128 KB limit]';
      }
      if (timedOut) {
        stderr = (stderr ? stderr + '\n' : '') + `[Execution Timed Out after ${timeoutMs / 1000}s]`;
      } else if (exitCode === 137) {
        stderr = (stderr ? stderr + '\n' : '') + `[Process terminated (SIGKILL) — Memory limit (${memoryLimit}) or PID limit exceeded]`;
      }

      resolve({
        ok: !timedOut && exitCode === 0,
        exitCode: timedOut ? 124 : (exitCode ?? 1),
        stdout,
        stderr,
        durationMs,
        timedOut,
        language,
        runtime: CONTAINER_RUNTIME
      });
    };

    child.on('error', (err) => {
      stderrBuf = Buffer.from(`Failed to start sandbox container: ${err.message}`);
      finalize(1);
    });

    child.on('close', (code) => {
      finalize(code);
    });

    try {
      child.stdin.write(input);
      child.stdin.end();
    } catch {
      // ignore EPIPE if container exited early
    }
  });
}


module.exports = {
  executeCode,
  executeWorkspace,
  buildWorkspaceScript,
  CONTAINER_RUNTIME,
  SANDBOX_IMAGE
};
