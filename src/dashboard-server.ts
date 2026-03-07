import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import http from 'http';
import os from 'os';

import { GROUPS_DIR, DATA_DIR } from './config.js';
import { logger } from './logger.js';

interface DashboardData {
  botName: string;
  botEmoji: string;
  lastRefresh: string;
  // system
  system: {
    uptime: number;
    cpu: { load: number; cores: number };
    memory: { totalGB: number; usedGB: number; freeGB: number };
    docker: { reachable: boolean; error?: string };
    voice: { reachable: boolean; error?: string };
  };
  // groups
  groups: Array<{
    folder: string;
    name?: string;
    lastMessage?: string;
    containerExitCode?: number;
    recentError?: string;
  }>;
  // sessions (active, last 24h)
  sessions: Array<{
    id: string;
    agent: string;
    model?: string;
    contextPct?: number;
    lastActivity?: string;
    type: string;
    active: boolean;
  }>;
  // tasks/scheduled
  tasks: Array<{
    id: string;
    name: string;
    schedule: string;
    lastRun?: string;
    status: string;
  }>;
  // recent container logs (per group, last lines)
  recentLogs: Record<string, string>;
  // tool registry
  toolRegistry: { tools: Array<{ name: string; description: string }>; count: number };
  // git
  git: { commit?: string; message?: string; ago?: string };
}

function getSystemHealth() {
  const uptime = os.uptime();
  const cpus = os.cpus();
  const totalMem = os.totalmem() / (1024 ** 3);
  const freeMem = os.freemem() / (1024 ** 3);
  const usedMem = totalMem - freeMem;
  const load1m = os.loadavg()[0];
  return {
    uptime,
    cpu: { load: load1m, cores: cpus.length },
    memory: { totalGB: parseFloat(totalMem.toFixed(1)), usedGB: parseFloat(usedMem.toFixed(1)), freeGB: parseFloat(freeMem.toFixed(1)) },
  };
}

function checkDocker(): boolean {
  try {
    const res = spawnSync('docker', ['info'], { stdio: 'pipe', timeout: 3000 });
    return res.status === 0;
  } catch {
    return false;
  }
}

function checkVoice(voiceUrl: string = 'http://localhost:8001'): { reachable: boolean; error?: string } {
  try {
    const res = spawnSync('curl', ['-s', '-f', `${voiceUrl}/health`], { stdio: 'pipe', timeout: 2000 });
    if (res.status === 0) return { reachable: true };
    return { reachable: false, error: `HTTP ${res.status}` };
  } catch (e: any) {
    return { reachable: false, error: e.message };
  }
}

function listGroups(): DashboardData['groups'] {
  const groups: DashboardData['groups'] = [];
  try {
    if (fs.existsSync(GROUPS_DIR)) {
      for (const folder of fs.readdirSync(GROUPS_DIR)) {
        const groupDir = path.join(GROUPS_DIR, folder);
        if (!fs.statSync(groupDir).isDirectory()) continue;
        // last message from DB? try reading store/messages.db to get last timestamp by chat_jid? Too heavy.
        // Instead we can look at recent container logs for activity.
        const logsDir = path.join(groupDir, 'logs');
        let lastContainerExit: number | undefined;
        let recentError: string | undefined;
        if (fs.existsSync(logsDir)) {
          const logs = fs.readdirSync(logsDir).filter(f => f.startsWith('container-') && f.endsWith('.log'));
          if (logs.length) {
            logs.sort().reverse();
            const latest = path.join(logsDir, logs[0]);
            try {
              const content = fs.readFileSync(latest, 'utf-8');
              const m = content.match(/Exit Code:\s*(\d+)/);
              if (m) lastContainerExit = parseInt(m[1], 10);
              // also capture last error line if any
              const errMatch = content.match(/=== Stderr ===\n([\s\S]*?)(?=\n===|\n$)/);
              if (errMatch) {
                const stderr = errMatch[1].trim();
                if (stderr) recentError = stderr.slice(-200);
              }
            } catch {}
          }
        }
        groups.push({ folder, lastMessage: undefined, containerExitCode: lastContainerExit, recentError });
      }
    }
  } catch {}
  return groups;
}

function listSessions(): DashboardData['sessions'] {
  const sessions: DashboardData['sessions'] = [];
  try {
    const sessionsBase = path.join(DATA_DIR, 'sessions');
    if (fs.existsSync(sessionsBase)) {
      // each group folder has .stingyclaw/sessions/*.json
      for (const groupFolder of fs.readdirSync(sessionsBase)) {
        const groupSessionsDir = path.join(sessionsBase, groupFolder, '.stingyclaw', 'sessions');
        if (!fs.existsSync(groupSessionsDir)) continue;
        for (const file of fs.readdirSync(groupSessionsDir)) {
          if (!file.endsWith('.json')) continue;
          const full = path.join(groupSessionsDir, file);
          try {
            const s = JSON.parse(fs.readFileSync(full, 'utf-8'));
            const updated = new Date(s.updatedAt || 0);
            const ageMin = (Date.now() - updated.getTime()) / 60000;
            if (ageMin > 1440) continue; // older than 24h skip
            // derive agent from session key pattern if available; else guess from group
            const agent = s.id.includes('main:') ? 'main' : groupFolder;
            const totalTokens = s.messages?.reduce((sum: number, m: any) => sum + (m.usage?.totalTokens || 0), 0) || 0;
            const contextTokens = s.contextTokens || totalTokens;
            const contextPct = contextTokens > 0 ? Math.round((totalTokens / contextTokens) * 100) : 0;
            sessions.push({
              id: s.id,
              agent,
              model: s.model, // not always present; best effort
              contextPct,
              lastActivity: updated.toISOString(),
              type: groupFolder === 'main' ? 'main' : 'group',
              active: ageMin < 30,
            });
          } catch {}
        }
      }
    }
  } catch {}
  sessions.sort((a, b) => (b.lastActivity ? new Date(b.lastActivity).getTime() : 0) - (a.lastActivity ? new Date(a.lastActivity).getTime() : 0));
  return sessions.slice(0, 20);
}

function listTasks(): DashboardData['tasks'] {
  // There's no simple tasks file like cron jobs. GroupQueue holds pending tasks internally but not persisted.
  // We'll return empty for now.
  return [];
}

function getRecentContainerLogs(): Record<string, string> {
  const logs: Record<string, string> = {};
  try {
    for (const group of ['main', ...fs.readdirSync(GROUPS_DIR).filter(f => f !== 'main')]) {
      const logsDir = path.join(GROUPS_DIR, group, 'logs');
      if (!fs.existsSync(logsDir)) continue;
      const logsEntries = fs.readdirSync(logsDir).filter(f => f.startsWith('container-') && f.endsWith('.log'));
      if (!logsEntries.length) continue;
      logsEntries.sort().reverse();
      const latest = path.join(logsDir, logsEntries[0]);
      try {
        const content = fs.readFileSync(latest, 'utf-8');
        // tail ~20 lines
        const lines = content.split('\n').slice(-20).join('\n');
        logs[group] = lines;
      } catch {}
    }
  } catch {}
  return logs;
}

function loadToolRegistry(): { tools: Array<{ name: string; description: string }>; count: number } {
  try {
    const registryPath = path.join(process.cwd(), 'container', 'agent-runner', 'tool-registry.json');
    if (fs.existsSync(registryPath)) {
      const reg = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
      const tools = (reg.tools || []).map((t: any) => ({ name: t.name, description: t.description }));
      return { tools, count: tools.length };
    }
  } catch {}
  return { tools: [], count: 0 };
}

function getGitInfo(): { commit?: string; message?: string; ago?: string } {
  try {
    const res = spawnSync('git', ['log', '-1', '--oneline', '--format=%h|%s|%ar'], { stdio: 'pipe', cwd: process.cwd() });
    if (res.status === 0 && res.stdout) {
      const [commit, message, ago] = res.stdout.toString().trim().split('|');
      return { commit, message, ago };
    }
  } catch {}
  return {};
}

function buildData(): DashboardData {
  const system = getSystemHealth();
  const docker = checkDocker();
  const voice = checkVoice();
  const groups = listGroups();
  const sessions = listSessions();
  const tasks = listTasks();
  const recentLogs = getRecentContainerLogs();
  const toolRegistry = loadToolRegistry();
  const git = getGitInfo();

  return {
    botName: 'Stingyclaw',
    botEmoji: '🦀',
    lastRefresh: new Date().toISOString(),
    system: { ...system, docker: { reachable: docker }, voice },
    groups,
    sessions,
    tasks,
    recentLogs,
    toolRegistry,
    git,
  };
}

function jsonResponse(res: http.ServerResponse, data: any) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data, null, 2));
}

function notFound(res: http.ServerResponse) {
  res.writeHead(404);
  res.end('Not found');
}

export function startDashboardServer(port: number) {
  const server = http.createServer((req, res) => {
    if (req.url === '/api/data') {
      try {
        const data = buildData();
        jsonResponse(res, data);
      } catch (e: any) {
        logger.error({ err: e }, 'Dashboard data build failed');
        res.writeHead(500);
        res.end(JSON.stringify({ error: e.message }));
      }
    } else if (req.url === '/' || req.url === '/index.html') {
      // serve embedded dashboard.html
      const htmlPath = path.join(process.cwd(), 'public', 'dashboard.html');
      if (fs.existsSync(htmlPath)) {
        const html = fs.readFileSync(htmlPath, 'utf-8');
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(html);
      } else {
        notFound(res);
      }
    } else {
      notFound(res);
    }
  });

  server.listen(port, '127.0.0.1', () => {
    logger.info({ port }, 'Dashboard server listening');
  });

  return server;
}
