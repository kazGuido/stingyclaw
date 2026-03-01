# Stingyclaw Debug Checklist

## Quick Status Check

```bash
# 1. Is the host process running?
pgrep -a -f 'nanoclaw/dist/index.js'

# 2. Any running agent containers?
docker ps --format '{{.Names}} {{.Status}}' | grep nanoclaw

# 3. Is the voice service running?
docker ps --format '{{.Names}} {{.Status}}' | grep stingyclaw-voice

# 4. Recent errors?
grep -E 'ERROR|WARN|Fatal' logs/nanoclaw.log | tail -20

# 5. Is WhatsApp connected?
grep -E 'Connected|Connection closed|Connecting' logs/nanoclaw.log | tail -5

# 6. Are groups loaded?
grep 'Group registered' logs/nanoclaw.log | tail -5
```

---

## Agent Not Responding

```bash
# Check if messages are being received
grep 'New messages\|Processing messages' logs/nanoclaw.log | tail -10

# Check if container was spawned
grep 'Spawning container' logs/nanoclaw.log | tail -5

# Check if agent errored and retries are happening
grep -E 'Container agent error|Scheduling retry|Max retries exceeded' logs/nanoclaw.log | tail -10

# Check the most recent container log
ls -lt groups/main/logs/container-*.log | head -3
cat groups/main/logs/container-$(ls -t groups/main/logs/ | head -1 | sed 's/container-//')

# Manually trigger by checking message cursor vs DB
sqlite3 store/messages.db "SELECT chat_jid, MAX(timestamp) as latest FROM messages GROUP BY chat_jid ORDER BY latest DESC LIMIT 5;"
```

---

## Container Failures

```bash
# Check recent container start/die events
docker events --since 10m --filter event=die --filter event=start \
  --format "{{.Time}} {{.Actor.Attributes.name}} {{.Action}}" 2>/dev/null

# Get logs from a specific container (it exits fast — catch it)
docker ps -a --format '{{.Names}} {{.Status}}' | grep nanoclaw

# Test run the agent image manually with dummy input
echo '{"group":"main","message":"test","history":[]}' | docker run --rm -i \
  -e OPENROUTER_API_KEY=test \
  nanoclaw-agent:latest 2>&1 | head -20

# Check image build date vs last code change
docker inspect nanoclaw-agent:latest --format '{{.Created}}'
ls -la container/agent-runner/src/index.ts
```

---

## Voice Service Issues

```bash
# Check voice container logs
docker logs stingyclaw-voice --tail 30

# Test transcription endpoint
curl -s http://localhost:8001/health

# Test synthesis (sends back audio bytes)
curl -s -X POST http://localhost:8001/synthesize \
  -H 'Content-Type: application/json' \
  -d '{"text":"hello world"}' | wc -c
# Expected: non-zero byte count

# Rebuild and restart voice if broken
docker compose build --no-cache voice
docker compose up -d voice
docker logs stingyclaw-voice --tail 20
```

---

## OpenRouter / Model Issues

```bash
# Test OpenRouter API key directly
OR_KEY=$(grep OPENROUTER_API_KEY .env | cut -d= -f2)
MODEL=$(grep MODEL_NAME .env | cut -d= -f2)
curl -s -X POST "https://openrouter.ai/api/v1/chat/completions" \
  -H "Authorization: Bearer $OR_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"ping\"}]}" | python3 -m json.tool

# Check what model and backend the agent is using
grep 'Backend:' logs/nanoclaw.log | tail -5

# Corrupt session causing 400? Reset it:
SESSION_FILE=$(find data/sessions -name "*.json" | head -1)
echo $SESSION_FILE
python3 -c "import json; s=json.load(open('$SESSION_FILE')); s['messages']=[]; json.dump(s,open('$SESSION_FILE','w'))"
```

---

## Session Issues

```bash
# Find session files for main group
ls data/sessions/main/.stingyclaw/sessions/

# Check session message count
python3 -c "
import json, glob
for f in glob.glob('data/sessions/main/.stingyclaw/sessions/*.json'):
    s = json.load(open(f))
    print(len(s.get('messages',[])), f.split('/')[-1])
"

# Reset a session (backup first)
SESSION="data/sessions/main/.stingyclaw/sessions/<session-id>.json"
cp "$SESSION" "${SESSION}.bak"
python3 -c "import json; s=json.load(open('$SESSION')); s['messages']=[]; json.dump(s,open('$SESSION','w'))"
```

---

## WhatsApp Auth Issues

```bash
# Check if auth expired (QR requested)
grep -E 'QR|authentication|pairing' logs/nanoclaw.log | tail -5

# Check auth files exist
ls -la store/auth/

# Re-authenticate
npx tsx setup/index.ts --step whatsapp-auth -- --method pairing-code --phone +XXXXXXXXXXX
```

---

## Service Management

```bash
# Restart the host process
HOST_PID=$(pgrep -f 'nanoclaw/dist/index.js')
kill $HOST_PID
sleep 2
nohup node dist/index.js >> logs/nanoclaw.log 2>> logs/nanoclaw.error.log &

# Rebuild after code changes and restart
npm run build
kill $(pgrep -f 'nanoclaw/dist/index.js')
nohup node dist/index.js >> logs/nanoclaw.log 2>> logs/nanoclaw.error.log &

# Rebuild agent container image
docker build -t nanoclaw-agent:latest -f container/Dockerfile container/
# (the agent-runner/src is mounted at runtime — just restart host for code changes there)

# View live logs
tail -f logs/nanoclaw.log
tail -f logs/nanoclaw.error.log
```

---

## Known Issues & Fixes

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| `400 status code (no body)` from Gemini | Session has OpenAI-specific fields (`refusal: null`) or bad turn ordering | Reset session messages to `[]` |
| `MODEL_NAME` model not found | Model slug not available on OpenRouter | Check [openrouter.ai/models](https://openrouter.ai/models) for exact slug |
| Max retries exceeded, you get WhatsApp error notification | API key wrong, model unavailable, or corrupt session | Check API key, reset session |
| Voice slow on first request | LFM2.5-Audio model downloading (~3GB) | Wait for download, check `docker logs stingyclaw-voice` |
| `container: command not found` in agent | Apple Container not installed (only relevant for macOS users) | Use Docker — the project uses `docker` by default |
| Agent container rebuilds too slow | `--no-cache` rebuilds everything | Without `--no-cache`, cached layers are reused; source is mounted at runtime anyway |
