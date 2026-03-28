import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME, GROUPS_DIR } from './config.js';
import {
  addKBEntry,
  buildKbDigestSinceCursor,
  getMessagesSinceChronological,
  getRouterState,
  setRouterState,
} from './db.js';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import type { NewMessage, RegisteredGroup } from './types.js';
import { z } from 'zod';

const KB_DIGEST_CURSORS_KEY = 'kb_digest_cursors';

const DEFAULT_INTERVAL_MS = 12 * 60 * 60 * 1000;
const DEFAULT_LOOKBACK_MS = 12 * 60 * 60 * 1000;
const DEFAULT_MESSAGE_LIMIT = 500;
const PROMPT_MAX_CHARS = 120_000;

const digestResponseSchema = z.object({
  entries: z
    .array(
      z.object({
        title: z.string().min(1).max(240),
        content: z.string().min(1).max(16_000),
        tags: z.string().max(500).optional(),
      }),
    )
    .max(12),
});

function parseIntervalMs(): number {
  const raw = process.env.KB_DIGEST_INTERVAL_MS;
  if (!raw) return DEFAULT_INTERVAL_MS;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 60_000 ? n : DEFAULT_INTERVAL_MS;
}

function parseLookbackMs(): number {
  const raw = process.env.KB_DIGEST_LOOKBACK_MS;
  if (!raw) return DEFAULT_LOOKBACK_MS;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 60_000 ? n : DEFAULT_LOOKBACK_MS;
}

function parseMessageLimit(): number {
  const raw = process.env.KB_DIGEST_MESSAGE_LIMIT;
  if (!raw) return DEFAULT_MESSAGE_LIMIT;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 1 && n <= 5000 ? n : DEFAULT_MESSAGE_LIMIT;
}

function loadCursors(): Record<string, string> {
  const raw = getRouterState(KB_DIGEST_CURSORS_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, string>;
    }
  } catch {
    logger.warn('Corrupted kb_digest_cursors in router_state, resetting map');
  }
  return {};
}

function saveCursors(map: Record<string, string>): void {
  setRouterState(KB_DIGEST_CURSORS_KEY, JSON.stringify(map));
}

function makeCursorFromMessages(messages: NewMessage[]): string {
  const last = messages[messages.length - 1];
  if (!last) return '';
  return JSON.stringify({
    timestamp: last.timestamp,
    messageId: last.id ?? '',
  });
}

function readMissionSnippet(groupFolder: string): string {
  const p = path.join(GROUPS_DIR, groupFolder, 'MISSION.md');
  try {
    const text = fs.readFileSync(p, 'utf-8').trim();
    if (!text) return '(No MISSION.md — infer only from chat context.)';
    return text.length > 12_000 ? `${text.slice(0, 12_000)}\n…` : text;
  } catch {
    return '(No MISSION.md — infer only from chat context.)';
  }
}

function formatMessagesForPrompt(messages: NewMessage[]): string {
  const lines: string[] = [];
  let total = 0;
  for (const m of messages) {
    const who = m.sender_name || m.sender || '?';
    const line = `[${m.timestamp}] ${who}: ${m.content}`;
    if (total + line.length > PROMPT_MAX_CHARS) break;
    lines.push(line);
    total += line.length + 1;
  }
  return lines.join('\n');
}

async function callOpenRouterDigest(
  mission: string,
  transcript: string,
  groupLabel: string,
): Promise<z.infer<typeof digestResponseSchema>> {
  const secrets = readEnvFile(['OPENROUTER_API_KEY', 'MODEL_NAME', 'OPENROUTER_BASE_URL']);
  const apiKey = secrets.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY missing');
  }
  const model = secrets.MODEL_NAME || 'openai/gpt-4o-mini';
  const base = (secrets.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/$/, '');
  const url = `${base}/chat/completions`;

  const system = `You extract durable facts for a group knowledge base. Output JSON only.
Rules:
- Only facts that fit the mission and are useful later (decisions, dates, commitments, definitions, recurring context).
- Skip small talk, greetings, and anything sensitive or speculative.
- At most 12 entries; each title is a short heading; content is 1–4 sentences.
- If nothing worth storing, return {"entries":[]}.`;

  const user = `Group: ${groupLabel}

MISSION:
${mission}

CHAT (chronological):
${transcript || '(no messages in window)'}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      max_tokens: 2500,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`OpenRouter ${res.status}: ${errText.slice(0, 400)}`);
  }

  const body = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const raw = body.choices?.[0]?.message?.content;
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new Error('Empty completion from model');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error('Model returned non-JSON');
  }

  return digestResponseSchema.parse(parsed);
}

export type KbDigestDeps = {
  getRegisteredGroups: () => Record<string, RegisteredGroup>;
};

let tickRunning = false;
let warnedNoApiKey = false;

export async function runKbDigestTick(deps: KbDigestDeps): Promise<void> {
  const secrets = readEnvFile(['OPENROUTER_API_KEY']);
  if (!secrets.OPENROUTER_API_KEY) {
    if (!warnedNoApiKey) {
      warnedNoApiKey = true;
      logger.debug('KB digest skipped: OPENROUTER_API_KEY not set in .env');
    }
    return;
  }

  const now = new Date();
  const lookbackMs = parseLookbackMs();
  const lookbackCut = new Date(now.getTime() - lookbackMs).toISOString();
  const messageLimit = parseMessageLimit();

  const groups = deps.getRegisteredGroups();
  const cursors = loadCursors();

  for (const [jid, group] of Object.entries(groups)) {
    const folder = group.folder;
    const since = buildKbDigestSinceCursor(cursors[folder], lookbackCut);
    const messages = getMessagesSinceChronological(jid, since, ASSISTANT_NAME, messageLimit);
    if (messages.length === 0) {
      continue;
    }

    const mission = readMissionSnippet(folder);
    const transcript = formatMessagesForPrompt(messages);

    let parsed: z.infer<typeof digestResponseSchema>;
    try {
      parsed = await callOpenRouterDigest(mission, transcript, group.name || folder);
    } catch (err) {
      logger.warn({ err, groupFolder: folder, jid }, 'KB digest LLM failed');
      continue;
    }

    const seenTitles = new Set<string>();
    let added = 0;
    for (const e of parsed.entries) {
      const key = e.title.trim().toLowerCase();
      if (!key || seenTitles.has(key)) continue;
      seenTitles.add(key);
      try {
        addKBEntry(folder, e.title.trim(), e.content.trim(), e.tags?.trim());
        added += 1;
      } catch (err) {
        logger.warn({ err, groupFolder: folder, title: e.title }, 'KB digest addKBEntry failed');
      }
    }

    cursors[folder] = makeCursorFromMessages(messages);
    saveCursors(cursors);

    logger.info(
      { groupFolder: folder, messages: messages.length, entriesAdded: added },
      'KB digest completed',
    );
  }
}

export function startKbDigestLoop(deps: KbDigestDeps): () => void {
  const intervalMs = parseIntervalMs();
  logger.info({ intervalMs, lookbackMs: parseLookbackMs() }, 'KB digest loop scheduled');

  const run = () => {
    if (tickRunning) {
      logger.debug('KB digest tick skipped (already running)');
      return;
    }
    tickRunning = true;
    runKbDigestTick(deps)
      .catch((err) => logger.error({ err }, 'KB digest tick error'))
      .finally(() => {
        tickRunning = false;
      });
  };

  const initialDelayMs = Math.max(0, parseInt(process.env.KB_DIGEST_INITIAL_DELAY_MS || '120000', 10) || 120000);
  const t0 = setTimeout(run, initialDelayMs);
  const id = setInterval(run, intervalMs);

  return () => {
    clearTimeout(t0);
    clearInterval(id);
  };
}
