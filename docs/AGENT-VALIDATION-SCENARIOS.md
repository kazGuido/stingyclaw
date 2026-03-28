# Agent validation scenarios (without WhatsApp)

Manual chat testing is slow and non-repeatable. Use **layers**: automate what you can, keep a **short** WhatsApp smoke list for release confidence.

## Layer 1 — Fast feedback (local, no API keys)

| Scenario | What it proves | How |
|----------|----------------|-----|
| **Host unit tests** | DB, routing, IPC contracts, formatting, group-queue | `npm run test:core` |
| **Agent-runner unit tests** | Chat history trim (no orphan leading `tool`), CoreMessage conversion | `cd container/agent-runner && npm test` |
| **Typecheck** | TS consistency across host + runner | `npm run typecheck` |

Run everything in one shot:

```bash
npm run validate:scenarios
```

## Layer 2 — Container image (same code as production)

| Scenario | What it proves | How |
|----------|----------------|-----|
| **Image builds** | `tsc` in Docker, entrypoint, deps | `docker build -t stingyclaw-agent:latest -f container/Dockerfile container/` |
| **Agent smoke (optional)** | Runner starts, loads registry, returns JSON envelope | See below |

Minimal stdin smoke (needs `OPENROUTER_API_KEY` in env; uses real API once):

```bash
echo '{"prompt":"Reply with the word OK only.","groupFolder":"main","chatJid":"test@g.us","isMain":true}' \
  | docker run -i --rm -e OPENROUTER_API_KEY="$OPENROUTER_API_KEY" stingyclaw-agent:latest
```

Expect `---STINGYCLAW_OUTPUT_START---` and `"status":"success"` (or a clear provider error if credits/network fail).

## Layer 3 — Host + Docker on the machine that runs Stingyclaw

| Scenario | What it proves | How |
|----------|----------------|-----|
| **Doctor** | Service, voice container, logs | `npx tsx scripts/doctor.ts` |
| **Health** | User service + voice HTTP | `npx tsx scripts/health-check.ts` |

## Layer 4 — Scenario checklist (manual / staging)

Use these **after** layers 1–3 pass. Still faster than “chat until something breaks.”

| # | Scenario | Pass criteria |
|---|----------|----------------|
| A | **Main group, no tools** | Normal reply, no error prefix |
| B | **Main + one tool** (e.g. `send_message` or `Read`) | Tool runs, reply makes sense |
| C | **Non-main group + trigger** | No reply without trigger; reply with `@…` or mention |
| D | **Long session + tools** | After many turns, no `CHAT_HISTORY_ERROR` / bogus “provider unavailable” |
| E | **reset_session** | Next message starts clean context |
| F | **Scheduled task** (if used) | Fires once, result visible |

## Layer 5 — Regression targets (automated tests already cover)

- **Orphan tool after `slice(-N)`** — `container/agent-runner/src/chat-messages.test.ts`
- **Trigger + `mentions_bot`** — host `whatsapp` / `index` tests where applicable
- **DB migrations** — `src/db.test.ts`

## When to use WhatsApp

Only for **Layer 4** spot-checks or after changing **Baileys / channel** code. Everything else should pass in CI or `validate:scenarios` first.
