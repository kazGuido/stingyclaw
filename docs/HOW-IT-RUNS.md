# How Stingyclaw Runs

## The three pieces

| Piece | What it does | How it runs |
|-------|----------------|----------------|
| **Host (app)** | Node process: WhatsApp (Baileys), DB, routing, group queue. When a message needs the agent, it **spawns** a container and streams JSON in/out. | On the **host**: `npm run dev` or `npm start` (or systemd/launchd). |
| **Agent container** | Ephemeral: runs the OpenRouter/Ollama agent loop (tools, memory, confirmations). Receives input via stdin, writes output to stdout, then exits. | **On demand**: the host runs `docker run -i --rm ... stingyclaw-agent:latest` per query. One container per group at a time. |
| **Voice container** | Long‑running: TTS (and optional ASR). The agent calls it over HTTP (e.g. `localhost:8001`) when it needs voice. | **Compose**: `docker compose up -d voice`. |

So by default:

- You start **voice** with Compose (or use the start script).
- You **build** the agent image once (`./container/build.sh` or `docker build -t stingyclaw-agent:latest -f container/Dockerfile container/`).
- You run the **app** on the host (`npm run dev` or the start script). The app uses the host’s Docker to run the agent image when needed.

The agent is **not** a long‑running service; it’s a short-lived process the host starts and stops for each conversation.

---

## Data and paths

The app expects to run with the project root as current working directory. It uses `process.cwd()` for `groups/`, `data/`, `store/`, and for **mount paths** when it spawns the agent.

---

## Bring everything up with one script

From the project root, run:

```bash
./scripts/start.sh
```

This will:

1. Start the **voice** container (`docker compose up -d voice`), building the image if needed.
2. Build the **agent** image if `stingyclaw-agent:latest` is missing.
3. Start the **host app** in the foreground (`npm run dev`). Logs appear in the terminal; Ctrl+C stops the app (voice keeps running).

Prereqs: `.env` with API keys, WhatsApp auth done. See the main README for setup.
