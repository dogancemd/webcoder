const { spawn, execFileSync } = require('node:child_process');
const http = require('node:http');
const crypto = require('node:crypto');
const { CONTAINER_RUNTIME } = require('./runner');

const IMAGE = process.env.VSCODE_IMAGE || 'webcoder-vscode:latest';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Runs a real VS Code server (openvscode-server) in an isolated container, one
// per room, reachable only via the main server's reverse proxy.
class VSCodeSession {
  constructor(roomId) {
    this.roomId = roomId;
    const safe = String(roomId).replace(/[^a-zA-Z0-9_-]/g, '') || 'room';
    this.containerName = `webcoder-vscode-${safe}-${crypto.randomBytes(4).toString('hex')}`;
    this.volumeName = `webcoder-vscode-${safe}`;
    this.port = null; // host port mapped from container's 3000
    this.starting = null;
  }

  get basePath() {
    return `/vsroom/${this.roomId}`;
  }

  ensure() {
    if (this.port) return Promise.resolve(this.port);
    if (this.starting) return this.starting;
    this.starting = this._start().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  async _start() {
    if (!CONTAINER_RUNTIME) {
      throw new Error('No container runtime (podman/docker) available.');
    }

    await new Promise((resolve, reject) => {
      const child = spawn(
        CONTAINER_RUNTIME,
        [
          'run', '-d', '--name', this.containerName,
          '-p', '127.0.0.1::3000',            // map container 3000 -> random localhost port
          '-v', `${this.volumeName}:/home/workspace`,
          '--memory=1g',
          '--cpus=2.0',
          '--pids-limit=512',
          IMAGE,
          '--server-base-path', this.basePath,
          '--extensions-dir', '/opt/webcoder/extensions',
          '--accept-server-license-terms',
          '--telemetry-level', 'off'
        ],
        { stdio: ['ignore', 'ignore', 'pipe'] }
      );
      let err = '';
      child.stderr.on('data', (d) => {
        err += d.toString();
      });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error((err || `podman run exited ${code}`).trim()));
      });
    });

    // Create an empty project folder on first use; retain interview files on rejoin.
    execFileSync(
      CONTAINER_RUNTIME,
      ['exec', this.containerName, 'mkdir', '-p', '/home/workspace/interview'],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );

    // Resolve the host port that podman assigned to container port 3000
    for (let i = 0; i < 60; i++) {
      try {
        const out = execFileSync(
          CONTAINER_RUNTIME,
          ['port', this.containerName, '3000/tcp'],
          { stdio: ['ignore', 'pipe', 'ignore'] }
        ).toString().trim();
        const m = out.match(/:(\d+)$/);
        if (m) {
          this.port = Number(m[1]);
          break;
        }
      } catch {
        // not ready yet
      }
      await sleep(250);
    }
    if (!this.port) {
      throw new Error('Timed out resolving VS Code server port.');
    }

    // Wait for the openvscode-server process to actually start listening
    await this._waitUntilReady();
    return this.port;
  }

  async _waitUntilReady() {
    const url = `http://127.0.0.1:${this.port}${this.basePath}/`;
    for (let i = 0; i < 120; i++) {
      const ok = await new Promise((resolve) => {
        const req = http.get(url, (res) => {
          res.resume();
          resolve(res.statusCode < 500);
        });
        req.on('error', () => resolve(false));
        req.setTimeout(1000, () => {
          req.destroy();
          resolve(false);
        });
      });
      if (ok) return;
      await sleep(500);
    }
    throw new Error('VS Code server did not become ready in time.');
  }

  destroy() {
    this.port = null;
    if (CONTAINER_RUNTIME && this.containerName) {
      const child = spawn(CONTAINER_RUNTIME, ['rm', '-f', '-t', '2', this.containerName], {
        stdio: 'ignore'
      });
      child.on('error', () => {});
    }
    // Note: the named volume is intentionally kept so a rejoined room retains
    // its workspace files.
  }
}

// roomId -> VSCodeSession
const sessions = new Map();

function getVSCodeSession(roomId) {
  let s = sessions.get(roomId);
  if (!s) {
    s = new VSCodeSession(roomId);
    sessions.set(roomId, s);
  }
  return s;
}

function destroyVSCodeSession(roomId) {
  const s = sessions.get(roomId);
  if (s) {
    s.destroy();
    sessions.delete(roomId);
  }
}

module.exports = {
  getVSCodeSession,
  destroyVSCodeSession
};
