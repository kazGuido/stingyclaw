# MCP roadmap for Stingyclaw tools

Tools are implemented **inline** in the agent-runner today and are the single source of execution. This doc describes how we can add **MCP (Model Context Protocol)** later so the same tools can be exposed to MCP clients without rewriting everything.

## Current state

- **Tool registry**: `container/agent-runner/tool-registry.json` — single source of truth for tool names, descriptions, parameters, `confirmation_required`, and `destructive`. The agent builds OpenAI tool definitions from it and filters by **enabled tools per context** (main vs non-main, or per-group via `tools-enabled.json`).
- **Execution**: Still in-process in `container/agent-runner/src/index.ts` (`executeTool`). No MCP server yet.
- **Audit**: Every tool call is appended to `data/ipc/<groupFolder>/audit.jsonl` (who, when, tool, success, result size).
- **Confirmation**: Tools with `confirmation_required` in the registry trigger an ask_boss-style preview; the next user message is treated as yes/no before running the tool.

## Why add MCP later

- **Maintainability**: One registry, one place to add/change tools; optional MCP server can expose the same list.
- **Future users**: Clients (other IDEs, CLI, or services) that speak MCP can use the same tools without reimplementing them.
- **No big bang**: We can keep inline execution and add an MCP server that mirrors the registry and delegates to the same `executeTool`-style logic (or a shared core).

## Optional path: MCP server for all tools

1. **Keep** `tool-registry.json` and the current agent flow (filter tools by context, confirmation flow, audit log).
2. **Add** an MCP server (e.g. in the host or a sidecar) that:
   - Reads the same `tool-registry.json` (or a host-visible copy).
   - Exposes each tool as an MCP tool with the same name/description/parameters.
   - On `call_tool`, either:
     - Invokes the same execution logic (e.g. a shared module or IPC to the agent-runner), or
     - Returns a “run in container” instruction that the existing agent-runner already handles.
3. **Optionally** switch the agent-runner to be an MCP client: it discovers tools from the MCP server and sends tool calls via MCP instead of inline. That step can be done later without changing the registry or the host’s config (enabled tools, audit, confirmation).

## Config and audit (already in place)

- **Enabled tools per context**: Main group gets all tools; other groups get `defaultEnabledNonMain` from the registry unless the group has `tools-enabled.json` in its folder (`/workspace/group/tools-enabled.json`), which is a JSON array of allowed tool names.
- **Audit log**: One file per group at `data/ipc/<groupFolder>/audit.jsonl`. Each line is JSON: `ts`, `groupFolder`, `chatJid`, `tool`, `success`, `resultSizeBytes`.
- **Confirmation**: In the registry, set `confirmation_required: true` (and optionally `destructive: true`). The runner will ask the user with a short preview before executing; the next message is treated as confirm/cancel.

No rewrite is required to add MCP later; the registry and behavior are already structured so an MCP server can be added on top.
