<p align="center">
  <img src="assets/nanoclaw-logo.png" alt="NanoClaw" width="400">
</p>

<p align="center">
  Personal WhatsApp AI assistant running securely in containers — forked and adapted to run on any model via OpenRouter or local Ollama.
</p>

---

> **Fork of [qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw)** — original by [@gavrielc](https://github.com/gavrielc).
> This fork replaces the `@anthropic-ai/claude-agent-sdk` with a plain OpenAI-compatible agent loop,
> so you can use free OpenRouter models (like `liquid/lfm-2.5`) or any local model via Ollama —
> no Claude subscription or Anthropic API key required.

---

## What's different from upstream

| | Upstream NanoClaw | This fork |
|---|---|---|
| **Model** | Claude (Anthropic subscription or API key required) | Any OpenRouter model or local Ollama |
| **Agent SDK** | `@anthropic-ai/claude-agent-sdk` | Plain `openai` package (OpenAI-compatible) |
| **Docker image size** | ~1.5GB (Chromium + claude-code) | ~400MB (just Node + ripgrep) |
| **Cost** | Requires paid Anthropic access | Free tier on OpenRouter, or fully local |

## Quick Start

```bash
git clone https://github.com/kazGuido/nanoclaw.git
cd nanoclaw
cp .env.example .env
# Edit .env — add your OPENROUTER_API_KEY and MODEL_NAME
```

Then follow the setup steps:
```bash
bash setup.sh                                          # check Node + deps
npx tsx setup/index.ts --step container -- --runtime docker  # build agent image
npx tsx setup/index.ts --step whatsapp-auth -- --method pairing-code --phone +3212345678
npx tsx setup/index.ts --step service                  # install + start systemd service
```

## Model config (`.env`)

```bash
# OpenRouter (free models available at openrouter.ai)
OPENROUTER_API_KEY=sk-or-v1-...
MODEL_NAME=liquid/lfm-2.5          # fast, good tool use, free tier
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1

# Local Ollama (fully offline)
# OPENROUTER_API_KEY=ollama
# MODEL_NAME=llama3.2
# OPENROUTER_BASE_URL=http://host.docker.internal:11434/v1
```

Free OpenRouter models worth trying:
- `liquid/lfm-2.5` — fast, solid tool use
- `google/gemini-flash-1.5` — free tier, capable
- `mistralai/mistral-7b-instruct:free` — lightweight

## What It Does

- **WhatsApp I/O** — message your assistant from your phone
- **Isolated group context** — each group has its own memory (`CLAUDE.md`), filesystem, and container sandbox
- **Scheduled tasks** — recurring jobs that run the agent and message you back
- **Web access** — fetch and read URLs
- **Container isolation** — agents run in Docker with only explicitly mounted directories visible
- **Tools** — Bash, Read/Write files, Grep, Glob, WebFetch, and WhatsApp IPC tools

## Architecture

```
WhatsApp (baileys) → SQLite → Polling loop → Docker container (OpenRouter agent loop) → Response
```

Single Node.js process. Agents execute in isolated Docker containers. Per-group message queue. IPC via filesystem.

Key files:
- `src/index.ts` — Orchestrator: state, message loop, agent invocation
- `src/channels/whatsapp.ts` — WhatsApp connection (baileys), auth, send/receive
- `src/ipc.ts` — IPC watcher and task processing
- `src/router.ts` — Message formatting and outbound routing
- `src/container-runner.ts` — Spawns agent containers, passes secrets via stdin
- `src/task-scheduler.ts` — Runs scheduled tasks
- `src/db.ts` — SQLite operations (messages, groups, sessions, state)
- `container/agent-runner/src/index.ts` — **Agent loop** (our fork: OpenAI-compatible, replaces Anthropic SDK)
- `groups/*/CLAUDE.md` — Per-group memory

## Requirements

- Linux (or macOS)
- Node.js 22+
- Docker
- An OpenRouter API key (free at [openrouter.ai](https://openrouter.ai)) — or a local Ollama install

## Updating from upstream

```bash
git fetch upstream
git merge upstream/main
# Resolve any conflicts in container/agent-runner/src/index.ts (our main fork point)
docker build -t nanoclaw-agent:latest -f container/Dockerfile container/
```

## Original project

This fork is based on [NanoClaw](https://github.com/qwibitai/nanoclaw) by qwibitai, MIT licensed.
All credit for the original architecture, WhatsApp integration, IPC design, and container isolation model goes to the upstream authors.

## License

MIT
