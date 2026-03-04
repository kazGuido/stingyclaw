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
import { createTask, deleteTask, getRecentMessages, getTaskById, updateTask } from './db.js';
import { isValidGroupFolder, resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';
import { NewMessage, RegisteredGroup } from './types.js';

export interface IpcDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  sendVoice: (jid: string, audioBuffer: Buffer) => Promise<void>;
  sendImage: (jid: string, imageBuffer: Buffer, caption?: string) => Promise<void>;
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

let ipcWatcherRunning = false;
let ipcDeps: IpcDeps | null = null;
let ipcBaseDir: string = '';

/**
 * Process pending IPC messages (voice, text, image) for a group immediately.
 * Call this before sending the final result so voice is delivered before any follow-up text.
 */
export async function flushMessagesForGroup(sourceGroup: string): Promise<void> {
  const deps = ipcDeps;
  if (!deps || !ipcBaseDir) return;

  const isMain = sourceGroup === MAIN_GROUP_FOLDER;
  const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
  const registeredGroups = deps.registeredGroups();

  if (!fs.existsSync(messagesDir)) return;

  const messageFiles = fs
    .readdirSync(messagesDir)
    .filter((f) => f.endsWith('.json'))
    .sort();

  // Process voice first, then image, then text — so audio/caption order is correct for the user
  const typeOrder = (t: string) => (t === 'voice_message' ? 0 : t === 'image_message' ? 1 : 2);
  const entries: { file: string; data: Record<string, unknown> }[] = [];
  for (const file of messageFiles) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(messagesDir, file), 'utf-8')) as Record<string, unknown>;
      entries.push({ file, data });
    } catch {
      /* skip corrupt file, will retry or error on next pass */
    }
  }
  entries.sort((a, b) => typeOrder((a.data.type as string) ?? '') - typeOrder((b.data.type as string) ?? ''));

  for (const { file, data } of entries) {
    const filePath = path.join(messagesDir, file);
    const chatJid = typeof data.chatJid === 'string' ? data.chatJid : undefined;
    try {
      if (data.type === 'voice_message' && chatJid && data.text) {
        const targetGroup = registeredGroups[chatJid];
        if (isMain || (targetGroup && targetGroup.folder === sourceGroup)) {
          const audio = await synthesizeSpeech(data.text as string, data.voice as string | undefined);
          if (audio) {
            await deps.sendVoice(chatJid, audio);
            logger.info({ chatJid, sourceGroup }, 'IPC voice message sent (flush)');
          } else {
            await deps.sendMessage(
              chatJid,
              `⚠️ Voice note could not be generated (TTS failed or service unavailable). Sending as text instead:\n\n${data.text as string}`,
            );
            logger.warn({ chatJid }, 'TTS failed, sent as text');
          }
        }
      } else if (data.type === 'image_message' && chatJid && data.relativePath) {
        const targetGroup = registeredGroups[chatJid];
        if (isMain || (targetGroup && targetGroup.folder === sourceGroup)) {
          const groupDir = resolveGroupFolderPath(sourceGroup);
          const imagePath = path.join(groupDir, data.relativePath as string);
          const rel = path.relative(groupDir, path.resolve(groupDir, data.relativePath as string));
          if (!rel.startsWith('..') && !path.isAbsolute(rel) && fs.existsSync(imagePath)) {
            const imageBuffer = fs.readFileSync(imagePath);
            if (deps.sendImage) {
              await deps.sendImage(chatJid, imageBuffer, data.caption as string | undefined);
              logger.info({ chatJid, sourceGroup }, 'IPC image sent (flush)');
            }
          }
        }
      } else if (data.type === 'message' && chatJid && data.text) {
        const targetGroup = registeredGroups[chatJid];
        if (isMain || (targetGroup && targetGroup.folder === sourceGroup)) {
          await deps.sendMessage(chatJid, data.text as string);
          logger.info({ chatJid, sourceGroup }, 'IPC message sent (flush)');
        }
      }
      fs.unlinkSync(filePath);
    } catch (err) {
      logger.error({ file, sourceGroup, err }, 'Error processing IPC message (flush)');
      const errorDir = path.join(ipcBaseDir, 'errors');
      fs.mkdirSync(errorDir, { recursive: true });
      try {
        fs.renameSync(filePath, path.join(errorDir, `${sourceGroup}-${file}`));
      } catch {
        /* ignore */
      }
    }
  }
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

          for (const { file, data } of entries) {
            const filePath = path.join(messagesDir, file);
            const chatJid = typeof data.chatJid === 'string' ? data.chatJid : undefined;
            try {
              if (data.type === 'voice_message' && chatJid && data.text) {
                const targetGroup = registeredGroups[chatJid];
                if (isMain || (targetGroup && targetGroup.folder === sourceGroup)) {
                  const audio = await synthesizeSpeech(data.text as string, data.voice as string | undefined);
                  if (audio) {
                    await deps.sendVoice(chatJid, audio);
                    logger.info({ chatJid, sourceGroup }, 'IPC voice message sent');
                  } else {
                    await deps.sendMessage(
                      chatJid,
                      `⚠️ Voice note could not be generated (TTS failed or service unavailable). Sending as text instead:\n\n${data.text as string}`,
                    );
                    logger.warn({ chatJid }, 'TTS failed, sent as text');
                  }
                } else {
                  logger.warn({ chatJid, sourceGroup }, 'Unauthorized IPC voice_message blocked');
                }
              } else if (data.type === 'image_message' && chatJid && data.relativePath) {
                const targetGroup = registeredGroups[chatJid];
                if (isMain || (targetGroup && targetGroup.folder === sourceGroup)) {
                  const groupDir = resolveGroupFolderPath(sourceGroup);
                  const imagePath = path.join(groupDir, data.relativePath as string);
                  const rel = path.relative(groupDir, path.resolve(groupDir, data.relativePath as string));
                  if (rel.startsWith('..') || path.isAbsolute(rel)) {
                    logger.warn({ sourceGroup, relativePath: data.relativePath }, 'IPC image path escapes group folder, blocked');
                  } else if (fs.existsSync(imagePath)) {
                    const imageBuffer = fs.readFileSync(imagePath);
                    if (deps.sendImage) {
                      await deps.sendImage(chatJid, imageBuffer, data.caption as string | undefined);
                      logger.info({ chatJid, sourceGroup }, 'IPC image sent');
                    } else {
                      logger.warn({ chatJid }, 'Channel does not support sendImage');
                    }
                  } else {
                    logger.warn({ imagePath, sourceGroup }, 'IPC image file not found');
                  }
                } else {
                  logger.warn({ chatJid, sourceGroup }, 'Unauthorized IPC image_message blocked');
                }
              } else if (data.type === 'message' && chatJid && data.text) {
                const targetGroup = registeredGroups[chatJid];
                if (isMain || (targetGroup && targetGroup.folder === sourceGroup)) {
                  await deps.sendMessage(chatJid, data.text as string);
                  logger.info({ chatJid, sourceGroup }, 'IPC message sent');
                } else {
                  logger.warn({ chatJid, sourceGroup }, 'Unauthorized IPC message attempt blocked');
                }
              }
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error({ file, sourceGroup, err }, 'Error processing IPC message');
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              try {
                fs.renameSync(filePath, path.join(errorDir, `${sourceGroup}-${file}`));
              } catch {
                /* ignore */
              }
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
    taskId?: string;
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
  },
  sourceGroup: string, // Verified identity from IPC directory
  isMain: boolean, // Verified from directory path
  deps: IpcDeps,
): Promise<void> {
  const registeredGroups = deps.registeredGroups();

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
      if (data.taskId) {
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
      if (data.taskId) {
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
      if (data.taskId) {
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
      if (data.requestId && data.chatJid) {
        const targetJid = data.chatJid as string;
        const targetGroup = registeredGroups[targetJid];
        const canRead =
          isMain ||
          (targetGroup && targetGroup.folder === sourceGroup);
        if (!canRead) {
          logger.warn(
            { sourceGroup, targetJid },
            'Unauthorized read_messages attempt blocked',
          );
          break;
        }
        const limit = Math.min(Math.max(1, (data.limit as number) || 50), 200);
        const messages = getRecentMessages(
          targetJid,
          limit,
          ASSISTANT_NAME,
        );
        const responsesDir = path.join(
          ipcBaseDir,
          sourceGroup,
          'responses',
        );
        fs.mkdirSync(responsesDir, { recursive: true });
        const responsePath = path.join(
          responsesDir,
          `read_messages_${data.requestId}.json`,
        );
        fs.writeFileSync(
          responsePath,
          JSON.stringify({
            messages: messages.map((m: NewMessage) => ({
              sender: m.sender_name,
              content: m.content,
              timestamp: m.timestamp,
            })),
          }),
          'utf-8',
        );
        logger.debug(
          { sourceGroup, targetJid, count: messages.length },
          'read_messages response written',
        );
      }
      break;

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
