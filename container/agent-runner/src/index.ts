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
import OpenAI from 'openai';
import { pipeline, env as xenovaEnv } from '@xenova/transformers';

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

function buildOpenAITools(registry: ToolRegistry): OpenAI.ChatCompletionTool[] {
  return registry.tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
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

/** Get tools filtered by enabled list; when query is set, semantically pick top-K. */
async function getToolsForContext(
  registry: ToolRegistry,
  isMain: boolean,
  query?: string,
  topK: number = 6,
): Promise<OpenAI.ChatCompletionTool[]> {
  const enabledNames = new Set(getEnabledToolNames(registry, isMain));
  const filteredTools = registry.tools.filter((t) => enabledNames.has(t.name));

  if (!query?.trim()) {
    return buildOpenAITools({ tools: filteredTools });
  }

  try {
    const results = await semanticToolSearch.searchAsync(query, topK);
    const topKNames = new Set(results.map((r) => r.name));
    const selectedTools = filteredTools.filter((t) => topKNames.has(t.name));
    log(`[semantic search] ${selectedTools.length} tools: ${results.map((r) => `${r.name}(${r.score.toFixed(2)})`).join(', ')}`);
    return buildOpenAITools({ tools: selectedTools });
  } catch (err) {
    log(`[semantic search] Fallback: ${(err as Error).message}`);
    return buildOpenAITools({ tools: filteredTools });
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
}

interface ContainerOutput {
  status: 'success' | 'error' | 'confirmation_required';
  result: string | null;
  newSessionId?: string;
  error?: string;
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
  messages: OpenAI.ChatCompletionMessageParam[];
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
  } catch { /* ignore */ }
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

function buildSystemPrompt(input: ContainerInput): string {
  const name = input.assistantName || 'Andy';
  const parts: string[] = [
    `You are ${name}, a helpful AI assistant connected to a WhatsApp chat.

=== CRITICAL TOOL USAGE RULES (READ THESE FIRST) ===

You MUST call the right tool for the task. If you don't, the user will NOT receive what they asked for.

1. When user asks for AUDIO or a VOICE NOTE:
   - You MUST call send_voice(text: "...") with the message content.
   - Do NOT reply with plain text only. If you don't call send_voice, the user gets NO audio.

2. When user sends a VOICE MESSAGE (text starts with "[Voice: ...]"):
   - You MUST call send_voice(text: "...") as your response. Do not reply with text only.

3. When user asks for a SCREENSHOT or IMAGE (of a page, diagram, saved file, output):
   - You MUST call send_image(path: "file.png") to show the image in the chat.
   - After agent-browser screenshot file.png: immediately call send_image("file.png") before any text reply.
   - Do NOT say "saved to file.png" — that text alone does not show the image.

4. When you are about to do something RISKY or IRREVERSIBLE:
   - Call ask_boss(question: "...") to get user approval first.
   - Do NOT proceed without approval if you are unsure.

5. Always use submit_plan() before multi-step tasks:
   - Call submit_plan(steps: ["Step 1", "Step 2", ...]) first.
   - Execute each step in order.
   - When done: store_memory("one-line summary") then clear_plan().

=== YOUR TOOLS AND HOW TO USE THEM ===

Tool: send_voice
  Description: Send spoken audio to the chat (OGG Opus voice note).
  When to use: 
    • User asks for audio, voice note, or to hear something ("send me audio", "reply with voice", "say it in a voice note")
    • User sent a voice message (your reply must also be voice)
    • You want a natural conversational reply (short messages under 150 words)
  How to use: send_voice(text: "short message under 150 words", voice?: "Ryan" | "Aiden" | "Vivian" | "Serena" | "Uncle_Fu" | "Dylan" | "Eric" | "Ono_Anna" | "Sohee" | "French")
  Use voice "French" when the user wants French speech.
  WARNING: If you don't call this when user asks for audio, they get NOTHING audible.

Tool: send_image  
  Description: Send an image file to the chat so the user sees it (not just text).
  When to use:
    • After screenshotting anything (agent-browser screenshot, page.png, diagram.png)
    • User asks to see an image, screenshot, or visual output
  How to use: send_image(path: "relative.png", caption?: "optional text")
  WARNING: If you don't call this after a screenshot, the user sees NOTHING.

Tool: send_message
  Description: Send immediate text updates (for progress, confirmation, or when still working).
  When to use:
    • Long-running tasks — send progress updates
    • You need to communicate before finishing
    • Scheduled tasks that must report results
  How to use: send_message(text: "progress update or final result")

Tool: ask_boss
  Description: Ask the user for guidance before risky actions or when unsure.
  When to use:
    • Before destructive actions (delete, overwrite, modify configs)
    • You don't have enough context to proceed safely
    • You need user approval to continue
  How to use: ask_boss(question: "clear question that user can answer yes/no or with guidance")
  Result: Your message is sent; their reply comes in the next turn. Stop and wait.

Tool: Bash
  Description: Run shell commands in /workspace/group (timeout: 30s default, max 120s).
  Use for: Quick checks, file operations, running scripts, debugging.
  Example: Bash(command: "ls -la && cat README.md", timeout: 60000)

Tool: Read, Glob, Grep
  Description: Read files, find files by pattern, search file contents with rg (ripgrep).
  Use for: Understanding codebases, finding files, searching for patterns.
  Example: Grep(pattern: "TODO", flags: "-i", path: "/workspace/group/src")

Tool: WebFetch, agent-browser
  Description: Fetch static pages (WebFetch) or full browser (agent-browser for JS, logins, interactions).
  agent-browser commands:
    - agent-browser open <url>
    - agent-browser snapshot          # get page elements with refs @e1, @e2, etc.
    - agent-browser snapshot -i        # interactive snapshot
    - agent-browser click @e1
    - agent-browser fill @e2 "text"
    - agent-browser get text @e1      # extract text from element
    - agent-browser screenshot file.png
    - agent-browser close
  ALWAYS call send_image("file.png") after screenshot.

Tool: submit_plan, store_memory, clear_plan, consult_memory
  Submit an execution plan before multi-step work. Store key facts across turns. Clear the plan when done.
  submit_plan(steps: ["Step 1", "Step 2"])
  store_memory(content: "one-line summary or fact to remember")
  consult_memory()  # Read current stored memory
  clear_plan()      # Clear after execution

Tool: list_workflows, search_tools, run_workflow
  Pre-built automations the user has configured. Use these instead of building from scratch.
  - list_workflows()     # Show all available workflows
  - search_tools(query)  # Find workflows by intent
  - run_workflow(name, args)  # Run a workflow

Tool: available_groups, refresh_groups, register_group
  WhatsApp group management (main group only).
  - available_groups()          # List discovered groups
  - refresh_groups()            # Refresh from WhatsApp
  - register_group(jid, name, folder, trigger)  # Register a new group

Tool: schedule_task, list_tasks, pause_task, resume_task, cancel_task
  Schedule recurring or one-time tasks (scheduled tasks run as full agents).
  - schedule_task(prompt, schedule_type: "cron"|"interval"|"once", schedule_value, context_mode: "group"|"isolated")
  - list_tasks()
  - pause_task(task_id), resume_task(task_id), cancel_task(task_id)

=== WORKFLOW ===

1. User sends message → you analyze what they want
2. If multi-step: call submit_plan() first with ordered steps
3. Execute steps using tools (Bash, Read, WebFetch, agent-browser, etc.)
4. When done (or confirming): send message if needed, store_memory summary, clear_plan
5. Your final text response is sent automatically after tool calls complete

=== SYSTEM CONTEXT ===

Working directory: /workspace/group — read/write files freely.
Extra directories may be mounted at /workspace/extra/*/

Voice service: Your TTS is available via send_voice. Keep voice replies under ~150 words.
Model: You are running with ${input.isMain ? 'main group context (full tool access)' : 'group context (filtered tools)'}.
Session ID: ${input.sessionId || 'new'}
Last agent timestamp: ${input.chatJid} — ${input.groupFolder}

${input.isScheduledTask ? '\n\n[SCHEDULED TASK — this is an automated agent task, not directly from user. Your output is sent via send_message if needed.]' : ''}`,
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
  if (memoryContent) {
    parts.push('\n\n---\nStored memory (context across turns; use consult_memory to read, store_memory to update, memory_search to find by meaning):\n' + memoryContent);
  }

  const planContent = getPlanForPrompt();
  if (planContent) {
    parts.push('\n\n---\nCurrent plan (execute in order, then store_memory and clear_plan):\n' + planContent);
  }

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
    try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }
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
      } catch { try { fs.unlinkSync(fp); } catch { /* ignore */ } }
    }
    return messages;
  } catch { return []; }
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
          } catch { /* ignore */ }
        }
        writeIpcFile(IPC_TASKS_DIR, {
          type: 'refresh_groups',
          groupFolder: input.groupFolder,
          timestamp: new Date().toISOString(),
        });
        // Poll for host to process and write updated snapshot (up to ~10s)
        for (let i = 0; i < 20; i++) {
          await new Promise((r) => setTimeout(r, 500));
          if (!fs.existsSync(groupsPath)) continue;
          try {
            const data = JSON.parse(fs.readFileSync(groupsPath, 'utf-8')) as { lastSync?: string; groups?: unknown[] };
            const newLastSync = data.lastSync ?? null;
            if (newLastSync && newLastSync !== oldLastSync) {
              return JSON.stringify(data, null, 2);
            }
          } catch { /* retry */ }
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
        for (let i = 0; i < 15; i++) {
          await new Promise((r) => setTimeout(r, IPC_POLL_MS));
          if (fs.existsSync(responsePath)) {
            try {
              const data = JSON.parse(fs.readFileSync(responsePath, 'utf-8'));
              fs.unlinkSync(responsePath);
              const msgs = data.messages || [];
              if (msgs.length === 0) return 'No messages in this chat yet.';
              return msgs
                .map((m: { sender: string; content: string; timestamp: string }) =>
                  `[${m.timestamp}] ${m.sender}: ${m.content}`,
                )
                .join('\n');
            } catch {
              return 'Error reading message history.';
            }
          }
        }
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

      case 'list_tasks': {
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

async function runQuery(
  prompt: string,
  session: Session,
  input: ContainerInput,
  client: OpenAI,
  modelName: string,
): Promise<{
  result: string | null;
  closed: boolean;
  confirmationRequired?: { preview: string; pendingTool: { name: string; args: Record<string, unknown> } };
}> {
  const registry = loadToolRegistry();
  const systemPrompt = buildSystemPrompt(input);

  await semanticToolSearch.load(registry);
  // Use prompt for semantic tool choice only when it's a real user message, not a confirmation reply
  const queryForTools = session.pendingConfirmation ? undefined : (prompt?.trim() || undefined);
  const toolsForContext = await getToolsForContext(registry, input.isMain, queryForTools, 8);

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

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    if (shouldClose()) {
      log('Close sentinel detected mid-query, aborting');
      saveSession(session);
      return { result: lastText, closed: true };
    }

    log(`Model call #${i + 1} (${session.messages.length} messages in history)`);

    // When stored memory exists, cap messages sent to API to avoid context blow-up; memory carries prior context.
    const hasMemory = fs.existsSync(AGENT_MEMORY_PATH);
    const messagesForApi =
      hasMemory && session.messages.length > MAX_SESSION_MESSAGES_WITH_MEMORY
        ? session.messages.slice(-MAX_SESSION_MESSAGES_WITH_MEMORY)
        : session.messages;
    // Strip provider-specific nulls (refusal, reasoning_details) and empty content
    // from assistant messages before sending — keeps the history clean regardless of model.
    const sanitizedMessages = messagesForApi.map((m: any) => {
      if (m.role !== 'assistant') return m;
      const cleaned: any = { role: m.role };
      if (typeof m.content === 'string' && m.content !== '') cleaned.content = m.content;
      if (m.tool_calls?.length) cleaned.tool_calls = m.tool_calls;
      return cleaned;
    });

    let response;
    try {
      response = await client.chat.completions.create({
        model: modelName,
        messages: [{ role: 'system', content: systemPrompt }, ...sanitizedMessages],
        tools: toolsForContext,
        tool_choice: 'auto',
        max_tokens: 8192,
      });
    } catch (err: any) {
      const msg = err?.message ?? '';
      // On 400 with a long session, trim to last 10 messages and retry once.
      if (msg.includes('400') && session.messages.length > 10) {
        log(`API 400 with ${session.messages.length} messages — trimming session to last 10 and retrying`);
        session.messages = session.messages.slice(-10);
        saveSession(session);
        continue;
      }
      throw err;
    }

    const choice = response.choices[0];
    const msg = choice.message;
    session.messages.push(msg);

    if (msg.content?.trim()) {
      lastText = msg.content.trim();
    }

    const hasToolCalls = msg.tool_calls && msg.tool_calls.length > 0;

    if (!hasToolCalls || choice.finish_reason === 'stop') {
      log(`Query complete. finish_reason=${choice.finish_reason}`);
      break;
    }

    log(`Executing ${msg.tool_calls!.length} tool call(s)`);
    const sessionRef: SessionRef = { session };
    for (const toolCall of msg.tool_calls!) {
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
    try { fs.unlinkSync('/tmp/input.json'); } catch { /* ignore */ }
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

  delete input.secrets;

  log(`Backend: ${backend} | Model: ${modelName} @ ${baseURL}`);

  const clientOpts: ConstructorParameters<typeof OpenAI>[0] = { apiKey, baseURL };
  if (backend === 'openrouter') {
    clientOpts.defaultHeaders = {
      'HTTP-Referer': 'https://github.com/kazGuido/stingyclaw',
      'X-Title': 'Stingyclaw',
    };
  }
  const client = new OpenAI(clientOpts);

  let session: Session = (input.sessionId ? loadSession(input.sessionId) : null) ?? newSession();
  log(`Session: ${session.id} (${session.messages.length} prior messages)`);

  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
  try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }

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
      const runResult = await runQuery(prompt, session, input, client, modelName);

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
    const e = err as Error;
    log(`Fatal: ${e.message}`);
    writeOutput({ status: 'error', result: null, newSessionId: session.id, error: e.message });
    process.exit(1);
  }
}

main();
