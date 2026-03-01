/**
 * Fetch latest WhatsApp Web version and persist to store/wa-version.json.
 * Run: npm run update-wa-version
 */
import { fetchAndPersistVersion } from '../src/whatsapp-version.js';

const v = await fetchAndPersistVersion();
if (v) {
  console.log('Updated to', JSON.stringify(v));
  process.exit(0);
} else {
  console.error('Fetch failed');
  process.exit(1);
}
