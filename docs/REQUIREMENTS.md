# Stingyclaw Requirements

Original requirements and design decisions — updated to reflect the current fork.

---

## Why This Exists

[NanoClaw](https://github.com/qwibitai/nanoclaw) gave us the core: a personal AI assistant that lives in WhatsApp, runs agents in isolated Docker containers, and uses file-based IPC to keep things simple. The problem was it required a paid Anthropic subscription and was locked to Claude via a proprietary SDK.

**Stingyclaw** removes that dependency entirely. The agent loop is a plain `openai`-package implementation that works with any OpenAI-compatible endpoint — OpenRouter (100+ models, free tiers) or local Ollama. Zero paid API requirements.

The name is a pun: stingy, as in unwilling to pay for AI.

---

## Philosophy

### Small Enough to Understand

One Node.js host process. A handful of source files. No microservices, no message queues, no abstraction layers. The entire `src/` directory is under 600 lines of meaningful logic.

### Security Through True Isolation

Agents run in actual Linux containers. The isolation is at the OS level. Agents can only see what's explicitly mounted. Bash access is safe because commands run inside the container, not on the host.

### Built for One User

This is working software for personal use, not a platform or framework. It supports WhatsApp because that's what the original author used. Add what you need, cut what you don't.

### Customization = Code Changes

No configuration sprawl. If you want different behavior, change the code. The codebase is small enough that this is safe and practical. Very few things are in config — mostly API keys and the trigger word.

### AI-Native Development

You have a capable AI collaborator (the bot itself, Cursor, etc.). The codebase doesn't need to be excessively self-documenting or self-healing. Describe a problem, fix it. The agent can help debug itself.

### Workflows Over Hardcoded Features

Instead of adding every capability to the agent runner, define shell scripts and register them in `registry.json`. The agent discovers them via semantic search and executes them as needed. A morning briefing, a Slack notification, a CRM pull — all just scripts.

---

## Vision

A personal AI assistant accessible via WhatsApp, with no paid API requirements and full local control.

**Core components:**
- **Model-agnostic agent loop** — OpenRouter or local Ollama
- **Docker containers** for isolated agent execution
- **WhatsApp** as the primary I/O channel
- **Voice in/out** — LFM2.5-Audio-1.5B GGUF (single model for ASR + TTS, CPU)
- **Persistent memory** per group (`MISSION.md`)
- **Scheduled tasks** that run the agent and message back
- **Web access** — WebFetch for static, `agent-browser` (Playwright/Chromium) for JS-heavy pages
- **Workflow registry** — shell scripts as semantic automations

**Implementation approach:**
- Standard `openai` npm package for model calls (OpenAI-compatible)
- File-based IPC between host and containers
- `MISSION.md` for per-group memory (model-agnostic replacement for `CLAUDE.md`)
- Minimal glue code — the agent loop is ~1000 lines including all tools

---

## Architecture Decisions

### Message Routing
- A router listens to WhatsApp and routes messages based on configuration
- Only messages from registered groups are processed
- Trigger: `@{ASSISTANT_NAME}` prefix (configurable via env var)
- Unregistered groups are ignored completely

### Memory System
- **Per-group memory**: Each group has a `groups/{name}/MISSION.md`
- **Global memory**: `groups/global/MISSION.md` is read by all groups, writable only from "main" (self-chat)
- **Files**: Groups can create/read files in their folder
- Agent runs in the group's folder, both MISSION.md files are injected into the system prompt

### Session Management
- Each group maintains a conversation session as a JSON file
- Sessions persist across container restarts
- Session trimming on API errors (auto-trim to last 10 messages on Gemini 400)
- Message sanitization: strips OpenAI-specific fields before sending to Gemini

### Container Isolation
- All agents run inside Docker containers
- Each agent invocation spawns a container with mounted directories
- Containers provide filesystem isolation — agents can only see mounted paths
- Bash access is safe because commands run inside the container, not on the host
- `agent-browser` (Playwright/Chromium) for full browser automation inside the container

### Scheduled Tasks
- Users can ask the agent to schedule recurring or one-time tasks from any group
- Tasks run as full agents in the context of the group that created them
- Tasks can send messages to their group via `send_message` tool, or complete silently
- Schedule types: cron expressions, intervals (ms), or one-time (ISO timestamp)
- Main group can manage tasks for all groups; other groups manage their own only

### Workflow Registry
- Per-group `workflows/registry.json` indexes available shell scripts
- Agent uses semantic search (local embeddings) to find relevant workflows
- Scripts run with args passed as environment variables
- Works offline — embedding model is baked into the agent image

### Group Management
- New groups are added explicitly via the main channel or setup CLI
- Groups are registered in SQLite
- Each group gets a dedicated folder under `groups/`
- Groups can have additional directories mounted via `containerConfig`

### Main Channel Privileges
- Main channel is the admin/control group (typically self-chat)
- Can write to global memory (`groups/global/MISSION.md`)
- Can schedule tasks for any group
- Can view and manage tasks from all groups
- Can configure additional directory mounts for any group

### Error Handling
- On agent failure: exponential backoff retry (5s → 10s → 20s → 40s → 80s)
- After max retries: sends WhatsApp error notification with last error text
- WhatsApp version auto-update on 405/408 auth failures

---

## Integration Points

### WhatsApp
- Using baileys library for WhatsApp Web connection
- Messages stored in SQLite, polled by router
- Pairing code authentication during setup
- Auto-fetches latest WhatsApp Web version to avoid auth failures

### Voice
- Whisper-small (ASR): faster-whisper, CPU inference
- LFM2.5-Audio-1.5B (GGUF): single model for both ASR and TTS, CPU via llama-cpp-python
- Both run in a persistent Docker container via FastAPI

### Scheduler
- Built-in scheduler runs on the host, spawns containers for task execution
- Tools inside container: `schedule_task`, `list_tasks`, `pause_task`, `resume_task`, `cancel_task`
- Tasks stored in SQLite with run history
- Scheduler loop checks for due tasks every minute

### Web Access
- `WebFetch` for static pages (fast, no overhead)
- `agent-browser` (Playwright/Chromium) for JS-heavy pages, login flows, interactive sites

### Workflow Automation
- Shell scripts registered in `groups/{name}/workflows/registry.json`
- Discovered via local semantic embeddings (no API call required)
- Can be bash, Python, Node — anything executable
- Future: MCP client integration for Gmail, GitHub, Slack, etc.

---

## Requirements

- Linux (recommended) or macOS
- Node.js 22+
- Docker + Docker Compose
- OpenRouter API key (free at [openrouter.ai](https://openrouter.ai)) — or local Ollama

---

## Project Name

**Stingyclaw** — a pun fork of NanoClaw. Stingy because it runs on free API credits.
