# Fix Summary: Qwen3.5 Flash 400 Error & System Improvements

## Problems Fixed

### 1. **Qwen3.5 Flash 400 Error** ✅
**Root Cause:** Qwen3.5 Flash returns `reasoning` and `reasoning_details` fields incompatible with OpenAI API format.

**Fix:**
- Added explicit cleanup to strip `reasoning`, `reasoning_details`, and `refusal` fields
- Improved retry logic with aggressive message trimming on 400 errors

### 2. **agent-browser Not Working** ✅
**Root Cause:** `agent-browser` was documented but not registered as a tool.

**Fix:**
- Added `agent-browser` tool to registry
- Implemented tool execution via `Bash(command: "agent-browser <cmd>")`
- Added to `defaultEnabledNonMain` list

### 3. **Context Bleed - History Treated as Current Instruction** ✅
**Root Cause:** Agent confused old conversation messages with current instructions.

**Fix:**
- Added explicit instruction in system prompt: "The LAST user message is the CURRENT INSTRUCTION; all previous messages are HISTORY providing context."
- Proactive session history trimming (max 6 messages with memory, 10 without)
- System prompt now clearly separates history from current instruction

### 4. **Semantic Search Misses Critical Tools** ✅
**Root Cause:** `ask_boss` not in top-K results even when approval needed.

**Fix:**
- Added `alwaysRequired: true` flag to `ask_boss` and `send_message`
- These tools are always included regardless of search results

### 5. **Tool Chain Dependencies Missing** ✅
**Root Cause:** `send_image` not available when using `agent-browser`.

**Fix:**
- Automatic tool chain inclusion:
  - If `agent-browser` or `WebFetch` selected → auto-include `send_image`
  - Log which tool chains were added

### 6. **Fallback Without Limit** ✅
**Root Cause:** Semantic search fallback sent all 27 tools.

**Fix:**
- Added cap: max 15 tools in fallback mode
- Prevents context overflow

---

## How Tool Permissions Work

### Main Group (`main` folder)
- All 27 tools automatically enabled
- No configuration needed

### Non-Main Groups
Create `tools-enabled.json` in each group's folder:

```json
[
  "Read", "Glob", "Grep", "WebFetch", "agent-browser",
  "send_message", "send_voice", "send_image", "ask_boss",
  "store_memory", "submit_plan"
]
```

---

---

## Investigation: Container Exit Code 2 When Requesting Audio

### What you saw
- "Agent failed after 5 retries" with last error: `Container exited with code 2: ` (empty stderr).
- You were requesting audio (e.g. "send an audio presenting Tulande Online").

### Root cause (verified from logs)
- The failing runs were for group **tulandeclaw-test**, not main. Logs are under `groups/tulandeclaw-test/logs/`.
- In those logs, **Stdout** contained the real error (tsc wrote to stdout in the old entrypoint):
  - `src/index.ts(1125,7): error TS1128: Declaration or statement expected.`
- So **exit code 2** was from the **agent container’s entrypoint**: `npx tsc --outDir /tmp/dist` failed (TypeScript uses exit code 2 for compile errors). The per-group agent-runner source that was mounted had a TS error at line 1125; the container never reached the Node process or any audio logic.

### Why stderr was empty
- The old entrypoint sent tsc output through a redirect; in practice the diagnostic ended up in stdout, so the host only saw it in the log under "Stdout", and the reported "stderr" snippet was empty.

### Fixes applied
1. **Error message**  
   When the container exits non-zero, the host now:
   - Uses **stdout** when stderr is empty for the snippet.
   - For exit code 2, adds a hint that it usually means the agent TypeScript compile failed.
   - Always appends the **full log path** (e.g. `groups/<group>/logs/container-<timestamp>.log`).

2. **Entrypoint (Dockerfile)**  
   tsc output is written to a file and, on failure, is `cat`’d to stderr before exit so the host always captures the compile error in stderr and in the log.

3. **Pre-run TypeScript check**  
   Before spawning the container, the host runs `npx tsc --noEmit` in `container/agent-runner`. If it fails, the run is aborted with a clear error and the tsc output, so you no longer get "exit 2" with no explanation.

### What to do if it happens again
- Open the log path shown in the error (e.g. `groups/tulandeclaw-test/logs/container-<timestamp>.log`).
- Check **Exit Code**, **Stderr**, and **Stdout**; the compile error will be in one of them.
- Fix the reported file/line in `container/agent-runner/src` (or ensure no stale/custom copy is used for that group); the next run will either pass the pre-run check or show the same error clearly.

---

## Testing

Container rebuilt with all fixes. Try:
1. Send "hello" - should work without 400 error
2. Ask to screenshot a website - `agent-browser` should work with `send_image` chain
3. Test in non-main group - tools properly filtered
