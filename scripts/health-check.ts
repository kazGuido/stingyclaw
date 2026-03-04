#!/usr/bin/env npx tsx
import { execSync } from 'child_process';

function ok(command: string): boolean {
  try {
    execSync(command, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

const checks = {
  service: ok('systemctl --user is-active stingyclaw'),
  voiceContainer: ok("docker ps --format '{{.Names}}' | awk '$1==\"stingyclaw-voice\"' | grep -q stingyclaw-voice"),
  voiceHealth: ok("curl -s -f http://127.0.0.1:8001/health > /dev/null"),
};

const failed = Object.entries(checks)
  .filter(([, passed]) => !passed)
  .map(([name]) => name);

if (failed.length > 0) {
  console.error(`health-check failed: ${failed.join(', ')}`);
  process.exit(1);
}

console.log('health-check ok');
