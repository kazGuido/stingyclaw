/**
 * Stingyclaw Agent Runner
 *
 * OpenAI-compatible agentic loop. Two backends:
 *   1. OpenRouter — set OPENROUTER_API_KEY + MODEL_NAME (default)
 *   2. Local Ollama — set OPENROUTER_API_KEY=ollama
 *
 * Tools: loaded from tool registry (single source of truth). Filtered by
 * enabled-tools config per context (main vs group). Optional MCP later.
 * Tool discovery: semantic search for top-K relevant tools to save context tokens.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import { promisify } from 'util';
import { glob } from 'glob';
import { pipeline, env as xenovaEnv } from '@xenova/transformers';
import { generateText, jsonSchema } from 'ai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';

// Custom OpenRouter client used for Ollama and as fallback
import { callOpenRouter, convertTools, buildMessages, OpenRouterMessage, OpenRouterTool } from './openrouter-client.js';
import {
  type ChatMessage,
  sessionToCoreMessages,
  trimSessionMessagesForApi,
} from './chat-messages.js';

// Store model in the shared stingyclaw data dir so it persists across rebuilds
xenovaEnv.cacheDir = '/home/node/.stingyclaw/transformers';

const execAsync = promisify(exec);

// Import semantic tool search (must be loaded before first use)
import { semanticToolSearch } from './semantic-tool-search.js';

// ─── Protocol ────────────────────────────────────────────────────────────────

const OUTPUT_START_MARKER = '---STINGYCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---STINGYCLAW_OUTPUT_END---';

const IPC_DIR = '/workspace/ipc';
const IPC_INPUT_DIR = `${IPC_DIR}/input`;
const IPC_MESSAGES_DIR = `${IPC_DIR}/messages`;
const IPC_TASKS_DIR = `${IPC_DIR}/tasks`;
const IPC_RESPONSES_DIR = `${IPC_DIR}/responses`;
const IPC_AUDIT_FILE = `${IPC_DIR}/audit.jsonl`;
const IPC_INPUT_CLOSE_SENTINEL = `${IPC_INPUT_DIR}/_close`;
const IPC_POLL_MS = 500;

const SESSIONS_DIR = '/home/node/.stingyclaw/sessions';
const MAX_TOOL_ITERATIONS = 60;
/** Max chars of a tool result to keep in session. Prevents huge WebFetch/Bash output from blowing context. */
const MAX_TOOL_RESULT_STORED_CHARS = 3000;

/** Stored memory (consult/store) — state across turns to avoid context blow-up. */
const AGENT_MEMORY_PATH = '/workspace/group/.agent-memory.json';
const AGENT_MEMORY_MAX_ENTRIES = 50;
const AGENT_MEMORY_MAX_CHARS = 12000;
const MAX_SESSION_MESSAGES_WITH_MEMORY = 14;

/** Current plan (plan → execute → summarize). */
const AGENT_PLAN_PATH = '/workspace/group/.agent-current-plan.json';

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const OPENROUTER_DEFAULT_MODEL = 'liquid/lfm-2.5';

type Backend = 'openrouter' | 'ollama';

// ─── Tool registry (single source of truth; enables MCP + per-context filtering) ─

interface ToolRegistryEntry {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  confirmation_required?: boolean;
  destructive?: boolean;
}

interface ToolRegistry {
  tools: ToolRegistryEntry[];
  defaultEnabledNonMain?: string[];
}

let cachedRegistry: ToolRegistry | null = null;

function loadToolRegistry(): ToolRegistry {
  if (cachedRegistry) return cachedRegistry;
  const candidates = [
    '/app/tool-registry.json',
    path.join(process.cwd(), 'tool-registry.json'),
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tool-registry.json'),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        cachedRegistry = JSON.parse(fs.readFileSync(p, 'utf-8')) as ToolRegistry;
        log(`Tool registry loaded from ${p} (${cachedRegistry.tools.length} tools)`);
        return cachedRegistry;
      }
    } catch (e) {
      log(`Tool registry skip ${p}: ${(e as Error).message}`);
    }
  }
  throw new Error('tool-registry.json not found. Tried: ' + candidates.join(', '));
}

/**
 * Poll for IPC response with exponential backoff and jitter.
 * More resilient than fixed 20-iteration loops.
 */
async function pollForIpcResponse<T>(
  responsePath: string,
  options: { maxWaitMs?: number; initialDelayMs?: number } = {},
): Promise<{ found: true; data: T } | { found: false; error?: string }> {
  const { maxWaitMs = 30000, initialDelayMs = 100 } = options;
  const startTime = Date.now();
  let delay = initialDelayMs;

  while (Date.now() - startTime < maxWaitMs) {
    if (fs.existsSync(responsePath)) {
      try {
        const content = fs.readFileSync(responsePath, 'utf-8');
        fs.unlinkSync(responsePath);
        const data = JSON.parse(content) as T;
        return { found: true, data };
      } catch (err) {
        log(`Failed to parse IPC response at ${responsePath}: ${err}`);
        // Don't remove - might be still being written
        await new Promise((r) => setTimeout(r, delay));
      }
    }

    // Exponential backoff with jitter (max 1s)
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 1.5 + Math.random() * 50, 1000);
  }

  return { found: false, error: `Timeout after ${maxWaitMs}ms` };
}

/** Vercel AI SDK tool format: object keyed by tool name with description + parameters (jsonSchema). */
type VercelToolSet = Record<string, { description: string; parameters: ReturnType<typeof jsonSchema> }>;

function buildVercelToolSet(entries: ToolRegistryEntry[]): VercelToolSet {
  const out: VercelToolSet = {};
  for (const t of entries) {
    const schema = t.parameters as { type?: string; properties?: Record<string, unknown>; required?: string[] };
    out[t.name] = {
      description: t.description,
      parameters: jsonSchema({
        type: schema?.type ?? 'object',
        properties: schema?.properties ?? {},
        required: schema?.required ?? [],
      }),
    };
  }
  return out;
}

function getToolMeta(registry: ToolRegistry, name: string): ToolRegistryEntry | undefined {
  return registry.tools.find((t) => t.name === name);
}

/** Enabled tool names for this context. Main: all; others: tools-enabled.json or default. */
function getEnabledToolNames(registry: ToolRegistry, isMain: boolean): string[] {
  const allNames = registry.tools.map((t) => t.name);
  if (isMain) return allNames;
  const enabledPath = '/workspace/group/tools-enabled.json';
  try {
    if (fs.existsSync(enabledPath)) {
      const list = JSON.parse(fs.readFileSync(enabledPath, 'utf-8')) as string[];
      return list.filter((n) => allNames.includes(n));
    }
  } catch {
    /* use default */
  }
  return (registry.defaultEnabledNonMain ?? []).filter((n) => allNames.includes(n));
}

/** Get tools filtered by enabled list; when query is set, semantically pick top-K. Returns Vercel SDK tool set. */
async function getToolsForContext(
  registry: ToolRegistry,
  isMain: boolean,
  query?: string,
  topK: number = 6,
): Promise<VercelToolSet> {
  const enabledNames = new Set(getEnabledToolNames(registry, isMain));
  const filteredTools = registry.tools.filter((t) => enabledNames.has(t.name));

  // Owner (main) always gets all enabled tools; no semantic limiting.
  if (isMain) {
    log(`[main] All ${filteredTools.length} tools enabled`);
    return buildVercelToolSet(filteredTools);
  }

  if (!query?.trim()) {
    return buildVercelToolSet(filteredTools);
  }

  try {
    const results = await semanticToolSearch.searchAsync(query, topK);
    const topKNames = new Set(results.map((r) => r.name));
    const selectedTools = filteredTools.filter((t) => topKNames.has(t.name));
    
    // Always include tools marked as alwaysRequired
    const alwaysRequiredTools = registry.tools.filter(t => (t as any).alwaysRequired);
    
    // Build tool chain: if agent-browser is selected, include send_image
    const selectedNames = new Set(selectedTools.map(t => t.name));
    const needsImageTool = selectedNames.has('agent-browser') || selectedNames.has('WebFetch');
    if (needsImageTool && enabledNames.has('send_image')) {
      const sendImageTool = registry.tools.find(t => t.name === 'send_image');
      if (sendImageTool && !selectedNames.has('send_image')) {
        selectedTools.push(sendImageTool);
        log(`[semantic search] Added tool chain dependency: send_image`);
      }
    }
    
    // Add alwaysRequired tools if not already included (bypasses enabled list - these are mandatory)
    for (const tool of alwaysRequiredTools) {
      if (!selectedNames.has(tool.name)) {
        selectedTools.push(tool);
        log(`[semantic search] Added required tool: ${tool.name}`);
      }
    }
    
    log(`[semantic search] ${selectedTools.length} tools: ${selectedTools.map((r) => `${r.name}`).join(', ')}`);
    return buildVercelToolSet(selectedTools);
  } catch (err) {
    log(`[semantic search] Fallback: ${(err as Error).message}`);
    const fallbackTools = filteredTools.slice(0, 15);
    log(`[semantic search] Using fallback with ${fallbackTools.length} tools (max 15)`);
    return buildVercelToolSet(fallbackTools);
  }
}

// ─── Local embedder (workflow search / embedding cache) ───────────────────────
const EMBED_MODEL = 'Xenova/all-MiniLM-L6-v2';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _embedder: any = null;
async function getEmbedder() {
  if (!_embedder) {
    log(`Loading embedding model ${EMBED_MODEL}...`);
    _embedder = await pipeline('feature-extraction', EMBED_MODEL, { quantized: true });
    log('Embedding model ready');
  }
  return _embedder;
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  secrets?: Record<string, string>;
  /** Pending confirmation from previous session (persisted across restarts) */
  pendingConfirmation?: {
    toolCallId: string;
    toolName: string;
    args: Record<string, unknown>;
    preview: string;
  };
}

interface ContainerOutput {
  status: 'success' | 'error' | 'confirmation_required';
  result: string | null;
  newSessionId?: string;
  error?: string;
  /** Server-side only: real error reason for host logs (not sent to user). */
  errorDetail?: string;
  /** When status is confirmation_required: message to show user (e.g. ask_boss preview). */
  confirmationPreview?: string;
  /** When status is confirmation_required: tool name and args for audit/logging. */
  pendingTool?: { name: string; args: Record<string, unknown> };
}

interface PendingConfirmation {
  toolCallId: string;
  name: string;
  args: Record<string, unknown>;
}

interface Session {
  id: string;
  messages: ChatMessage[];
  createdAt: string;
  updatedAt: string;
  /** Set when a confirmation_required tool was requested; cleared after user confirms/cancels. */
  pendingConfirmation?: PendingConfirmation | null;
}

function writeOutput(output: ContainerOutput): void {
  const data =
    OUTPUT_START_MARKER + '\n' + JSON.stringify(output) + '\n' + OUTPUT_END_MARKER + '\n';
  // Write directly to fd to bypass Node.js block buffering when stdout is piped.
  // Without this, the host never receives output until the container exits.
  if (typeof process.stdout.fd === 'number') {
    fs.writeSync(process.stdout.fd, data);
  } else {
    process.stdout.write(data);
  }
}

function log(msg: string): void {
  console.error(`[agent-runner] ${msg}`);
}

// ─── Session management ───────────────────────────────────────────────────────

function sessionPath(id: string): string {
  return path.join(SESSIONS_DIR, `${id}.json`);
}

function loadSession(id: string): Session | null {
  try {
    return JSON.parse(fs.readFileSync(sessionPath(id), 'utf-8')) as Session;
  } catch {
    return null;
  }
}

function saveSession(session: Session): void {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  session.updatedAt = new Date().toISOString();
  fs.writeFileSync(sessionPath(session.id), JSON.stringify(session, null, 2));
}

// ─── Stored memory (consult/store) — state across turns ─────────────────────

interface MemoryEntry {
  t: string;
  content: string;
  embedding?: number[];
}

function loadMemoryFile(): MemoryEntry[] {
  try {
    if (!fs.existsSync(AGENT_MEMORY_PATH)) return [];
    const data = JSON.parse(fs.readFileSync(AGENT_MEMORY_PATH, 'utf-8')) as { entries?: MemoryEntry[] };
    return Array.isArray(data.entries) ? data.entries : [];
  } catch {
    return [];
  }
}

function getMemoryForPrompt(): string {
  const entries = loadMemoryFile();
  if (entries.length === 0) return '';
  let out = '';
  for (let i = entries.length - 1; i >= 0 && out.length < AGENT_MEMORY_MAX_CHARS; i--) {
    const line = `[${entries[i].t}] ${entries[i].content}`;
    out = out ? line + '\n' + out : line;
  }
  return out.slice(-AGENT_MEMORY_MAX_CHARS);
}

function appendStoredMemory(content: string): void {
  const entries = loadMemoryFile();
  entries.push({ t: new Date().toISOString(), content: content.slice(0, 2000) });
  const trimmed = entries.slice(-AGENT_MEMORY_MAX_ENTRIES);
  fs.mkdirSync(path.dirname(AGENT_MEMORY_PATH), { recursive: true });
  fs.writeFileSync(AGENT_MEMORY_PATH, JSON.stringify({ entries: trimmed }, null, 2));
}

/** Append memory with embedding for semantic search. Compaction: drop oldest when over limit. */
async function appendStoredMemoryWithEmbedding(content: string): Promise<void> {
  const entries = loadMemoryFile();
  const text = content.slice(0, 2000);
  const [vec] = await embed([text]);
  entries.push({ t: new Date().toISOString(), content: text, embedding: vec });
  // Compaction: keep last N entries
  const trimmed = entries.slice(-AGENT_MEMORY_MAX_ENTRIES);
  fs.mkdirSync(path.dirname(AGENT_MEMORY_PATH), { recursive: true });
  fs.writeFileSync(AGENT_MEMORY_PATH, JSON.stringify({ entries: trimmed }, null, 2));
}

/** Semantic search over stored memory. Returns top-k most relevant entries. */
async function memorySearch(query: string, topK = 5): Promise<MemoryEntry[]> {
  const entries = loadMemoryFile();
  if (entries.length === 0) return [];
  const withoutEmbedding = entries.filter(e => !e.embedding || e.embedding.length === 0);
  if (withoutEmbedding.length > 0) {
    const vecs = await embed(withoutEmbedding.map(e => e.content));
    for (let i = 0; i < withoutEmbedding.length; i++) {
      withoutEmbedding[i].embedding = vecs[i];
    }
    fs.writeFileSync(AGENT_MEMORY_PATH, JSON.stringify({ entries }, null, 2));
  }
  const [queryVec] = await embed([query]);
  const scored = entries
    .filter((e): e is MemoryEntry & { embedding: number[] } => !!(e.embedding?.length))
    .map(e => ({ entry: e, score: cosine(queryVec, e.embedding) }))
    .filter(s => s.score > 0.2)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, topK).map(s => s.entry);
}

// ─── Current plan (plan → execute → summarize) ─────────────────────────────────

interface CurrentPlan {
  steps: string[];
  createdAt: string;
}

function loadCurrentPlan(): CurrentPlan | null {
  try {
    if (!fs.existsSync(AGENT_PLAN_PATH)) return null;
    const data = JSON.parse(fs.readFileSync(AGENT_PLAN_PATH, 'utf-8')) as CurrentPlan;
    return data?.steps?.length ? data : null;
  } catch {
    return null;
  }
}

function getPlanForPrompt(): string {
  const plan = loadCurrentPlan();
  if (!plan) return '';
  return plan.steps.map((s, i) => `${i + 1}. ${s}`).join('\n');
}

function setCurrentPlan(steps: string[]): void {
  const trimmed = steps.slice(0, 30).map(s => String(s).slice(0, 500));
  fs.mkdirSync(path.dirname(AGENT_PLAN_PATH), { recursive: true });
  fs.writeFileSync(AGENT_PLAN_PATH, JSON.stringify({
    steps: trimmed,
    createdAt: new Date().toISOString(),
  }, null, 2));
}

function clearCurrentPlan(): void {
  try {
    if (fs.existsSync(AGENT_PLAN_PATH)) fs.unlinkSync(AGENT_PLAN_PATH);
  } catch (err) {
    log(`Failed to clear plan: ${err}`);
  }
}

function newSession(): Session {
  return {
    id: crypto.randomUUID(),
    messages: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

// ─── System prompt ────────────────────────────────────────────────────────────

/** Only document tools that are actually passed to the model. Prevents "Model tried to call unavailable tool" (e.g. Bash) when the prompt described tools not in the API request. */
function buildSystemPrompt(input: ContainerInput, availableToolNames: string[]): string {
  const name = input.assistantName || 'Andy';
  const has = (tool: string) => availableToolNames.includes(tool);
  const toolList = availableToolNames.join(', ');

  const toolBlocks: string[] = [];
  if (has('send_voice')) toolBlocks.push(`Tool: send_voice
  Description: Send spoken audio to the chat (OGG Opus voice note).
  When to use: User asks for audio/voice, or sent a voice message (reply with voice).
  How to use: send_voice(text: "short message under 150 words", voice?: "Ryan" | "Aiden" | "Vivian" | "Serena" | "Uncle_Fu" | "Dylan" | "Eric" | "Ono_Anna" | "Sohee" | "French")
  WARNING: If you don't call this when user asks for audio, they get NOTHING audible.`);
  if (has('send_image')) toolBlocks.push(`Tool: send_image
  Description: Send an image file to the chat. After any screenshot, call send_image(path) so the user sees it.
  How to use: send_image(path: "relative.png", caption?: "optional text")`);
  if (has('send_message')) toolBlocks.push(`Tool: send_message
  Description: Send immediate text updates. How to use: send_message(text: "progress or result")`);
  if (has('ask_boss')) toolBlocks.push(`Tool: ask_boss
  Description: Ask the user for guidance before risky actions. How to use: ask_boss(question: "...")`);
  if (has('Bash')) toolBlocks.push(`Tool: Bash
  Description: Run shell commands in /workspace/group (timeout: 30s default, max 120s).
  Example: Bash(command: "ls -la", timeout: 60000). For agent-browser: Bash(command: "agent-browser open https://...") etc.`);
  if (has('Read') || has('Glob') || has('Grep')) toolBlocks.push(`Tool: Read, Glob, Grep
  Description: Read files, find files by pattern, search file contents. Example: Grep(pattern: "TODO", path: "/workspace/group")`);
  if (has('WebFetch')) toolBlocks.push(`Tool: WebFetch — Fetch a URL and return text (HTML stripped).`);
  if (has('agent-browser')) toolBlocks.push(`Tool: agent-browser — Browser automation. Use Bash(command: "agent-browser open ..."), snapshot, click, fill, screenshot. After screenshot call send_image("file.png").`);
  if (has('submit_plan') || has('store_memory') || has('clear_plan') || has('consult_memory')) toolBlocks.push(`Tool: submit_plan, store_memory, clear_plan, consult_memory — Plan before multi-step work; store/consult memory; clear_plan when done.`);
  if (has('list_workflows') || has('search_tools') || has('run_workflow')) toolBlocks.push(`Tool: list_workflows, search_tools, run_workflow — Pre-built automations. list_workflows(), search_tools(query), run_workflow(name, args).`);
  if (has('available_groups') || has('refresh_groups') || has('register_group')) toolBlocks.push(`Tool: available_groups, refresh_groups, register_group — WhatsApp group management (main only).`);
  if (has('schedule_task')) toolBlocks.push(`Tool: schedule_task, list_scheduled_tasks, pause_task, resume_task, cancel_task — Schedule recurring or one-time tasks.`);
  if (has('kb_add') || has('kb_search') || has('kb_list')) toolBlocks.push(`Tool: kb_add, kb_search, kb_list — Knowledge base. kb_add(title, content, tags), kb_search(query), kb_list().`);
  if (has('add_task') || has('list_tasks') || has('update_task') || has('delete_task')) toolBlocks.push(`Tool: add_task, list_tasks, update_task, delete_task — Task management. add_task(title, ...), list_tasks(status?, type?), update_task(task_id, ...), delete_task(task_id).`);
  if (has('read_group_messages')) toolBlocks.push(`Tool: read_group_messages — Read recent group messages for context.`);
  if (has('reset_session')) toolBlocks.push(`Tool: reset_session — Clear conversation state and start fresh.`);

  const rules: string[] = [
    'When user asks for AUDIO or sent a voice message: you MUST call send_voice(text: "..."). Do not reply with text only.',
    'When user asks for a SCREENSHOT/IMAGE or after you create one: call send_image(path: "file.png").',
    'Before risky/irreversible actions: call ask_boss(question: "...") and wait for approval.',
  ];
  if (has('submit_plan') || has('store_memory') || has('clear_plan')) {
    rules.push('Multi-step tasks: call submit_plan(steps: [...]) first, then execute, then store_memory and clear_plan.');
  }
  const workflowSteps: string[] = ['Analyze what the user wants.', 'Use only the tools listed above — never call a tool that is not in the list.'];
  if (has('submit_plan')) workflowSteps.splice(1, 0, 'If multi-step: submit_plan() then execute.');
  if (has('send_message') || has('send_voice')) workflowSteps.push('When done: send_message/send_voice if needed.');
  if (has('store_memory') || has('clear_plan')) workflowSteps.push('store_memory and clear_plan when done.');

  const parts: string[] = [
    `You are ${name}, a helpful AI assistant connected to a WhatsApp chat.

=== CRITICAL ===
You ONLY have access to these tools in this context. Do NOT call any other tool (calling an unavailable tool will fail).
Available tools: ${toolList}

`,
    rules.map((r, i) => `${i + 1}. ${r}`).join('\n'),
    `

=== YOUR TOOLS (use only these) ===

`,
    toolBlocks.join('\n\n'),
    `

=== WORKFLOW ===
`,
    workflowSteps.map((s, i) => `${i + 1}. ${s}`).join(' '),
    `

=== SYSTEM CONTEXT ===
Working directory: /workspace/group.
Model: ${input.isMain ? 'main group (full tool access)' : 'group context (filtered tools)'}.
Session ID: ${input.sessionId || 'new'}
${input.chatJid} — ${input.groupFolder}
${input.isMain ? `\nHow to allow tools for a specific group (operator action): Create or edit groups/<group-folder>/tools-enabled.json on the host with a JSON array of allowed tool names (e.g. ["Read","Grep","send_message","ask_boss"]). If the file is missing, that group uses the registry default allowlist. Main (you) always has all tools; other groups use tools-enabled.json or the default.\n` : ''}
${input.isScheduledTask ? '\n[SCHEDULED TASK — output via send_message if needed.]' : ''}`,
  ];

  // (no secondary AI CLI — the primary model handles everything directly)

  const groupMd = '/workspace/group/MISSION.md';
  if (fs.existsSync(groupMd)) {
    parts.push('\n\n---\n' + fs.readFileSync(groupMd, 'utf-8'));
  }

  if (!input.isMain) {
    const globalMd = '/workspace/global/MISSION.md';
    if (fs.existsSync(globalMd)) {
      parts.push('\n\n---\n' + fs.readFileSync(globalMd, 'utf-8'));
    }
  }

  const memoryContent = getMemoryForPrompt();
  if (memoryContent && (has('consult_memory') || has('store_memory') || has('memory_search'))) {
    const memHints = [has('consult_memory') && 'consult_memory to read', has('store_memory') && 'store_memory to update', has('memory_search') && 'memory_search to find by meaning'].filter(Boolean) as string[];
    parts.push('\n\n---\nStored memory (context across turns; ' + memHints.join(', ') + '):\n' + memoryContent);
  }

  const planContent = getPlanForPrompt();
  if (planContent && (has('submit_plan') || has('clear_plan'))) {
    const planHint = (has('store_memory') || has('clear_plan')) ? ' then store_memory and clear_plan' : '';
    parts.push('\n\n---\nCurrent plan (execute in order' + planHint + '):\n' + planContent);
  }

  parts.push(`

=== REMINDER: ONLY THESE TOOLS ===
You may ONLY call tools from this exact list. Do not call any other tool (e.g. submit_plan, store_memory, clear_plan, Bash, Read) unless it is in the list below.
Allowed: ${toolList}

=== HISTORY vs CURRENT MESSAGE ===
The conversation history below contains previous exchanges. The LAST user message in the list is the CURRENT INSTRUCTION you need to respond to.
All messages before that are HISTORY that provides context but should not be treated as new instructions.
Focus on responding to the LAST message in the history array.
`);

  return parts.join('');
}

// ─── IPC helpers ──────────────────────────────────────────────────────────────

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const fp = path.join(dir, filename);
  const tmp = `${fp}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, fp);
  return filename;
}

function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try {
      fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
    } catch (err) {
      log(`Failed to remove close sentinel: ${err}`);
    }
    return true;
  }
  return false;
}

function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs.readdirSync(IPC_INPUT_DIR).filter(f => f.endsWith('.json')).sort();
    const messages: string[] = [];
    for (const file of files) {
      const fp = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(fp, 'utf-8')) as { type?: string; text?: string };
        fs.unlinkSync(fp);
        if (data.type === 'message' && data.text) messages.push(data.text);
      } catch (err) {
        log(`Failed to process IPC file ${file}: ${err}`);
        try {
          fs.unlinkSync(fp);
        } catch (unlinkErr) {
          log(`Failed to remove corrupt IPC file ${file}: ${unlinkErr}`);
        }
      }
    }
    return messages;
  } catch (err) {
    log(`Failed to drain IPC input: ${err}`);
    return [];
  }
}

function waitForIpcMessage(): Promise<string | null> {
  return new Promise(resolve => {
    const poll = () => {
      if (shouldClose()) { resolve(null); return; }
      const msgs = drainIpcInput();
      if (msgs.length > 0) { resolve(msgs.join('\n')); return; }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

// ─── Tool definitions ─────────────────────────────────────────────────────────

// Tools are built from tool-registry.json; semantic search picks top-K by query when provided.

/** Append one line to the audit log (who, when, tool, success, result size). */
function auditLog(
  input: ContainerInput,
  toolName: string,
  success: boolean,
  resultSizeBytes: number,
): void {
  try {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      groupFolder: input.groupFolder,
      chatJid: input.chatJid,
      tool: toolName,
      success,
      resultSizeBytes,
    }) + '\n';
    fs.appendFileSync(IPC_AUDIT_FILE, line);
  } catch (e) {
    log(`Audit log write failed: ${(e as Error).message}`);
  }
}

// ─── Semantic search helpers ──────────────────────────────────────────────────

interface RegistryEntry {
  name: string;
  description: string;
  run: string;
  args?: string[];
}

interface EmbeddingCache {
  model: string;
  entries: Array<{ name: string; embedding: number[] }>;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

async function embed(texts: string[]): Promise<number[][]> {
  const model = await getEmbedder();
  const results: number[][] = [];
  for (const text of texts) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out: any = await model(text, { pooling: 'mean', normalize: true });
    results.push(Array.from(out.data as Float32Array) as number[]);
  }
  return results;
}

const EMBEDDINGS_CACHE_PATH = '/workspace/group/workflows/.embeddings-cache.json';

async function loadEmbeddingCache(registry: RegistryEntry[]): Promise<EmbeddingCache> {
  // Return cache if model matches and all current entries are covered
  try {
    const cached = JSON.parse(fs.readFileSync(EMBEDDINGS_CACHE_PATH, 'utf-8')) as EmbeddingCache;
    const cachedNames = new Set(cached.entries.map(e => e.name));
    const allCovered = registry.every(e => cachedNames.has(e.name));
    if (cached.model === EMBED_MODEL && allCovered) return cached;
  } catch { /* cache missing or stale */ }

  log('Building workflow embeddings cache...');
  const embeddings = await embed(registry.map(e => `${e.name}: ${e.description}`));
  const cache: EmbeddingCache = {
    model: EMBED_MODEL,
    entries: registry.map((e, i) => ({ name: e.name, embedding: embeddings[i] })),
  };
  fs.mkdirSync(path.dirname(EMBEDDINGS_CACHE_PATH), { recursive: true });
  fs.writeFileSync(EMBEDDINGS_CACHE_PATH, JSON.stringify(cache));
  return cache;
}

async function semanticSearch(query: string, registry: RegistryEntry[], topK = 4): Promise<RegistryEntry[]> {
  const [cache, queryVec] = await Promise.all([
    loadEmbeddingCache(registry),
    embed([query]).then(v => v[0]),
  ]);

  const scored = cache.entries
    .map(cached => ({
      entry: registry.find(e => e.name === cached.name)!,
      score: cosine(queryVec, cached.embedding),
    }))
    .filter(s => s.entry && s.score > 0.3)
    .sort((a, b) => b.score - a.score);

  return scored.slice(0, topK).map(s => s.entry);
}

// ─── Tool executor ────────────────────────────────────────────────────────────

function resolvePath(p: string): string {
  return path.isAbsolute(p) ? p : path.join('/workspace/group', p);
}

interface SessionRef {
  session: Session;
  replaceWithNew?: boolean;
}

async function executeTool(
  name: string,
  args: Record<string, unknown>,
  input: ContainerInput,
  sessionRef?: SessionRef,
): Promise<string> {
  try {
    switch (name) {
      case 'Bash': {
        const cmd = args.command as string;
        const timeout = Math.min((args.timeout as number | undefined) ?? 30000, 120000);
        log(`Bash: ${cmd.slice(0, 120)}`);
        try {
          const { stdout, stderr } = await execAsync(cmd, {
            timeout,
            cwd: '/workspace/group',
            maxBuffer: 10 * 1024 * 1024,
          });
          return [stdout, stderr ? `STDERR:\n${stderr}` : ''].filter(Boolean).join('\n') || '(no output)';
        } catch (err) {
          const e = err as { message: string; stdout?: string; stderr?: string; killed?: boolean };
          if (e.killed) return `Command timed out after ${timeout}ms`;
          return [e.stdout, e.stderr ? `STDERR:\n${e.stderr}` : '', `Exit error: ${e.message}`]
            .filter(Boolean).join('\n');
        }
      }

      case 'Read': {
        const fp = resolvePath(args.path as string);
        log(`Read: ${fp}`);
        const content = fs.readFileSync(fp, 'utf-8');
        const lines = content.split('\n');
        const start = args.offset != null ? (args.offset as number) - 1 : 0;
        const end = args.limit != null ? start + (args.limit as number) : lines.length;
        return lines
          .slice(start, end)
          .map((l, i) => `${String(start + i + 1).padStart(6)}|${l}`)
          .join('\n');
      }

      case 'Write': {
        const fp = resolvePath(args.path as string);
        log(`Write: ${fp}`);
        fs.mkdirSync(path.dirname(fp), { recursive: true });
        fs.writeFileSync(fp, args.content as string);
        return `Written ${(args.content as string).length} bytes to ${fp}`;
      }

      case 'Edit': {
        const fp = resolvePath(args.path as string);
        log(`Edit: ${fp}`);
        const content = fs.readFileSync(fp, 'utf-8');
        const oldStr = args.old_string as string;
        const newStr = args.new_string as string;
        const count = content.split(oldStr).length - 1;
        if (count === 0) return `Error: old_string not found in ${fp}`;
        if (count > 1) return `Error: old_string matches ${count} times — must be unique. Add more surrounding context.`;
        fs.writeFileSync(fp, content.replace(oldStr, newStr));
        return `Replaced text in ${fp}`;
      }

      case 'Glob': {
        const cwd = args.directory ? resolvePath(args.directory as string) : '/workspace/group';
        log(`Glob: ${args.pattern} in ${cwd}`);
        const files = await glob(args.pattern as string, { cwd });
        return files.sort().join('\n') || '(no matches)';
      }

      case 'Grep': {
        const searchPath = args.path ? resolvePath(args.path as string) : '/workspace/group';
        const flags = (args.flags as string | undefined) ?? '';
        const escaped = (args.pattern as string).replace(/'/g, "'\\''");
        const cmd = `rg ${flags} '${escaped}' -- '${searchPath}' 2>&1 | head -300`;
        log(`Grep: ${args.pattern} in ${searchPath}`);
        try {
          const { stdout } = await execAsync(cmd, { timeout: 15000, cwd: '/workspace/group' });
          return stdout || '(no matches)';
        } catch (err) {
          const e = err as { stdout?: string; code?: number };
          if (e.code === 1) return '(no matches)';
          return e.stdout || '(grep error)';
        }
      }

      case 'WebFetch': {
        const url = args.url as string;
        log(`WebFetch: ${url}`);
        const res = await fetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Stingyclaw/2.0)' },
          signal: AbortSignal.timeout(30000),
        });
        const text = await res.text();
        const cleaned = text
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>').replace(/&quot;/g, '"')
          .replace(/\s+/g, ' ')
          .trim();
        return cleaned.slice(0, 15000) + (cleaned.length > 15000 ? '\n...(truncated)' : '');
      }

      case 'agent-browser': {
        const command = args.command as string;
        if (!command?.trim()) return 'Error: agent-browser requires a command.';
        log(`agent-browser: ${command.slice(0, 100)}`);
        const cmd = `agent-browser ${command}`;
        try {
          const { stdout, stderr } = await execAsync(cmd, {
            timeout: 60000,
            cwd: '/workspace/group',
            maxBuffer: 10 * 1024 * 1024,
          });
          return [stdout, stderr ? `STDERR:\n${stderr}` : ''].filter(Boolean).join('\n') || '(no output)';
        } catch (err) {
          const e = err as { message: string; stdout?: string; stderr?: string; killed?: boolean };
          if (e.killed) return `Command timed out after 60s`;
          return [e.stdout, e.stderr ? `STDERR:\n${e.stderr}` : '', `Exit error: ${e.message}`]
            .filter(Boolean).join('\n');
        }
      }

      case 'send_message': {
        writeIpcFile(IPC_MESSAGES_DIR, {
          type: 'message',
          chatJid: input.chatJid,
          text: args.text as string,
          groupFolder: input.groupFolder,
          timestamp: new Date().toISOString(),
        });
        return 'Message sent.';
      }

      case 'send_voice': {
        writeIpcFile(IPC_MESSAGES_DIR, {
          type: 'voice_message',
          chatJid: input.chatJid,
          text: args.text as string,
          voice: args.voice as string | undefined,
          groupFolder: input.groupFolder,
          timestamp: new Date().toISOString(),
        });
        return 'Voice message queued for sending.';
      }

      case 'send_image': {
        const groupBase = '/workspace/group';
        const rawPath = String((args.path as string) || '').trim();
        const resolved = path.isAbsolute(rawPath) ? path.resolve(rawPath) : path.resolve(groupBase, rawPath);
        const relativePath = path.relative(groupBase, resolved);
        if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
          return 'Invalid path: image must be under /workspace/group.';
        }
        if (!fs.existsSync(resolved)) {
          return `File not found: ${resolved}`;
        }
        writeIpcFile(IPC_MESSAGES_DIR, {
          type: 'image_message',
          chatJid: input.chatJid,
          relativePath: path.normalize(relativePath),
          caption: (args.caption as string) || undefined,
          groupFolder: input.groupFolder,
          timestamp: new Date().toISOString(),
        });
        return 'Image sent to chat.';
      }

      case 'kb_add': {
        const title = args.title as string;
        const content = args.content as string;
        const tags = (args.tags as string | undefined) ?? '';
        const groupFolder = input.groupFolder;
        const requestId = crypto.randomUUID();
        writeIpcFile(IPC_TASKS_DIR, {
          type: 'kb_add',
          requestId,
          groupFolder,
          title,
          content,
          tags,
          timestamp: new Date().toISOString(),
        });
        const responsePath = path.join(IPC_RESPONSES_DIR, `kb_add_${requestId}.json`);
        const result = await pollForIpcResponse<{ error?: string; id?: string }>(responsePath, { maxWaitMs: 30000 });
        if (!result.found) return 'KB entry request timed out. Try again.';
        if (result.data.error) return `Error: ${result.data.error}`;
        return `Knowledge base entry created with ID: ${result.data.id}`;
      }

      case 'kb_search': {
        const query = args.query as string;
        const groupFolder = input.groupFolder;
        const requestId = crypto.randomUUID();
        writeIpcFile(IPC_TASKS_DIR, {
          type: 'kb_search',
          requestId,
          groupFolder,
          query,
          timestamp: new Date().toISOString(),
        });
        const responsePath = path.join(IPC_RESPONSES_DIR, `kb_search_${requestId}.json`);
        const searchResult = await pollForIpcResponse<{ error?: string; results?: Array<{ id: number; title: string; snippet: string }> }>(responsePath, { maxWaitMs: 30000 });
        if (!searchResult.found) return 'KB search timed out. Try again.';
        if (searchResult.data.error) return `Error: ${searchResult.data.error}`;
        if (!searchResult.data.results || searchResult.data.results.length === 0) return 'No matching KB entries found.';
        return searchResult.data.results
          .map((r) => `[${r.id}] ${r.title}\n${r.snippet}`)
          .join('\n\n');
      }

      case 'kb_list': {
        const groupFolder = input.groupFolder;
        const requestId = crypto.randomUUID();
        writeIpcFile(IPC_TASKS_DIR, {
          type: 'kb_list',
          requestId,
          groupFolder,
          timestamp: new Date().toISOString(),
        });
        const responsePath = path.join(IPC_RESPONSES_DIR, `kb_list_${requestId}.json`);
        const listResult = await pollForIpcResponse<{ error?: string; entries?: Array<{ id: number; title: string; tags?: string }> }>(responsePath, { maxWaitMs: 30000 });
        if (!listResult.found) return 'KB list timed out. Try again.';
        if (listResult.data.error) return `Error: ${listResult.data.error}`;
        if (!listResult.data.entries || listResult.data.entries.length === 0) return 'No KB entries found.';
        return listResult.data.entries
          .map((e) => `[${e.id}] ${e.title}${e.tags ? ' (#' + e.tags + ')' : ''}`)
          .join('\n');
      }

      case 'add_task': {
        const title = args.title as string;
        const description = (args.description as string | undefined) ?? '';
        const dueDate = (args.due_date as string | undefined) ?? '';
        const type = (args.type as string | undefined) ?? 'todo';
        const priority = (args.priority as number | undefined) ?? 0;
        const groupFolder = input.groupFolder;
        const requestId = crypto.randomUUID();
        writeIpcFile(IPC_TASKS_DIR, {
          type: 'add_task',
          requestId,
          groupFolder,
          title,
          description,
          dueDate,
          taskType: type,
          priority,
          timestamp: new Date().toISOString(),
        });
        const responsePath = path.join(IPC_RESPONSES_DIR, `add_task_${requestId}.json`);
        const addResult = await pollForIpcResponse<{ error?: string; id?: string }>(responsePath, { maxWaitMs: 30000 });
        if (!addResult.found) return 'Task creation timed out. Try again.';
        if (addResult.data.error) return `Error: ${addResult.data.error}`;
        return `Task created with ID: ${addResult.data.id}`;
      }

      case 'list_tasks': {
        const groupFolder = input.groupFolder;
        const status = (args.status as string | undefined) ?? '';
        const type = (args.type as string | undefined) ?? '';
        const requestId = crypto.randomUUID();
        writeIpcFile(IPC_TASKS_DIR, {
          type: 'list_tasks',
          requestId,
          groupFolder,
          status,
          taskType: type,
          timestamp: new Date().toISOString(),
        });
        const responsePath = path.join(IPC_RESPONSES_DIR, `list_tasks_${requestId}.json`);
        const listTaskResult = await pollForIpcResponse<{ error?: string; tasks?: Array<{ id: number; title: string; status: string; due_date?: string; type: string }> }>(responsePath, { maxWaitMs: 30000 });
        if (!listTaskResult.found) return 'Task list timed out. Try again.';
        if (listTaskResult.data.error) return `Error: ${listTaskResult.data.error}`;
        if (!listTaskResult.data.tasks || listTaskResult.data.tasks.length === 0) return 'No tasks found.';
        return listTaskResult.data.tasks
          .map((t) => `[${t.id}] ${t.title} (${t.status})${t.due_date ? ' due ' + t.due_date.split('T')[0] : ''}${t.type !== 'todo' ? ' [' + t.type + ']' : ''}`)
          .join('\n');
      }

      case 'update_task': {
        const taskId = args.task_id as number;
        const updates: Record<string, any> = {};
        if (args.title !== undefined) updates.title = args.title as string;
        if (args.status !== undefined) updates.status = args.status as string;
        if (args.due_date !== undefined) updates.due_date = args.due_date as string;
        if (args.priority !== undefined) updates.priority = args.priority as number;
        const groupFolder = input.groupFolder;
        const requestId = crypto.randomUUID();
        writeIpcFile(IPC_TASKS_DIR, {
          type: 'update_task',
          requestId,
          groupFolder,
          taskId,
          updates,
          timestamp: new Date().toISOString(),
        });
        const responsePath = path.join(IPC_RESPONSES_DIR, `update_task_${requestId}.json`);
        const updateResult = await pollForIpcResponse<{ error?: string; success?: boolean }>(responsePath, { maxWaitMs: 30000 });
        if (!updateResult.found) return 'Task update timed out. Try again.';
        if (updateResult.data.error) return `Error: ${updateResult.data.error}`;
        return updateResult.data.success ? 'Task updated.' : 'Task not found.';
      }

      case 'delete_task': {
        const taskId = args.task_id as number;
        const groupFolder = input.groupFolder;
        const requestId = crypto.randomUUID();
        writeIpcFile(IPC_TASKS_DIR, {
          type: 'delete_task',
          requestId,
          groupFolder,
          taskId,
          timestamp: new Date().toISOString(),
        });
        const responsePath = path.join(IPC_RESPONSES_DIR, `delete_task_${requestId}.json`);
        const deleteResult = await pollForIpcResponse<{ error?: string; success?: boolean }>(responsePath, { maxWaitMs: 30000 });
        if (!deleteResult.found) return 'Task deletion timed out. Try again.';
        if (deleteResult.data.error) return `Error: ${deleteResult.data.error}`;
        return deleteResult.data.success ? 'Task deleted.' : 'Task not found.';
      }

      case 'ask_boss': {
        const q = (args.question as string) || 'Need your input.';
        const text = `Need your input: ${q}`;
        writeIpcFile(IPC_MESSAGES_DIR, {
          type: 'message',
          chatJid: input.chatJid,
          text,
          groupFolder: input.groupFolder,
          timestamp: new Date().toISOString(),
        });
        return 'Question sent. Stop and wait for the user\'s reply in the next message.';
      }

      case 'refresh_groups': {
        if (!input.isMain) {
          return 'Only the main group can refresh group metadata.';
        }
        const groupsPath = path.join(IPC_DIR, 'available_groups.json');
        let oldLastSync: string | null = null;
        if (fs.existsSync(groupsPath)) {
          try {
            const prev = JSON.parse(fs.readFileSync(groupsPath, 'utf-8')) as { lastSync?: string };
            oldLastSync = prev.lastSync ?? null;
          } catch (err) {
            log(`Failed to parse available_groups.json: ${err}`);
          }
        }
        writeIpcFile(IPC_TASKS_DIR, {
          type: 'refresh_groups',
          groupFolder: input.groupFolder,
          timestamp: new Date().toISOString(),
        });
        // Poll for host to process and write updated snapshot (up to ~30s)
        const refreshResult = await pollForIpcResponse<{ lastSync?: string; groups?: unknown[] }>(groupsPath, { maxWaitMs: 30000, initialDelayMs: 500 });
        if (refreshResult.found) {
          const newLastSync = refreshResult.data.lastSync ?? null;
          if (newLastSync && newLastSync !== oldLastSync) {
            return JSON.stringify(refreshResult.data, null, 2);
          }
          return 'Refresh requested but data has not changed. Call available_groups again in a moment.';
        }
        return 'Refresh requested but host may still be syncing. Call available_groups again in a moment.';
      }

      case 'available_groups': {
        const groupsPath = path.join(IPC_DIR, 'available_groups.json');
        if (!fs.existsSync(groupsPath)) {
          return 'available_groups.json not found. Try refresh_groups first (main group only).';
        }
        const content = fs.readFileSync(groupsPath, 'utf-8');
        return content;
      }

      case 'read_group_messages': {
        const requestId = crypto.randomUUID();
        const limit = Math.min(Math.max(1, (args.limit as number) || 50), 200);
        writeIpcFile(IPC_TASKS_DIR, {
          type: 'read_messages',
          requestId,
          chatJid: input.chatJid,
          limit,
          groupFolder: input.groupFolder,
          timestamp: new Date().toISOString(),
        });
        const responsePath = path.join(IPC_RESPONSES_DIR, `read_messages_${requestId}.json`);
        const readResult = await pollForIpcResponse<{ error?: string; messages?: Array<{ sender: string; content: string; timestamp: string }> }>(responsePath, { maxWaitMs: 25000 });
        if (!readResult.found) return 'Reading message history timed out. Try again.';
        if (readResult.data.error) return `Error: ${readResult.data.error}`;
        const msgs = readResult.data.messages || [];
        if (msgs.length === 0) return 'No messages in this chat yet.';
        return msgs
          .map((m) => `[${m.timestamp}] ${m.sender}: ${m.content}`)
          .join('\n');
        return 'Message history request timed out. Try again.';
      }

      case 'register_group': {
        if (!input.isMain) {
          return 'Only the main group can register new groups.';
        }
        writeIpcFile(IPC_TASKS_DIR, {
          type: 'register_group',
          jid: args.jid as string,
          name: args.name as string,
          folder: args.folder as string,
          trigger: args.trigger as string,
          requiresTrigger: args.requiresTrigger as boolean | undefined,
          groupFolder: input.groupFolder,
          timestamp: new Date().toISOString(),
        });
        return `Group "${args.name}" registration requested. It will start receiving messages immediately.`;
      }

      case 'schedule_task': {
        const filename = writeIpcFile(IPC_TASKS_DIR, {
          type: 'schedule_task',
          prompt: args.prompt,
          schedule_type: args.schedule_type,
          schedule_value: args.schedule_value,
          context_mode: (args.context_mode as string) || 'group',
          targetJid: input.chatJid,
          createdBy: input.groupFolder,
          timestamp: new Date().toISOString(),
        });
        return `Task scheduled (${filename})`;
      }

      case 'list_scheduled_tasks': {
        const tasksFile = path.join(IPC_DIR, 'current_tasks.json');
        if (!fs.existsSync(tasksFile)) return 'No tasks found.';
        const all = JSON.parse(fs.readFileSync(tasksFile, 'utf-8')) as Array<{
          id: string; prompt: string; schedule_type: string;
          schedule_value: string; status: string; next_run: string | null;
          groupFolder: string;
        }>;
        const tasks = input.isMain ? all : all.filter(t => t.groupFolder === input.groupFolder);
        if (!tasks.length) return 'No tasks found.';
        return tasks.map(t =>
          `[${t.id}] ${t.prompt.slice(0, 60)} | ${t.schedule_type}: ${t.schedule_value} | ${t.status} | next: ${t.next_run ?? 'N/A'}`
        ).join('\n');
      }

      case 'list_workflows': {
        const registryPath = '/workspace/group/workflows/registry.json';
        if (!fs.existsSync(registryPath)) return 'No workflows registered yet. Create workflows/registry.json to add automations.';
        const registry = JSON.parse(fs.readFileSync(registryPath, 'utf-8')) as RegistryEntry[];
        if (!registry.length) return 'Workflow registry is empty.';
        return registry.map(e =>
          `• ${e.name}: ${e.description}${e.args?.length ? ` | args: ${e.args.join(', ')}` : ''}`
        ).join('\n');
      }

      case 'search_tools': {
        const query = args.query as string;
        const registryPath = '/workspace/group/workflows/registry.json';
        if (!fs.existsSync(registryPath)) {
          return 'No workflow registry found at workflows/registry.json. Create it to register automations.';
        }
        const registry = JSON.parse(fs.readFileSync(registryPath, 'utf-8')) as RegistryEntry[];
        const matches = await semanticSearch(query, registry);
        if (!matches.length) return `No workflows matched "${query}". Available: ${registry.map(e => e.name).join(', ')}`;
        return matches.map(e =>
          `• ${e.name}: ${e.description}${e.args?.length ? ` | args: ${e.args.join(', ')}` : ''}`
        ).join('\n');
      }

      case 'run_workflow': {
        const name = args.name as string;
        const registryPath = '/workspace/group/workflows/registry.json';
        if (!fs.existsSync(registryPath)) return 'No workflow registry found.';
        const registry = JSON.parse(fs.readFileSync(registryPath, 'utf-8')) as Array<{
          name: string; description: string; run: string;
        }>;
        const entry = registry.find(e => e.name === name);
        if (!entry) return `Workflow "${name}" not found. Use search_tools to find available workflows.`;
        const env = { ...process.env } as Record<string, string>;
        if (args.args && typeof args.args === 'object') {
          Object.assign(env, args.args as Record<string, string>);
        }
        log(`run_workflow: ${name} → ${entry.run}`);
        try {
          const { stdout, stderr } = await execAsync(entry.run, {
            cwd: '/workspace/group/workflows',
            env,
            timeout: 60000,
            maxBuffer: 5 * 1024 * 1024,
          });
          return [stdout, stderr ? `STDERR:\n${stderr}` : ''].filter(Boolean).join('\n') || '(no output)';
        } catch (err) {
          const e = err as { message: string; stdout?: string; stderr?: string };
          return [e.stdout, e.stderr ? `STDERR:\n${e.stderr}` : '', `Error: ${e.message}`].filter(Boolean).join('\n');
        }
      }

      case 'pause_task':
      case 'resume_task':
      case 'cancel_task': {
        writeIpcFile(IPC_TASKS_DIR, {
          type: name,
          taskId: args.task_id,
          groupFolder: input.groupFolder,
          isMain: input.isMain,
          timestamp: new Date().toISOString(),
        });
        return `${name} requested for task ${String(args.task_id)}`;
      }

      case 'reset_session': {
        if (!sessionRef) return 'Error: reset_session requires session context.';
        const sid = sessionRef.session.id;
        const fp = sessionPath(sid);
        try {
          if (fs.existsSync(fp)) fs.unlinkSync(fp);
        } catch (e) {
          log(`reset_session: could not delete ${fp}: ${(e as Error).message}`);
        }
        writeIpcFile(IPC_TASKS_DIR, {
          type: 'clear_session',
          groupFolder: input.groupFolder,
          timestamp: new Date().toISOString(),
        });
        sessionRef.replaceWithNew = true;
        return 'Session cleared. The next message will start a fresh conversation.';
      }

      case 'store_memory': {
        const content = (args.content as string) || '';
        if (!content.trim()) return 'No content to store.';
        await appendStoredMemoryWithEmbedding(content.trim());
        return 'Stored. It will be available in your context on the next turn.';
      }

      case 'consult_memory': {
        const content = getMemoryForPrompt();
        return content || '(No stored memory yet. Use store_memory to save summaries or facts.)';
      }

      case 'memory_search': {
        const query = (args.query as string) || '';
        if (!query.trim()) return 'Provide a query to search for.';
        const topK = Math.min(10, Math.max(1, (args.top_k as number) || 5));
        const matches = await memorySearch(query.trim(), topK);
        if (!matches.length) return `No stored memory matched "${query}".`;
        return matches.map(e => `[${e.t}] ${e.content}`).join('\n\n');
      }

      case 'submit_plan': {
        const steps = args.steps as string[] | undefined;
        if (!Array.isArray(steps) || steps.length === 0) {
          return 'Provide a non-empty array of steps, e.g. submit_plan({ steps: ["1. Open URL", "2. Screenshot", "3. send_image"] }).';
        }
        setCurrentPlan(steps);
        return `Plan recorded (${steps.length} steps). Execute them in order with tool calls, then store_memory(summary) and clear_plan.`;
      }

      case 'clear_plan': {
        clearCurrentPlan();
        return 'Plan cleared.';
      }

      default:
        return `Unknown tool: ${name}`;
    }
  } catch (err) {
    const e = err as Error;
    log(`Tool error (${name}): ${e.message}`);
    return `Error executing ${name}: ${e.message}`;
  }
}

// ─── Agent loop ───────────────────────────────────────────────────────────────

function buildConfirmationPreview(name: string, args: Record<string, unknown>): string {
  const maxArgLen = 80;
  const parts = Object.entries(args).map(([k, v]) => {
    const str = typeof v === 'string' ? v : JSON.stringify(v);
    const display = str.length > maxArgLen ? str.slice(0, maxArgLen) + '…' : str;
    return `${k}=${display}`;
  });
  return `About to run: ${name}(${parts.join(', ')}). Reply "yes" to confirm or "no" to cancel.`;
}

/**
 * Determine how many prior messages to keep based on prompt content.
 * For simple messages (greetings, simple questions), keep only recent turns.
 * For complex tool-related messages, keep more context.
 */
function getIdealMessageCount(prompt: string, currentCount: number): number {
  const simplePatterns = [
    /^hi|hello|hey|greetings/i, // greetings
    /^how are you|what's up/i, // small talk
    /^can you|can i|i can/i, // simple questions
    /good morning|good afternoon|good evening/i, // time-based greetings
    /^test|testing/i, // test messages
  ];
  
  const isSimpleMessage = simplePatterns.some(p => p.test(prompt));
  
  if (isSimpleMessage) {
    // For simple messages, 6 messages (3 turns) is enough
    return Math.min(6, currentCount);
  } else {
    // For complex messages, keep up to 10 (5 turns)
    return Math.min(10, currentCount);
  }
}

/** Append SDK response messages to session (assistant + tool messages from result.steps). */
function appendStepsToSession(
  session: Session,
  steps: Array<{ text: string; toolCalls: Array<{ toolCallId: string; toolName: string; args: unknown }>; toolResults: Array<{ toolCallId: string; toolName: string; result: unknown }> }>,
  pendingConfirmationToolCallId: string | null,
): void {
  for (const step of steps) {
    const hasToolCalls = step.toolCalls && step.toolCalls.length > 0;
    const assistantContent = step.text?.trim() ?? '';
    const toolCallsForMsg = hasToolCalls
      ? step.toolCalls.map((tc) => ({
          id: tc.toolCallId,
          function: { name: tc.toolName, arguments: typeof tc.args === 'object' && tc.args !== null ? JSON.stringify(tc.args) : String(tc.args) },
        }))
      : undefined;
    session.messages.push({
      role: 'assistant',
      content: assistantContent || null,
      tool_calls: toolCallsForMsg,
    });
    if (hasToolCalls && step.toolResults) {
      for (const tr of step.toolResults) {
        if (pendingConfirmationToolCallId !== null && tr.toolCallId === pendingConfirmationToolCallId) break; // stop before appending confirmation tool result
        const content = typeof tr.result === 'string' ? tr.result : JSON.stringify(tr.result);
        const stored =
          content.length <= MAX_TOOL_RESULT_STORED_CHARS
            ? content
            : content.slice(0, MAX_TOOL_RESULT_STORED_CHARS) + '\n[Truncated for context.]';
        session.messages.push({ role: 'tool', tool_call_id: tr.toolCallId, content: stored });
      }
    }
  }
}

/** Run the OpenRouter tool loop using Vercel AI SDK (avoids provider 400 on tool-result round-trips). */
async function runQueryWithSdk(
  session: Session,
  input: ContainerInput,
  modelName: string,
  baseURL: string,
  apiKey: string,
  systemPrompt: string,
  toolsForContext: VercelToolSet,
  registry: ToolRegistry,
): Promise<{
  result: string | null;
  closed: boolean;
  confirmationRequired?: { preview: string; pendingTool: { name: string; args: Record<string, unknown> } };
}> {
  if (shouldClose()) {
    saveSession(session);
    return { result: null, closed: true };
  }

  const hasMemory = fs.existsSync(AGENT_MEMORY_PATH);
  const maxWindow =
    hasMemory && session.messages.length > MAX_SESSION_MESSAGES_WITH_MEMORY
      ? MAX_SESSION_MESSAGES_WITH_MEMORY
      : session.messages.length;
  const messagesForApi = trimSessionMessagesForApi(session.messages, maxWindow);
  const coreMessages = sessionToCoreMessages(messagesForApi);

  const sessionRef: SessionRef = { session };
  const toolsWithExecute: Record<string, { description: string; parameters: ReturnType<typeof jsonSchema>; execute: (args: Record<string, unknown>, opts: { toolCallId: string }) => Promise<string> }> = {};
  for (const [name, def] of Object.entries(toolsForContext)) {
    toolsWithExecute[name] = {
      ...def,
      execute: async (args: Record<string, unknown>, opts: { toolCallId: string }) => {
        const meta = getToolMeta(registry, name);
        if (meta?.confirmation_required) {
          session.pendingConfirmation = { toolCallId: opts.toolCallId, name, args };
          saveSession(session);
          return buildConfirmationPreview(name, args);
        }
        const result = await executeTool(name, args, input, sessionRef);
        auditLog(input, name, !result.startsWith('Error'), Buffer.byteLength(result, 'utf8'));
        if (sessionRef.replaceWithNew) {
          sessionRef.session = newSession();
          sessionRef.session.messages.push(...session.messages.filter((m) => m.role === 'user').slice(-1));
          sessionRef.replaceWithNew = false;
        }
        return result;
      },
    };
  }

  const openrouter = createOpenRouter({
    apiKey: apiKey === 'no-key' ? undefined : apiKey,
    baseURL: baseURL || 'https://openrouter.ai/api/v1',
    headers: { 'HTTP-Referer': 'https://github.com/kazGuido/stingyclaw', 'X-Title': 'Stingyclaw' },
  });

  log(`OpenRouter via AI SDK: messages=${coreMessages.length}, tools=${Object.keys(toolsWithExecute).length}, maxSteps=${MAX_TOOL_ITERATIONS}`);

  const result = await generateText({
    model: openrouter.chat(modelName),
    system: systemPrompt,
    messages: coreMessages,
    tools: toolsWithExecute,
    maxSteps: MAX_TOOL_ITERATIONS,
    maxTokens: 8192,
  });

  const steps = result.steps;
  const lastText = result.text?.trim() ?? null;

  if (session.pendingConfirmation) {
    const pending = session.pendingConfirmation;
    const pendingId = pending.toolCallId;
    // Append steps up to and including the one that requested confirmation; omit that step's tool result.
    for (const step of steps) {
      const hasPending = step.toolCalls?.some((tc: { toolCallId: string }) => tc.toolCallId === pendingId);
      const assistantContent = step.text?.trim() ?? '';
      const toolCallsForMsg =
        step.toolCalls?.map((tc: { toolCallId: string; toolName: string; args: unknown }) => ({
          id: tc.toolCallId,
          function: { name: tc.toolName, arguments: typeof tc.args === 'object' && tc.args !== null ? JSON.stringify(tc.args) : String(tc.args) },
        })) ?? undefined;
      session.messages.push({ role: 'assistant', content: assistantContent || null, tool_calls: toolCallsForMsg });
      if (hasPending) break; // do not append tool results for this step
      if (step.toolResults?.length) {
        for (const tr of step.toolResults) {
          const content = typeof tr.result === 'string' ? tr.result : JSON.stringify(tr.result);
          const stored = content.length <= MAX_TOOL_RESULT_STORED_CHARS ? content : content.slice(0, MAX_TOOL_RESULT_STORED_CHARS) + '\n[Truncated for context.]';
          session.messages.push({ role: 'tool', tool_call_id: tr.toolCallId, content: stored });
        }
      }
    }
    saveSession(session);
    const preview = buildConfirmationPreview(pending.name, pending.args);
    return { result: null, closed: false, confirmationRequired: { preview, pendingTool: { name: pending.name, args: pending.args } } };
  }

  appendStepsToSession(session, steps, null);
  saveSession(session);
  return { result: lastText, closed: false };
}

async function runQuery(
  prompt: string,
  session: Session,
  input: ContainerInput,
  modelName: string,
  baseURL: string,
  apiKey: string,
): Promise<{
  result: string | null;
  closed: boolean;
  confirmationRequired?: { preview: string; pendingTool: { name: string; args: Record<string, unknown> } };
}> {
  const registry = loadToolRegistry();
  await semanticToolSearch.load(registry);
  // Use prompt for semantic tool choice only when it's a real user message, not a confirmation reply
  const queryForTools = session.pendingConfirmation ? undefined : (prompt?.trim() || undefined);
  const toolsForContext = await getToolsForContext(registry, input.isMain, queryForTools, 8);
  const toolCount = Object.keys(toolsForContext).length;
  if (input.isMain) {
    log(`[OWNER] All ${toolCount} tools allowed (main group has full permission)`);
  }
  // Only document tools we actually pass to the API; avoids "Model tried to call unavailable tool" (e.g. Bash in restricted groups)
  const systemPrompt = buildSystemPrompt(input, Object.keys(toolsForContext));
  // Convert tool schema once per query so follow-up calls after tool execution
  // never "drop" the schema (some providers 400 if tool results exist without tools[]).
  const openRouterToolsAll = toolCount > 0 ? convertTools(toolsForContext) : undefined;

  // Clean up old conversation history to prevent context bleed
  // Keep only the last 6 messages if stored memory exists, or last 10 if not
  // This prevents the agent from treating old conversation as current instruction
  const hasMemory = fs.existsSync(AGENT_MEMORY_PATH);
  const maxMessagesForHistory = hasMemory ? 6 : 10;
  if (session.messages.length > maxMessagesForHistory) {
    log(`Trimming session history from ${session.messages.length} to ${maxMessagesForHistory} messages to prevent context bleed`);
    // trimSessionMessagesForApi: also drops leading orphan `tool` rows if the cut removed their assistant
    session.messages = trimSessionMessagesForApi(session.messages, maxMessagesForHistory);
    saveSession(session); // Persist trim so next run loads fewer messages; avoids repeated trim+fail cycles
  }

  // Resuming from confirmation: user replied yes/no; execute or cancel pending tool, then continue loop.
  if (session.pendingConfirmation && prompt) {
    const reply = prompt.trim().toLowerCase();
    const confirmed = /^(yes|confirm|ok|y)$/.test(reply);
    const pending = session.pendingConfirmation;
    session.pendingConfirmation = null;
    let result: string;
    const sessionRef: SessionRef = { session };
    if (confirmed) {
      result = await executeTool(pending.name, pending.args, input, sessionRef);
      auditLog(input, pending.name, !result.startsWith('Error'), Buffer.byteLength(result, 'utf8'));
    } else {
      result = 'User cancelled.';
      auditLog(input, pending.name, false, 0);
    }
    const storedContent =
      result.length <= MAX_TOOL_RESULT_STORED_CHARS
        ? result
        : result.slice(0, MAX_TOOL_RESULT_STORED_CHARS) + '\n[Truncated for context. Full output was used in that turn.]';
    session.messages.push({ role: 'tool', tool_call_id: pending.toolCallId, content: storedContent });
    saveSession(session);
    // Fall through to loop; do not push user message.
  } else {
    session.messages.push({ role: 'user', content: prompt });
  }

  let lastText: string | null = null;

  // OpenRouter: use Vercel AI SDK so the provider gets correctly formatted tool round-trips (avoids 400 after tool use).
  if (apiKey !== 'ollama') {
    const sdkResult = await runQueryWithSdk(
      session,
      input,
      modelName,
      baseURL,
      apiKey,
      systemPrompt,
      toolsForContext,
      registry,
    );
    if (sdkResult.closed) return sdkResult;
    if (sdkResult.confirmationRequired) return sdkResult;
    return { result: sdkResult.result, closed: false };
  }

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    if (shouldClose()) {
      log('Close sentinel detected mid-query, aborting');
      saveSession(session);
      return { result: lastText, closed: true };
    }

    log(`Model call #${i + 1} (${session.messages.length} messages in history)`);

    // When stored memory exists, cap messages sent to API to avoid context blow-up; memory carries prior context.
    const hasMemory = fs.existsSync(AGENT_MEMORY_PATH);
    const maxWindow =
      hasMemory && session.messages.length > MAX_SESSION_MESSAGES_WITH_MEMORY
        ? MAX_SESSION_MESSAGES_WITH_MEMORY
        : session.messages.length;
    const messagesForApi = trimSessionMessagesForApi(session.messages, maxWindow);
    // Build map tool_call_id -> toolName from assistant messages so we can format tool results for the SDK.
    const toolCallIdToName: Record<string, string> = {};
    for (const m of messagesForApi) {
      if (m.role === 'assistant' && Array.isArray((m as any).tool_calls)) {
        for (const tc of (m as any).tool_calls) {
          if (tc.id && tc.function?.name) toolCallIdToName[tc.id] = tc.function.name;
        }
      }
    }
    // Strip provider-specific fields and convert to Vercel SDK format.
    // SDK expects: assistant content string (not null); tool messages as simple strings with tool_call_id.
    const sanitizedMessages = messagesForApi.map((m: any) => {
      if (m.role === 'assistant') {
        return { role: m.role, content: typeof m.content === 'string' ? m.content : '' };
      }
      if (m.role === 'tool') {
        // Vercel SDK with OpenRouter expects tool results as simple string content with tool_call_id
        return {
          role: 'tool' as const,
          tool_call_id: m.tool_call_id,
          content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
        };
      }
      return m;
    });

    // Use our custom OpenRouter HTTP client (replaces Vercel SDK)
    let responseText: string | undefined;
    let toolCalls: Array<{ id: string; function: { name: string; arguments: string } }> = [];

    try {
      // Build messages in OpenRouter format
      const openRouterMessages = buildMessages(systemPrompt, sanitizedMessages);

      // Always pass tools when available.
      // Some OpenRouter providers return 400 when a follow-up call contains tool results
      // but omits the tool schema.
      const hasToolResults = sanitizedMessages.some(m => m.role === 'tool');
      const openRouterTools = openRouterToolsAll;

      log(`Calling OpenRouter: messages=${openRouterMessages.length}, tools=${openRouterTools?.length ?? 0}, hasToolResults=${hasToolResults}`);

      // Call OpenRouter directly (Ollama uses apiKey 'ollama' and does not need OPENROUTER_API_KEY)
      if (apiKey !== 'ollama' && (!apiKey || apiKey === 'no-key')) {
        throw new Error('OPENROUTER_API_KEY not provided');
      }

      const result = await callOpenRouter(
        apiKey,
        baseURL,
        modelName,
        openRouterMessages,
        openRouterTools,
        8192,
      );

      const choice = result.choices?.[0];
      if (!choice) {
        throw new Error('No response from OpenRouter');
      }

      responseText = choice.message?.content || undefined;
      toolCalls = (choice.message?.tool_calls || []).map(tc => ({
        id: tc.id,
        function: {
          name: tc.function.name,
          arguments: tc.function.arguments,
        },
      }));
    } catch (err: any) {
      const msg = err?.message ?? '';
      const status = err?.status ?? err?.statusCode;

      // Handle specific error types
      if (msg.includes('429')) {
        // Preserve upstream status in logs; host layer will retry with backoff.
        throw err;
      }
      if (msg.includes('400') && session.messages.length > 6) {
        log(`API 400 with ${session.messages.length} messages — auto-trimming and retrying`);
        session.messages = session.messages.slice(-8);
        saveSession(session);
        // Retry this iteration
        continue;
      }

      // Provider-specific fallback: some models/providers reject role=tool messages on follow-up.
      // If we already have tool results in history, retry once by converting tool outputs into
      // plain user text and disabling tools for the retry, so the model can still summarize.
      const hadToolResults = sanitizedMessages.some((m: any) => m.role === 'tool');
      if ((status === 400 || msg.includes('400')) && hadToolResults) {
        log('OpenRouter 400 after tool results — retrying with tool outputs as plain text (no tools)');

        const MAX_FALLBACK_TOOL_OUTPUT = 3500; // Avoid huge HTML/JSON that triggers provider 400
        const fallbackHistory = sanitizedMessages.map((m: any) => {
          if (m.role === 'tool') {
            const toolOut = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
            const truncated =
              toolOut.length <= MAX_FALLBACK_TOOL_OUTPUT
                ? toolOut
                : toolOut.slice(0, MAX_FALLBACK_TOOL_OUTPUT) + '\n[Output truncated for length.]';
            return {
              role: 'user' as const,
              content: `[Tool result]\n${truncated}`,
            };
          }
          if (m.role === 'assistant') {
            // Provider often rejects assistant message with tool_calls when tools=0. Send text only.
            const text = (m.content && String(m.content).trim()) || 'I called a tool; the result is in the next message.';
            return { role: 'assistant' as const, content: text };
          }
          return m;
        });

        const fallbackMessages = buildMessages(systemPrompt, fallbackHistory);
        const retry = await callOpenRouter(
          apiKey,
          baseURL,
          modelName,
          fallbackMessages,
          undefined,
          8192,
          'none',
        );

        const choice = retry.choices?.[0];
        if (!choice) {
          throw new Error('No response from OpenRouter (fallback)');
        }

        responseText = choice.message?.content || undefined;
        toolCalls = (choice.message?.tool_calls || []).map((tc) => ({
          id: tc.id,
          function: {
            name: tc.function.name,
            arguments: tc.function.arguments,
          },
        }));
      } else {
        // Re-throw other errors to be handled by outer error handling
        throw err;
      }
    }

    // Build message structure similar to OpenAI response
    const msg: ChatMessage = {
      role: 'assistant',
      content: responseText || null,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
    };
    session.messages.push(msg);

    type AssistantMsg = { content?: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> };
    const assistantMsg = msg as AssistantMsg;
    if (typeof assistantMsg.content === 'string' && assistantMsg.content.trim()) {
      lastText = assistantMsg.content.trim();
    }

    const hasToolCalls = assistantMsg.tool_calls && assistantMsg.tool_calls.length > 0;

    if (!hasToolCalls) {
      log(`Query complete. No more tool calls.`);
      break;
    }

    log(`Executing ${assistantMsg.tool_calls!.length} tool call(s)`);
    const sessionRef: SessionRef = { session };
    for (const toolCall of assistantMsg.tool_calls!) {
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(toolCall.function.arguments) as Record<string, unknown>;
      } catch {
        args = { command: toolCall.function.arguments };
      }
      const toolMeta = getToolMeta(registry, toolCall.function.name);
      if (toolMeta?.confirmation_required) {
        session.pendingConfirmation = {
          toolCallId: toolCall.id,
          name: toolCall.function.name,
          args,
        };
        saveSession(session);
        const preview = buildConfirmationPreview(toolCall.function.name, args);
        return {
          result: null,
          closed: false,
          confirmationRequired: { preview, pendingTool: { name: toolCall.function.name, args } },
        };
      }
      const result = await executeTool(toolCall.function.name, args, input, sessionRef);
      auditLog(input, toolCall.function.name, !result.startsWith('Error'), Buffer.byteLength(result, 'utf8'));
      if (sessionRef.replaceWithNew) {
        session = newSession();
        session.messages.push({ role: 'user', content: prompt });
        session.messages.push(msg);
        sessionRef.session = session;
        sessionRef.replaceWithNew = false;
      }
      // Don't keep full webpage/huge output in context — truncate so future turns stay under token limits
      const storedContent =
        result.length <= MAX_TOOL_RESULT_STORED_CHARS
          ? result
          : result.slice(0, MAX_TOOL_RESULT_STORED_CHARS) +
            '\n[Truncated for context. Full output was used in that turn.]';
      session.messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: storedContent,
      });
    }
  }

  saveSession(session);
  return { result: lastText, closed: false };
}

// ─── Stdin reader ─────────────────────────────────────────────────────────────

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', c => { data += c; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

// ─── Entry point ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  let input: ContainerInput;
  try {
    const raw = await readStdin();
    input = JSON.parse(raw) as ContainerInput;
    try {
      fs.unlinkSync('/tmp/input.json');
    } catch (unlinkErr) {
      log(`Failed to remove temp input file: ${unlinkErr}`);
    }
    log(`Group: ${input.groupFolder}, session: ${input.sessionId ?? 'new'}`);
  } catch (err) {
    writeOutput({ status: 'error', result: null, error: `Failed to parse input: ${err}` });
    process.exit(1);
  }

  const secrets = input.secrets ?? {};
  const openrouterKey = secrets.OPENROUTER_API_KEY;

  let apiKey: string;
  let baseURL: string;
  let modelName: string;
  let backend: Backend;

  if (openrouterKey === 'ollama') {
    apiKey = 'ollama';
    baseURL = secrets.OPENROUTER_BASE_URL ?? 'http://host.docker.internal:11434/v1';
    modelName = secrets.MODEL_NAME ?? 'llama3.2';
    backend = 'ollama';
  } else {
    apiKey = openrouterKey ?? 'no-key';
    baseURL = secrets.OPENROUTER_BASE_URL ?? OPENROUTER_BASE_URL;
    modelName = secrets.MODEL_NAME ?? OPENROUTER_DEFAULT_MODEL;
    backend = 'openrouter';
  }

  // Store API key before deleting secrets from input (runQuery needs it)
  const storedApiKey = apiKey;
  delete input.secrets;

  log(`Backend: ${backend} | Model: ${modelName} @ ${baseURL}`);

  // Persist browser profile (cookies, localStorage) per group so logins survive container restarts
  process.env.AGENT_BROWSER_PROFILE = '/workspace/group/.browser-profile';

  let session: Session = (input.sessionId ? loadSession(input.sessionId) : null) ?? newSession();

  // Restore pending confirmation from host DB if present
  if (input.pendingConfirmation && !session.pendingConfirmation) {
    session.pendingConfirmation = {
      toolCallId: input.pendingConfirmation.toolCallId,
      name: input.pendingConfirmation.toolName,
      args: input.pendingConfirmation.args,
    };
    log(`Restored pending confirmation: ${input.pendingConfirmation.toolName}`);
  }

  log(`Session: ${session.id} (${session.messages.length} prior messages)`);

  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
  try {
    fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
  } catch (err) {
    log(`Failed to remove close sentinel at startup: ${err}`);
  }

  let prompt = input.prompt;
  if (input.isScheduledTask) {
    prompt = `[SCHEDULED TASK — automated, not from a user directly]\n\n${prompt}`;
  }
  const pending = drainIpcInput();
  if (pending.length > 0) {
    prompt += '\n' + pending.join('\n');
  }

  try {
    while (true) {
      log(`Starting query (session: ${session.id})...`);
      const runResult = await runQuery(prompt, session, input, modelName, baseURL, storedApiKey);

      if (runResult.confirmationRequired) {
        writeOutput({
          status: 'confirmation_required',
          result: null,
          newSessionId: session.id,
          confirmationPreview: runResult.confirmationRequired.preview,
          pendingTool: runResult.confirmationRequired.pendingTool,
        });
      } else {
        writeOutput({ status: 'success', result: runResult.result, newSessionId: session.id });
      }

      if (runResult.closed || shouldClose()) {
        log('Exiting after close sentinel');
        break;
      }

      log('Waiting for next IPC message...');
      const next = await waitForIpcMessage();
      if (next === null) {
        log('Close sentinel, exiting');
        break;
      }

      log(`New message (${next.length} chars), looping`);
      prompt = next;
    }
  } catch (err) {
    const e = err as Error & { cause?: Error; status?: number; statusCode?: number };
    const msg = e.message ?? String(err);
    const causeMsg = e.cause instanceof Error ? e.cause.message : '';
    // Log full error to stderr so host/container logs show the real cause (e.g. 502, no choices, fetch failed)
    console.error('[Agent Fatal]', msg);
    if (causeMsg) console.error('[Agent Fatal Cause]', causeMsg);
    if (e.stack) console.error(e.stack);
    log(`Fatal: ${msg}${causeMsg ? ` (cause: ${causeMsg})` : ''}`);

    // Sanitize for logs: no URLs/keys, first 200 chars
    const detail = (msg + (causeMsg ? ` | ${causeMsg}` : '')).slice(0, 200).replace(/sk-[^\s]+/gi, 'sk-***');

    const combined = `${msg}\n${causeMsg}`;
    // Upstream model rejected the message list (often orphan tool rows after history trim) — not "outage".
    if (
      /InvalidParameter|must be a response.*tool_calls|preceeding message.*tool_calls|preceding message.*tool_calls/i.test(
        combined,
      ) ||
      (/Invalid JSON response/i.test(msg) &&
        /"code"\s*:\s*502/.test(causeMsg) &&
        /Upstream error|InvalidParameter/i.test(causeMsg))
    ) {
      writeOutput({
        status: 'error',
        result: null,
        newSessionId: session.id,
        error:
          'CHAT_HISTORY_ERROR: The conversation could not be sent to the AI (broken tool/history sequence). Try reset_session or start a new chat.',
        errorDetail: detail,
      });
      process.exit(0);
    }

    // Provider 5xx/429/no choices/network: do not exit(1) so host won't retry. Send one clear message.
    // Do not treat Alibaba's embedded `"code":502` in JSON as HTTP 502 (that was misclassified as outage).
    const causeHasEmbeddedVendorCode502 =
      /"code"\s*:\s*502/.test(causeMsg) && /Upstream error|InvalidParameter/i.test(causeMsg);
    const looksLikeHttp5xxOrNoChoices =
      /500|502|503|Internal Server Error|no choices/.test(msg) ||
      (/500|502|503|Internal Server Error|no choices/.test(causeMsg) && !causeHasEmbeddedVendorCode502);
    if (looksLikeHttp5xxOrNoChoices) {
      writeOutput({
        status: 'error',
        result: null,
        newSessionId: session.id,
        error: 'PROVIDER_UNAVAILABLE: The AI provider is temporarily unavailable. Please try again in a few minutes.',
        errorDetail: detail,
      });
      process.exit(0);
    }
    if (/429|rate limit/i.test(msg) || /429|rate limit/i.test(causeMsg)) {
      writeOutput({
        status: 'error',
        result: null,
        newSessionId: session.id,
        error: 'PROVIDER_UNAVAILABLE: The AI provider is temporarily rate-limited. Please wait a minute and try again.',
        errorDetail: detail,
      });
      process.exit(0);
    }
    // Network/connection errors: treat as temporary so user gets one message instead of retries
    if (/ECONNREFUSED|ETIMEDOUT|fetch failed|network|socket hang up/i.test(msg) || /ECONNREFUSED|ETIMEDOUT|fetch failed|network|socket hang up/i.test(causeMsg)) {
      writeOutput({
        status: 'error',
        result: null,
        newSessionId: session.id,
        error: 'PROVIDER_UNAVAILABLE: The AI provider is temporarily unavailable. Please try again in a few minutes.',
        errorDetail: detail,
      });
      process.exit(0);
    }
    writeOutput({ status: 'error', result: null, newSessionId: session.id, error: msg, errorDetail: detail });
    process.exit(1);
  }
}

main();
