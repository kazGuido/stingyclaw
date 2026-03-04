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

## Testing

Container rebuilt with all fixes. Try:
1. Send "hello" - should work without 400 error
2. Ask to screenshot a website - `agent-browser` should work with `send_image` chain
3. Test in non-main group - tools properly filtered
