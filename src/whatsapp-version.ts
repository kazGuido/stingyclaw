/**
 * WhatsApp Web version — must match what WhatsApp servers expect.
 * Baileys' default (1027934701) causes 405 Connection Failure.
 *
 * Resolution order:
 * 1. store/wa-version.json (persisted from successful fetch)
 * 2. FALLBACK_VERSION below (updated from https://wppconnect.io/whatsapp-versions/)
 *
 * When auth or connection fails with 405, we try fetchLatestWaWebVersion
 * and persist to store/wa-version.json. Run `npm run update-wa-version`
 * to manually refresh.
 */
import fs from 'fs';
import path from 'path';

import { fetchLatestWaWebVersion } from '@whiskeysockets/baileys';

export const FALLBACK_VERSION: [number, number, number] = [2, 3000, 1034270928];

const VERSION_FILE = path.resolve(process.cwd(), 'store', 'wa-version.json');

function isValidVersion(v: unknown): v is [number, number, number] {
  return (
    Array.isArray(v) &&
    v.length === 3 &&
    v.every((n) => typeof n === 'number')
  );
}

/**
 * Get the WhatsApp version to use. Reads from store/wa-version.json if present.
 */
export function getWhatsAppVersion(): [number, number, number] {
  try {
    const raw = fs.readFileSync(VERSION_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (isValidVersion(parsed)) return parsed;
  } catch {
    // File missing or invalid — use fallback
  }
  return FALLBACK_VERSION;
}

/**
 * Fetch latest version from WhatsApp, persist to store, and return it.
 * Returns null if fetch fails.
 */
export async function fetchAndPersistVersion(): Promise<[number, number, number] | null> {
  try {
    const result = await fetchLatestWaWebVersion({});
    if (result.version && isValidVersion(result.version)) {
      fs.mkdirSync(path.dirname(VERSION_FILE), { recursive: true });
      fs.writeFileSync(VERSION_FILE, JSON.stringify(result.version));
      return result.version;
    }
  } catch {
    // ignore
  }
  return null;
}
