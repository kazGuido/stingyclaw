import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import { synthesizeSpeech } from './transcription.js';

import {
  ASSISTANT_NAME,
  DATA_DIR,
  IPC_POLL_INTERVAL,
  MAIN_GROUP_FOLDER,
  TIMEZONE,
} from './config.js';
import { AvailableGroup } from './container-runner.js';
import {
  addKBEntry,
  addGroupTask,
  createTask,
  deleteGroupTask,
  deleteTask,
  getKBEntriesByGroup,
  getRecentMessages,
  getTaskById,
  getGroupTasksByGroup,
  getGroupTasksByStatus,
  getGroupTasksByType,
  GroupTask,
  searchKBEntries,
  updateKBEntry,
  updateGroupTask,
  updateTask,
} from './db.js';
import { isValidGroupFolder, resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';
import { NewMessage, RegisteredGroup } from './types.js';

export interface IpcDeps {
  sendMessage: (
    jid: string,
    text: string,
    options?: { idempotencyKey?: string },
  ) => Promise<void>;
  sendVoice: (
    jid: string,
    audioBuffer: Buffer,
    options?: { idempotencyKey?: string },
  ) => Promise<void>;
  sendImage: (
    jid: string,
    imageBuffer: Buffer,
    caption?: string,
    options?: { idempotencyKey?: string },
  ) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  clearSession: (groupFolder: string) => void;
  syncGroupMetadata: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
    registeredJids: Set<string>,
  ) => void;
}

export interface FlushSummary {
  totalSent: number;
  sentByChat: Record<string, number>;
}

let ipcWatcherRunning = false;
let ipcDeps: IpcDeps | null = null;
let ipcBaseDir: string = '';

function ipcIdempotencyKey(
  sourceGroup: string,
  file: string,
  kind: 'message' | 'voice' | 'image',
): string {
  return `ipc:${sourceGroup}:${kind}:${file}`;
}

/** While set, limits outbound IPC images to this chat for one agent run (flush + watcher). */
const activeIpcImageQuotaByChat = new Map<string, { max: number; sent: number }>();

function parseMaxIpcImagesPerAgentRun(): number {
  const raw = parseInt(process.env.IPC_MAX_IMAGES_PER_CHAT_PER_AGENT_RUN || '1', 10);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return raw;
}

/** Call when starting processGroupMessages for a chat; pairs with {@link endIpcImageQuotaForChat}. */
export function beginIpcImageQuotaForChat(chatJid: string): void {
  const max = parseMaxIpcImagesPerAgentRun();
  if (max <= 0) return;
  activeIpcImageQuotaByChat.set(chatJid, { max, sent: 0 });
}

export function endIpcImageQuotaForChat(chatJid: string): void {
  activeIpcImageQuotaByChat.delete(chatJid);
}

/** @internal */
export function _resetIpcImageQuotaForTests(): void {
  activeIpcImageQuotaByChat.clear();
}

function ipcImageQuotaAllowsSend(chatJid: string): boolean {
  const q = activeIpcImageQuotaByChat.get(chatJid);
  if (!q) return true;
  return q.sent < q.max;
}

function ipcImageQuotaRecordSent(chatJid: string): void {
  const q = activeIpcImageQuotaByChat.get(chatJid);
  if (q) q.sent++;
}

const IPC_PROCESSING_SUBDIR = '.processing';

/**
 * Atomically move a pending JSON into `.processing/` so only one consumer (flush or watcher) delivers it.
 */
function tryClaimIpcMessageFile(messagesDir: string, file: string): string | null {
  if (!file.endsWith('.json')) return null;
  const src = path.join(messagesDir, file);
  const destDir = path.join(messagesDir, IPC_PROCESSING_SUBDIR);
  try {
    fs.mkdirSync(destDir, { recursive: true });
    const dest = path.join(destDir, file);
    fs.renameSync(src, dest);
    return dest;
  } catch {
    return null;
  }
}

async function deliverIpcJsonPayload(
  data: Record<string, unknown>,
  file: string,
  sourceGroup: string,
  deps: IpcDeps,
  isMain: boolean,
  registeredGroups: Record<string, RegisteredGroup>,
  logSuffix: 'flush' | 'watcher',
  summary: FlushSummary | null,
): Promise<void> {
  const chatJid = typeof data.chatJid === 'string' ? data.chatJid : undefined;

  if (data.type === 'voice_message' && chatJid && data.text) {
    const targetGroup = registeredGroups[chatJid];
    if (isMain || (targetGroup && targetGroup.folder === sourceGroup)) {
      const audio = await synthesizeSpeech(data.text as string, data.voice as string | undefined);
      if (audio) {
        await deps.sendVoice(chatJid, audio, {
          idempotencyKey: ipcIdempotencyKey(sourceGroup, file, 'voice'),
        });
        if (summary) {
          summary.totalSent++;
          summary.sentByChat[chatJid] = (summary.sentByChat[chatJid] || 0) + 1;
        }
        logger.info({ chatJid, sourceGroup }, `IPC voice message sent${logSuffix === 'flush' ? ' (flush)' : ''}`);
      } else {
        await deps.sendMessage(
          chatJid,
          `⚠️ Voice note could not be generated (TTS failed or service unavailable). Sending as text instead:\n\n${data.text as string}`,
          { idempotencyKey: ipcIdempotencyKey(sourceGroup, file, 'message') },
        );
        if (summary) {
          summary.totalSent++;
          summary.sentByChat[chatJid] = (summary.sentByChat[chatJid] || 0) + 1;
        }
        logger.warn({ chatJid }, 'TTS failed, sent as text');
      }
    }
    return;
  }

  if (data.type === 'image_message' && chatJid && data.relativePath) {
    if (!ipcImageQuotaAllowsSend(chatJid)) {
      logger.info(
        { chatJid, sourceGroup, file },
        'IPC image JSON dropped (per-agent-run image quota); agent emitted extra screenshots',
      );
      return;
    }
    const targetGroup = registeredGroups[chatJid];
    if (isMain || (targetGroup && targetGroup.folder === sourceGroup)) {
      const groupDir = resolveGroupFolderPath(sourceGroup);
      const imagePath = path.join(groupDir, data.relativePath as string);
      const rel = path.relative(groupDir, path.resolve(groupDir, data.relativePath as string));
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        logger.warn({ sourceGroup, relativePath: data.relativePath }, 'IPC image path escapes group folder, blocked');
        return;
      }
      if (!fs.existsSync(imagePath)) {
        logger.warn({ imagePath, sourceGroup }, 'IPC image file not found');
        return;
      }
      const imageBuffer = fs.readFileSync(imagePath);
      if (deps.sendImage) {
        await deps.sendImage(chatJid, imageBuffer, data.caption as string | undefined, {
          idempotencyKey: ipcIdempotencyKey(sourceGroup, file, 'image'),
        });
        ipcImageQuotaRecordSent(chatJid);
        if (summary) {
          summary.totalSent++;
          summary.sentByChat[chatJid] = (summary.sentByChat[chatJid] || 0) + 1;
        }
        logger.info({ chatJid, sourceGroup }, `IPC image sent${logSuffix === 'flush' ? ' (flush)' : ''}`);
      } else {
        logger.warn({ chatJid }, 'Channel does not support sendImage');
      }
    } else {
      logger.warn({ chatJid, sourceGroup }, 'Unauthorized IPC image_message blocked');
    }
    return;
  }

  if (data.type === 'message' && chatJid && data.text) {
    const targetGroup = registeredGroups[chatJid];
    if (isMain || (targetGroup && targetGroup.folder === sourceGroup)) {
      await deps.sendMessage(chatJid, data.text as string, {
        idempotencyKey: ipcIdempotencyKey(sourceGroup, file, 'message'),
      });
      if (summary) {
        summary.totalSent++;
        summary.sentByChat[chatJid] = (summary.sentByChat[chatJid] || 0) + 1;
      }
      logger.info({ chatJid, sourceGroup }, `IPC message sent${logSuffix === 'flush' ? ' (flush)' : ''}`);
    } else {
      logger.warn({ chatJid, sourceGroup }, 'Unauthorized IPC message attempt blocked');
    }
  }
}

/**
 * Process pending IPC messages (voice, text, image) for a group immediately.
 * Call this before sending the final result so voice is delivered before any follow-up text.
 */
export async function flushMessagesForGroup(sourceGroup: string): Promise<FlushSummary> {
  const deps = ipcDeps;
  const summary: FlushSummary = { totalSent: 0, sentByChat: {} };
  if (!deps || !ipcBaseDir) return summary;

  const isMain = sourceGroup === MAIN_GROUP_FOLDER;
  const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
  const registeredGroups = deps.registeredGroups();

  if (!fs.existsSync(messagesDir)) return summary;

  const messageFiles = fs
    .readdirSync(messagesDir)
    .filter((f) => f.endsWith('.json'))
    .sort();

  const typeOrder = (t: string) => (t === 'voice_message' ? 0 : t === 'image_message' ? 1 : 2);
  const entries: { file: string; data: Record<string, unknown> }[] = [];
  for (const file of messageFiles) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(messagesDir, file), 'utf-8')) as Record<string, unknown>;
      entries.push({ file, data });
    } catch {
      /* skip corrupt file */
    }
  }
  entries.sort((a, b) => typeOrder((a.data.type as string) ?? '') - typeOrder((b.data.type as string) ?? ''));

  for (const { file } of entries) {
    const claimedPath = tryClaimIpcMessageFile(messagesDir, file);
    if (!claimedPath) continue;
    try {
      const data = JSON.parse(fs.readFileSync(claimedPath, 'utf-8')) as Record<string, unknown>;
      await deliverIpcJsonPayload(data, file, sourceGroup, deps, isMain, registeredGroups, 'flush', summary);
    } catch (err) {
      logger.error({ file, sourceGroup, err }, 'Error processing IPC message (flush)');
      const errorDir = path.join(ipcBaseDir, 'errors');
      fs.mkdirSync(errorDir, { recursive: true });
      try {
        fs.renameSync(claimedPath, path.join(errorDir, `${sourceGroup}-${file}`));
      } catch {
        /* ignore */
      }
      continue;
    }
    try {
      fs.unlinkSync(claimedPath);
    } catch {
      /* ignore */
    }
  }
  return summary;
}

export function startIpcWatcher(deps: IpcDeps): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;
  ipcDeps = deps;
  ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  const processIpcFiles = async () => {
    // Scan all group IPC directories (identity determined by directory)
    let groupFolders: string[];
    try {
      groupFolders = fs.readdirSync(ipcBaseDir).filter((f) => {
        const stat = fs.statSync(path.join(ipcBaseDir, f));
        return stat.isDirectory() && f !== 'errors';
      });
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
      return;
    }

    const registeredGroups = deps.registeredGroups();

    for (const sourceGroup of groupFolders) {
      const isMain = sourceGroup === MAIN_GROUP_FOLDER;
      const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
      const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');

      // Process messages from this group's IPC directory
      try {
        if (fs.existsSync(messagesDir)) {
          const messageFiles = fs.readdirSync(messagesDir).filter((f) => f.endsWith('.json'));
          const typeOrder = (t: string) => (t === 'voice_message' ? 0 : t === 'image_message' ? 1 : 2);
          const entries: { file: string; data: Record<string, unknown> }[] = [];
          for (const file of messageFiles) {
            try {
              const data = JSON.parse(fs.readFileSync(path.join(messagesDir, file), 'utf-8')) as Record<string, unknown>;
              entries.push({ file, data });
            } catch {
              /* skip */
            }
          }
          entries.sort((a, b) => typeOrder((a.data.type as string) ?? '') - typeOrder((b.data.type as string) ?? ''));

          for (const { file } of entries) {
            const claimedPath = tryClaimIpcMessageFile(messagesDir, file);
            if (!claimedPath) continue;
            try {
              const data = JSON.parse(fs.readFileSync(claimedPath, 'utf-8')) as Record<string, unknown>;
              await deliverIpcJsonPayload(data, file, sourceGroup, deps, isMain, registeredGroups, 'watcher', null);
            } catch (err) {
              logger.error({ file, sourceGroup, err }, 'Error processing IPC message');
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              try {
                fs.renameSync(claimedPath, path.join(errorDir, `${sourceGroup}-${file}`));
              } catch {
                /* ignore */
              }
              continue;
            }
            try {
              fs.unlinkSync(claimedPath);
            } catch {
              /* ignore */
            }
          }
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading IPC messages directory',
        );
      }

      // Process tasks from this group's IPC directory
      try {
        if (fs.existsSync(tasksDir)) {
          const taskFiles = fs
            .readdirSync(tasksDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of taskFiles) {
            const filePath = path.join(tasksDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              // Pass source group identity to processTaskIpc for authorization
              await processTaskIpc(data, sourceGroup, isMain, deps);
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC task',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC tasks directory');
      }
    }

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info('IPC watcher started (per-group namespaces)');
}

export async function processTaskIpc(
  data: {
    type: string;
    taskId?: string | number;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    groupFolder?: string;
    chatJid?: string;
    targetJid?: string;
    // For register_group
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    requiresTrigger?: boolean;
    containerConfig?: RegisteredGroup['containerConfig'];
    // For read_messages
    requestId?: string;
    limit?: number;
    // For kb_add / kb_search
    title?: string;
    content?: string;
    tags?: string;
    query?: string;
    // For add_task / update_task / delete_task
    description?: string;
    dueDate?: string;
    taskType?: string;
    priority?: number;
    status?: string;
    updates?: Record<string, string | number>;
    // Common fields
    timestamp?: string;
  },
  sourceGroup: string, // Verified identity from IPC directory
  isMain: boolean, // Verified from directory path
  deps: IpcDeps,
): Promise<void> {
  const registeredGroups = deps.registeredGroups();
  const responsesDir = path.join(ipcBaseDir, sourceGroup, 'responses');
  fs.mkdirSync(responsesDir, { recursive: true });

  const writeResponse = (filename: string, payload: unknown): void => {
    fs.writeFileSync(path.join(responsesDir, filename), JSON.stringify(payload), 'utf-8');
  };
  const writeErrorResponse = (filenamePrefix: string, requestId: string | undefined, message: string): void => {
    if (!requestId) return;
    writeResponse(`${filenamePrefix}_${requestId}.json`, { error: message });
  };

  switch (data.type) {
    case 'schedule_task':
      if (
        data.prompt &&
        data.schedule_type &&
        data.schedule_value &&
        data.targetJid
      ) {
        // Resolve the target group from JID
        const targetJid = data.targetJid as string;
        const targetGroupEntry = registeredGroups[targetJid];

        if (!targetGroupEntry) {
          logger.warn(
            { targetJid },
            'Cannot schedule task: target group not registered',
          );
          break;
        }

        const targetFolder = targetGroupEntry.folder;

        // Authorization: non-main groups can only schedule for themselves
        if (!isMain && targetFolder !== sourceGroup) {
          logger.warn(
            { sourceGroup, targetFolder },
            'Unauthorized schedule_task attempt blocked',
          );
          break;
        }

        const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';

        let nextRun: string | null = null;
        if (scheduleType === 'cron') {
          try {
            const interval = CronExpressionParser.parse(data.schedule_value, {
              tz: TIMEZONE,
            });
            nextRun = interval.next().toISOString();
          } catch {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid cron expression',
            );
            break;
          }
        } else if (scheduleType === 'interval') {
          const ms = parseInt(data.schedule_value, 10);
          if (isNaN(ms) || ms <= 0) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid interval',
            );
            break;
          }
          nextRun = new Date(Date.now() + ms).toISOString();
        } else if (scheduleType === 'once') {
          const scheduled = new Date(data.schedule_value);
          if (isNaN(scheduled.getTime())) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid timestamp',
            );
            break;
          }
          nextRun = scheduled.toISOString();
        }

        const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const contextMode =
          data.context_mode === 'group' || data.context_mode === 'isolated'
            ? data.context_mode
            : 'isolated';
        createTask({
          id: taskId,
          group_folder: targetFolder,
          chat_jid: targetJid,
          prompt: data.prompt,
          schedule_type: scheduleType,
          schedule_value: data.schedule_value,
          context_mode: contextMode,
          next_run: nextRun,
          status: 'active',
          created_at: new Date().toISOString(),
        });
        logger.info(
          { taskId, sourceGroup, targetFolder, contextMode },
          'Task created via IPC',
        );
      }
      break;

    case 'pause_task':
      if (data.taskId && typeof data.taskId === 'string') {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'paused' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task paused via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task pause attempt',
          );
        }
      }
      break;

    case 'resume_task':
      if (data.taskId && typeof data.taskId === 'string') {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'active' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task resumed via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task resume attempt',
          );
        }
      }
      break;

    case 'cancel_task':
      if (data.taskId && typeof data.taskId === 'string') {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          deleteTask(data.taskId);
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task cancelled via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task cancel attempt',
          );
        }
      }
      break;

    case 'refresh_groups':
      // Only main group can request a refresh
      if (isMain) {
        logger.info(
          { sourceGroup },
          'Group metadata refresh requested via IPC',
        );
        await deps.syncGroupMetadata(true);
        // Write updated snapshot immediately
        const availableGroups = deps.getAvailableGroups();
        deps.writeGroupsSnapshot(
          sourceGroup,
          true,
          availableGroups,
          new Set(Object.keys(registeredGroups)),
        );
      } else {
        logger.warn(
          { sourceGroup },
          'Unauthorized refresh_groups attempt blocked',
        );
      }
      break;

    case 'clear_session':
      deps.clearSession(sourceGroup);
      logger.info({ sourceGroup }, 'Session cleared via IPC');
      break;

    case 'read_messages':
      if (!data.requestId || !data.chatJid) {
        logger.warn({ data }, 'Invalid read_messages request');
        break;
      }
      {
        const targetJid = data.chatJid as string;
        const targetGroup = registeredGroups[targetJid];
        const canRead = isMain || (targetGroup && targetGroup.folder === sourceGroup);
        if (!canRead) {
          logger.warn(
            { sourceGroup, targetJid },
            'Unauthorized read_messages attempt blocked',
          );
          writeErrorResponse('read_messages', data.requestId, 'You do not have permission to read that chat.');
          break;
        }
        const limit = Math.min(Math.max(1, (data.limit as number) || 50), 200);
        const messages = getRecentMessages(
          targetJid,
          limit,
          ASSISTANT_NAME,
        );
        writeResponse(
          `read_messages_${data.requestId}.json`,
          {
            messages: messages.map((m: NewMessage) => ({
              sender: m.sender_name,
              content: m.content,
              timestamp: m.timestamp,
            })),
          },
        );
        logger.debug(
          { sourceGroup, targetJid, count: messages.length },
          'read_messages response written',
        );
      }
      break;

    case 'kb_add': {
      if (!data.groupFolder || !data.title || !data.content || !data.requestId) {
        logger.warn({ data }, 'Invalid kb_add request');
        writeErrorResponse('kb_add', data.requestId, 'Invalid kb_add request.');
        break;
      }
      if (!isMain && data.groupFolder !== sourceGroup) {
        logger.warn({ sourceGroup, groupFolder: data.groupFolder }, 'Unauthorized kb_add attempt blocked');
        writeErrorResponse('kb_add', data.requestId, 'You do not have permission to add KB entries for this group.');
        break;
      }
      const id = addKBEntry(data.groupFolder, data.title, data.content, data.tags as string | undefined);
      writeResponse(`kb_add_${data.requestId}.json`, { id });
      logger.info({ sourceGroup, id }, 'KB entry created via IPC');
      break;
    }

    case 'kb_search': {
      if (!data.groupFolder || !data.query || !data.requestId) {
        logger.warn({ data }, 'Invalid kb_search request');
        writeErrorResponse('kb_search', data.requestId, 'Invalid kb_search request.');
        break;
      }
      if (!isMain && data.groupFolder !== sourceGroup) {
        logger.warn({ sourceGroup, groupFolder: data.groupFolder }, 'Unauthorized kb_search attempt blocked');
        writeErrorResponse('kb_search', data.requestId, 'You do not have permission to search KB entries for this group.');
        break;
      }
      const results = searchKBEntries(data.groupFolder, data.query).map((e) => ({
        id: e.id,
        title: e.title,
        snippet: e.content.substring(0, 150) + (e.content.length > 150 ? '...' : ''),
      }));
      writeResponse(`kb_search_${data.requestId}.json`, { results });
      logger.info({ sourceGroup, query: data.query, count: results.length }, 'KB search via IPC');
      break;
    }

    case 'kb_list': {
      if (!data.groupFolder || !data.requestId) {
        logger.warn({ data }, 'Invalid kb_list request');
        writeErrorResponse('kb_list', data.requestId, 'Invalid kb_list request.');
        break;
      }
      if (!isMain && data.groupFolder !== sourceGroup) {
        logger.warn({ sourceGroup, groupFolder: data.groupFolder }, 'Unauthorized kb_list attempt blocked');
        writeErrorResponse('kb_list', data.requestId, 'You do not have permission to list KB entries for this group.');
        break;
      }
      const entries = getKBEntriesByGroup(data.groupFolder).map((e) => ({
        id: e.id,
        title: e.title,
        tags: e.tags || undefined,
      }));
      writeResponse(`kb_list_${data.requestId}.json`, { entries });
      logger.info({ sourceGroup, count: entries.length }, 'KB list via IPC');
      break;
    }

    case 'add_task': {
      if (!data.groupFolder || !data.title || !data.requestId) {
        logger.warn({ data }, 'Invalid add_task request');
        writeErrorResponse('add_task', data.requestId, 'Invalid add_task request.');
        break;
      }
      if (!isMain && data.groupFolder !== sourceGroup) {
        logger.warn({ sourceGroup, groupFolder: data.groupFolder }, 'Unauthorized add_task attempt blocked');
        writeErrorResponse('add_task', data.requestId, 'You do not have permission to add tasks for this group.');
        break;
      }
      const id = addGroupTask(
        data.groupFolder,
        data.title,
        data.description as string | undefined,
        (data.status as string | undefined) ?? 'pending',
        data.dueDate as string | undefined,
        (data.taskType as string | undefined) ?? 'todo',
        (data.priority as number | undefined) ?? 0,
      );
      writeResponse(`add_task_${data.requestId}.json`, { id });
      logger.info({ sourceGroup, id }, 'Task created via IPC');
      break;
    }

    case 'list_tasks': {
      if (!data.groupFolder || !data.requestId) {
        logger.warn({ data }, 'Invalid list_tasks request');
        writeErrorResponse('list_tasks', data.requestId, 'Invalid list_tasks request.');
        break;
      }
      if (!isMain && data.groupFolder !== sourceGroup) {
        logger.warn({ sourceGroup, groupFolder: data.groupFolder }, 'Unauthorized list_tasks attempt blocked');
        writeErrorResponse('list_tasks', data.requestId, 'You do not have permission to list tasks for this group.');
        break;
      }
      let tasks: GroupTask[] = [];
      if (data.status) {
        tasks = getGroupTasksByStatus(data.groupFolder, data.status as string);
      } else if (data.taskType) {
        tasks = getGroupTasksByType(data.groupFolder, data.taskType as string);
      } else {
        tasks = getGroupTasksByGroup(data.groupFolder);
      }
      writeResponse(`list_tasks_${data.requestId}.json`, { tasks });
      logger.info({ sourceGroup, count: tasks.length }, 'Task list via IPC');
      break;
    }

    case 'update_task': {
      if (!data.groupFolder || data.taskId === undefined || !data.updates || !data.requestId) {
        logger.warn({ data }, 'Invalid update_task request');
        writeErrorResponse('update_task', data.requestId, 'Invalid update_task request.');
        break;
      }
      if (!isMain && data.groupFolder !== sourceGroup) {
        logger.warn({ sourceGroup, groupFolder: data.groupFolder }, 'Unauthorized update_task attempt blocked');
        writeErrorResponse('update_task', data.requestId, 'You do not have permission to update tasks for this group.');
        break;
      }
      if (typeof data.taskId !== 'number') {
        logger.warn({ sourceGroup, taskId: data.taskId }, 'Invalid task_id for update_task (expected number)');
        writeErrorResponse('update_task', data.requestId, 'Invalid task_id for update_task (expected number).');
        break;
      }
      const success = updateGroupTask(data.taskId, data.updates);
      writeResponse(`update_task_${data.requestId}.json`, { success });
      logger.info({ sourceGroup, taskId: data.taskId, success }, 'Task updated via IPC');
      break;
    }

    case 'delete_task': {
      if (!data.groupFolder || data.taskId === undefined || !data.requestId) {
        logger.warn({ data }, 'Invalid delete_task request');
        writeErrorResponse('delete_task', data.requestId, 'Invalid delete_task request.');
        break;
      }
      if (!isMain && data.groupFolder !== sourceGroup) {
        logger.warn({ sourceGroup, groupFolder: data.groupFolder }, 'Unauthorized delete_task attempt blocked');
        writeErrorResponse('delete_task', data.requestId, 'You do not have permission to delete tasks for this group.');
        break;
      }
      if (typeof data.taskId !== 'number') {
        logger.warn({ sourceGroup, taskId: data.taskId }, 'Invalid task_id for delete_task (expected number)');
        writeErrorResponse('delete_task', data.requestId, 'Invalid task_id for delete_task (expected number).');
        break;
      }
      const success = deleteGroupTask(data.taskId);
      writeResponse(`delete_task_${data.requestId}.json`, { success });
      logger.info({ sourceGroup, taskId: data.taskId, success }, 'Task deleted via IPC');
      break;
    }

    case 'register_group':
      // Only main group can register new groups
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized register_group attempt blocked',
        );
        break;
      }
      if (data.jid && data.name && data.folder && data.trigger) {
        if (!isValidGroupFolder(data.folder)) {
          logger.warn(
            { sourceGroup, folder: data.folder },
            'Invalid register_group request - unsafe folder name',
          );
          break;
        }
        deps.registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          containerConfig: data.containerConfig,
          requiresTrigger: data.requiresTrigger,
        });
      } else {
        logger.warn(
          { data },
          'Invalid register_group request - missing required fields',
        );
      }
      break;

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}
