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
- **Monaco Workspace:** a multi-file editor with folders, tabs, drag-and-drop moves, live collaboration, and per-stage file trees. Runs build the whole project in the sandbox from a chosen entry file.
- **Bring-your-own AI agents:** participants can connect their own Claude Code, Claude Desktop, claude.ai, or other MCP client to a room. Agents chat with people in the room's AI panel, read the question and code, edit files, and run code, all visible to everyone. The interviewer decides who may connect agents, enabling AI-enabled interviews.
- **Administrator MCP tools:** an optional authenticated MCP endpoint lets agents create rooms and add, edit, reorder, switch, or delete questions, with live updates for participants.
- **Persistent rooms:** SQLite stores room content and browser-linked participant roles across server restarts. VS Code files live in a persistent container volume.
- **Container-based execution:** classic-editor runs use temporary containers with resource limits and no network access.

### Two workspace options

Choose a layout when creating a room:

| Layout | Experience | Best suited to |
| --- | --- | --- |
| **Classic CoderPad** | Resizable problem, Monaco editor, and output/input panels with live collaboration | Focused coding questions and algorithm interviews |
| **Monaco Workspace** | The classic panels plus a file explorer with folders and editor tabs; no extra container needed | Multi-file exercises such as small projects, refactoring, and code reading |
| **Real VS Code Server** | OpenVSCode Server in a per-room container, with a terminal, language tools, and a persistent project folder | Exercises involving multiple files and a fuller development environment |

The VS Code workspace starts with an empty `/home/workspace/interview` folder. Its image includes Python/Pyright, C/C++ clangd, Java support, Go tools, Rust Analyzer, and Prettier, alongside built-in JavaScript/TypeScript support. The classic editor's synchronized buffers and interview panels are a separate experience from the VS Code workspace.

### Supported languages

The classic editor and Monaco Workspace compile or run code using the tools installed in the sandbox image:

| Language | Execution |
| --- | --- |
| Python | Python 3 |
| JavaScript | Node.js |
| C++ | `g++` with C++20 |
| Java | `javac` and `java`, with automatic class-name detection |
| Go | `go build` |
| Rust | `rustc` with edition 2021 |

The sandbox uses Debian Bookworm packages; exact runtime versions depend on the built image. Runs have no network access, so dependencies must already be available inside the image.

### Monaco Workspace

Choose **Monaco Workspace** as the layout when creating a room. A blank room starts with a small multi-file project in the selected language; a problem preset starts with that preset's starter file. Each stage has its own file tree, so moving to another question gives everyone a fresh project and returning restores the earlier files.

- Use **+ File** and **+ Folder**, or right-click the explorer for New File, New Folder, Rename / Move, Delete, and **Set as Entry File**. Type paths such as `src/util/math.py` to create folders on the way. Drag files or folders onto another folder to move them.
- Everyone can edit files and run code; edits, file operations, and cursors synchronize live. **Reset Workspace** (interviewer only) replaces the stage's files with the starter project.
- **Run** copies the workspace into a fresh sandbox and starts from the entry file (marked ▶):

| Entry file | Build and run |
| --- | --- |
| `.py` / `.js` | Runs the entry file from the project root, so imports of other project files work |
| `.cpp` / `.cc` / `.cxx` | Compiles the entry file plus every other C++ source that does not define its own `main()`; includes resolve from the project root |
| `.java` | Compiles all `.java` files and runs the entry file's class, including its `package` |
| `.go` | Builds the entry file's package; with a root `go.mod`, module-local imports work (no downloads) |
| `.rs` | Compiles the entry file with `rustc`; `mod` declarations load sibling files |

Workspaces are limited to 200 files, 200 folders, 8 nesting levels, 512 KiB per file, and 4 MiB in total. Runs use the compiled-language limits below.

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
| `MCP_TOKEN` | unset (disabled) | Bearer token granting administrator access to MCP room and question tools |
| `MCP_ALLOWED_ORIGINS` | empty | Comma-separated browser Origin values allowed on authenticated MCP requests (administrator and room agent endpoints); requests without Origin are accepted |
| `VSCODE_IMAGE` | `webcoder-vscode:latest` | Image used for VS Code room containers |

`npm start` and `npm run dev` also read an optional `.env` file in the project directory (see [`.env.example`](.env.example)); variables already set in the shell take precedence. For example, to keep a fixed local address for a reverse proxy or tunnel:

```bash
cp .env.example .env   # HOST=127.0.0.1, PORT=31311
npm start
```

Or, to listen locally on a different port for one run:

```bash
HOST=127.0.0.1 PORT=8080 npm start
```

### Participants' AI agents (AI-enabled interviews)

Anyone allowed by the room's AI policy can connect their own AI agent to a Classic CoderPad or Monaco Workspace room. No server configuration or model API key is needed: the agent runs in the participant's own Claude Code, Claude Desktop, claude.ai, or other MCP client, and connects to WebCoder's room-scoped MCP endpoint.

1. Open the **AI** tab next to **Output**. The interviewer chooses who may connect agents: **Off**, **Interviewers only** (the default), or **Everyone (AI-enabled)**.
2. Click **+ Connect your Claude**, name the agent, and create the connection. Copy the setup immediately; its token is shown only once:
   - **Claude Code:** `claude mcp add --transport http webcoder-room https://your-host/mcp/agent --header "Authorization: Bearer wca_…"`
   - **Claude Desktop / claude.ai:** add a custom connector with the URL `https://your-host/mcp/agent/wca_…`. claude.ai connects from the internet, so the server must have a public HTTPS address.
   - **Other clients:** Streamable HTTP at `/mcp/agent` with the `Authorization: Bearer` header.
3. Ask the agent to join, for example: “Use the webcoder-room tools: call get_context, introduce yourself with send_message, then keep listening with wait_for_messages and reply to what people ask in the room.”

Messages typed in the AI panel's chat reach every connected agent, and agent replies appear there. Everyone in the room sees all chat messages, and agent file edits, runs, and question changes appear as activity lines, so the interviewer can follow how the candidate works with AI.

| Tool | Layout | Purpose |
| --- | --- | --- |
| `get_context` | All | Active question, code or file tree, stdin, last output, participants, agents, and latest chat message ID |
| `send_message` / `read_messages` | All | Post to and read the room chat (Markdown supported) |
| `wait_for_messages` | All | Wait up to 55 seconds for new messages from others after `afterId` |
| `run_code` | All | Run like the Run button; output is shown to everyone and returned |
| `read_code` / `write_code` / `edit_code` | Classic | Read, replace, or search-and-replace a language buffer of the active question |
| `list_files` / `read_file` / `write_file` / `edit_file` | Workspace | Read and change workspace files |
| `create_folder` / `rename_path` / `delete_path` / `set_entry_file` | Workspace | Manage the file tree and the file `run_code` starts from |
| `set_question` | All | Replace the active question's Markdown; offered only to interviewers' agents |

Security model:

- A connection token acts as the participant who created it, with that participant's **current** role, and only in that room. It works while the room's AI policy allows that role. Interviewers' agents can change the question; interviewees' agents cannot.
- Tokens are stored hashed. They are not affected by room password changes, so revoke connections you no longer trust: owners and interviewers can **Revoke** any listed agent, which takes effect immediately. A room can have up to 10 connections.
- The custom-connector URL contains the token. Treat it like a password and avoid logging request URLs in any reverse proxy in front of WebCoder. Prefer the header form where the client supports it.
- Browser requests with an Origin header are refused unless listed in `MCP_ALLOWED_ORIGINS`.

### Administrator MCP

WebCoder exposes a stateless Streamable HTTP MCP endpoint at **`/mcp`** on the same port as the website. It is disabled unless `MCP_TOKEN` is set. Generate a secret, store it in your service environment, and restart WebCoder:

```bash
openssl rand -hex 32
# Set MCP_TOKEN to the generated value in your environment or service configuration.
MCP_TOKEN="your-generated-secret" npm start
```

Connect an MCP client that supports Streamable HTTP and custom authorization headers. A representative client configuration is below; the exact configuration format depends on your agent:

```json
{
  "mcpServers": {
    "webcoder": {
      "url": "http://127.0.0.1:3000/mcp",
      "headers": {
        "Authorization": "Bearer your-generated-secret"
      }
    }
  }
}
```

Use your HTTPS website URL when connecting remotely. This endpoint uses a configured bearer token, not an OAuth sign-in flow. **The token grants administrator access to all rooms, including password-protected rooms**, independently of browser participant roles. Keep it private. Rotate it by changing `MCP_TOKEN` and restarting. Room passwords still control browser access; returned room links do not bypass them. Tokens are accepted only in the Authorization header, never in URLs. Browser requests carrying an Origin header are denied unless that exact origin appears in `MCP_ALLOWED_ORIGINS`; native agent clients normally omit Origin.

| Tool | Purpose |
| --- | --- |
| `list_rooms` | List recent room summaries (`limit`, default 30, maximum 100) |
| `get_room` | Read a room's current live questions and code using `roomId` |
| `create_room` | Create a room with `title`, optional `language`, `password`, and `layout` (`legacy` or `workspace`); return its room and relative link |
| `rename_room` | Update a room's `title` |
| `add_question` | Append a question with `title`, `promptMarkdown`, optional per-language `starterCode`, and optional `activate` (default false) |
| `edit_question` | Update `title` and/or `promptMarkdown` using `roomId` and `stageId` |
| `set_question_code` | Explicitly replace one question's current code buffer using `language` and `code` |
| `switch_question` | Switch everyone's active stage using `stageId` |
| `reorder_questions` | Supply all question IDs exactly once in `stageIds` |
| `delete_question` | Delete a stage and its code; the last stage cannot be deleted |

Question tools operate on Classic CoderPad and Monaco Workspace rooms; new questions in workspace rooms start with the starter project, and `set_question_code` applies only to Classic rooms. `get_room` returns stage IDs in `room.stages`; each stage is a question with independent code buffers. Prompt/title edits preserve candidate code. Adding a question leaves the current stage active unless `activate: true` is supplied. Only `set_question_code` explicitly replaces existing code; it can overwrite candidate work, so use it intentionally. Deleting the active question selects a neighboring stage and restores that stage's code. All successful edits are saved before returning and broadcast to connected participants. The existing limits apply: 20 stages per room, 80 characters per title, 262,144 characters per Markdown prompt, and 524,288 characters per language's code buffer. MCP request bodies are limited to 4 MiB.

For example, ask your agent: “Read this room, clarify the first question's examples, and add a harder Python follow-up without switching the candidate to it.” The agent can call `get_room`, `edit_question`, and `add_question` in sequence. The agent generates the content; WebCoder provides the editing tools and does not require a model API key.

### Hosting

Place an HTTPS reverse proxy or Cloudflare Tunnel in front of the server when sharing it remotely. Forward HTTP traffic and WebSocket upgrades to the configured host and port; live collaboration and the VS Code proxy use WebSockets.

An example systemd unit is provided in [`deploy/webcoder.service`](deploy/webcoder.service). Adjust its user, working directory, Node executable, host, and port to match your machine before installing it. The service account needs access to the container runtime and write access to the `data/` directory.

### Persistence

- **Room content and roles:** `data/webcoder.db`, created automatically on startup. SQLite uses write-ahead logging. Workspace files, the AI policy, room chat (the latest 2,000 messages per room), and hashed agent tokens are stored there too.
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
│   ├── mcp.js               # Administrator MCP room and question tools
│   ├── room-mcp.js          # Room-scoped MCP endpoint for participants' agents
│   ├── presets.js           # Problem presets and language starter code
│   ├── runner.js            # Temporary containers for single-file and workspace runs
│   ├── workspace.js         # Multi-file workspace model, validation, and starters
│   └── vscode.js            # Per-room VS Code containers and volumes
├── sandbox/
│   ├── Dockerfile           # Classic execution image
│   └── vscode.Dockerfile    # OpenVSCode Server image and language tools
├── deploy/                  # Example systemd service
├── data/                    # Runtime SQLite database
├── server.js                # HTTP routes, WebSockets, and reverse proxy
└── package.json             # Dependencies and development commands
```
