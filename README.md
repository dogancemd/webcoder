# WebCoder

**A self-hosted coding workspace for live technical interviews.**

WebCoder brings the problem statement, shared code editor, program output, and interview timer into one browser-based room. Create a room, share its link, and work through a problem together in Python, JavaScript, C++, Java, Go, or Rust.

The project aims to make technical interviews easy to host on your own infrastructure: candidates can start coding without a local development setup, interviewers can guide the session, and work is saved for later. It combines a focused CoderPad-style experience with an optional full VS Code workspace for file-based exercises.

[Features](#features) · [Quick start](#quick-start) · [Configuration](#configuration) · [How-it-works](#how-it-works) · [Development](#development)

## Features

- **Live collaboration:** shared code, participant cursors and selections, custom stdin, and program output in the classic editor. Each language keeps its own code buffer.
- **Interview tools:** a Markdown problem statement with preview, a shared stopwatch, and built-in exercises including Two Sum, LRU Cache, Merge Intervals, and Number of Islands. New rooms default to a blank/custom prompt with starter code.
- **Question images:** interviewers can use **Add Image**, paste, or drop PNG, JPEG, GIF, and WebP images (up to 5 MB) into the problem panel. Uploaded images are saved with the room and inserted into the current stage's prompt. Markdown image links such as `![Diagram](https://example.com/diagram.png)` also work.
- **Multi-stage interviews:** CoderPad rooms support up to 20 named stages, each with its own saved problem prompt and code buffers for every language. New stages start with fresh starter code, and switching back restores that stage's code. Only interviewers can add, rename, remove, or switch stages. Everyone follows the active stage in real time; the selected language, stdin, output, and timer are shared across stages. Existing rooms retain their code when upgraded.
- **Optional room passwords:** protect room pages, live state, API data, and the VS Code workspace. Browser unlocks last 24 hours; changing the password invalidates existing unlocks and invite links. **Copy Invite Link** embeds a signed token so invitees join without typing the password.
- **Interviewer controls:** manage the prompt, load presets, rename the room, reset starter code, control the timer, and promote or demote participants. Everyone can edit and run code. If no interviewer is currently present, any participant can use **Become Interviewer** to take over.
- **Persistent rooms:** SQLite stores room content and browser-linked participant roles across server restarts. VS Code files live in a persistent container volume.
- **Container-based execution:** classic-editor runs use temporary containers with resource limits and no network access.

### Two workspace options

Choose a layout when creating a room:

| Layout | Experience | Best suited to |
| --- | --- | --- |
| **Classic CoderPad** | Resizable problem, Monaco editor, and output/input panels with live collaboration | Focused coding questions and algorithm interviews |
| **Real VS Code Server** | OpenVSCode Server in a per-room container, with a terminal, language tools, and a persistent project folder | Exercises involving multiple files and a fuller development environment |

The VS Code workspace starts with an empty `/home/workspace/interview` folder. Its image includes Python/Pyright, C/C++ clangd, Java support, Go tools, Rust Analyzer, and Prettier, alongside built-in JavaScript/TypeScript support. The classic editor's synchronized buffers and interview panels are a separate experience from the VS Code workspace.

### Supported languages

The classic editor compiles or runs code using the tools installed in the sandbox image:

| Language | Execution |
| --- | --- |
| Python | Python 3 |
| JavaScript | Node.js |
| C++ | `g++` with C++20 |
| Java | `javac` and `java`, with automatic class-name detection |
| Go | `go build` |
| Rust | `rustc` with edition 2021 |

The sandbox uses Debian Bookworm packages; exact runtime versions depend on the built image. Runs have no network access, so dependencies must already be available inside the image.

## Quick start

### Prerequisites

- **Node.js 24** with npm, for the server and its built-in `node:sqlite` module.
- **Podman or Docker**, installed and usable by the account running WebCoder.
- Internet access to install dependencies and build container images. The classic editor also loads Monaco from a CDN in the browser.

### Install and run

From the repository directory:

```bash
npm ci
npm run build:sandbox
npm start
```

Open **[http://localhost:3000](http://localhost:3000)** in your browser.

The build script tries Podman first, then Docker. The server also prefers Podman when both are installed, so make sure the image is available in the runtime the server selects.

To enable the optional VS Code layout, build its image as well:

```bash
npm run build:vscode
```

### Start an interview

1. Create a room from the lobby and choose a language, problem preset, and editor layout.
2. Add a room password if desired.
3. Enter the room and share its URL with the other participant. Use **Copy Invite Link** to generate a link that unlocks the room automatically.
4. In the classic editor, edit code together, supply custom input, and run it to see shared results.

The first participant to enter a room becomes the interviewer. Roles are associated with an identity stored in that browser's `localStorage` and persisted in SQLite; using a different browser or clearing browser storage creates a different identity. If the interviewer has left, an interviewee can claim the role with **Become Interviewer**.

In the CoderPad layout, use **+ Add Stage** to create a stage, then write its prompt in **Edit Markdown** or load a preset. Use the stage selector or **Previous** / **Next** to move everyone to another stage. Each stage's prompt and code, along with the selected stage, are saved with the room. Loading a preset or resetting starter code changes only the active stage. Removing a stage deletes its prompt and code.

## Configuration

Set environment variables when starting the server:

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | Address the HTTP server binds to |
| `PORT` | `3000` | HTTP port |
| `SANDBOX_IMAGE` | `webcoder-sandbox:latest` | Image used for classic-editor code execution |
| `VSCODE_IMAGE` | `webcoder-vscode:latest` | Image used for VS Code room containers |

For example, to listen locally on a different port:

```bash
HOST=127.0.0.1 PORT=8080 npm start
```

### Hosting

Place an HTTPS reverse proxy or Cloudflare Tunnel in front of the server when sharing it remotely. Forward HTTP traffic and WebSocket upgrades to the configured host and port; live collaboration and the VS Code proxy use WebSockets.

An example systemd unit is provided in [`deploy/webcoder.service`](deploy/webcoder.service). Adjust its user, working directory, Node executable, host, and port to match your machine before installing it. The service account needs access to the container runtime and write access to the `data/` directory.

### Persistence

- **Room content and roles:** `data/webcoder.db`, created automatically on startup. SQLite uses write-ahead logging.
- **Uploaded question images:** `data/uploads/<roomId>/`, retained across restarts and protected by the room password. Include this directory in backups; deleting a room deletes its uploaded images.
- **VS Code workspace files:** named container volumes following `webcoder-vscode-<roomId>`. These are retained when a session container is removed.
- **Interview timer:** held in server memory; it is not persisted across server restarts.

Back up both the SQLite database and the VS Code volumes if you need to retain all interview work. Use a SQLite-aware backup or stop the server before copying database files.

After rebuilding the VS Code image, recreate existing room containers to use the updated tools and extensions. Retain their named volumes to preserve workspace files.

## How it works

The browser connects to a Node.js HTTP and WebSocket server. The server distributes classic-editor room updates to connected participants and saves room content to SQLite. Code execution launches a fresh sandbox container and returns its output to the room.

For VS Code rooms, the server starts a dedicated OpenVSCode Server container and proxies browser traffic to its localhost-only port. Each room mounts its own persistent workspace volume.

### Classic execution limits

| Resource | Python / JavaScript | C++ / Java / Go / Rust |
| --- | --- | --- |
| Time limit | 10 seconds | 20 seconds, including compilation |
| Memory | 256 MiB | 512 MiB |
| CPU | 1 CPU | 1 CPU |
| Process limit | 64 | 64 |
| Captured output | 128 KiB each for stdout and stderr | 128 KiB each for stdout and stderr |

The server allows up to four simultaneous classic code executions. Sandbox containers run as a non-root user with no network, a read-only root filesystem, temporary writable directories, dropped capabilities, and privilege escalation disabled.

VS Code containers have separate limits of 1 GiB memory, 2 CPUs, and 512 processes. They provide a persistent development environment and do not use the classic runner's network restrictions or per-run timeout.

## Development

Run the server with automatic restarts when source files change:

```bash
npm run dev
```

The frontend is plain HTML, CSS, and JavaScript served directly by Node.js; there is no frontend build step. The server uses `ws` for WebSockets, `http-proxy` for VS Code traffic, and Node's built-in SQLite support.

```text
webcoder/
├── public/                  # Lobby, room pages, styles, and browser logic
├── src/
│   ├── auth.js              # Room passwords and signed access cookies
│   ├── db.js                # SQLite schema, persistence, and participant roles
│   ├── presets.js           # Problem presets and language starter code
│   ├── runner.js            # Temporary containers for code execution
│   └── vscode.js            # Per-room VS Code containers and volumes
├── sandbox/
│   ├── Dockerfile           # Classic execution image
│   └── vscode.Dockerfile    # OpenVSCode Server image and language tools
├── deploy/                  # Example systemd service
├── data/                    # Runtime SQLite database
├── server.js                # HTTP routes, WebSockets, and reverse proxy
└── package.json             # Dependencies and development commands
```
