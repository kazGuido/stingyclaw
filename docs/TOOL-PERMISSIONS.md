# Tool registration and permissions

## Registration (single source of truth)

- **File:** `container/agent-runner/tool-registry.json`
- **Registration:** Every tool the agent can call is listed in `tools[]`. There is no separate registration step; if it’s in the registry, it’s registered.
- **Current total:** 36 tools (Bash, Read, Write, Edit, Glob, Grep, WebFetch, agent-browser, send_message, send_voice, send_image, ask_boss, schedule_task, refresh_groups, available_groups, read_group_messages, register_group, list_scheduled_tasks, pause_task, resume_task, cancel_task, reset_session, store_memory, consult_memory, submit_plan, clear_plan, kb_*, add_task, list_tasks, update_task, delete_task, list_workflows, search_tools, run_workflow).

## Who is the “owner” (main)?

- **Main group:** The group whose **folder** is `main` (see `MAIN_GROUP_FOLDER` in `src/config.ts`). That’s the owner channel.
- **How the runner knows:** The host passes `isMain: true` only when `group.folder === 'main'`. So only the group that is registered with folder `main` gets owner permissions.

## Permissions for the owner (main)

- **Rule:** When `isMain === true`, the agent gets **all** tools from the registry.
- **Implementation:** `getEnabledToolNames(registry, true)` returns every tool name; `getToolsForContext(..., isMain: true)` returns the full tool set (no semantic limiting). So in the **main** channel you always have all 36 tools.

## Permissions for other groups

- **Rule:** When `isMain === false`, the allowed tools are either:
  1. **Custom list:** `groups/<group-folder>/tools-enabled.json` (JSON array of tool names), if that file exists, or  
  2. **Default allowlist:** `defaultEnabledNonMain` in `tool-registry.json`, otherwise.
- **Owner-only by default (not in defaultEnabledNonMain):**  
  `Bash`, `Write`, `Edit`, `refresh_groups`, `available_groups`, `register_group`.  
  So non-main groups get 30 tools by default; the other 6 are main-only unless you add them via `tools-enabled.json`.

## Why you might see “only 8 tools” as owner

- If the message was sent **from a non-main group** (e.g. NiceDay Biz, GuidoClawTest), the runner uses that group’s folder and `isMain` is **false**. Then:
  - If that group has a **custom** `tools-enabled.json` with e.g. 8 tools, only those 8 are allowed.
  - So you get “Available tools: send_message, send_voice, send_image, ask_boss, read_group_messages, register_group, reset_session, kb_add” and `submit_plan` is unavailable because it’s not in that group’s list.
- **To have all tools as owner:** Use the channel that is registered as the **main** group (folder `main`). There you always get all 36 tools. Other channels are restricted by their `tools-enabled.json` or by `defaultEnabledNonMain`.

## Quick reference

| Context              | How tools are chosen                                      | Owner gets all? |
|----------------------|-----------------------------------------------------------|-----------------|
| Main (folder `main`) | All tools from registry; no semantic limiting            | **Yes** (all 36) |
| Other groups         | `tools-enabled.json` in that group, or default allowlist  | No (list or 30) |

## Where to change permissions

- **Add/remove tools for a specific group:** Create or edit `groups/<group-folder>/tools-enabled.json` (e.g. `groups/nice-day-biz/tools-enabled.json`) with a JSON array of allowed tool names.
- **Change default for all non-main groups:** Edit `defaultEnabledNonMain` in `container/agent-runner/tool-registry.json`.
- **Add a new tool:** Add an entry to `tools[]` in `tool-registry.json` and implement its `case` in `executeTool()` in `container/agent-runner/src/index.ts`.
