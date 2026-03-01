<p align="center">
  <img src="assets/stingyclaw-logo.png" alt="Stingyclaw" width="600">
</p>

<p align="center">
  <strong>Your personal WhatsApp AI — free models, real voice, real automation.</strong><br>
  Because great AI shouldn't require a corporate credit card.
</p>

---

## The story

[NanoClaw](https://github.com/qwibitai/nanoclaw) is a brilliant little project: a personal AI assistant that lives in WhatsApp, runs in a Docker container, and uses Claude to do the thinking. The problem? Claude costs money. Real money. And the agent SDK it used was proprietary, locking you into Anthropic's ecosystem entirely.

**Stingyclaw** is the broke developer's fork.

The goal was simple: rip out everything that requires a paid subscription, replace it with free alternatives that are *actually good*, and add the features we actually wanted — voice notes in and out, a browser that handles real websites, and a way to define custom automations without writing a new tool every time.

The result: a WhatsApp assistant that runs on free Gemini API credits, speaks and listens locally, browses the web like a real browser, and can execute your own shell scripts on command — all from your phone, all containerized, all yours.

The name? Stingyclaw is a play on being stingy. We took the claw and made it pinch pennies.

---

## What's different from upstream

|  | Upstream NanoClaw | Stingyclaw |
|---|---|---|
| **Model** | Claude only (Anthropic subscription) | Any model: Gemini, OpenRouter, Ollama |
| **Agent loop** | Proprietary Claude SDK | Plain `openai` package (OpenAI-compatible) |
| **Docker image** | ~1.5GB | ~2GB (includes Chromium for browser automation) |
| **Cost** | Requires paid Anthropic access | Free tier on Gemini/OpenRouter, or fully local |
| **Voice input** | Not supported | ✅ Local Whisper ASR |
| **Voice output** | Not supported | ✅ Local Qwen3-TTS (natural, LLM-based) |
| **Browser** | Not supported | ✅ `agent-browser` (Playwright/Chromium, JS-capable) |
| **Workflows** | Not supported | ✅ Semantic registry — shell scripts as automations |
| **Memory files** | `CLAUDE.md` | `MISSION.md` (model-agnostic) |

---

## Quick Start

```bash
git clone https://github.com/kazGuido/stingyclaw.git
cd stingyclaw
cp .env.example .env
# Edit .env — set GEMINI_API_KEY (or OPENROUTER_API_KEY)
```

Setup steps:
```bash
bash setup.sh                                                                  # check Node + deps
npx tsx setup/index.ts --step container -- --runtime docker                    # build agent image
docker compose up -d voice                                                     # start voice service
npx tsx setup/index.ts --step whatsapp-auth -- --method pairing-code --phone +3212345678
npx tsx setup/index.ts --step service                                          # install systemd service
```

---

## Model config (`.env`)

Stingyclaw auto-detects your backend from which keys are set. `GEMINI_API_KEY` takes priority.

```bash
# Option 1: Gemini direct (recommended — free, fast, excellent tool use)
GEMINI_API_KEY=AIza...          # free at aistudio.google.com
# MODEL_NAME=gemini-2.5-flash  # default
# MODEL_NAME=gemini-2.5-pro    # stronger reasoning, lower free limits

# Option 2: OpenRouter (access to 100+ models)
# OPENROUTER_API_KEY=sk-or-v1-...
# MODEL_NAME=liquid/lfm-2.5         # fast, free
# MODEL_NAME=meta-llama/llama-3.3-70b-instruct:free

# Option 3: Local Ollama (fully offline)
# OPENROUTER_API_KEY=ollama
# MODEL_NAME=llama3.2
# OPENROUTER_BASE_URL=http://host.docker.internal:11434/v1
```

---

## How it works

When you send a WhatsApp message (or voice note), here's what happens:

1. **Voice?** → transcribed locally by Whisper (no cloud, no cost)
2. **Text lands in SQLite** → the host polling loop picks it up
3. **A Docker container spawns** for that group — isolated, ephemeral
4. **The agent loop runs** — the model picks tools, runs them, loops until done
5. **Reply goes out** — text or voice (Qwen3-TTS renders natural speech locally)
6. **Container exits** — sessions are saved, resumed next time

Every group is fully isolated: its own container, its own files, its own `MISSION.md` persona, its own workflow scripts.

```
WhatsApp message
    ↓ voice note?
Voice Service (Docker)  ← Whisper-small ASR (CPU)
    ↓ [Voice: transcript]
SQLite → Host polling loop
    ↓
Agent Container (Docker, isolated per-group)
    ├── Primary model (Gemini / OpenRouter / Ollama)
    ├── Built-in tools: Bash, Read, Write, Edit, Grep, Glob,
    │                   WebFetch, agent-browser, send_message,
    │                   send_voice, ask_boss, schedule_task,
    │                   list_workflows, search_tools, run_workflow
    └── Workflow registry (groups/*/workflows/registry.json)
    ↓ send_voice IPC
Voice Service → Qwen3-TTS → OGG → WhatsApp PTT reply
```

One Node.js host process. Each message spawns an isolated Docker container. The container exits after the conversation goes idle. Sessions are persisted and resumed.

---

## Agent capabilities

### Built-in tools (always available)

| Tool | What it does |
|------|-------------|
| `Bash` | Run any shell command in the group sandbox |
| `Read` / `Write` / `Edit` | File operations in `/workspace/group/` |
| `Grep` / `Glob` | Search files |
| `WebFetch` | Fetch static pages (fast, no JS) |
| `agent-browser` | Full headless browser via Bash — JS pages, click, fill, screenshot |
| `send_message` | Send WhatsApp text mid-task (progress updates) |
| `send_voice` | Send WhatsApp voice note (Qwen3-TTS) |
| `ask_boss` | Ask the user for guidance before risky actions |
| `schedule_task` | Schedule recurring or one-time agent tasks |
| `list_workflows` | Show all registered automations |
| `search_tools` | Semantic search over workflow registry |
| `run_workflow` | Execute a workflow by name |

### Web browsing

- **Simple pages**: `WebFetch` — fast, no overhead
- **JS-heavy pages, login flows, interactive sites**: `agent-browser` (Playwright/Chromium)
  ```bash
  agent-browser open <url>
  agent-browser snapshot -i        # accessibility tree with refs (@e1, @e2...)
  agent-browser click @e1
  agent-browser fill @e2 "text"
  agent-browser screenshot page.png
  ```

### Workflow registry — your personal automation library

This is where Stingyclaw gets interesting. Instead of hardcoding every capability into the agent, you drop shell scripts into `groups/*/workflows/` and register them in a `registry.json`. The agent discovers them automatically using **semantic search** — no keywords, no exact matching, just intent.

```
groups/main/
  workflows/
    registry.json      ← index with names + descriptions
    morning-briefing.sh
    notify-slack.sh
    pull-crm.sh
```

**`registry.json` format:**
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

Scripts can be bash, Python, Node — anything executable. Arguments arrive as environment variables. Embeddings are computed locally (`all-MiniLM-L6-v2`, baked into image) and cached in `.embeddings-cache.json`.

**The agent's decision flow:**
```
User: "morning briefing"
  → search_tools("morning briefing")  [semantic match → found]
  → run_workflow("morning-briefing")
  → bash morning-briefing.sh
  → reply

User: "what's the capital of France?"
  → search_tools("capital of France")  [no match]
  → model answers directly
```

The agent never has a bloated system prompt full of workflow details. It looks things up when it needs them, exactly like a person would.

### Per-group memory (`MISSION.md`)

Each group has a `groups/{name}/MISSION.md` injected into the system prompt. This is where you give the agent its persona, context, and standing instructions for that group. Keep it short — it's sent on every request. For larger reference data, let the agent `Read` files on demand.

---

## Key files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: message loop, agent invocation |
| `src/channels/whatsapp.ts` | WhatsApp connection, send/receive |
| `src/container-runner.ts` | Spawn agent containers, pass secrets via stdin |
| `src/ipc.ts` | IPC watcher: messages, voice, tasks |
| `src/task-scheduler.ts` | Scheduled task runner |
| `src/transcription.ts` | ASR + TTS HTTP client |
| `container/agent-runner/src/index.ts` | **Agent loop** — all tools, session management |
| `container/Dockerfile` | Agent image (Node + ripgrep + agent-browser + embedding model) |
| `container/voice-service/` | FastAPI: `/transcribe` (Whisper) + `/synthesize` (Qwen3-TTS) |
| `docker-compose.yml` | Voice service container |
| `groups/*/MISSION.md` | Per-group persona and memory |
| `groups/*/workflows/registry.json` | Per-group workflow registry |

---

## Roadmap / what to build next

The current build is a solid foundation. Here's what comes next:

- **MCP client** — connect to any MCP server (Gmail, GitHub, Slack) for dynamic tool loading without code changes
- **Richer workflow args** — typed inputs, validation, prompting for missing args before running
- **n8n / webhook bridge** — call external automation platforms from registry scripts
- **Group onboarding** — auto-prompt new groups for their mission/context on first message
- **Per-group agent customization** — groups can modify their own agent-runner source (already mounted writable)
- **Embeddings for memory** — semantic search over conversation history, not just workflows

---

## Requirements

- Linux (or macOS)
- Node.js 22+
- Docker + Docker Compose
- A Gemini API key (free at [aistudio.google.com](https://aistudio.google.com)) — or OpenRouter/Ollama

---

## Updating from upstream

```bash
git fetch upstream
git merge upstream/main
# Resolve conflicts in container/agent-runner/src/index.ts and src/channels/whatsapp.ts
docker build -t nanoclaw-agent:latest -f container/Dockerfile container/
docker compose build voice
```

---

## Original project

Based on [NanoClaw](https://github.com/qwibitai/nanoclaw) by qwibitai, MIT licensed.
All credit for the original architecture, WhatsApp integration, IPC design, and container isolation model goes to the upstream authors.

## License

MIT
