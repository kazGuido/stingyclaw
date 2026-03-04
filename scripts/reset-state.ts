#!/usr/bin/env tsx
/**
 * Clean-slate reset: clears router state, sessions, and on-disk agent session/memory files.
 * Use when you want no pending retries, no stuck message cursor, and fresh conversations.
 *
 * Does NOT remove: WhatsApp auth, registered groups, chat/message history, or scheduled tasks.
 *
 * Stop the host before running, then restart after: npm run build && npm start
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR, GROUPS_DIR } from '../src/config.js';
import {
  initDatabase,
  resetRouterAndSessionState,
} from '../src/db.js';

function main(): void {
  console.log('Resetting state for a clean slate...\n');

  initDatabase();
  resetRouterAndSessionState();
  console.log('  ✓ Cleared router_state and sessions in DB');

  const sessionsDir = path.join(DATA_DIR, 'sessions');
  if (fs.existsSync(sessionsDir)) {
    for (const groupFolder of fs.readdirSync(sessionsDir)) {
      const stingySessions = path.join(
        sessionsDir,
        groupFolder,
        '.stingyclaw',
        'sessions',
      );
      if (fs.existsSync(stingySessions)) {
        for (const file of fs.readdirSync(stingySessions)) {
          if (file.endsWith('.json')) {
            fs.unlinkSync(path.join(stingySessions, file));
          }
        }
        console.log(`  ✓ Cleared .stingyclaw/sessions for ${groupFolder}`);
      }
    }
  }

  if (fs.existsSync(GROUPS_DIR)) {
    for (const name of fs.readdirSync(GROUPS_DIR)) {
      const groupDir = path.join(GROUPS_DIR, name);
      if (!fs.statSync(groupDir).isDirectory()) continue;
      const memoryPath = path.join(groupDir, '.agent-memory.json');
      const planPath = path.join(groupDir, '.agent-current-plan.json');
      if (fs.existsSync(memoryPath)) {
        fs.unlinkSync(memoryPath);
        console.log(`  ✓ Removed ${name}/.agent-memory.json`);
      }
      if (fs.existsSync(planPath)) {
        fs.unlinkSync(planPath);
        console.log(`  ✓ Removed ${name}/.agent-current-plan.json`);
      }
    }
  }

  console.log('\nDone. Restart the host: npm run build && npm start');
}

main();
