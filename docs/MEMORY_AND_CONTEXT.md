# Memory and Context Handling

## Current State (as of this audit)

### Long-context problem

We had issues with long conversations blowing up the API context (token limits, 400 errors). Here's how we tackle it:

### 1. Stored memory (`.agent-memory.json`)

- **Location**: `groups/{name}/.agent-memory.json`
- **Purpose**: Agent-instructed summaries and facts across turns
- **Tools**: `store_memory` (append), `consult_memory` (read)
- **Limits**: Max 50 entries, 12k chars in prompt (most recent)
- **Behavior**: Agent is instructed to call `store_memory` after important steps. Memory is injected into the system prompt each turn.

**Summary acts as state**: Yes. The stored entries are short summaries (e.g. "User asked for screenshot of X; I took page.png and sent it"). They carry prior context so we don't need to send full history.

### 2. Session message capping

- **When memory exists**: Only last `MAX_SESSION_MESSAGES_WITH_MEMORY` (14) messages sent to API
- **When no memory**: Full session sent (can grow unbounded until 400)
- **On 400**: Auto-trim to last 10 messages, retry once

### 3. Tool result truncation

- **Max chars stored**: `MAX_TOOL_RESULT_STORED_CHARS` (3000)
- **Behavior**: WebFetch, Bash, etc. output truncated in session to avoid context blow-up

### 4. Plan state (`.agent-current-plan.json`)

- **Purpose**: Multi-step task tracking (plan → execute → summarize)
- **Tools**: `submit_plan`, `clear_plan`
- **Flow**: Agent plans, executes, then `store_memory` + `clear_plan`

### What we don't have yet

- **Vector memory**: No semantic search over memories. Entries are chronological only.
- **Compaction**: No automatic summarization of old memories. We just slice last 50.
- **Temporal decay**: No "older memories matter less" weighting.
