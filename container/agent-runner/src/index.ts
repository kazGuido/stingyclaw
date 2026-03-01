/**
 * Stingyclaw Agent Runner
 *
 * OpenAI-compatible agentic loop. Supports three backends:
 *   1. OpenRouter (default)  — set OPENROUTER_API_KEY + MODEL_NAME
 *   2. Local Ollama          — set OPENROUTER_API_KEY=ollama
 *   3. Gemini API (fallback) — set GEMINI_API_KEY (only if no OPENROUTER_API_KEY)
 *
 * Priority: OPENROUTER_API_KEY > GEMINI_API_KEY
 */

import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { glob } from 'glob';
import OpenAI from 'openai';
import { pipeline, env as xenovaEnv } from '@xenova/transformers';

// Store model in the shared stingyclaw data dir so it persists across rebuilds
xenovaEnv.cacheDir = '/home/node/.stingyclaw/transformers';

const execAsync = promisify(exec);

// ─── Protocol ────────────────────────────────────────────────────────────────

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

const IPC_DIR = '/workspace/ipc';
const IPC_INPUT_DIR = `${IPC_DIR}/input`;
const IPC_MESSAGES_DIR = `${IPC_DIR}/messages`;
const IPC_TASKS_DIR = `${IPC_DIR}/tasks`;
const IPC_INPUT_CLOSE_SENTINEL = `${IPC_INPUT_DIR}/_close`;
const IPC_POLL_MS = 500;

const SESSIONS_DIR = '/home/node/.stingyclaw/sessions';
const MAX_TOOL_ITERATIONS = 60;

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/';
const GEMINI_DEFAULT_MODEL = 'gemini-2.5-flash';
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const OPENROUTER_DEFAULT_MODEL = 'liquid/lfm-2.5';

type Backend = 'gemini' | 'openrouter' | 'ollama';

// ─── Local embedder (lazy-loaded, shared across tool calls) ──────────────────

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
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

interface Session {
  id: string;
  messages: OpenAI.ChatCompletionMessageParam[];
  createdAt: string;
  updatedAt: string;
}

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
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
You have access to tools to complete tasks. Use them proactively.
Be concise — WhatsApp messages should be short and to the point.
For long-running work, use send_message to send intermediate updates.
Your final text response (after all tool calls) is sent to the user automatically.

Working directory: /workspace/group — read/write files here freely.
Extra directories may be mounted at /workspace/extra/*/

Web browsing — use agent-browser for any page that needs it:
- \`agent-browser open <url>\` → navigate
- \`agent-browser snapshot -i\` → get interactive elements (buttons, links, inputs) with refs like @e1, @e2
- \`agent-browser click @e1\` / \`agent-browser fill @e2 "text"\` → interact via refs
- \`agent-browser get text @e1\` / \`agent-browser screenshot page.png\` → extract content
- \`agent-browser close\` when done
- Use WebFetch for simple static pages (faster). Use agent-browser for JS-heavy pages, login flows, or when you need to interact.

Voice rules — follow these strictly:
- When the user's message starts with [Voice: ...], you MUST call send_voice as your response. Do not reply with plain text alone.
- Keep voice replies short — under ~150 words (about 30 seconds of speech).
- After send_voice you may optionally add a short text follow-up for links, code, or anything that doesn't work well spoken.
- For non-voice messages, use send_voice only when it genuinely adds value (e.g. the user explicitly asks for spoken output).

Workflows — pre-built automations the user has defined:
- When asked "what can you do?" or "what workflows exist?" → call list_workflows
- When the user asks you to do something → call search_tools("intent") first to check if a workflow exists
- If found → run it with run_workflow(name, args)
- If not found → use your built-in tools (Bash, WebFetch, etc.) directly

Tell the boss — when stuck or unsure:
- If you're not sure what to do, about to do something risky/irreversible, or need human approval, use ask_boss to ask the user first.
- Do NOT guess or proceed blindly. Your message will be sent; their reply will come in the next message. Stop and wait for it.`,
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

const TOOLS: OpenAI.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'Bash',
      description: 'Execute a bash command. Working directory: /workspace/group. Returns stdout + stderr.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The bash command to execute' },
          timeout: { type: 'number', description: 'Timeout in ms (default 30000, max 120000)' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'Read',
      description: 'Read a file and return its contents with line numbers.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute or relative (from /workspace/group) file path' },
          offset: { type: 'number', description: 'Start line number (1-indexed)' },
          limit: { type: 'number', description: 'Maximum lines to return' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'Write',
      description: 'Write content to a file (creates parent directories as needed).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute or relative file path' },
          content: { type: 'string', description: 'Content to write' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'Edit',
      description: 'Replace a specific string in a file. old_string must appear exactly once in the file.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path' },
          old_string: { type: 'string', description: 'Exact text to replace (must be unique in the file)' },
          new_string: { type: 'string', description: 'Replacement text' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'Glob',
      description: 'Find files matching a glob pattern.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Glob pattern, e.g. "**/*.ts" or "*.json"' },
          directory: { type: 'string', description: 'Search root directory (default: /workspace/group)' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'Grep',
      description: 'Search file contents using ripgrep. Returns matching lines with file:line context.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regex or literal search pattern' },
          path: { type: 'string', description: 'File or directory to search (default: /workspace/group)' },
          flags: { type: 'string', description: 'Extra rg flags e.g. "-i" (case insensitive), "-l" (filenames only)' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'WebFetch',
      description: 'Fetch a URL and return its text content (HTML stripped).',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to fetch' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'send_message',
      description: 'Send a WhatsApp text message to the chat right now (before finishing). Use for progress updates.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Message text to send' },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'send_voice',
      description: 'Send a WhatsApp voice note (spoken audio). Use for natural conversational replies, especially when the user sent a voice message. Keep text short — under ~200 words.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Text to speak aloud as a voice note' },
          voice: { type: 'string', description: 'Optional speaker: Ryan, Aiden, Vivian, Serena, Uncle_Fu, Dylan, Eric, Ono_Anna, Sohee (default: Ryan)' },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ask_boss',
      description: 'Ask the user (the boss) for guidance when stuck, unsure, or before doing something risky/irreversible. Your question is sent to the chat. Stop and wait for their reply — do not proceed until you have it. Use when: ambiguous request, destructive action, sensitive data, or you lack context.',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'Clear question or context for the user to respond to' },
        },
        required: ['question'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'schedule_task',
      description: 'Schedule a recurring or one-time task that runs as an agent.',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'What the agent should do when the task runs' },
          schedule_type: { type: 'string', enum: ['cron', 'interval', 'once'], description: 'cron=time-based, interval=every N ms, once=run once' },
          schedule_value: { type: 'string', description: 'cron: "0 9 * * *" | interval: ms like "3600000" | once: local ISO "2026-02-01T15:30:00" (no Z!)' },
          context_mode: { type: 'string', enum: ['group', 'isolated'], description: 'group=with chat history, isolated=fresh session (include context in prompt)' },
        },
        required: ['prompt', 'schedule_type', 'schedule_value'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_tasks',
      description: 'List all scheduled tasks.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'pause_task',
      description: 'Pause a scheduled task by ID.',
      parameters: {
        type: 'object',
        properties: { task_id: { type: 'string', description: 'Task ID to pause' } },
        required: ['task_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'resume_task',
      description: 'Resume a paused task by ID.',
      parameters: {
        type: 'object',
        properties: { task_id: { type: 'string', description: 'Task ID to resume' } },
        required: ['task_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cancel_task',
      description: 'Cancel and delete a scheduled task by ID.',
      parameters: {
        type: 'object',
        properties: { task_id: { type: 'string', description: 'Task ID to cancel' } },
        required: ['task_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_workflows',
      description: 'List all available workflows and automations in the registry. Call this when the user asks what you can do, what automations are available, or to browse capabilities.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_tools',
      description: 'Search the workflow registry for tools/automations by keyword or intent. Returns matching entries with name, description, and how to run them. Call this first when the user asks you to do something that might be a pre-built workflow.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Keywords describing what you want to do, e.g. "morning briefing", "send slack message", "fetch leads"' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_workflow',
      description: 'Run a workflow by name from the registry. Optionally pass arguments as a JSON object.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Workflow name from the registry' },
          args: { type: 'object', description: 'Optional key-value arguments passed as environment variables to the script', additionalProperties: { type: 'string' } },
        },
        required: ['name'],
      },
    },
  },
];

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

async function executeTool(
  name: string,
  args: Record<string, unknown>,
  input: ContainerInput,
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
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NanoClaw/2.0)' },
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

async function runQuery(
  prompt: string,
  session: Session,
  input: ContainerInput,
  client: OpenAI,
  modelName: string,
): Promise<{ result: string | null; closed: boolean }> {
  const systemPrompt = buildSystemPrompt(input);
  session.messages.push({ role: 'user', content: prompt });

  let lastText: string | null = null;

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    if (shouldClose()) {
      log('Close sentinel detected mid-query, aborting');
      saveSession(session);
      return { result: lastText, closed: true };
    }

    log(`Model call #${i + 1} (${session.messages.length} messages in history)`);

    // Gemini's OpenAI-compatible endpoint is strict about message shape:
    // - Rejects content:"" on assistant messages that have tool_calls
    // - Rejects null values for unknown fields like refusal, reasoning, reasoning_details
    const sanitizedMessages = session.messages.map((m: any) => {
      if (m.role !== 'assistant') return m;
      const cleaned: any = { role: m.role };
      // Only include content if it's a non-empty string
      if (typeof m.content === 'string' && m.content !== '') cleaned.content = m.content;
      if (m.tool_calls?.length) cleaned.tool_calls = m.tool_calls;
      return cleaned;
    });

    let response;
    try {
      response = await client.chat.completions.create({
        model: modelName,
        messages: [{ role: 'system', content: systemPrompt }, ...sanitizedMessages],
        tools: TOOLS,
        tool_choice: 'auto',
        max_tokens: 8192,
      });
    } catch (err: any) {
      const msg = err?.message ?? '';
      // Gemini rejects sessions with turn-ordering violations or token overflow.
      // Trim to the last 10 messages and retry once before giving up.
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
    for (const toolCall of msg.tool_calls!) {
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(toolCall.function.arguments) as Record<string, unknown>;
      } catch {
        args = { command: toolCall.function.arguments };
      }
      const result = await executeTool(toolCall.function.name, args, input);
      session.messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: result,
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
  const geminiKey = secrets.GEMINI_API_KEY;
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
  } else if (openrouterKey && openrouterKey !== 'no-key') {
    // OpenRouter takes priority — this is the primary backend
    apiKey = openrouterKey;
    baseURL = secrets.OPENROUTER_BASE_URL ?? OPENROUTER_BASE_URL;
    modelName = secrets.MODEL_NAME ?? OPENROUTER_DEFAULT_MODEL;
    backend = 'openrouter';
  } else if (geminiKey) {
    // Gemini fallback — only used when no OPENROUTER_API_KEY is set
    apiKey = geminiKey;
    baseURL = GEMINI_BASE_URL;
    const rawModel = secrets.MODEL_NAME;
    const looksLikeOpenRouter = rawModel && (rawModel.includes('/') || rawModel.includes(':'));
    modelName = looksLikeOpenRouter ? GEMINI_DEFAULT_MODEL : (rawModel ?? GEMINI_DEFAULT_MODEL);
    backend = 'gemini';
  } else {
    apiKey = 'no-key';
    baseURL = OPENROUTER_BASE_URL;
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
      const { result, closed } = await runQuery(prompt, session, input, client, modelName);

      writeOutput({ status: 'success', result, newSessionId: session.id });

      if (closed || shouldClose()) {
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
