/**
 * Chat history ↔ Vercel AI SDK CoreMessage conversion.
 * Providers (e.g. Qwen via OpenRouter) require: every `tool` message immediately follows
 * an assistant message that includes matching `tool_calls`. Trimming the tail of
 * `session.messages` with `.slice(-N)` can leave a leading `tool` whose assistant was
 * dropped — that produces upstream errors like "tool must be a response to tool_calls".
 */

import type { CoreMessage } from 'ai';

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | {
      role: 'assistant';
      content?: string | null;
      tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
      refusal?: null;
    }
  | { role: 'tool'; tool_call_id: string; content: string };

/** Build id -> toolName from assistant tool_calls in this window. */
export function toolCallIdToName(messages: ChatMessage[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const m of messages) {
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        if (tc.id && tc.function?.name) map[tc.id] = tc.function.name;
      }
    }
  }
  return map;
}

/**
 * Take at most the last `maxMessages` messages, then drop leading `tool` rows until the
 * window starts with `user` or `assistant`. Those leading tools belonged to an assistant
 * turn that was truncated off the left and would break provider APIs.
 */
export function trimSessionMessagesForApi(messages: ChatMessage[], maxMessages: number): ChatMessage[] {
  const max = Math.max(1, maxMessages);
  let slice = messages.length > max ? messages.slice(-max) : messages.slice();
  while (slice.length > 0 && slice[0].role === 'tool') {
    slice = slice.slice(1);
  }
  return slice;
}

/** Convert stored chat messages to AI SDK CoreMessage[] (system is passed separately). */
export function sessionToCoreMessages(messages: ChatMessage[]): CoreMessage[] {
  const idToName = toolCallIdToName(messages);
  const out: CoreMessage[] = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.content });
      continue;
    }
    if (m.role === 'assistant') {
      const msg = m as {
        content?: string | null;
        tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
      };
      const text = typeof msg.content === 'string' && msg.content.trim() ? msg.content : '';
      const toolCalls = msg.tool_calls ?? [];
      if (toolCalls.length === 0) {
        out.push({ role: 'assistant', content: text || '' });
      } else {
        const parts: Array<
          | { type: 'text'; text: string }
          | { type: 'tool-call'; toolCallId: string; toolName: string; args: unknown }
        > = [];
        if (text) parts.push({ type: 'text', text });
        for (const tc of toolCalls) {
          let args: unknown;
          try {
            args = JSON.parse(tc.function.arguments);
          } catch {
            args = { command: tc.function.arguments };
          }
          parts.push({ type: 'tool-call', toolCallId: tc.id, toolName: tc.function.name, args });
        }
        out.push({ role: 'assistant', content: parts });
      }
      continue;
    }
    if (m.role === 'tool') {
      const toolName = idToName[m.tool_call_id] ?? '';
      if (!toolName) {
        // Orphan tool result (assistant with tool_calls was truncated off) — skip
        continue;
      }
      out.push({
        role: 'tool',
        content: [{ type: 'tool-result', toolCallId: m.tool_call_id, toolName, result: m.content }],
      });
      continue;
    }
  }
  return out;
}
