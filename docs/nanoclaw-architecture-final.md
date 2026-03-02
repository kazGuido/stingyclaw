# Stingyclaw Architecture

> This document describes the current architecture of Stingyclaw — a fork of NanoClaw that replaces the proprietary Claude SDK with a model-agnostic OpenAI-compatible agent loop.

---

## Overview

One Node.js host process manages WhatsApp, SQLite, and the task scheduler. For each incoming message, it spawns an isolated Docker container that runs the agent loop. The container exits when idle. Voice is handled by a separate persistent FastAPI container.

```
WhatsApp (baileys)
    │
    ▼
SQLite (messages.db)
    │
    ▼
Host polling loop (src/index.ts)
    │
    ├── Voice note? → Voice Service (/transcribe, Whisper-small)
    │
    ▼
GroupQueue → spawns Docker container per group
    │
    ▼
Agent Container (nanoclaw-agent:latest)
    ├── Primary model: OpenRouter / Ollama
    ├── Tool registry (tool-registry.json) — single source of truth;
    │   tools filtered by context (main = all; others = tools-enabled.json or default)
    ├── Tool executor (Bash, Read, Write, …); confirmation_required → ask_boss preview
    ├── Audit log → /workspace/ipc/audit.jsonl (who, when, tool, success, result size)
    └── Workflow registry (groups/*/workflows/registry.json)
    │
    ▼ IPC (file-based)
    │
    ├── send_message → WhatsApp text reply
    └── send_voice → Voice Service (/synthesize, LFM2.5-Audio TTS) → WhatsApp PTT
```

---

## Host Process (`src/`)

### `src/index.ts` — Orchestrator

The main entry point. Owns:
- Loading registered groups from SQLite
- Starting the WhatsApp channel
- Running the message polling loop
- Starting the task scheduler
- Invoking the GroupQueue for each incoming message
- Wiring up error notifications (sends WhatsApp message on agent failure)

**Key state:**
- `registeredGroups` — map of JID → group config
- `lastAgentTimestamp` — per-group cursor into the message DB (persisted to disk)
- `sessions` — per-group session ID (persisted to disk)

### `src/group-queue.ts` — Concurrency Controller

Manages container lifecycle and retry logic:
- **One container per group at a time** — concurrent messages for the same group are queued
- **Max concurrency** (`MAX_CONCURRENT_CONTAINERS`) — prevents runaway spawning
- **Exponential backoff retry** — up to `MAX_RETRIES` (5) on failure, delays: 5s, 10s, 20s, 40s, 80s
- **Error notification** — calls `onMaxRetriesExceeded` callback when giving up; host sends WhatsApp message with the error

### `src/container-runner.ts` — Container Spawner

Builds and launches the Docker container for each agent invocation:

**Volume mounts per container:**
```
groups/{name}/             → /workspace/group        (rw)
groups/global/             → /workspace/global       (ro)
data/sessions/{group}/     → /home/node/.stingyclaw  (rw)
data/ipc/{group}/          → /workspace/ipc          (rw)
container/agent-runner/src → /app/src                (rw, synced on spawn)
Additional dirs             → /workspace/extra/*     (validated against allowlist)
```

**Secret passing:** API keys are never written to disk. They're passed via stdin as JSON alongside the message payload. The container reads them once and discards them.

**Agent-runner source sync:** On every container spawn, the host copies `container/agent-runner/src/` into `data/sessions/{group}/agent-runner-src/` and mounts it as `/app/src`. This means code changes to the agent-runner take effect immediately without rebuilding the image.

### `src/channels/whatsapp.ts` — WhatsApp Channel

Maintains the Baileys WebSocket connection:
- Stores incoming messages in SQLite
- Sends text replies and voice notes (OGG/PTT format)
- Auto-updates WhatsApp Web version on 405/408 errors (fetches from web, persists to disk)
- Exponential backoff reconnect: 2s → 5s → 15s → 30s → 60s

### `src/ipc.ts` — IPC Watcher

File-based inter-process communication between container and host:
- Watches `data/ipc/{group}/messages/` for outbound text messages from agent
- Watches `data/ipc/{group}/voice/` for outbound voice synthesis requests
- Watches `data/ipc/{group}/tasks/` for `schedule_task` / `register_group` commands
- Watches `data/ipc/{group}/input/` for inbound messages piped to active container

### `src/task-scheduler.ts` — Scheduler

Polls SQLite every minute for due tasks:
- Supports cron expressions, intervals (ms), and one-time ISO timestamps
- Spawns agent containers in the group's context
- Records run history (duration, result) in SQLite

### `src/transcription.ts` — Voice Client

HTTP client for the voice service:
- `POST /transcribe` — sends audio bytes, receives transcript text
- `POST /synthesize` — sends text, receives OGG audio bytes

---

## Agent Container (`container/agent-runner/src/index.ts`)

The agent loop runs inside the container. It receives a JSON payload via stdin containing the message, session ID, group config, and secrets.

### Tool registry and enabled tools

- **Single source of truth**: `container/agent-runner/tool-registry.json` — every tool’s name, description, parameters, and optional `confirmation_required` / `destructive`.
- **Filtering**: Only tools **enabled for this context** are sent to the model. **Main group**: all tools. **Other groups**: either `groups/<name>/tools-enabled.json` (JSON array of tool names) or the registry’s `defaultEnabledNonMain` list.
- **Confirmation**: For tools with `confirmation_required`, the runner does not execute immediately; it sends an ask_boss-style preview to the user and treats the next message as yes/no before running.
- **Audit**: Every tool call is appended to `/workspace/ipc/audit.jsonl` (ts, groupFolder, chatJid, tool, success, resultSizeBytes). On the host this is `data/ipc/<group>/audit.jsonl`.

Optional MCP exposure of the same tools is described in [MCP-ROADMAP.md](MCP-ROADMAP.md).

### Backend Selection

Priority order (first key found wins):
1. `OPENROUTER_API_KEY=ollama` → Ollama (local, fully offline)
2. `OPENROUTER_API_KEY` set → OpenRouter

### Agent Loop

```
1. Load tool registry; build tool list for this context (getToolsForContext).
2. Build system prompt (MISSION.md from group + global + agent capabilities).
3. If session has pendingConfirmation and prompt is user reply → execute or cancel pending tool, then continue.
4. Else append new user message.
5. Loop:
   a. Sanitize messages for API compat (strip refusal:null, empty content).
   b. Call model API (tools: filtered list, tool_choice: auto).
   c. If tool calls → for each: if confirmation_required → set pendingConfirmation, return confirmation_required to host; else execute, audit log, append results.
   d. If text response → stream to host via OUTPUT_START/END markers.
   e. If finish_reason=stop → break.
6. Save session; exit (or wait for next IPC message if multi-turn).
```

On 400 errors with many messages: auto-trims session to last 10 and retries once.

### Tools (from registry)

| Tool | Implementation |
|------|---------------|
| `Bash` | `child_process.execSync` inside container sandbox *(confirmation_required)* |
| `Read` / `Write` / `Edit` | Direct filesystem ops in `/workspace/` *(Write/Edit: confirmation_required)* |
| `Grep` / `Glob` | `ripgrep` binary + `glob` package |
| `WebFetch` | `fetch()` with HTML→markdown conversion |
| `agent-browser` | Playwright-based Chromium CLI (`agent-browser` npm package) |
| `send_message` | Writes JSON file to `/workspace/ipc/messages/` |
| `send_voice` | Writes JSON file to `/workspace/ipc/voice/` |
| `ask_boss` | Sends message asking user, waits for reply via IPC input |
| `schedule_task` | Writes JSON file to `/workspace/ipc/tasks/` |
| `register_group` | Writes to IPC; main only *(confirmation_required)* |
| `list_tasks` / `pause_task` / `resume_task` / `cancel_task` | IPC to host |
| `reset_session` | Deletes session file; writes clear_session IPC |
| `list_workflows` | Reads `registry.json` from group's workflows dir |
| `search_tools` | Semantic search over registry using local `all-MiniLM-L6-v2` embeddings |
| `run_workflow` | Executes shell script from registry *(confirmation_required)* |

### Workflow Registry

Each group can define automations in `groups/{name}/workflows/registry.json`:

```json
[
  {
    "name": "morning-briefing",
    "description": "Daily weather and news summary",
    "run": "bash morning-briefing.sh",
    "args": []
  }
]
```

The agent's decision flow:
1. User intent arrives
2. `search_tools(intent)` — semantic search (local embeddings, no API call)
3. If match found → `run_workflow(name)` → execute script → reply
4. If no match → agent uses built-in tools or answers directly

Embeddings use `Xenova/all-MiniLM-L6-v2` (quantized, ~23MB), baked into the image, cached in `.embeddings-cache.json`.

---

## Voice Service (`container/voice-service/`)

A FastAPI Python service running in its own persistent Docker container.

| Endpoint | Model | Input | Output |
|----------|-------|-------|--------|
| `POST /transcribe` | LFM2.5-Audio-1.5B (GGUF, CPU) | Audio file upload | `{"text": "..."}` |
| `POST /synthesize` | LFM2.5-Audio-1.5B (GGUF, CPU) | `{"text": "..."}` | OGG audio bytes |
| `GET /health` | — | — | `{"status": "ok"}` |

- Backbone: llama.cpp compatible GGUF via `llama-cpp-python` — CPU efficient, no heavy PyTorch inference
- Audio codec: FastConformer encoder + Mimi detokenizer (CPU PyTorch)
- Single model handles both ASR and TTS — no separate Whisper
- Model downloaded on first request, cached in Docker volume (`voice-models`)

---

## Memory System (`MISSION.md`)

Each group has a `groups/{name}/MISSION.md` injected into every system prompt. This is the agent's per-group persona and standing instructions.

```
groups/
  global/
    MISSION.md        ← read by ALL groups (read-only for non-main)
  main/
    MISSION.md        ← main group persona + admin instructions
    workflows/
      registry.json
      morning-briefing.sh
  {other-group}/
    MISSION.md        ← group-specific persona
    workflows/
      registry.json
```

Global `MISSION.md` is writable only from the main group.

---

## Session Management

Sessions are stored as JSON at `data/sessions/{group}/.stingyclaw/sessions/{uuid}.json`:

```json
{
  "messages": [
    {"role": "user", "content": "..."},
    {"role": "assistant", "content": "..."},
    {"role": "assistant", "tool_calls": [...]},
    {"role": "tool", "tool_call_id": "...", "content": "..."}
  ]
}
```

Sessions persist across container restarts. The session ID is tracked per group by the host.

**Gemini compatibility notes:**
- `content: ""` on assistant messages with `tool_calls` is stripped before sending
- `refusal`, `reasoning`, `reasoning_details` fields are stripped (OpenAI-only)
- On 400 errors, session is auto-trimmed to last 10 messages

---

## IPC Protocol

All host↔container communication uses JSON files dropped into watched directories. This avoids network ports and complex protocols.

```
data/ipc/{group}/
  messages/          ← agent writes here → host sends WhatsApp message
  voice/             ← agent writes here → host synthesizes + sends voice
  tasks/             ← agent writes here → host creates/modifies scheduled task
  input/             ← host writes here → agent reads during idle wait
    _close           ← sentinel to shut down active container
```

---

## Data Directory

```
data/
  sessions/
    {group}/
      .stingyclaw/
        sessions/
          {uuid}.json     ← conversation history (may include pendingConfirmation)
        transformers/     ← embedding model cache
  ipc/
    {group}/              ← IPC file exchange
      audit.jsonl         ← tool call audit log (one JSON line per call)
store/
  messages.db             ← SQLite: messages, groups, tasks, chats
  auth/                   ← WhatsApp session auth (never mounted into containers)
logs/
  nanoclaw.log
  nanoclaw.error.log
groups/
  {name}/
    MISSION.md
    workflows/
      registry.json
      *.sh / *.py / *.js
```

---

## Docker Images

| Image | Size | Purpose |
|-------|------|---------|
| `nanoclaw-agent:latest` | ~2.5GB | Agent runner (Node + ripgrep + Chromium + embedding model) |
| `stingyclaw-voice:latest` | ~3GB | Voice service (LFM2.5-Audio-1.5B GGUF — handles ASR + TTS) |

Agent image is rebuilt with:
```bash
docker build -t nanoclaw-agent:latest -f container/Dockerfile container/
```

Voice image:
```bash
docker compose build voice
docker compose up -d voice
```

---

## Configuration

All config lives in `.env`:

```bash
# Model backend (auto-detected by priority)
OPENROUTER_API_KEY=sk-or-v1-... # OpenRouter (100+ models, free tiers available)
# OPENROUTER_API_KEY=ollama     # Or: local Ollama

MODEL_NAME=stepfun/step-3.5-flash:free  # Any OpenRouter model slug
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1

ASSISTANT_NAME=Clawman           # Trigger word @Clawman
TZ=Europe/Brussels               # Timezone injected into containers
```
