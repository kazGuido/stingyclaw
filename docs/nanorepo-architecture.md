# Stingyclaw — Codebase Structure

> Previously this document described the NanoClaw "skills" system (git-merge-based plugin architecture using Claude Code). That system is no longer in use. Stingyclaw dropped the skills concept entirely in favour of a model-agnostic agent loop.

---

## Repository Layout

```
stingyclaw/
├── src/                          # Host process (Node.js)
│   ├── index.ts                  # Orchestrator, message loop, agent invocation
│   ├── group-queue.ts            # Concurrency control, retry with backoff, error notification
│   ├── container-runner.ts       # Docker container spawner, volume mounts, secret passing
│   ├── channels/
│   │   └── whatsapp.ts           # WhatsApp connection (baileys), auto-version update
│   ├── ipc.ts                    # File-based IPC watcher (messages, voice, tasks, input)
│   ├── task-scheduler.ts         # Scheduled task runner
│   ├── transcription.ts          # ASR + TTS HTTP client
│   └── config.ts / logger.ts     # Config constants, structured logger
│
├── container/
│   ├── Dockerfile                # Agent image (Node + ripgrep + agent-browser + embed model)
│   ├── agent-runner/
│   │   ├── src/
│   │   │   └── index.ts          # Agent loop: tools, model calls, session mgmt, workflow registry
│   │   ├── download-embed-model.mjs  # Pre-downloads all-MiniLM-L6-v2 at image build time
│   │   └── package.json          # Agent runner deps (@xenova/transformers, openai, etc.)
│   └── voice-service/
│       ├── Dockerfile            # Voice image (LFM2.5-Audio GGUF + llama-cpp-python)
│       ├── server.py             # FastAPI: /transcribe + /synthesize (LFM2.5-Audio-1.5B)
│       └── requirements.txt
│
├── groups/
│   ├── global/
│   │   └── MISSION.md            # Shared memory injected into all groups
│   └── main/
│       ├── MISSION.md            # Main group (self-chat) persona
│       └── workflows/
│           ├── registry.json     # Workflow index (name, description, run command)
│           ├── morning-briefing.sh
│           └── system-status.sh
│
├── setup/                        # One-time setup scripts
│   ├── index.ts                  # Setup CLI entry point
│   ├── groups.ts                 # Group registration
│   ├── register.ts               # Register/update group in SQLite
│   └── verify.ts                 # Environment verification
│
├── scripts/
│   └── update-wa-version.ts      # Fetch + persist latest WhatsApp Web version
│
├── docs/                         # Documentation
├── store/                        # Runtime data (gitignored)
│   ├── messages.db               # SQLite: messages, groups, tasks, chats
│   └── auth/                     # WhatsApp session (never mounted into containers)
├── data/                         # Runtime data (gitignored)
│   ├── sessions/                 # Agent session history per group
│   └── ipc/                      # IPC file exchange
├── logs/                         # Log files (gitignored)
├── docker-compose.yml            # Voice service container
├── MISSION.md                    # Project-level agent context
└── .env                          # API keys and config
```

---

## How to Extend

### Add a new tool to the agent

Edit `container/agent-runner/src/index.ts`:

1. Add a definition to the `TOOLS` array (OpenAI tool schema)
2. Add a case to `executeTool()` (or `executeToolInternal()`)

No image rebuild needed — the source is synced to the container on every spawn.

### Add a workflow (automation script)

1. Create a script in `groups/{name}/workflows/your-script.sh`
2. Add an entry to `groups/{name}/workflows/registry.json`:
   ```json
   {
     "name": "your-script",
     "description": "What this does in plain English — used for semantic search",
     "run": "bash your-script.sh",
     "args": ["optional_arg1"]
   }
   ```

The agent discovers it automatically via `search_tools`.

### Switch model backend

Edit `.env`:
```bash
# Use Gemini (free, recommended)
OPENROUTER_API_KEY=sk-or-v1-...
MODEL_NAME=stepfun/step-3.5-flash:free

# Use OpenRouter
OPENROUTER_API_KEY=sk-or-v1-...
MODEL_NAME=meta-llama/llama-3.3-70b-instruct:free

# Use local Ollama
OPENROUTER_API_KEY=ollama
MODEL_NAME=llama3.2
OPENROUTER_BASE_URL=http://host.docker.internal:11434/v1
```

### Add a new group

From the main WhatsApp chat:
> @Clawman register this group: "My Team"

Or via CLI:
```bash
npx tsx setup/index.ts --step register
```

### Add per-group memory

Edit `groups/{name}/MISSION.md`. It's injected into every system prompt for that group. Keep it short — it's sent on every request.

---

## Roadmap

- **MCP client** — load tools dynamically from any MCP server (Gmail, GitHub, Slack)
- **Typed workflow args** — validation, prompting for missing required args
- **n8n / webhook bridge** — call external automation platforms from workflow scripts
- **Group onboarding** — auto-prompt new groups for mission on first message
- **Conversation memory** — semantic search over message history (not just workflows)
