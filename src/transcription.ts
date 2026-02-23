import fs from 'fs';

import { WAMessage, WASocket, downloadMediaMessage } from '@whiskeysockets/baileys';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

function getVoiceServiceUrl(): string {
  const env = readEnvFile(['VOICE_SERVICE_URL']);
  return (env.VOICE_SERVICE_URL ?? 'http://localhost:8001').replace(/\/$/, '');
}

export function isVoiceMessage(msg: WAMessage): boolean {
  return msg.message?.audioMessage?.ptt === true;
}

/**
 * Download and transcribe a WhatsApp voice note via the local voice service.
 * Returns the transcript text, or null if transcription fails.
 */
export async function transcribeVoiceMessage(
  msg: WAMessage,
  _sock: WASocket,
): Promise<string | null> {
  const baseUrl = getVoiceServiceUrl();

  // Health-check the voice service before trying (fast fail)
  try {
    const ping = await fetch(`${baseUrl}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!ping.ok) throw new Error(`HTTP ${ping.status}`);
  } catch (err) {
    logger.warn({ err }, 'Voice service unavailable — skipping transcription');
    return null;
  }

  // Download the OGG audio from WhatsApp
  let audioBuffer: Buffer;
  try {
    audioBuffer = (await downloadMediaMessage(msg, 'buffer', {})) as Buffer;
  } catch (err) {
    logger.error({ err }, 'Failed to download voice message audio');
    return null;
  }

  if (!audioBuffer || audioBuffer.length === 0) {
    logger.warn('Downloaded voice message was empty');
    return null;
  }

  // POST the audio to the voice service
  try {
    const form = new FormData();
    form.append('audio', new Blob([audioBuffer], { type: 'audio/ogg' }), 'voice.ogg');

    const res = await fetch(`${baseUrl}/transcribe`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(60000),
    });

    if (!res.ok) {
      const body = await res.text();
      logger.error({ status: res.status, body }, 'Voice service transcription error');
      return null;
    }

    const json = (await res.json()) as { text?: string };
    const text = json.text?.trim();

    if (!text) {
      logger.debug('Voice service returned empty transcript (silence?)');
      return null;
    }

    logger.info(
      { bytes: audioBuffer.length, chars: text.length },
      'Transcribed voice message',
    );
    return text;
  } catch (err) {
    logger.error({ err }, 'Failed to call voice service for transcription');
    return null;
  }
}

/**
 * Synthesize text to speech via the voice service.
 * Returns an OGG Opus buffer suitable for WhatsApp PTT, or null on failure.
 */
export async function synthesizeSpeech(
  text: string,
  voice?: string,
): Promise<Buffer | null> {
  const baseUrl = getVoiceServiceUrl();

  try {
    const res = await fetch(`${baseUrl}/synthesize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voice }),
      signal: AbortSignal.timeout(60000),
    });

    if (!res.ok) {
      const body = await res.text();
      logger.error({ status: res.status, body }, 'Voice service synthesis error');
      return null;
    }

    const bytes = Buffer.from(await res.arrayBuffer());
    logger.info({ chars: text.length, bytes: bytes.length }, 'Synthesized speech');
    return bytes;
  } catch (err) {
    logger.error({ err }, 'Failed to call voice service for synthesis');
    return null;
  }
}
