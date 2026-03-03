# Message Lifecycle — How Your Text Flows Through Stingyclaw

This document explains what happens when you text the bot in three scenarios: a simple message, a single-action request, and a multi-step planning request.

---

## High-Level Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────────┐
│   WhatsApp      │────▶│  Host (index.ts)  │────▶│  Agent Container     │
│   (Baileys)     │     │  - storeMessage   │     │  (agent-runner)      │
│                 │◀────│  - GroupQueue     │◀────│  - OpenAI loop       │
└─────────────────┘     │  - IPC watcher    │     │  - Tools             │
                        └──────────────────┘     └─────────────────────┘
```

---

## Scenario 1: Simple Text (e.g. "Hi" or "How are you?")

**Flow:** Chat → Store → Route → Agent → Text reply

```
┌──────────────┐
│ You: "Hi"    │
└──────┬───────┘
       │
       ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ 1. WhatsApp (Baileys) receives message                                   │
│    → onMessage(chatJid, msg) fires                                         │
└──────┬───────────────────────────────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ 2. Host: storeMessage(msg) → SQLite (messages table)                      │
│    handleNewMessagesForGroup(chatJid)                                      │
└──────┬───────────────────────────────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ 3. Routing                                                                │
│    • Is group registered? → yes                                          │
│    • Main group or has trigger? → yes                                     │
│    • getMessagesSince() → pending messages                                │
│    • formatMessages() → prompt string                                     │
└──────┬───────────────────────────────────────────────────────────────────┘
       │
       ├─── Container ACTIVE? ───yes───▶ queue.sendMessage() → IPC file
       │                                 (data/ipc/{group}/input/*.json)
       │                                 → Agent polls, reads, processes
       │
       └─── Container INACTIVE? ──yes──▶ queue.enqueueMessageCheck()
                                         → processGroupMessages() when slot free
                                         → runContainerAgent() spawns container
                                         → prompt sent via stdin
       │
       ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ 4. Agent container                                                        │
│    • Loads session (or new)                                               │
│    • Injects: system prompt, MISSION.md, memory, plan (if any)             │
│    • API call: OpenAI chat completion                                    │
│    • Model returns text only (no tool calls)                              │
│    • lastText = model response                                            │
│    • writeOutput({ status: 'success', result: lastText })                 │
└──────┬───────────────────────────────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ 5. Host: parse container stdout (OUTPUT_START/END markers)               │
│    onOutput(result) → channel.sendMessage(chatJid, result.result)         │
│    queue.notifyIdle(chatJid) → container stays alive, waits for next msg   │
└──────┬───────────────────────────────────────────────────────────────────┘
       │
       ▼
┌──────────────┐
│ Bot: "Hi!"   │  ← Delivered via WhatsApp
└──────────────┘
```

**Key points:**
- No tools used; model produces text directly.
- Container stays alive (idle) for `IDLE_TIMEOUT`; next message can be piped via IPC.
- If no container was running, one is spawned; prompt goes via stdin.

---

## Scenario 2: Single Action (e.g. "What's the weather?" or "Run `ls`")

**Flow:** Chat → Route → Agent → Tool call → Report result (always)

```
┌────────────────────────────┐
│ You: "What's 2+2?"         │  or  "Run: ls -la"
└────────────┬───────────────┘
             │
             ▼
    [Same steps 1–3 as Scenario 1]
             │
             ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ 4. Agent container — tool loop                                            │
│                                                                          │
│    Iteration 1:                                                          │
│    • API call with user message                                          │
│    • Model returns: tool_calls: [Bash or WebFetch or ...]                │
│    • executeTool() → runs command, returns output                        │
│    • session.messages += tool result (truncated to 3000 chars)           │
│                                                                          │
│    Iteration 2:                                                          │
│    • API call with tool result in context                                │
│    • Model returns: content: "The result is 4" (no more tool calls)       │
│    • finish_reason = 'stop' → break                                      │
│    • lastText = "The result is 4"                                         │
│    • writeOutput({ status: 'success', result: lastText })                │
└──────┬───────────────────────────────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ 5. Host: onOutput() → channel.sendMessage(chatJid, result.result)        │
└──────┬───────────────────────────────────────────────────────────────────┘
       │
       ▼
┌────────────────────────────┐
│ Bot: "The result is 4"     │  ← You always get a reply
└────────────────────────────┘
```

**"Report the result no matter what" — why it works:**
- The agent loop does not exit until the model produces a final response (no more tool calls).
- The model is instructed (via system prompt) to summarize tool output and reply to the user.
- `result` is the last assistant `content` before `finish_reason === 'stop'`.
- If the model only used tools and produced no text, `lastText` could be null — but in practice the model is prompted to always provide a user-facing summary. The MISSION also says: "after browser screenshot, always call send_image" — so for actions that produce artifacts, the agent uses `send_message` or `send_image` to deliver the result.
- **Bottom line:** The loop forces a completion; the model is instructed to report. You get output either as final text or via `send_message`/`send_image` during execution.

---

## Scenario 3: Multi-Step (Planning + Actions + Report)

**Flow:** Chat → Route → Agent → Plan → Execute steps → Summarize → Report

```
┌─────────────────────────────────────────────────┐
│ You: "Open example.com, take a screenshot,      │
│      and send it to me"                         │
└────────────────────┬──────────────────────────┘
                      │
                      ▼
         [Same steps 1–3 as before]
                      │
                      ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ 4. Agent container — plan → execute → summarize                            │
│                                                                          │
│    Iteration 1: submit_plan                                                │
│    • Model: submit_plan({ steps: ["Open URL", "Screenshot", "send_image"] })│
│    • Tool writes to .agent-current-plan.json                              │
│    • Returns to model                                                      │
│                                                                          │
│    Iteration 2: execute step 1                                             │
│    • Model: agent-browser open https://example.com                        │
│    • Tool runs, returns success                                            │
│                                                                          │
│    Iteration 3: execute step 2                                             │
│    • Model: agent-browser screenshot page.png                              │
│    • Tool runs, returns path                                               │
│                                                                          │
│    Iteration 4: execute step 3                                             │
│    • Model: send_image(page.png)                                           │
│    • Tool writes to IPC messages/ → Host delivers image via WhatsApp      │
│                                                                          │
│    Iteration 5: summarize & clear                                          │
│    • Model: store_memory("Opened example.com, took screenshot, sent")     │
│    • Model: clear_plan()                                                   │
│    • Model: content: "Done! I've sent you the screenshot." (no tool calls) │
│    • finish_reason = 'stop' → break                                        │
│    • lastText = "Done! I've sent you the screenshot."                      │
│    • writeOutput({ status: 'success', result: lastText })                 │
└──────┬───────────────────────────────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ 5. Host                                                                   │
│    • IPC watcher already delivered send_image → you got the image         │
│    • onOutput() → channel.sendMessage(chatJid, "Done! I've sent...")     │
└──────┬───────────────────────────────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────┐
│ Bot: [image] + "Done! I've sent you the       │
│      screenshot."                             │
└─────────────────────────────────────────────────┘
```

**Plan state:**
- `submit_plan` → writes `.agent-current-plan.json`
- Plan is injected into system prompt: "Current plan (execute in order...)"
- `clear_plan` → removes it after completion
- `store_memory` → appends to `.agent-memory.json` for future context

---

## Visual Summary (All Three)

```
                    ┌─────────────────────────────────────────────────────────┐
                    │                    YOUR MESSAGE                          │
                    └─────────────────────────┬───────────────────────────────┘
                                              │
                                              ▼
                    ┌─────────────────────────────────────────────────────────┐
                    │  WhatsApp → storeMessage → handleNewMessagesForGroup     │
                    │  • Pipe to active container (IPC) OR                     │
                    │  • Enqueue → processGroupMessages → spawn container      │
                    └─────────────────────────┬───────────────────────────────┘
                                              │
                    ┌─────────────────────────┼───────────────────────────────┐
                    │                         │                               │
                    ▼                         ▼                               ▼
           ┌─────────────────┐     ┌─────────────────────┐     ┌─────────────────────┐
           │  SIMPLE CHAT     │     │  SINGLE ACTION      │     │  MULTI-STEP         │
           │  "Hi"            │     │  "Run ls"           │     │  "Screenshot & send"│
           └────────┬────────┘     └─────────┬──────────┘     └─────────┬───────────┘
                    │                         │                          │
                    ▼                         ▼                          ▼
           ┌─────────────────┐     ┌─────────────────────┐     ┌─────────────────────┐
           │  API → text      │     │  API → tool_call     │     │  submit_plan         │
           │  (no tools)      │     │  → execute           │     │  → tool × N           │
           │                  │     │  → API → text       │     │  → store_memory      │
           │                  │     │  (report result)    │     │  → clear_plan        │
           │                  │     │                     │     │  → text (report)      │
           └────────┬────────┘     └─────────┬──────────┘     └─────────┬───────────┘
                    │                         │                          │
                    └─────────────────────────┼──────────────────────────┘
                                              │
                                              ▼
                    ┌─────────────────────────────────────────────────────────┐
                    │  writeOutput(result) → Host parses stdout                 │
                    │  • send_message / send_image → via IPC (immediate)        │
                    │  • result (final text) → onOutput callback → WhatsApp    │
                    │  • notifyIdle → container waits for next message          │
                    └─────────────────────────────────────────────────────────┘
```

---

## When Does the Container Exit?

| Condition | Behavior |
|-----------|----------|
| `_close` sentinel written to IPC input | Container drains input, exits after current query |
| `IDLE_TIMEOUT` elapsed with no new messages | Host calls `closeStdin()` → container sees `_close`, exits |
| Another group needs a slot | Current group's container is not killed; it finishes, then slot freed |
| Fatal error | Container writes `status: 'error'`, exits; host may retry |

---

## Key Files

| Component | File |
|-----------|------|
| Message entry, routing, queue | `src/index.ts` |
| Group queue, IPC pipe, concurrency | `src/group-queue.ts` |
| Agent loop, tools, plan/memory | `container/agent-runner/src/index.ts` |
| IPC message delivery (send_message, etc.) | `src/ipc.ts` |
| Container spawn, stdin/stdout | `src/container-runner.ts` |
