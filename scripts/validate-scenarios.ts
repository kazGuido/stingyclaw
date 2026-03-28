#!/usr/bin/env npx tsx
/**
 * Run automated validation that does not require WhatsApp or a live API.
 */
import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function run(name: string, cmd: string, cwd: string): void {
  console.log(`\n━━━ ${name} ━━━\n$ ${cmd}\n`);
  execSync(cmd, { stdio: 'inherit', cwd });
}

function main(): void {
  console.log('Stingyclaw validate:scenarios (no WhatsApp)\n');
  console.log('Project root:', root);

  run('Host + setup tests (test:core)', 'npm run test:core', root);
  run('Agent-runner unit tests', 'npm test', path.join(root, 'container/agent-runner'));

  console.log('\n✓ validate:scenarios finished.\n');
  console.log('Optional: one-shot Docker + OpenRouter smoke → docs/AGENT-VALIDATION-SCENARIOS.md\n');
}

main();
