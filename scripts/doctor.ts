#!/usr/bin/env npx tsx
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const projectRoot = process.cwd();
const dataDir = path.join(projectRoot, 'data');
const lockFile = path.join(dataDir, '.stingyclaw.lock');
const oldLockFile = path.join(dataDir, '.nanoclaw.lock');

function run(command: string): string {
  try {
    return execSync(command, { encoding: 'utf-8', stdio: 'pipe' }).trim();
  } catch (err: any) {
    const stderr = (err?.stderr || '').toString().trim();
    const stdout = (err?.stdout || '').toString().trim();
    return stderr || stdout || 'unavailable';
  }
}

function printCheck(name: string, value: string): void {
  console.log(`${name}: ${value}`);
}

console.log('=== STINGYCLAW DOCTOR ===');
printCheck('project_root', projectRoot);
printCheck('service_stingyclaw', run('systemctl --user is-active stingyclaw'));
printCheck('service_nanoclaw_legacy', run('systemctl --user is-active nanoclaw'));
printCheck('service_unit_enabled', run('systemctl --user is-enabled stingyclaw'));
printCheck('dev_processes', run('pgrep -af "tsx src/index.ts" || true') || 'none');
printCheck('runtime_process', run(`pgrep -af "node ${projectRoot}/dist/index.js" || true`) || 'none');
printCheck('voice_container', run("docker ps --format '{{.Names}} {{.Status}}' | awk '$1==\"stingyclaw-voice\"' || true") || 'not running');
printCheck('voice_health', run("curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8001/health || true"));

if (fs.existsSync(lockFile)) {
  printCheck('lock_file', `${lockFile} -> ${fs.readFileSync(lockFile, 'utf-8').trim()}`);
} else if (fs.existsSync(oldLockFile)) {
  printCheck('lock_file_legacy', `${oldLockFile} -> ${fs.readFileSync(oldLockFile, 'utf-8').trim()}`);
} else {
  printCheck('lock_file', 'none');
}

printCheck(
  'logs',
  run(`stat -c '%y %n' "${path.join(projectRoot, 'logs', 'stingyclaw.log')}" "${path.join(projectRoot, 'logs', 'stingyclaw.error.log')}" 2>/dev/null || true`) || 'missing',
);

console.log('=== END ===');
