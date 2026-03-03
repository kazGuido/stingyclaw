import fs from 'fs';

import { WAMessage, WASocket, downloadMediaMessage } from '@whiskeysockets/baileys';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getVoiceServiceUrl(): string {
  const env = readEnvFile(['VOICE_SERVICE_URL']);
  return (env.VOICE_SERVICE_URL ?? 'http://localhost:8001').replace(/\/$/, '');
}

/** True for PTT voice notes (short push-to-talk). */
export function isVoiceMessage(msg: WAMessage): boolean {
  return msg.message?.audioMessage?.ptt === true;
}

/** True for any audio message (voice note or audio file). Used to transcribe call recordings etc. */
export function isAudioMessage(msg: WAMessage): boolean {
  return Boolean(msg.message?.audioMessage);
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

  // Health check before first attempt — fail fast with clear message if service is down
  try {
    const ping = await fetch(`${baseUrl}/health`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!ping.ok) {
      logger.error(
        { url: baseUrl, status: ping.status },
        'Voice service health check failed — is the voice container running? (docker compose up -d voice)',
      );
      return null;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isConnectionRefused = /ECONNREFUSED|fetch failed|Failed to fetch/i.test(msg);
    logger.error(
      { url: baseUrl, err: msg, isConnectionRefused },
      'Voice service unreachable — check VOICE_SERVICE_URL (.env) and that voice container is running (docker compose up -d voice)',
    );
    return null;
  }

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`${baseUrl}/synthesize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, voice }),
        signal: AbortSignal.timeout(180000), // 180s — server serializes TTS (CLI_LOCK); a queued request can wait 90s + 90s
      });

      if (!res.ok) {
        const body = await res.text();
        const retryable = res.status >= 500 || res.status === 429;
        const isModelLoad =
          body.includes('llama_model_loader') ||
          body.includes('load_backend') ||
          body.includes('not found') ||
          res.status === 503;
        logger.error(
          {
            status: res.status,
            bodySnippet: body.slice(0, 400),
            attempt,
            retryable,
            isModelLoad,
            hint: isModelLoad
              ? 'Model may still be downloading. Check voice container logs: docker logs stingyclaw-voice'
              : undefined,
          },
          'Voice service synthesis error',
        );
        if (retryable && attempt < 3) {
          const delay = isModelLoad ? 8000 : 2000;
          logger.info({ attempt, delayMs: delay }, 'Retrying voice synthesis...');
          await sleep(delay);
          continue;
        }
        return null;
      }

      const bytes = Buffer.from(await res.arrayBuffer());
      logger.info({ chars: text.length, bytes: bytes.length }, 'Synthesized speech');
      return bytes;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isTimeout = /timeout|aborted/i.test(msg);
      logger.error(
        { err: msg, attempt, isTimeout, url: baseUrl },
        'Failed to call voice service for synthesis',
      );
      if (attempt < 3) {
        await sleep(attempt === 1 ? 5000 : 8000);
        continue;
      }
      return null;
    }
  }
  return null;
}
