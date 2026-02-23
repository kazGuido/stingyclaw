# NanoClaw — Agent Rules

Follow these rules when working on this project.

## GitHub setup (one-time)

This repo was forked from `qwibitai/nanoclaw`. To point it at your own GitHub:

```bash
# 1. Create a new repo on github.com (e.g. yourname/nanoclaw), then:
git remote set-url origin https://github.com/YOURNAME/nanoclaw.git
git remote add upstream https://github.com/qwibitai/nanoclaw.git
git push -u origin main

# Pull upstream improvements later with:
git fetch upstream && git merge upstream/main
```

## Branching

- **`main`** = active development. This is where you work.
- **`beta`** = stable features awaiting testing. Do NOT commit here directly.
- **`production`** = released / working installation. Do NOT commit here directly.

## How to work on a task

1. **Always create a feature branch** from `main` before making changes:
   ```bash
   git checkout main && git pull origin main
   git checkout -b feature/<short-description>
   ```
2. Do your work and commit on the feature branch.
3. When done, merge into `main`:
   ```bash
   git checkout main
   git merge feature/<short-description>
   git push origin main
   ```
4. **Do NOT delete the feature branch** — keep it for reference.
5. **Do NOT merge into `beta` or `production`** unless explicitly asked.

## Branch naming

| Type    | Pattern                        | Example                        |
|---------|--------------------------------|--------------------------------|
| Feature | `feature/<short-description>`  | `feature/telegram-channel`     |
| Bug fix | `fix/<short-description>`      | `fix/whatsapp-reconnect`       |
| Hotfix  | `hotfix/<short-description>`   | `hotfix/ipc-race-condition`    |

## Project structure

| Path | What it is |
|------|-----------|
| `src/` | Host orchestrator — WhatsApp (baileys), SQLite, IPC, scheduler, message routing |
| `src/channels/` | Channel adapters (WhatsApp, etc.) |
| `container/` | Everything that runs inside the Docker agent container |
| `container/agent-runner/src/index.ts` | **Our custom agent loop** — OpenRouter-based, replaces Anthropic SDK |
| `container/Dockerfile` | Agent container image |
| `setup/` | Setup wizard steps (`npx tsx setup/index.ts --step <name>`) |
| `groups/` | Per-group state, CLAUDE.md memory files, conversation logs |
| `scripts/` | Utility scripts (migrations, skill management, CI) |
| `.claude/skills/` | Claude Code skills (setup, update, customize, etc.) |
| `.env` | Secrets — never commit this |

## Environment variables (`.env`)

```bash
# Required — model provider
OPENROUTER_API_KEY=sk-or-v1-...
MODEL_NAME=liquid/lfm-2.5          # or any OpenRouter model
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1

# For local Ollama instead:
# OPENROUTER_API_KEY=ollama
# MODEL_NAME=llama3.2
# OPENROUTER_BASE_URL=http://host.docker.internal:11434/v1
```

## Rebuilding the Docker image

The agent runs inside a Docker container. Rebuild the image whenever you change
anything inside `container/` (Dockerfile, agent-runner source, etc.):

```bash
cd /home/admin_user/nanoclaw
docker build -t nanoclaw-agent:latest -f container/Dockerfile container/
```

Verify the build:
```bash
# Should print 401 auth error (correct — it reached OpenRouter)
echo '{"prompt":"hi","groupFolder":"test","chatJid":"test@s.whatsapp.net","isMain":false,"secrets":{"OPENROUTER_API_KEY":"no-key"}}' \
  | docker run --rm -i nanoclaw-agent:latest 2>&1 | tail -5
```

## Service management

```bash
# Start
systemctl --user start nanoclaw

# Stop
systemctl --user stop nanoclaw

# Restart (after code changes to src/)
npm run build && systemctl --user restart nanoclaw

# Logs (live)
tail -f logs/nanoclaw.log

# Full setup wizard
npx tsx setup/index.ts --step <name>
# Steps: environment, container, whatsapp-auth, groups, register, mounts, service, verify
```

## What changed from upstream

| File | Change |
|------|--------|
| `container/agent-runner/src/index.ts` | Full rewrite — OpenRouter agent loop instead of `@anthropic-ai/claude-agent-sdk` |
| `container/agent-runner/package.json` | `openai` + `glob` instead of Anthropic SDK |
| `container/Dockerfile` | Removed Chromium + claude-code global (500MB+ lighter); added ripgrep |
| `src/container-runner.ts` | Passes `OPENROUTER_API_KEY`, `MODEL_NAME`, `OPENROUTER_BASE_URL` as secrets |
| `.env.example` | Documents the new env vars |

## Other rules

- Never commit `.env` or any file containing secrets.
- Never commit directly to `main`, `beta`, or `production` — always use a feature/fix branch.
- Run `npm test` before merging into `main`.
- When in doubt about setup, run `npx tsx setup/index.ts --step verify` to check current state.
