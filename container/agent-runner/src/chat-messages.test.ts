import { describe, expect, it } from 'vitest';
import {
  sessionToCoreMessages,
  trimSessionMessagesForApi,
  type ChatMessage,
} from './chat-messages.js';

function assistantWithTools(
  id: string,
  name: string,
  args: string,
): ChatMessage {
  return {
    role: 'assistant',
    content: null,
    tool_calls: [{ id, function: { name, arguments: args } }],
  };
}

function toolMsg(id: string, content: string): ChatMessage {
  return { role: 'tool', tool_call_id: id, content };
}

describe('trimSessionMessagesForApi', () => {
  it('drops leading tool messages after tail slice (orphan tool_calls)', () => {
    const history: ChatMessage[] = [
      { role: 'user', content: 'old' },
      assistantWithTools('call-1', 'Bash', '{"command":"echo"}'),
      toolMsg('call-1', 'ok'),
      { role: 'user', content: 'new' },
    ];
    // Simulates slice(-2) keeping only last tool + user — invalid for APIs
    const sliced = history.slice(-2);
    expect(sliced[0].role).toBe('tool');
    const fixed = trimSessionMessagesForApi(history, 2);
    expect(fixed).toHaveLength(1);
    expect(fixed[0].role).toBe('user');
    expect((fixed[0] as { content: string }).content).toBe('new');
  });

  it('keeps intact sequence when slice starts at user', () => {
    const history: ChatMessage[] = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'hi' },
      { role: 'user', content: 'b' },
    ];
    const out = trimSessionMessagesForApi(history, 2);
    expect(out.map((m) => m.role)).toEqual(['assistant', 'user']);
  });
});

describe('sessionToCoreMessages', () => {
  it('skips orphan tool rows without matching assistant tool_calls in window', () => {
    const history: ChatMessage[] = [
      { role: 'user', content: 'ping' },
      toolMsg('unknown-id', 'orphan'),
    ];
    const core = sessionToCoreMessages(history);
    expect(core.filter((m) => m.role === 'tool')).toHaveLength(0);
    expect(core.some((m) => m.role === 'user')).toBe(true);
  });

  it('preserves tool after assistant with matching tool_calls', () => {
    const history: ChatMessage[] = [
      { role: 'user', content: 'run' },
      assistantWithTools('call-1', 'Bash', '{"command":"echo"}'),
      toolMsg('call-1', 'out'),
    ];
    const core = sessionToCoreMessages(history);
    expect(core.filter((m) => m.role === 'tool')).toHaveLength(1);
  });
});
