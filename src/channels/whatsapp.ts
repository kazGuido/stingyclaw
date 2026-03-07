import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';

import makeWASocket, {
  Browsers,
  DisconnectReason,
  WASocket,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';

import { ASSISTANT_HAS_OWN_NUMBER, ASSISTANT_NAME, STORE_DIR } from '../config.js';
import {
  fetchAndPersistVersion,
  getWhatsAppVersion,
} from '../whatsapp-version.js';
import {
  getLastGroupSync,
  markOutboundDeliveryFailed,
  markOutboundDeliverySent,
  registerOutboundDelivery,
  setLastGroupSync,
  updateChatName,
} from '../db.js';
import { logger } from '../logger.js';
import { isAudioMessage, transcribeVoiceMessage } from '../transcription.js';
import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  OutboundSendOptions,
  RegisteredGroup,
} from '../types.js';

const GROUP_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface WhatsAppChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

// Backoff delays in ms: 2s, 5s, 15s, 30s, 60s, 120s, ...
const RECONNECT_DELAYS = [2_000, 5_000, 15_000, 30_000, 60_000, 120_000];

// Conflict (440) = another client connected with same auth. Wait longer to avoid flip-flop.
const CONFLICT_DELAY_MS = 120_000; // 2 min

function reconnectDelay(attempt: number, reason?: number): number {
  if (reason === 440) {
    return CONFLICT_DELAY_MS + Math.floor(Math.random() * 30_000); // 2–2.5 min
  }
  const delay = RECONNECT_DELAYS[Math.min(attempt, RECONNECT_DELAYS.length - 1)];
  return delay + Math.floor((Math.random() * 0.2 - 0.1) * delay);
}

export class WhatsAppChannel implements Channel {
  name = 'whatsapp';

  private sock!: WASocket;
  private connected = false;
  private lidToPhoneMap: Record<string, string> = {};
  private outgoingQueue: Array<
    | { kind: 'text'; jid: string; text: string; idempotencyKey?: string }
    | { kind: 'voice'; jid: string; audio: Buffer; idempotencyKey?: string }
    | { kind: 'image'; jid: string; image: Buffer; caption?: string; idempotencyKey?: string }
  > = [];
  private flushing = false;
  private groupSyncTimerStarted = false;
  private reconnectAttempts = 0;

  private opts: WhatsAppChannelOpts;

  constructor(opts: WhatsAppChannelOpts) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.connectInternal(resolve).catch(reject);
    });
  }

  private async connectInternal(onFirstOpen?: () => void): Promise<void> {
    const authDir = path.join(STORE_DIR, 'auth');
    fs.mkdirSync(authDir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    this.sock = makeWASocket({
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      version: getWhatsAppVersion(),
      printQRInTerminal: false,
      logger,
      browser: Browsers.macOS('Chrome'),
    });

    this.sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        const msg =
          'WhatsApp authentication required. Run: npx tsx setup/index.ts --step whatsapp-auth';
        logger.error(msg);
        exec(
          `osascript -e 'display notification "${msg}" with title "Stingyclaw" sound name "Basso"'`,
        );
        setTimeout(() => process.exit(1), 1000);
      }

      if (connection === 'close') {
        this.connected = false;
        const reason = (lastDisconnect?.error as { output?: { statusCode?: number } })?.output?.statusCode;
        const shouldReconnect = reason !== DisconnectReason.loggedOut;
        const isConflict = reason === 440;
        if (isConflict) {
          logger.warn(
            { reason, attempt: this.reconnectAttempts },
            'Connection replaced (440) — another client is using this WhatsApp session. Close WhatsApp Web elsewhere, or wait for reconnect.',
          );
        }
        logger.info({ reason, shouldReconnect, attempt: this.reconnectAttempts, queuedMessages: this.outgoingQueue.length }, 'Connection closed');

        // 405/408 = outdated version or rate limit — refresh version and reconnect in-process
        if (reason === 405 || reason === 408) {
          const newVersion = await fetchAndPersistVersion();
          if (newVersion) {
            logger.info(
              { reason, version: newVersion },
              'Updated WhatsApp version after 405/408; continuing with in-process reconnect',
            );
          } else {
            logger.warn(
              { reason },
              '405/408 but could not fetch latest version; continuing with in-process reconnect',
            );
          }
        }

        if (shouldReconnect) {
          const delay = reconnectDelay(this.reconnectAttempts, reason);
          this.reconnectAttempts++;
          logger.info({ delayMs: delay, attempt: this.reconnectAttempts, reason }, 'Reconnecting with backoff...');
          try {
            this.sock?.end(undefined);
          } catch { /* ignore */ }
          setTimeout(() => {
            this.connectInternal().catch((err) => {
              logger.error({ err }, 'Reconnect attempt failed, will retry via next close event');
            });
          }, delay);
        } else {
          logger.info('Logged out. Run /setup to re-authenticate.');
          process.exit(0);
        }
      } else if (connection === 'open') {
        this.connected = true;
        this.reconnectAttempts = 0; // reset backoff on successful connect
        logger.info('Connected to WhatsApp');

        // Announce availability so WhatsApp relays subsequent presence updates (typing indicators)
        this.sock.sendPresenceUpdate('available').catch((err) => {
          logger.warn({ err }, 'Failed to send presence update');
        });

        // Build LID to phone mapping from auth state for self-chat translation
        if (this.sock.user) {
          const phoneUser = this.sock.user.id.split(':')[0];
          const lidUser = this.sock.user.lid?.split(':')[0];
          if (lidUser && phoneUser) {
            this.lidToPhoneMap[lidUser] = `${phoneUser}@s.whatsapp.net`;
            logger.debug({ lidUser, phoneUser }, 'LID to phone mapping set');
          }
        }

        // Flush any messages queued while disconnected
        this.flushOutgoingQueue().catch((err) =>
          logger.error({ err }, 'Failed to flush outgoing queue'),
        );

        // Sync group metadata on startup (respects 24h cache)
        this.syncGroupMetadata().catch((err) =>
          logger.error({ err }, 'Initial group sync failed'),
        );
        // Set up daily sync timer (only once)
        if (!this.groupSyncTimerStarted) {
          this.groupSyncTimerStarted = true;
          setInterval(() => {
            this.syncGroupMetadata().catch((err) =>
              logger.error({ err }, 'Periodic group sync failed'),
            );
          }, GROUP_SYNC_INTERVAL_MS);
        }

        // Signal first connection to caller
        if (onFirstOpen) {
          onFirstOpen();
          onFirstOpen = undefined;
        }
      }
    });

    this.sock.ev.on('creds.update', saveCreds);

    this.sock.ev.on('messages.upsert', async ({ messages }) => {
      for (const msg of messages) {
        if (!msg.message) continue;
        const rawJid = msg.key.remoteJid;
        if (!rawJid || rawJid === 'status@broadcast') continue;

        // Translate LID JID to phone JID if applicable
        const chatJid = await this.translateJid(rawJid);

        const timestamp = new Date(
          Number(msg.messageTimestamp) * 1000,
        ).toISOString();

        // Always notify about chat metadata for group discovery
        const isGroup = chatJid.endsWith('@g.us');
        this.opts.onChatMetadata(chatJid, timestamp, undefined, 'whatsapp', isGroup);

        // Only deliver full message for registered groups
        const groups = this.opts.registeredGroups();
        if (groups[chatJid]) {
          // Handle voice notes and any audio (e.g. call recordings): download + transcribe, deliver as [Voice: text]
          if (isAudioMessage(msg)) {
            const transcript = await transcribeVoiceMessage(msg, this.sock);
            const content = transcript
              ? `[Voice: ${transcript}]`
              : '[Voice message — transcription unavailable]';

            const sender = msg.key.participant || msg.key.remoteJid || '';
            const senderName = msg.pushName || sender.split('@')[0];
            const fromMe = msg.key.fromMe || false;
            // Any message we sent is a bot message (avoids agent reacting to its own voice/text)
            const isBotMessage = fromMe || (ASSISTANT_HAS_OWN_NUMBER ? false : content.startsWith(`${ASSISTANT_NAME}:`));

            this.opts.onMessage(chatJid, {
              id: msg.key.id || '',
              chat_jid: chatJid,
              sender,
              sender_name: senderName,
              content,
              timestamp,
              is_from_me: fromMe,
              is_bot_message: isBotMessage,
            });
            continue;
          }

          const imageMsg = msg.message?.imageMessage;
          const videoMsg = msg.message?.videoMessage;
          const content =
            msg.message?.conversation ||
            msg.message?.extendedTextMessage?.text ||
            (imageMsg ? `[Image]${imageMsg.caption ? ` ${imageMsg.caption}` : ''}`.trim() : '') ||
            (videoMsg ? `[Video]${videoMsg.caption ? ` ${videoMsg.caption}` : ''}`.trim() : '') ||
            '';

          // Skip protocol messages with no text content (encryption keys, read receipts, etc.)
          if (!content) continue;

          const sender = msg.key.participant || msg.key.remoteJid || '';
          const senderName = msg.pushName || sender.split('@')[0];

          const fromMe = msg.key.fromMe || false;
          // Any message we sent is a bot message (avoids agent reacting to its own replies).
          // With shared number, also treat assistant-prefixed content as bot.
          const isBotMessage = fromMe || (ASSISTANT_HAS_OWN_NUMBER ? false : content.startsWith(`${ASSISTANT_NAME}:`));

          this.opts.onMessage(chatJid, {
            id: msg.key.id || '',
            chat_jid: chatJid,
            sender,
            sender_name: senderName,
            content,
            timestamp,
            is_from_me: fromMe,
            is_bot_message: isBotMessage,
          });
        }
      }
    });
  }

  async sendVoice(jid: string, audioBuffer: Buffer, options?: OutboundSendOptions): Promise<void> {
    const idempotencyKey = options?.idempotencyKey;
    if (idempotencyKey && !registerOutboundDelivery(idempotencyKey, jid, 'voice')) {
      logger.info({ jid, idempotencyKey }, 'Skipping duplicate voice send by idempotency key');
      return;
    }
    if (!this.connected) {
      this.outgoingQueue.push({ kind: 'voice', jid, audio: audioBuffer, idempotencyKey });
      logger.info(
        { jid, bytes: audioBuffer.length, queueSize: this.outgoingQueue.length },
        'WA disconnected, voice queued',
      );
      return;
    }
    try {
      await this.sock.sendMessage(jid, {
        audio: audioBuffer,
        ptt: true,
        mimetype: 'audio/ogg; codecs=opus',
      });
      logger.info({ jid, bytes: audioBuffer.length }, 'Voice message sent');
      if (idempotencyKey) {
        markOutboundDeliverySent(idempotencyKey);
      }
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send voice message');
      if (idempotencyKey) {
        const msg = err instanceof Error ? err.message : String(err);
        markOutboundDeliveryFailed(idempotencyKey, msg);
      }
      this.outgoingQueue.push({ kind: 'voice', jid, audio: audioBuffer, idempotencyKey });
    }
  }

  async sendMessage(jid: string, text: string, options?: OutboundSendOptions): Promise<void> {
    const idempotencyKey = options?.idempotencyKey;
    if (
      idempotencyKey &&
      !registerOutboundDelivery(idempotencyKey, jid, 'message')
    ) {
      logger.info({ jid, idempotencyKey }, 'Skipping duplicate message send by idempotency key');
      return;
    }
    // Prefix bot messages with assistant name so users know who's speaking.
    // On a shared number, prefix is also needed in DMs (including self-chat)
    // to distinguish bot output from user messages.
    // Skip only when the assistant has its own dedicated phone number.
    const prefixed = ASSISTANT_HAS_OWN_NUMBER
      ? text
      : `${ASSISTANT_NAME}: ${text}`;

    if (!this.connected) {
      this.outgoingQueue.push({ kind: 'text', jid, text: prefixed, idempotencyKey });
      logger.info(
        { jid, length: prefixed.length, queueSize: this.outgoingQueue.length },
        'WA disconnected, message queued',
      );
      return;
    }
    try {
      await this.sock.sendMessage(jid, { text: prefixed });
      logger.info({ jid, length: prefixed.length }, 'Message sent');
      if (idempotencyKey) {
        markOutboundDeliverySent(idempotencyKey);
      }
    } catch (err) {
      // If send fails, queue it for retry on reconnect
      this.outgoingQueue.push({ kind: 'text', jid, text: prefixed, idempotencyKey });
      logger.warn({ jid, err, queueSize: this.outgoingQueue.length }, 'Failed to send, message queued');
    }
  }

  async sendImage(
    jid: string,
    imageBuffer: Buffer,
    caption?: string,
    options?: OutboundSendOptions,
  ): Promise<void> {
    const idempotencyKey = options?.idempotencyKey;
    if (idempotencyKey && !registerOutboundDelivery(idempotencyKey, jid, 'image')) {
      logger.info({ jid, idempotencyKey }, 'Skipping duplicate image send by idempotency key');
      return;
    }
    if (!this.connected) {
      this.outgoingQueue.push({
        kind: 'image',
        jid,
        image: imageBuffer,
        caption: caption ? `${ASSISTANT_NAME}: ${caption}` : undefined,
        idempotencyKey,
      });
      logger.info(
        { jid, bytes: imageBuffer.length, queueSize: this.outgoingQueue.length },
        'WA disconnected, image queued',
      );
      return;
    }
    try {
      await this.sock.sendMessage(jid, {
        image: imageBuffer,
        caption: caption ? `${ASSISTANT_NAME}: ${caption}` : undefined,
      });
      logger.info({ jid, bytes: imageBuffer.length }, 'Image sent');
      if (idempotencyKey) {
        markOutboundDeliverySent(idempotencyKey);
      }
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send image');
      if (idempotencyKey) {
        const msg = err instanceof Error ? err.message : String(err);
        markOutboundDeliveryFailed(idempotencyKey, msg);
      }
      this.outgoingQueue.push({
        kind: 'image',
        jid,
        image: imageBuffer,
        caption: caption ? `${ASSISTANT_NAME}: ${caption}` : undefined,
        idempotencyKey,
      });
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.endsWith('@g.us') || jid.endsWith('@s.whatsapp.net');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.sock?.end(undefined);
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    try {
      const status = isTyping ? 'composing' : 'paused';
      logger.debug({ jid, status }, 'Sending presence update');
      await this.sock.sendPresenceUpdate(status, jid);
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to update typing status');
    }
  }

  /**
   * Sync group metadata from WhatsApp.
   * Fetches all participating groups and stores their names in the database.
   * Called on startup, daily, and on-demand via IPC.
   */
  async syncGroupMetadata(force = false): Promise<void> {
    if (!force) {
      const lastSync = getLastGroupSync();
      if (lastSync) {
        const lastSyncTime = new Date(lastSync).getTime();
        if (Date.now() - lastSyncTime < GROUP_SYNC_INTERVAL_MS) {
          logger.debug({ lastSync }, 'Skipping group sync - synced recently');
          return;
        }
      }
    }

    try {
      logger.info('Syncing group metadata from WhatsApp...');
      const groups = await this.sock.groupFetchAllParticipating();

      let count = 0;
      for (const [jid, metadata] of Object.entries(groups)) {
        if (metadata.subject) {
          updateChatName(jid, metadata.subject);
          count++;
        }
      }

      setLastGroupSync();
      logger.info({ count }, 'Group metadata synced');
    } catch (err) {
      logger.error({ err }, 'Failed to sync group metadata');
    }
  }

  private async translateJid(jid: string): Promise<string> {
    if (!jid.endsWith('@lid')) return jid;
    const lidUser = jid.split('@')[0].split(':')[0];

    // Check local cache first
    const cached = this.lidToPhoneMap[lidUser];
    if (cached) {
      logger.debug({ lidJid: jid, phoneJid: cached }, 'Translated LID to phone JID (cached)');
      return cached;
    }

    // Query Baileys' signal repository for the mapping
    try {
      const pn = await this.sock.signalRepository?.lidMapping?.getPNForLID(jid);
      if (pn) {
        const phoneJid = `${pn.split('@')[0].split(':')[0]}@s.whatsapp.net`;
        this.lidToPhoneMap[lidUser] = phoneJid;
        logger.info({ lidJid: jid, phoneJid }, 'Translated LID to phone JID (signalRepository)');
        return phoneJid;
      }
    } catch (err) {
      logger.debug({ err, jid }, 'Failed to resolve LID via signalRepository');
    }

    return jid;
  }

  private async flushOutgoingQueue(): Promise<void> {
    if (this.flushing || this.outgoingQueue.length === 0) return;
    this.flushing = true;
    try {
      logger.info({ count: this.outgoingQueue.length }, 'Flushing outgoing message queue');
      while (this.outgoingQueue.length > 0) {
        const item = this.outgoingQueue[0]!;
        try {
          if (item.kind === 'text') {
            await this.sock.sendMessage(item.jid, { text: item.text });
          } else if (item.kind === 'voice') {
            await this.sock.sendMessage(item.jid, {
              audio: item.audio,
              ptt: true,
              mimetype: 'audio/ogg; codecs=opus',
            });
          } else {
            await this.sock.sendMessage(item.jid, {
              image: item.image,
              caption: item.caption,
            });
          }
          if (item.idempotencyKey) {
            markOutboundDeliverySent(item.idempotencyKey);
          }
          logger.info({ jid: item.jid, kind: item.kind }, 'Queued message sent');
          this.outgoingQueue.shift();
        } catch (err) {
          logger.warn({ jid: item.jid, err }, 'Queued message send failed, will retry later');
          break;
        }
      }
    } finally {
      this.flushing = false;
    }
  }
}
