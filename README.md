# WebCoder — Collaborative Interview Coding Pad

A lightweight, real-time collaborative CoderPad clone built for conducting technical interviews in **Python 3**, **JavaScript (Node.js)**, **C++20**, **Java 17**, **Go**, and **Rust**, with isolated container execution.

## Features

- **6 Languages Supported**:
  - **Python 3** (`python3` 3.11)
  - **JavaScript** (`node` 18)
  - **C++20** (`g++ -O2 -std=c++20`)
  - **Java 17** (`javac` + `java` OpenJDK 17 — automatically detects public/main class name)
  - **Go** (`go` 1.19)
  - **Rust** (`rustc` 1.63, edition 2021)
- **Isolated Container Sandbox**:
  - Runs each execution inside an ephemeral container (`webcoder-sandbox:latest` via `podman` or `docker`) with:
    - `--network=none` (no internet/network access — std library only, no external packages)
    - `--memory` 256m (interpreted) / 512m (compiled), `--memory-swap` equal, `--cpus=1.0`, `--pids-limit=64`
    - `--read-only` root filesystem with ephemeral in-memory `tmpfs` `/workspace` and `/tmp`
    - `--cap-drop=ALL --security-opt=no-new-privileges`
    - Hard timeout of 10s (interpreted) / 20s (compiled, to allow compilation) and a 128 KB output cap
- **Real-Time Collaboration**:
  - Live code synchronization per language (each language's buffer is preserved independently when switching)
  - Live remote participant cursors & text selections, color-coded per user, in Monaco Editor
  - Collaborative **Problem Prompt** panel with live Markdown preview, Markdown editor, and built-in problem presets (*Two Sum*, *LRU Cache*, *Merge Intervals*, *Number of Islands*, *Blank/Custom*)
  - Shared **Program Output** & **Custom Stdin** console
  - Shared **Interview Stopwatch** (`Start` / `Pause` / `Reset`) in the top bar
- **Interviewer / Interviewee Roles**:
  - The first person to enter a room (the room creator) becomes the **Interviewer**; everyone else joins as **Interviewee**.
  - Roles are **sticky** — tied to a per-browser identity stored in `localStorage` and persisted in SQLite, so they survive reconnects, page reloads, and server restarts.
  - **Interviewer-only controls** (enforced server-side): edit/load the problem prompt, load problem presets, rename the room, reset starter code, control the timer, and promote/demote other participants (click their name pill in the top bar).
  - **Everyone can**: edit code, run code, switch language, edit custom stdin, clear output, and rename themselves.
- **Two Layouts Per Room**:
  - **Classic CoderPad** (default): a resizable 3-pane layout (Problem | Editor | Output+stdin).
  - **Real VS Code Server**: a full VS Code instance in an isolated container, opening the room’s persistent `/home/workspace/interview` folder automatically. The folder starts empty, and files created during the interview are retained on rejoin.
  - VS Code includes Python + Pyright, C/C++ clangd, Java language support, Go, Rust Analyzer, and Prettier, alongside built-in JavaScript/TypeScript support. Go tools (`gopls`, Delve), clangd, Java 21, and Rust with standard library sources are installed in the image.
  - Chosen when creating a room via the lobby's "Editor Layout" selector.
  - Rooms using the retired custom VS Code layout now open in CoderPad with their saved content preserved.
- **Blank / Custom Preset by Default**:
  - New rooms start with the custom problem prompt and basic language starter code. Problem presets remain available in the lobby and room.
- **Zero-Config SQLite Persistence**:
  - Uses Node's built-in `node:sqlite` (`data/webcoder.db`) so rooms and code persist across restarts.

## Quick Start

1. **Build the sandbox container image** (already built on this machine):
   ```bash
   npm run build:sandbox
   ```

2. **Start the server**:
   ```bash
   npm start
   ```
   By default, the server listens on `http://0.0.0.0:3000`. To use a custom port:
   ```bash
   PORT=8080 npm start
   ```

3. **Cloudflare Tunnel**:
   Point your Cloudflare Tunnel ingress to `http://localhost:3000` (WebSockets work automatically over `wss://`).

> **Note:** If port `3000` is already in use (e.g., by another container or service on this VPS), start the server on a different port and point your tunnel there instead:
> ```bash
> PORT=8080 npm start
> ```

To build the VS Code image with its language extensions and tools:

```bash
npm run build:vscode
```

Bundled extensions live outside the room volume. Recreate existing VS Code room containers after rebuilding to pick up image changes; their named workspace volumes retain interview files.
