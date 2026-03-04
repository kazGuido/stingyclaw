import { execSync } from 'child_process';

function isServiceActive(name: string): boolean {
  try {
    execSync(`systemctl --user is-active ${name}`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

const activeServices = ['stingyclaw', 'nanoclaw'].filter(isServiceActive);

if (activeServices.length > 0) {
  const list = activeServices.join(', ');
  console.error(
    `Refusing to run dev mode while systemd service is active (${list}).`,
  );
  console.error('Stop the service first to avoid WhatsApp session conflicts:');
  console.error('  systemctl --user stop stingyclaw');
  console.error('  systemctl --user stop nanoclaw');
  process.exit(1);
}
