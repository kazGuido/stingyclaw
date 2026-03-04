import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { logger } from './logger.js';

interface ContractState {
  version: number;
  migratedAt: string;
}

const CONFIG_CONTRACT_VERSION = 1;
const CONTRACT_STATE_PATH = path.join(DATA_DIR, 'system', 'config-contract.json');

function safeRename(oldPath: string, newPath: string): boolean {
  if (!fs.existsSync(oldPath) || fs.existsSync(newPath)) return false;
  fs.mkdirSync(path.dirname(newPath), { recursive: true });
  fs.renameSync(oldPath, newPath);
  return true;
}

function migrateLegacyPaths(projectRoot: string): string[] {
  const migrated: string[] = [];

  if (safeRename(path.join(projectRoot, '.nanoclaw'), path.join(projectRoot, '.stingyclaw'))) {
    migrated.push('.nanoclaw -> .stingyclaw');
  }

  const sessionsRoot = path.join(DATA_DIR, 'sessions');
  if (fs.existsSync(sessionsRoot)) {
    for (const folder of fs.readdirSync(sessionsRoot)) {
      const base = path.join(sessionsRoot, folder);
      if (!fs.statSync(base).isDirectory()) continue;
      if (safeRename(path.join(base, '.nanoclaw'), path.join(base, '.stingyclaw'))) {
        migrated.push(`sessions/${folder}/.nanoclaw -> .stingyclaw`);
      }
    }
  }

  if (safeRename(path.join(DATA_DIR, '.nanoclaw.lock'), path.join(DATA_DIR, '.stingyclaw.lock'))) {
    migrated.push('data/.nanoclaw.lock -> data/.stingyclaw.lock');
  }

  return migrated;
}

export function ensureConfigContract(projectRoot: string): void {
  fs.mkdirSync(path.dirname(CONTRACT_STATE_PATH), { recursive: true });

  let currentVersion = 0;
  if (fs.existsSync(CONTRACT_STATE_PATH)) {
    try {
      const state = JSON.parse(fs.readFileSync(CONTRACT_STATE_PATH, 'utf-8')) as Partial<ContractState>;
      currentVersion = typeof state.version === 'number' ? state.version : 0;
    } catch {
      currentVersion = 0;
    }
  }

  if (currentVersion >= CONFIG_CONTRACT_VERSION) return;

  const migrated = migrateLegacyPaths(projectRoot);
  const nextState: ContractState = {
    version: CONFIG_CONTRACT_VERSION,
    migratedAt: new Date().toISOString(),
  };
  fs.writeFileSync(CONTRACT_STATE_PATH, JSON.stringify(nextState, null, 2));

  logger.info(
    {
      fromVersion: currentVersion,
      toVersion: CONFIG_CONTRACT_VERSION,
      migratedPaths: migrated,
    },
    'Applied config contract migration',
  );
}
