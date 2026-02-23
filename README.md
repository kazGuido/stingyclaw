<p align="center">
  <img src="assets/nanoclaw-logo.png" alt="NanoClaw" width="400">
</p>

<p align="center">
  Personal WhatsApp AI assistant running securely in containers — forked and adapted to run on any model via OpenRouter or local Ollama, with local voice in/out.
</p>

---

> **Fork of [qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw)** — original by [@gavrielc](https://github.com/gavrielc).
> This fork replaces the `@anthropic-ai/claude-agent-sdk` with a plain OpenAI-compatible agent loop,
> adds local voice transcription + speech synthesis, and wires in Gemini CLI for heavy coding —
> all with zero paid API requirements.

---

## What's different from upstream

|  | Upstream NanoClaw | This fork |
|---|---|---|
| **Model** | Claude (Anthropic subscription or API key required) | Any OpenRouter model or local Ollama |
| **Agent SDK** | `@anthropic-ai/claude-agent-sdk` | Plain `openai` package (OpenAI-compatible) |
| **Docker image size** | ~1.5GB (Chromium + claude-code) | ~400MB (just Node + ripgrep) |
| **Cost** | Requires paid Anthropic access | Free tier on OpenRouter, or fully local |
| **Voice notes** | Not supported | ✅ Transcribed with local Whisper (ASR) |
| **Voice replies** | Not supported | ✅ Spoken back with local Piper TTS |
| **Heavy coding** | claude-code CLI | ✅ Gemini CLI (Gemini 2.5 Pro, free) |

## Quick Start

```bash
git clone https://github.com/kazGuido/stingyclaw.git
cd stingyclaw
cp .env.example .env
# Edit .env — add your OPENROUTER_API_KEY and MODEL_NAME
```

Then follow the setup steps:
```bash
bash setup.sh                                          # check Node + deps
npx tsx setup/index.ts --step container -- --runtime docker  # build agent image
docker compose up -d voice                             # start local voice service
npx tsx setup/index.ts --step whatsapp-auth -- --method pairing-code --phone +3212345678
npx tsx setup/index.ts --step service                  # install + start systemd service
```

## Model config (`.env`)

```bash
# OpenRouter (free models available at openrouter.ai)
OPENROUTER_API_KEY=sk-or-v1-...
MODEL_NAME=stepfun/step-3.5-flash:free   # fast, free, good tool use
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1

# Local Ollama (fully offline)
# OPENROUTER_API_KEY=ollama
# MODEL_NAME=llama3.2
# OPENROUTER_BASE_URL=http://host.docker.internal:11434/v1

# Optional: Gemini CLI for heavy coding tasks (free at aistudio.google.com)
# GEMINI_API_KEY=AIza...
```

Free OpenRouter models worth trying:
- `stepfun/step-3.5-flash:free` — fast, great tool use, generous free tier
- `liquid/lfm-2.5` — Liquid AI's own model
- `google/gemini-flash-1.5` — free tier, capable
- `mistralai/mistral-7b-instruct:free` — lightweight

## What It Does

- **WhatsApp I/O** — message your assistant from your phone
- **Voice notes** — send a voice note, get a transcript + response. The bot can reply with spoken audio too
- **Isolated group context** — each group has its own memory (`CLAUDE.md`), filesystem, and container sandbox
- **Scheduled tasks** — recurring jobs that run the agent and message you back
- **Web access** — fetch and read URLs
- **Container isolation** — agents run in Docker with only explicitly mounted directories visible
- **Gemini CLI** — agent delegates complex coding tasks to Gemini 2.5 Pro
- **Tools** — Bash, Read/Write files, Grep, Glob, WebFetch, send_message, send_voice, schedule_task

## Architecture

```
WhatsApp (baileys)
    ↓ voice note?
Voice Service (Docker) ← faster-whisper (Whisper-small, CPU)
    ↓ [Voice: transcript]
SQLite → Polling loop → Agent Container (OpenRouter loop)
    ↓ send_voice IPC
Voice Service → Piper TTS → OGG → WhatsApp PTT reply
```

Single Node.js host process. Agents execute in isolated Docker containers per message.
Voice service is a separate persistent Docker container (`docker compose up -d voice`).

Key files:
- `src/index.ts` — Orchestrator: state, message loop, agent invocation
- `src/channels/whatsapp.ts` — WhatsApp connection, send/receive text + voice
- `src/transcription.ts` — ASR + TTS client (calls voice service HTTP API)
- `src/ipc.ts` — IPC watcher: text messages, voice messages, task scheduling
- `src/container-runner.ts` — Spawns agent containers, passes secrets via stdin
- `src/task-scheduler.ts` — Runs scheduled tasks
- `container/agent-runner/src/index.ts` — **Agent loop** (OpenAI-compatible, OpenRouter/Ollama)
- `container/voice-service/` — FastAPI server: `/transcribe` (Whisper) + `/synthesize` (Piper)
- `docker-compose.yml` — Manages the voice service container
- `groups/*/CLAUDE.md` — Per-group memory

## Requirements

- Linux (or macOS)
- Node.js 22+
- Docker + Docker Compose
- An OpenRouter API key (free at [openrouter.ai](https://openrouter.ai)) — or a local Ollama install

## Updating from upstream

```bash
git fetch upstream
git merge upstream/main
# Resolve conflicts in container/agent-runner/src/index.ts and src/channels/whatsapp.ts
docker build -t nanoclaw-agent:latest -f container/Dockerfile container/
docker compose build voice  # rebuild voice service if Dockerfile changed
```

## Original project

This fork is based on [NanoClaw](https://github.com/qwibitai/nanoclaw) by qwibitai, MIT licensed.
All credit for the original architecture, WhatsApp integration, IPC design, and container isolation model goes to the upstream authors.

## License

MIT
