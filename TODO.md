# Stingyclaw — Nice to Have

Collected ideas from development. Roughly prioritized.

---

## Voice

- [ ] **Whisper-medium upgrade** — better accuracy for accented speech and noisy environments, still CPU-friendly (~769MB vs 244MB)
- [ ] **More Piper voices** — Spanish, French, Chinese, male voices. Add to `docker-compose.yml` env and `download_models.py`
- [ ] **LFM2.5-Audio** — Liquid AI's 1.5B audio model (ASR + TTS in one). Once Ollama adds audio support or the GGUF llama.cpp integration matures, swap in for local-only pipeline with no separate Whisper/Piper containers
- [ ] **Language auto-detection display** — Whisper already detects language; surface it in the `[Voice: ...]` tag so agent knows what language was spoken

---

## Browser / Web

- [ ] **Playwright MCP inside agent container** — install Chromium + `@playwright/mcp`, bridge its tools (navigate, screenshot, click, fill forms) into the OpenAI tool loop. Needed for JS-rendered pages, logged-in sites, web automation
- [ ] **Screenshot → WhatsApp image** — once Playwright is in, allow agent to send screenshots as image messages

---

## Channels

- [ ] **Gmail skill** — run the upstream `.claude/skills/add-gmail/SKILL.md` once the skills engine init is fixed; gives Clawman read/send email capability
- [ ] **Telegram channel** — second channel alongside WhatsApp, sharing the same agent and session infrastructure
- [ ] **GitHub project management** — `gh` CLI or GitHub MCP server inside the container; let Clawman create issues, review PRs, check CI status

---

## Dashboard / UI

- [ ] **Web dashboard** — small Express server + HTMX frontend reading the existing SQLite DB
  - Registered chats + message history
  - Scheduled tasks (create / pause / cancel from browser)
  - Voice service health
  - Per-group `CLAUDE.md` editor
  - Container logs viewer
  - Active containers indicator

---

## Agent / LLM

- [ ] **Step-3.5-flash tool-call reliability** — test against other free models (`google/gemini-2.0-flash-exp:free`, `meta-llama/llama-3.3-70b-instruct:free`) and document which ones actually follow tool-calling and voice rules reliably
- [ ] **Multi-turn voice conversation** — if user replies with another voice note, keep context and continue in voice mode until they switch back to text
- [ ] **Image understanding** — pass `imageMessage` to the LLM if the model supports vision; currently image captions are forwarded but the image itself is dropped

---

## Infrastructure

- [ ] **Fix lingering container shutdown** — when nanoclaw restarts, old agent containers block shutdown. Add a pre-stop hook that calls `docker stop nanoclaw-*` before the new process starts
- [ ] **Skills engine init** — the `npx tsx scripts/apply-skill.ts --init` command hangs (snapshotting large directories). Fix or rewrite; needed to apply upstream skills automatically
- [ ] **Upstream sync tooling** — script to `git fetch upstream && git merge upstream/main` and auto-rebuild affected containers; document conflict zones (`container/agent-runner/src/index.ts`, `src/channels/whatsapp.ts`)
- [ ] **Voice service health in setup verify** — `npx tsx setup/index.ts --step verify` should check `localhost:8001/health` and report voice service status
