# Stingyclaw Specification

A personal AI assistant accessible via WhatsApp, with local voice, persistent memory, scheduled tasks, and extensible shell script workflows — zero paid API requirements.

---

## Table of Contents

1. [Architecture](#architecture)
2. [Folder Structure](#folder-structure)
3. [Configuration](#configuration)
4. [Memory System](#memory-system)
5. [Session Management](#session-management)
6. [Message Flow](#message-flow)
7. [Tools](#tools)
8. [Workflows](#workflows)
9. [Scheduled Tasks](#scheduled-tasks)
10. [Voice](#voice)
11. [Deployment](#deployment)
12. [Security Considerations](#security-considerations)

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                           HOST (Linux)                               │
│                      (Main Node.js Process)                          │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ┌──────────────┐                     ┌────────────────────┐        │
│  │  WhatsApp    │────────────────────▶│   SQLite Database  │        │
│  │  (baileys)   │◀────────────────────│   (messages.db)    │        │
│  └──────────────┘   store/send        └─────────┬──────────┘        │
│                                                  │                   │
│         ┌────────────────────────────────────────┘                   │
│         │                                                            │
│         ▼                                                            │
│  ┌──────────────────┐    ┌──────────────────┐    ┌───────────────┐  │
│  │  Message Loop    │    │  Scheduler Loop  │    │  IPC Watcher  │  │
│  │  (polls SQLite)  │    │  (checks tasks)  │    │  (file-based) │  │
│  └────────┬─────────┘    └────────┬─────────┘    └───────────────┘  │
│           │                       │                                  │
│           └───────────┬───────────┘                                  │
│                       │ GroupQueue → spawns container                │
│                       ▼                                              │
├─────────────────────────────────────────────────────────────────────┤
│              AGENT CONTAINER (Docker, per-group)                     │
├─────────────────────────────────────────────────────────────────────┤
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │                    AGENT RUNNER                               │   │
│  │                                                               │   │
│  │  Model: OpenRouter / Ollama                                   │   │
│  │  Volume mounts:                                               │   │
│  │    • groups/{name}/  → /workspace/group  (rw)                 │   │
│  │    • groups/global/  → /workspace/global (ro)                 │   │
│  │    • data/sessions/  → /home/node/.stingyclaw (rw)            │   │
│  │    • data/ipc/       → /workspace/ipc    (rw)                 │   │
│  │    • agent-runner/src → /app/src         (synced on spawn)    │   │
│  │                                                               │   │
│  │  Tools: Bash, Read, Write, Edit, Glob, Grep,                  │   │
│  │         WebFetch, agent-browser,                              │   │
│  │         send_message, send_voice, ask_boss,                   │   │
│  │         schedule_task, list_workflows,                        │   │
│  │         search_tools, run_workflow                            │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
         │ send_voice IPC
         ▼
┌─────────────────────────────────────────────────────────────────────┐
│              VOICE SERVICE (Docker, persistent)                      │
│  FastAPI: /transcribe + /synthesize (LFM2.5-Audio-1.5B GGUF)        │
└─────────────────────────────────────────────────────────────────────┘
```

### Technology Stack

| Component | Technology | Purpose |
|-----------|------------|---------|
| WhatsApp Connection | Node.js (@whiskeysockets/baileys) | Connect to WhatsApp, send/receive |
| Message Storage | SQLite (better-sqlite3) | Store messages for polling |
| Container Runtime | Docker | Isolated agent execution |
| Agent Loop | Plain OpenAI-compatible loop (`openai` package) | Model calls + tool execution |
| Model Backend | OpenRouter / Ollama | LLM inference |
| Browser Automation | agent-browser + Chromium (Playwright) | Web interaction |
| Voice ASR | faster-whisper (Whisper-small, CPU) | Voice note transcription |
| Voice ASR + TTS | LFM2.5-Audio-1.5B GGUF (CPU) | Speech-to-speech via single model |
| Semantic Search | @xenova/transformers (all-MiniLM-L6-v2) | Workflow discovery |

---

## Folder Structure

```
stingyclaw/
├── src/                     # Host process
├── container/
│   ├── Dockerfile            # Agent image
│   ├── agent-runner/src/     # Agent loop (synced at runtime)
│   └── voice-service/        # FastAPI voice server
├── groups/
│   ├── global/MISSION.md     # Shared memory
│   └── {name}/
│       ├── MISSION.md        # Group-specific memory
│       └── workflows/
│           ├── registry.json
│           └── *.sh
├── setup/                   # One-time setup scripts
├── store/
│   ├── messages.db           # SQLite
│   └── auth/                 # WhatsApp session (host-only)
├── data/
│   ├── sessions/             # Agent session history
│   └── ipc/                  # File-based IPC
├── logs/
├── docker-compose.yml        # Voice service
├── MISSION.md                # Project context
└── .env                      # API keys + config
```

---

## Configuration

`.env` file:

```bash
OPENROUTER_API_KEY=sk-or-v1-...     # OpenRouter (100+ models, free tiers)
# OPENROUTER_API_KEY=ollama         # Or: local Ollama

MODEL_NAME=stepfun/step-3.5-flash:free  # Any OpenRouter model slug
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1

ASSISTANT_NAME=Clawman              # Trigger: @Clawman
TZ=Europe/Brussels                  # Timezone for container
```

**Model name rules:**
- For OpenRouter: use slugs like `stepfun/step-3.5-flash:free`, `meta-llama/llama-3.3-70b-instruct:free`
- For Ollama: use model names like `llama3.2`
- Browse free models at [openrouter.ai/models?order=top-weekly&supported_parameters=tools](https://openrouter.ai/models?order=top-weekly&supported_parameters=tools)

---

## Memory System

### MISSION.md (Per-Group Memory)

Each group has a `groups/{name}/MISSION.md` injected into every system prompt. This is the agent's persona and standing instructions for that group.

```
groups/
  global/MISSION.md    ← read by ALL groups; writable only from main
  main/MISSION.md      ← main group persona
  {name}/MISSION.md    ← group-specific persona
```

Keep MISSION.md short — it's sent on every request. For large reference data, let the agent `Read` files on demand.

### Files

The agent's working directory inside the container is `/workspace/group`, which maps to `groups/{name}/` on the host. The agent can create and read files here freely. These files persist across sessions.

---

## Session Management

Sessions are stored as JSON at `data/sessions/{group}/.stingyclaw/sessions/{uuid}.json`:

```json
{
  "messages": [
    {"role": "user", "content": "..."},
    {"role": "assistant", "content": "...", "tool_calls": [...]},
    {"role": "tool", "tool_call_id": "...", "content": "..."},
    {"role": "assistant", "content": "..."}
  ]
}
```

Sessions are resumed on every new message to the group. They accumulate indefinitely.

**Gemini compatibility:** Before each API call, messages are sanitized — empty `content` and OpenAI-specific null fields are stripped. On 400 errors, the session is auto-trimmed to the last 10 messages.

---

## Message Flow

```
1. User sends WhatsApp message (text or voice note)
2. Baileys receives it → stores in SQLite
3. Host polling loop detects new message
4. [If voice] → POST /transcribe to voice service → get transcript
5. GroupQueue: is a container already running for this group?
   └── Yes → send via IPC input file (agent receives mid-session)
   └── No  → spawn new container
6. Container starts → TypeScript compiled → session loaded
7. Agent loop runs until model says stop or MAX_TURNS reached
8. Agent sends reply via send_message or send_voice IPC
9. Container exits → session saved → host picks up next message
```

**Error path:**
- Container fails (non-zero exit) → GroupQueue schedules retry with backoff
- After 5 retries → WhatsApp error notification sent to user → cursor reset

---

## Tools

### Always Available (Built-In)

| Tool | Description |
|------|-------------|
| `Bash` | Run shell commands in container sandbox |
| `Read` | Read file contents |
| `Write` | Write file (create or overwrite) |
| `Edit` | Replace string in file |
| `Grep` | Search file contents (ripgrep) |
| `Glob` | Find files by pattern |
| `WebFetch` | Fetch URL, convert HTML to markdown |
| `agent-browser` | Headless Chromium via CLI (JS pages, click, fill, screenshot) |
| `send_message` | Send WhatsApp text message |
| `send_voice` | Synthesize + send WhatsApp voice note |
| `ask_boss` | Send message to user and wait for their reply |
| `schedule_task` | Create/modify scheduled agent tasks |
| `list_workflows` | List all registered automations |
| `search_tools` | Semantic search over workflow registry |
| `run_workflow` | Execute a workflow by name |

### agent-browser Usage

```bash
# Inside Bash tool:
agent-browser open https://example.com
agent-browser snapshot -i                    # get accessibility tree with refs
agent-browser click @e5
agent-browser fill @e3 "search query"
agent-browser screenshot page.png
```

Use `WebFetch` for simple/static pages. Use `agent-browser` for:
- JavaScript-rendered pages
- Login flows
- Form submission
- Sites that block non-browser requests

---

## Workflows

Pre-built automations the agent discovers and runs via semantic search.

### Registry Format

`groups/{name}/workflows/registry.json`:
```json
[
  {
    "name": "morning-briefing",
    "description": "Daily weather and news summary. Also: morning report, daily briefing.",
    "run": "bash morning-briefing.sh"
  },
  {
    "name": "notify-slack",
    "description": "Send a message to a Slack channel",
    "run": "bash notify-slack.sh",
    "args": ["message", "channel"]
  }
]
```

### Decision Flow

```
User: "morning briefing"
  → search_tools("morning briefing")   [semantic, local embeddings]
  → match found: morning-briefing
  → run_workflow("morning-briefing")
  → bash morning-briefing.sh
  → reply

User: "what's the capital of France?"
  → search_tools("capital of France")  [no match above threshold]
  → model answers directly
```

### Script Execution

Scripts run inside the container:
- Working directory: `/workspace/group/workflows/`
- Args passed as uppercase env vars: `run_workflow("notify-slack", {message: "hello", channel: "#general"})` → `$MESSAGE=hello $CHANNEL=#general bash notify-slack.sh`
- stdout is returned to the model as the tool result
- Timeout: 120 seconds

Scripts can be bash, Python, Node — anything available in the container.

### Embedding

Workflows are embedded locally using `all-MiniLM-L6-v2` (quantized, ~23MB, baked into image). Results are cached in `.embeddings-cache.json`. No API call required.

---

## Scheduled Tasks

Users can ask the agent to schedule tasks:

> "Remind me every morning at 9am with a news briefing"
> "Check the server status every hour and message me if disk is above 80%"

### Schedule Types

| Type | Format | Example |
|------|--------|---------|
| Cron | Standard cron string | `"0 9 * * *"` (daily 9am) |
| Interval | Milliseconds | `3600000` (every hour) |
| One-time | ISO timestamp | `"2026-03-15T10:00:00Z"` |

### Execution

Tasks spawn a full agent container in the group's context. The agent runs the task prompt and can use all tools including `send_message` to report results back.

### Privileges
- Main group: can schedule tasks for any group, view/manage all
- Other groups: own tasks only

---

## Voice

### Input (ASR)

Voice notes are transcribed locally by Whisper-small (CPU) via the voice service. The transcript is prepended with `[Voice: ...]` in the message:

```
[Voice: Hey, what's the weather today?]
```

The agent is instructed to reply with `send_voice` when the user sent a voice note.

### Output (TTS)

`send_voice` → POST `/synthesize` to voice service → LFM2.5-Audio generates audio (GGUF, CPU) → OGG file → WhatsApp PTT voice note.

First synthesis is slow (model downloads ~3GB on first use). Subsequent calls are faster.

---

## Deployment

### Setup

```bash
git clone https://github.com/kazGuido/stingyclaw.git
cd stingyclaw
cp .env.example .env
# Edit .env — set OPENROUTER_API_KEY + MODEL_NAME

bash setup.sh                          # check deps
npx tsx setup/index.ts --step container -- --runtime docker   # build agent image
docker compose up -d voice             # start voice service
npx tsx setup/index.ts --step whatsapp-auth -- --method pairing-code --phone +XXXXXXXXXXX
```

### Running

```bash
npm run build
node dist/index.js >> logs/nanoclaw.log 2>> logs/nanoclaw.error.log &
```

### Updating Agent Code

The agent-runner source (`container/agent-runner/src/`) is synced to the container on every spawn — no image rebuild needed for agent logic changes. Just restart the host process.

For Dockerfile changes (new packages, system deps):
```bash
docker build -t nanoclaw-agent:latest -f container/Dockerfile container/
```

For voice service changes:
```bash
docker compose build --no-cache voice
docker compose up -d voice
```

---

## Security Considerations

See [SECURITY.md](SECURITY.md) for the full security model.

**Key points:**
- Agents run in Docker containers — no access to host filesystem except explicit mounts
- API keys passed via stdin only — never written to disk or mounted as files
- WhatsApp auth (`store/auth/`) is never mounted into containers
- Mount allowlist stored outside project root — agents cannot modify it
- Main group is admin; non-main groups have restricted capabilities
- On agent errors: exponential retry backoff, then WhatsApp error notification
