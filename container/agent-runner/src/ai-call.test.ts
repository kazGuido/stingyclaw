/**
 * Test the AI call path exactly as used in index.ts:
 * - createOpenRouter with same options
 * - Tools in Vercel SDK format (object + jsonSchema)
 * - Message sanitization (no tool_calls in assistant history)
 * - generateText with same params
 *
 * Run: npx tsx src/ai-call.test.ts (or ts-node)
 * Requires OPENROUTER_API_KEY and optionally MODEL_NAME in env.
 */

import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { generateText, jsonSchema } from 'ai';
import fs from 'fs';
import path from 'path';

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const OPENROUTER_DEFAULT_MODEL = 'liquid/lfm-2.5';

interface ToolRegistryEntry {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

interface ToolRegistry {
  tools: ToolRegistryEntry[];
}

function loadToolRegistry(): ToolRegistry {
  const candidates = [
    path.join(process.cwd(), 'tool-registry.json'),
    path.join(process.cwd(), '..', 'tool-registry.json'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, 'utf-8')) as ToolRegistry;
    }
  }
  throw new Error('tool-registry.json not found');
}

/** Build tools in Vercel AI SDK format: object keyed by name, each value has description + parameters (jsonSchema). SDK uses .parameters, not .inputSchema. */
function buildVercelTools(registry: ToolRegistry): Record<string, { description: string; parameters: ReturnType<typeof jsonSchema> }> {
  const out: Record<string, { description: string; parameters: ReturnType<typeof jsonSchema> }> = {};
  for (const t of registry.tools.slice(0, 3)) {
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

/** Sanitize messages like index.ts: assistant only role+content; tool has role, tool_call_id, content. */
function sanitizeMessages(messages: Array<{ role: string; content?: string | null; tool_call_id?: string }>) {
  return messages.map((m: any) => {
    if (m.role === 'assistant') {
      return { role: m.role, content: typeof m.content === 'string' ? m.content : null };
    }
    if (m.role === 'tool') {
      return { role: m.role, tool_call_id: m.tool_call_id, content: m.content };
    }
    return m;
  });
}

async function main() {
  const apiKey = process.env.OPENROUTER_API_KEY;
  const modelName = process.env.MODEL_NAME || OPENROUTER_DEFAULT_MODEL;
  const baseURL = process.env.OPENROUTER_BASE_URL || OPENROUTER_BASE_URL;

  if (!apiKey) {
    console.error('Set OPENROUTER_API_KEY to run this test');
    process.exit(1);
  }

  const registry = loadToolRegistry();
  const tools = buildVercelTools(registry);

  const openrouter = createOpenRouter({
    apiKey,
    baseURL,
    headers: {
      'HTTP-Referer': 'https://github.com/kazGuido/stingyclaw',
      'X-Title': 'Stingyclaw',
    },
  });

  const systemPrompt = 'You are a helpful assistant. If the user asks for a tool, call one of the provided tools once.';
  const messagesForApi = [
    { role: 'user' as const, content: 'List the files in the current directory. Use a single tool call.' },
  ];
  const sanitizedMessages = sanitizeMessages(messagesForApi);

  console.log('Calling generateText with:', { modelName, toolsCount: Object.keys(tools).length, messagesCount: sanitizedMessages.length + 1 });

  const result = await generateText({
    model: openrouter.chat(modelName),
    messages: [{ role: 'system', content: systemPrompt }, ...sanitizedMessages],
    tools,
    maxTokens: 512,
  });

  console.log('text:', result.text?.slice(0, 200) ?? '(none)');
  console.log('toolCalls:', result.toolCalls?.length ?? 0);
  if (result.toolCalls?.length) {
    console.log('first toolCall:', result.toolCalls[0]);
  }
  console.log('OK');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
