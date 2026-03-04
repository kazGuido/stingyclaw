import { describe, expect, it, beforeEach, vi } from 'vitest';

import {
  _initTestDatabase,
  markOutboundDeliverySent,
  registerOutboundDelivery,
  setMessagePipelineStateBulk,
  storeChatMetadata,
  storeMessage,
  getMessagePipelineState,
} from './db.js';

beforeEach(() => {
  _initTestDatabase();
});

describe('synthetic reliability smoke', () => {
  it('sends text/voice once and commits pipeline state', async () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');
    storeMessage({
      id: 'smoke-msg-1',
      chat_jid: 'group@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: '[Voice: hello]',
      timestamp: '2024-01-01T00:00:01.000Z',
      is_from_me: false,
      is_bot_message: false,
    });

    setMessagePipelineStateBulk('group@g.us', ['smoke-msg-1'], 'queued');
    setMessagePipelineStateBulk('group@g.us', ['smoke-msg-1'], 'running', 'smoke-run');

    const sendText = vi.fn(async (_jid: string, _text: string) => {});
    const sendVoice = vi.fn(async (_jid: string, _bytes: Buffer) => {});

    const textKey = 'smoke:text:1';
    if (registerOutboundDelivery(textKey, 'group@g.us', 'message')) {
      await sendText('group@g.us', 'reply text');
      markOutboundDeliverySent(textKey);
    }
    // duplicate logical send should be suppressed
    if (registerOutboundDelivery(textKey, 'group@g.us', 'message')) {
      await sendText('group@g.us', 'reply text');
      markOutboundDeliverySent(textKey);
    }

    const voiceKey = 'smoke:voice:1';
    if (registerOutboundDelivery(voiceKey, 'group@g.us', 'voice')) {
      await sendVoice('group@g.us', Buffer.from('audio'));
      markOutboundDeliverySent(voiceKey);
    }
    if (registerOutboundDelivery(voiceKey, 'group@g.us', 'voice')) {
      await sendVoice('group@g.us', Buffer.from('audio'));
      markOutboundDeliverySent(voiceKey);
    }

    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendVoice).toHaveBeenCalledTimes(1);

    setMessagePipelineStateBulk('group@g.us', ['smoke-msg-1'], 'sent', 'smoke-run');
    setMessagePipelineStateBulk('group@g.us', ['smoke-msg-1'], 'committed', 'smoke-run');
    expect(getMessagePipelineState('group@g.us', 'smoke-msg-1')?.state).toBe('committed');
  });
});
