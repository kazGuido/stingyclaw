# Agent Loop Deep Dive

> The original version of this document was a reverse-engineering of the `@anthropic-ai/claude-agent-sdk`. That SDK is no longer used. This document describes Stingyclaw's actual agent loop in `container/agent-runner/src/index.ts`.

---

## Overview

The agent loop is a plain TypeScript file (~1000 lines) that:
1. Reads a JSON payload from stdin (message, session, secrets)
2. Calls an OpenAI-compatible model API in a loop until it stops calling tools
3. Executes tools locally in the container
4. Streams results back to the host via stdout markers
5. Saves the updated session
6. Exits

No SDK. No subprocess. One file, one loop, easy to reason about.

---

## Entry Point

```
stdin → JSON payload
  {
    group, sessionId, groupFolder, chatJid, isMain,
    assistantName, prompt, secrets: { OPENROUTER_API_KEY, MODEL_NAME, ... }
  }
```

The entrypoint (`entrypoint.sh` in the image) compiles the TypeScript on each container start (`npx tsc`), then pipes stdin to the compiled `index.js`. This means code changes to the agent runner take effect without rebuilding the Docker image — the source is synced from the host on every container spawn.

---

## Backend Detection

```typescript
if (openrouterKey === 'ollama') {
  // Local Ollama
  baseURL = OPENROUTER_BASE_URL ?? 'http://host.docker.internal:11434/v1'
  modelName = MODEL_NAME ?? 'llama3.2'

} else {
  // OpenRouter (default)
  baseURL = OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1'
  modelName = MODEL_NAME ?? 'liquid/lfm-2.5'
}
```

An `OpenAI` client is constructed with the chosen `apiKey` and `baseURL`. Because all three backends speak the OpenAI API format, the rest of the code is identical.

---

## System Prompt Construction

Built fresh on every container start from:

1. **Role declaration** — "You are {assistantName}, a personal AI assistant..."
2. **Global MISSION.md** — read from `/workspace/global/MISSION.md` (if exists)
3. **Group MISSION.md** — read from `/workspace/group/MISSION.md` (if exists)
4. **Available tools** — brief description of built-in tools
5. **Workflow guidance** — instruction to use `search_tools` → `run_workflow` before falling back to built-ins
6. **agent-browser guide** — how to use the headless browser CLI
7. **ask_boss instruction** — when to escalate to the user

---

## The Loop

```typescript
async function runQuery(prompt, session, input, client, modelName) {
  session.messages.push({ role: 'user', content: prompt })

  for (let i = 0; i < MAX_TURNS; i++) {

    // 1. Sanitize messages for Gemini compatibility
    const sanitized = session.messages.map(sanitizeForGemini)

    // 2. Call model
    let response
    try {
      response = await client.chat.completions.create({
        model: modelName,
        messages: [systemMsg, ...sanitized],
        tools: TOOLS,
        tool_choice: 'auto',
        max_tokens: 8192,
      })
    } catch (err) {
      // 400 with large session? Trim to last 10 messages and retry once
      if (err.message.includes('400') && session.messages.length > 10) {
        session.messages = session.messages.slice(-10)
        continue
      }
      throw err
    }

    const msg = response.choices[0].message
    session.messages.push(msg)

    // 3. Text output → stream to host
    if (msg.content?.trim()) {
      process.stdout.write(OUTPUT_START + JSON.stringify({ result: msg.content }) + OUTPUT_END)
    }

    // 4. Done?
    if (!msg.tool_calls?.length || response.choices[0].finish_reason === 'stop') break

    // 5. Execute tools
    for (const toolCall of msg.tool_calls) {
      const result = await executeTool(toolCall.function.name, args, input)
      session.messages.push({ role: 'tool', tool_call_id: toolCall.id, content: result })
    }
  }

  saveSession(session)
}
```

---

## Message Sanitization (Gemini Compat)

Gemini's OpenAI-compatible endpoint is stricter than OpenAI about message shape:

| Problem | Fix |
|---------|-----|
| `content: ""` on assistant messages with `tool_calls` | Remove `content` field |
| `refusal: null` on assistant messages | Strip field |
| `reasoning: null` / `reasoning_details` | Strip fields |
| Turn ordering violations (assistant→assistant without user in between) | Auto-trim on 400 |

The sanitizer rebuilds every assistant message keeping only `role`, non-empty `content`, and `tool_calls`.

---

## Tool Execution

`executeTool(name, args, input)` dispatches to individual implementations:

### Bash
```typescript
execSync(args.command, {
  cwd: '/workspace/group',
  timeout: 60000,
  maxBuffer: 1024 * 1024,
  env: { ...process.env, HOME: '/home/node' }
})
```
Safe because it runs inside the container. Container has no access to host filesystem except explicit mounts.

### File Tools (Read/Write/Edit)
Standard `fs` operations, resolved relative to `/workspace/group`. Paths are validated to stay within the workspace.

### WebFetch
`fetch(url)` → HTML response → convert to markdown via cheerio/turndown.

### agent-browser
```typescript
// Open a URL
execSync(`agent-browser open ${url}`)

// Get accessibility tree
execSync(`agent-browser snapshot -i`)

// Click / fill / screenshot
execSync(`agent-browser click @e1`)
```
Chromium is baked into the image (`PLAYWRIGHT_BROWSERS_PATH=/usr/local/share/playwright`).

### send_message / send_voice
Write a JSON file to `/workspace/ipc/messages/` or `/workspace/ipc/voice/`. The host IPC watcher picks it up within milliseconds and sends it via WhatsApp.

### ask_boss
1. Write a message to the user via IPC
2. Wait for reply by polling `/workspace/ipc/input/`
3. Return the reply text to the model

### search_tools (Semantic Search)
```typescript
const embedder = await getEmbedder()  // lazy-load local model
const queryVec = await embed(query)
const scores = registry.map(w => ({
  ...w,
  score: cosineSimilarity(queryVec, w.embedding)
}))
return scores.filter(s => s.score > THRESHOLD).slice(0, 3)
```

Embeddings are computed locally using `@xenova/transformers` with `Xenova/all-MiniLM-L6-v2` (quantized). Results are cached in `.embeddings-cache.json` so the model only runs once per workflow change.

### run_workflow
```typescript
const result = execSync(workflow.run, {
  cwd: '/workspace/group/workflows',
  env: { ...process.env, ...argsAsEnvVars },
  timeout: 120000
})
```
Scripts receive their arguments as uppercase environment variables. Output is returned to the model as the tool result.

---

## Session Storage

Sessions are stored as JSON at `/home/node/.stingyclaw/sessions/{uuid}.json` (inside the container), which maps to `data/sessions/{group}/.stingyclaw/sessions/` on the host.

```json
{
  "messages": [...]
}
```

On each container start, the session ID is passed in the input payload. The agent loads the existing messages, appends the new conversation, and saves on exit.

---

## Output Protocol

Results are sent to the host via stdout using delimited markers:

```
---NANOCLAW_OUTPUT_START---
{"status":"success","result":"The weather today is...","newSessionId":"..."}
---NANOCLAW_OUTPUT_END---
```

The host reads stdout line by line, buffers between markers, and parses the JSON. For streaming, the agent can write multiple OUTPUT_START/END blocks during a single run (e.g., one per tool result if progressive output is enabled).

---

## Error Handling

All fatal errors write an error output block and exit with code 1:

```
---NANOCLAW_OUTPUT_START---
{"status":"error","result":null,"error":"401 Missing Authentication header"}
---NANOCLAW_OUTPUT_END---
```

The host interprets exit code 1 as failure and schedules a retry with exponential backoff. After `MAX_RETRIES` (5), it sends a WhatsApp error notification and stops retrying until the next incoming message.

---

## Embedding Model

`Xenova/all-MiniLM-L6-v2` (quantized, ~23MB) is pre-downloaded into the image at build time via `download-embed-model.mjs`. Cache directory: `/home/node/.stingyclaw/transformers`.

At runtime, the model is loaded lazily on the first `search_tools` call:
```typescript
let _embedder: any = null
async function getEmbedder() {
  if (!_embedder) {
    _embedder = await pipeline('feature-extraction', EMBED_MODEL, { quantized: true })
  }
  return _embedder
}
```

Embedding results are cached per-registry in `.embeddings-cache.json` alongside the registry file. Cache is invalidated when the registry changes.
