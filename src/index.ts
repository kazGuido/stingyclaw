import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';

import {
  ASSISTANT_NAME,
  buildTriggerPattern,
  DATA_DIR,
  DASHBOARD_PORT,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  MAIN_GROUP_FOLDER,
  stripLeadingForTriggerMatch,
} from './config.js';
import { WhatsAppChannel } from './channels/whatsapp.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import { cleanupOrphans, ensureContainerRuntimeRunning } from './container-runtime.js';
import {
  clearPendingConfirmation,
  clearSession as clearSessionInDb,
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getMessagesSince,
  getNewMessages,
  getPendingConfirmation,
  getRouterState,
  initDatabase,
  setMessagePipelineStateBulk,
  setPendingConfirmation,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { ensureConfigContract } from './config-contract.js';
import { GroupQueue, MAX_RETRIES } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import {
  beginIpcImageQuotaForChat,
  endIpcImageQuotaForChat,
  flushMessagesForGroup,
  startIpcWatcher,
} from './ipc.js';
import { findChannel, formatMessages, formatOutbound } from './router.js';
import { synthesizeSpeech } from './transcription.js';
import { startKbDigestLoop } from './kb-digest.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;

type MessageCursor = {
  timestamp: string;
  messageId: string;
};

function parseMessageCursor(cursor: string | null | undefined): MessageCursor {
  if (!cursor) {
    return { timestamp: '', messageId: '' };
  }

  try {
    const parsed = JSON.parse(cursor) as { timestamp?: string; messageId?: string };
    return {
      timestamp: typeof parsed.timestamp === 'string' ? parsed.timestamp : cursor,
      messageId: typeof parsed.messageId === 'string' ? parsed.messageId : '',
    };
  } catch {
    return { timestamp: cursor, messageId: '' };
  }
}

type MessageLikeForCursor = Pick<NewMessage, 'timestamp'> & { id?: string };

function makeCursorFromMessages(messages: MessageLikeForCursor[]): string {
  const lastMessage = messages[messages.length - 1];
  if (!lastMessage) {
    return '';
  }
  return JSON.stringify({
    timestamp: lastMessage.timestamp,
    messageId: lastMessage.id ?? '',
  } satisfies MessageCursor);
}

let whatsapp: WhatsAppChannel;
const channels: Channel[] = [];
const queue = new GroupQueue();

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState(
    'last_agent_timestamp',
    JSON.stringify(lastAgentTimestamp),
  );
}

function outboundKey(
  chatJid: string,
  runId: string,
  stage: string,
  payload: string,
): string {
  const hash = createHash('sha256')
    .update(`${chatJid}|${runId}|${stage}|${payload}`)
    .digest('hex')
    .slice(0, 24);
  return `out:${stage}:${hash}`;
}

const HARD_RESET_CLAW = '[HARD_RESET_CLAW]';
const CONFIRM_HARD_RESET = '[CONFIRM_HARD_RESET]';
const PENDING_HARD_RESET_JID_KEY = 'pending_hard_reset_jid';

/** Reset conversation and memory for a single group (chat-specific). No AI, no cursor change. */
function resetStateForGroup(groupFolder: string): void {
  clearSessionInDb(groupFolder);
  delete sessions[groupFolder];
  const stingySessions = path.join(DATA_DIR, 'sessions', groupFolder, '.stingyclaw', 'sessions');
  if (fs.existsSync(stingySessions)) {
    for (const file of fs.readdirSync(stingySessions)) {
      if (file.endsWith('.json')) fs.unlinkSync(path.join(stingySessions, file));
    }
  }
  const groupDir = path.join(GROUPS_DIR, groupFolder);
  for (const name of ['.agent-memory.json', '.agent-current-plan.json']) {
    const p = path.join(groupDir, name);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
}

/**
 * If the message batch contains hard-reset codewords, handle them (no AI): confirm prompt or execute reset.
 * Advances cursor and returns true so caller does not enqueue/send to agent.
 */
function handleHardResetCodewords(
  chatJid: string,
  group: RegisteredGroup,
  messages: Array<{ content: string; is_from_me?: boolean; timestamp: string }>,
  channel: Channel,
): boolean {
  const pendingJid = getRouterState(PENDING_HARD_RESET_JID_KEY) || '';
  const userMessages = messages.filter((m) => !m.is_from_me);
  const lastTs = messages[messages.length - 1]?.timestamp ?? '';

  const hasConfirm = userMessages.some((m) => m.content.includes(CONFIRM_HARD_RESET));
  const hasTrigger = userMessages.some((m) => m.content.includes(HARD_RESET_CLAW));

  if (hasConfirm && pendingJid === chatJid) {
    resetStateForGroup(group.folder);
    setRouterState(PENDING_HARD_RESET_JID_KEY, '');
    const cursor = makeCursorFromMessages(messages);
    if (cursor) lastAgentTimestamp[chatJid] = cursor;
    else lastAgentTimestamp[chatJid] = JSON.stringify({ timestamp: lastTs, messageId: '' });
    saveState();
    channel.sendMessage(
      chatJid,
      'Done. State reset for this chat.',
    ).catch((err) => logger.warn({ chatJid, err }, 'Failed to send hard-reset confirmation'));
    logger.info({ group: group.name }, 'Hard reset (codeword) completed');
    return true;
  }
  if (hasTrigger) {
    setRouterState(PENDING_HARD_RESET_JID_KEY, chatJid);
    const cursor = makeCursorFromMessages(messages);
    if (cursor) lastAgentTimestamp[chatJid] = cursor;
    else lastAgentTimestamp[chatJid] = JSON.stringify({ timestamp: lastTs, messageId: '' });
    saveState();
    channel.sendMessage(
      chatJid,
      `This will reset conversation and memory for this chat. Reply with ${CONFIRM_HARD_RESET} to confirm.`,
    ).catch((err) => logger.warn({ chatJid, err }, 'Failed to send hard-reset prompt'));
    return true;
  }
  return false;
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Handle new messages for a group (event-driven path).
 * Either pipes to active container or enqueues for processing.
 */
async function handleNewMessagesForGroup(chatJid: string): Promise<void> {
  const group = registeredGroups[chatJid];
  if (!group) return;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping');
    return;
  }

  const isMainGroup = group.folder === MAIN_GROUP_FOLDER;
  const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

  const allPending = getMessagesSince(
    chatJid,
    lastAgentTimestamp[chatJid] || '',
    ASSISTANT_NAME,
  );
  if (allPending.length === 0) return;
  setMessagePipelineStateBulk(
    chatJid,
    allPending.map((m) => m.id),
    'queued',
  );

  if (handleHardResetCodewords(chatJid, group, allPending, channel)) return;

  if (needsTrigger) {
    const triggerPattern = buildTriggerPattern(group.trigger);
    const hasTrigger = allPending.some(
      (m) =>
        triggerPattern.test(stripLeadingForTriggerMatch(m.content)) ||
        Boolean(m.mentions_bot),
    );
    if (!hasTrigger) return;
  }

  const formatted = formatMessages(allPending);

  const sent = await queue.sendMessage(chatJid, formatted);
  if (sent) {
    logger.debug({ chatJid, count: allPending.length }, 'Piped messages to active container');
    // Cursor will be advanced after container confirms successful processing
    // The container will report back and cursor advancement happens in processGroupMessages
    channel.setTyping?.(chatJid, true)?.catch((err) =>
      logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
    );
  } else {
    queue.enqueueMessageCheck(chatJid);
  }
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(groups: Record<string, RegisteredGroup>): void {
  registeredGroups = groups;
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<{ ok: boolean; error?: string; noRetry?: boolean }> {
  const group = registeredGroups[chatJid];
  if (!group) return { ok: true };

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    console.log(`Warning: no channel owns JID ${chatJid}, skipping messages`);
    return { ok: true };
  }

  const isMainGroup = group.folder === MAIN_GROUP_FOLDER;

  const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
  const missedMessages = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);

  if (missedMessages.length === 0) return { ok: true };

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const triggerPattern = buildTriggerPattern(group.trigger);
    const hasTrigger = missedMessages.some(
      (m) =>
        triggerPattern.test(stripLeadingForTriggerMatch(m.content)) ||
        Boolean(m.mentions_bot),
    );
    if (!hasTrigger) return { ok: true };
  }

  if (handleHardResetCodewords(chatJid, group, missedMessages, channel)) {
    return { ok: true };
  }

  const prompt = formatMessages(missedMessages);
  const pipelineMessageIds = missedMessages.map((m) => m.id);
  const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  setMessagePipelineStateBulk(chatJid, pipelineMessageIds, 'running', runId);

  // Enforce voice reply when user sent a voice message
  const lastUserMessageWasVoice = missedMessages.some(
    (m) => !m.is_from_me && m.content.trim().startsWith('[Voice:'),
  );

  // DO NOT advance cursor before processing - this causes message loss on crash.
  // Cursor will be advanced only after successful container completion.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  let cursorAdvanced = false;

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug({ group: group.name }, 'Idle timeout, closing container stdin');
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  await channel.setTyping?.(chatJid, true);
  let hadError = false;
  let streamedError: string | undefined;
  let streamedNoRetry = false;
  let outputSentToUser = false;
  let ipcSentToCurrentChat = false;
  let pipelineSentMarked = false;
  /** One auto-send (stdout completion) per run — streaming can emit duplicate OUTPUT markers. */
  let streamFinalTextSent = false;

  beginIpcImageQuotaForChat(chatJid);
  let output: Awaited<ReturnType<typeof runAgent>>;
  try {
    output = await runAgent(group, prompt, chatJid, async (result) => {
    // Streaming output callback — called for each agent result
    if (result.status === 'confirmation_required' && result.confirmationPreview) {
      await channel.sendMessage(chatJid, result.confirmationPreview, {
        idempotencyKey: outboundKey(
          chatJid,
          runId,
          'confirmation',
          result.confirmationPreview,
        ),
      });
      outputSentToUser = true;
      if (!pipelineSentMarked) {
        setMessagePipelineStateBulk(chatJid, pipelineMessageIds, 'sent', runId);
        pipelineSentMarked = true;
      }
      resetIdleTimer();

      // Persist confirmation state to DB for recovery across restarts
      if (result.pendingTool && result.newSessionId) {
        setPendingConfirmation(group.folder, {
          sessionId: result.newSessionId,
          toolCallId: 'pending', // Will be set by agent
          toolName: result.pendingTool.name,
          args: result.pendingTool.args,
          preview: result.confirmationPreview,
        });
      }

      // Do not notifyIdle: container is waiting for user reply
      return;
    }

    if (result.result) {
      // Flush pending IPC (voice, message, image) before sending any conclusive text.
      // Ensures audio is delivered first when agent uses send_voice + text follow-up.
      const firstFlush = await flushMessagesForGroup(group.folder);
      // Brief wait then flush again — container may write IPC slightly after stdout.
      await new Promise((r) => setTimeout(r, 400));
      const secondFlush = await flushMessagesForGroup(group.folder);
      const sentViaIpc =
        (firstFlush.sentByChat[chatJid] || 0) + (secondFlush.sentByChat[chatJid] || 0);
      if (sentViaIpc > 0) {
        ipcSentToCurrentChat = true;
        if (!pipelineSentMarked) {
          setMessagePipelineStateBulk(chatJid, pipelineMessageIds, 'sent', runId);
          pipelineSentMarked = true;
        }
      }

      const raw = typeof result.result === 'string' ? result.result : JSON.stringify(result.result);
      // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
      const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
      logger.info({ group: group.name }, `Agent output: ${raw.slice(0, 200)}`);
      if (text) {
        if (ipcSentToCurrentChat) {
          // If tool-side IPC already sent output to this chat in this run, suppress
          // auto-send to avoid duplicate user-visible replies.
          logger.info(
            { group: group.name, chatJid },
            'Suppressing auto-send because IPC already sent output for this chat',
          );
          outputSentToUser = true;
        } else if (streamFinalTextSent) {
          logger.info(
            { group: group.name, chatJid },
            'Suppressing duplicate streamed stdout completion (already sent to chat this run)',
          );
          outputSentToUser = true;
        } else {
          // Enforce voice reply when user sent voice: send text as voice note instead of plain text
          if (lastUserMessageWasVoice && channel.sendVoice) {
            const audio = await synthesizeSpeech(text);
            if (audio) {
              await channel.sendVoice(chatJid, audio, {
                idempotencyKey: outboundKey(chatJid, runId, 'voice-final', text),
              });
              outputSentToUser = true;
            } else {
              await channel.sendMessage(
                chatJid,
                `⚠️ Voice note could not be generated (TTS failed or service unavailable). Sending as text instead:\n\n${text}`,
                {
                  idempotencyKey: outboundKey(
                    chatJid,
                    runId,
                    'voice-fallback',
                    text,
                  ),
                },
              );
              outputSentToUser = true;
            }
          } else {
            await channel.sendMessage(chatJid, text, {
              idempotencyKey: outboundKey(chatJid, runId, 'text-final', text),
            });
            outputSentToUser = true;
          }
          streamFinalTextSent = true;
          if (!pipelineSentMarked) {
            setMessagePipelineStateBulk(chatJid, pipelineMessageIds, 'sent', runId);
            pipelineSentMarked = true;
          }
        }
      }
      // Only reset idle timer on actual results, not session-update markers (result: null)
      resetIdleTimer();
    }

    if (result.status === 'success') {
      queue.notifyIdle(chatJid);
    }

    if (result.status === 'error') {
      hadError = true;
      streamedError = result.error;
      logger.warn({ group: group.name, error: result.error, errorDetail: result.errorDetail }, 'Streamed agent error');
      // Provider unavailability / rate-limit errors are not worth retrying —
      // the window won't have reset. Mark noRetry so we send one clear message
      // instead of burning through all 6 retry slots and looping.
      if (
        result.error?.includes('429') ||
        result.error?.toLowerCase().includes('rate limit') ||
        result.error?.startsWith('PROVIDER_UNAVAILABLE:') ||
        result.error?.startsWith('CHAT_HISTORY_ERROR:')
      ) {
        streamedNoRetry = true;
      }
    }
  });
  } finally {
    endIpcImageQuotaForChat(chatJid);
  }

  await channel.setTyping?.(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);

  if (output.status === 'error' || hadError) {
    const effectiveError = streamedError || output.error;

    // Report exception to owner for monitoring
    reportExceptionToOwner(group.folder, effectiveError || 'Unknown error', 'processGroupMessages', channel);

    // If we already sent output to the user, don't roll back the cursor —
    // the user got their response and re-processing would send duplicates.
    if (outputSentToUser) {
      logger.warn({ group: group.name }, 'Agent error after output was sent, skipping cursor rollback to prevent duplicates');
      // Still advance cursor since user saw output
      if (!cursorAdvanced) {
        lastAgentTimestamp[chatJid] = makeCursorFromMessages(missedMessages);
        saveState();
        cursorAdvanced = true;
      }
      setMessagePipelineStateBulk(
        chatJid,
        pipelineMessageIds,
        'committed',
        runId,
        output.error,
      );
      return { ok: true };
    }

    const noRetry = output.noRetry === true || streamedNoRetry;
    if (!noRetry) {
      // Cursor was never advanced, so no rollback needed - just stay at previousCursor
      logger.warn({ group: group.name }, 'Agent error, cursor unchanged for retry');
      setMessagePipelineStateBulk(chatJid, pipelineMessageIds, 'queued', runId, effectiveError);
    } else {
      // For noRetry errors, advance cursor to prevent infinite loop
      if (!cursorAdvanced) {
        lastAgentTimestamp[chatJid] = makeCursorFromMessages(missedMessages);
        saveState();
        cursorAdvanced = true;
      }
      setMessagePipelineStateBulk(
        chatJid,
        pipelineMessageIds,
        'committed',
        runId,
        effectiveError,
      );
    }
    // Use PROVIDER_UNAVAILABLE / CHAT_HISTORY_ERROR prefix so group-queue strips to a clean user message.
    const userError = streamedNoRetry
      ? (effectiveError?.startsWith('PROVIDER_UNAVAILABLE:') ||
          effectiveError?.startsWith('CHAT_HISTORY_ERROR:'))
        ? effectiveError
        : `PROVIDER_UNAVAILABLE: The AI provider is temporarily rate-limited. Please wait a minute and try again.`
      : effectiveError;
    return { ok: false, error: userError, noRetry };
  }

  // Only advance cursor after successful processing - prevents message loss on crash
  if (!cursorAdvanced) {
    lastAgentTimestamp[chatJid] = makeCursorFromMessages(missedMessages);
    saveState();
    cursorAdvanced = true;
  }

  setMessagePipelineStateBulk(chatJid, pipelineMessageIds, 'committed', runId);
  return { ok: true };
}

/**
 * Report exception to the owner (main group) for monitoring and debugging.
 */
async function reportExceptionToOwner(
  sourceGroup: string,
  error: string,
  context: string,
  channel: any,
): Promise<void> {
  const mainJid = Object.keys(registeredGroups).find(
    (jid) => registeredGroups[jid].folder === MAIN_GROUP_FOLDER,
  );
  if (!mainJid || sourceGroup === mainJid) return;

  const message = `🚨 **Exception Report**\n\nGroup: ${sourceGroup}\nContext: ${context}\nError: ${error.slice(0, 500)}`;
  try {
    await channel.sendMessage(mainJid, message, { idempotencyKey: `exception-${Date.now()}` });
  } catch (sendErr) {
    logger.error({ err: sendErr }, 'Failed to send exception report to owner');
  }
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<{ status: 'success' | 'error'; error?: string; noRetry?: boolean }> {
  const isMain = group.folder === MAIN_GROUP_FOLDER;
  const sessionId = sessions[group.folder];

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          sessions[group.folder] = output.newSessionId;
          setSession(group.folder, output.newSessionId);
        }
        await onOutput(output);
      }
    : undefined;

  // Load any pending confirmation for this group
  const pendingConfirmation = getPendingConfirmation(group.folder);
  if (pendingConfirmation) {
    logger.info({ group: group.name, tool: pendingConfirmation.toolName }, 'Resuming with pending confirmation');
  }

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        assistantName: ASSISTANT_NAME,
        pendingConfirmation: pendingConfirmation ? {
          toolCallId: pendingConfirmation.toolCallId,
          toolName: pendingConfirmation.toolName,
          args: pendingConfirmation.args,
          preview: pendingConfirmation.preview,
        } : undefined,
      },
      (proc, containerName) => queue.registerProcess(chatJid, proc, containerName, group.folder),
      wrappedOnOutput,
    );

    // Clear pending confirmation on successful completion (not confirmation_required)
    if (output.status === 'success' && pendingConfirmation) {
      clearPendingConfirmation(group.folder);
      logger.debug({ group: group.name }, 'Cleared pending confirmation after success');
    }

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }

    if (output.status === 'error') {
      logger.error(
        { group: group.name, error: output.error, errorDetail: output.errorDetail },
        'Container agent error',
      );
      return { status: 'error', error: output.error ?? 'Agent error', noRetry: true };
    }

    return { status: 'success' };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error({ group: group.name, err }, 'Agent error');
    return { status: 'error', error };
  }
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`Stingyclaw running (trigger: @${ASSISTANT_NAME}) — event-driven, safety poll every 30s`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(jids, lastTimestamp, ASSISTANT_NAME);

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'Safety poll: new messages');
        lastTimestamp = makeCursorFromMessages(messages) || newTimestamp;
        saveState();
        const seenGroups = new Set<string>();
        for (const msg of messages) {
          if (seenGroups.has(msg.chat_jid)) continue;
          seenGroups.add(msg.chat_jid);
          handleNewMessagesForGroup(msg.chat_jid).catch((err) =>
            logger.error({ chatJid: msg.chat_jid, err }, 'Error handling new messages'),
          );
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in safety poll loop');
    }
    await new Promise((resolve) => setTimeout(resolve, 30_000));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
    const pending = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  cleanupOrphans();
}

const LOCK_FILE = path.join(DATA_DIR, '.stingyclaw.lock');

function acquireProcessLock(): boolean {
  try {
    fs.mkdirSync(path.dirname(LOCK_FILE), { recursive: true });
    const pid = process.pid.toString();
    const lockPath = fs.existsSync(LOCK_FILE) ? LOCK_FILE : null;

    if (lockPath) {
      const existing = fs.readFileSync(lockPath, 'utf-8').trim();
      const existingPid = parseInt(existing, 10);
      if (!Number.isNaN(existingPid)) {
        try {
          process.kill(existingPid, 0);
          logger.warn(
            { existingPid, lockPath },
            'Another stingyclaw instance appears to be running (lock file exists). Exiting.',
          );
          return false;
        } catch {
          /* process not running, we can take the lock */
        }
      }
    }
    fs.writeFileSync(LOCK_FILE, pid);
    process.on('exit', () => {
      try {
        fs.unlinkSync(LOCK_FILE);
      } catch (err) {
        logger.debug({ err }, 'Lock file cleanup failed on exit');
      }
    });
    return true;
  } catch (err) {
    logger.error({ err }, 'Could not acquire process lock');
    return false;
  }
}

async function main(): Promise<void> {
  ensureConfigContract(process.cwd());
  if (!acquireProcessLock()) {
    process.exit(1);
  }
  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();

  let stopKbDigestLoop: (() => void) | undefined;

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    stopKbDigestLoop?.();
    stopKbDigestLoop = undefined;
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Channel callbacks (shared by all channels)
  // Event-driven: store message and immediately trigger processing for registered groups
  const channelOpts = {
    onMessage: (chatJid: string, msg: NewMessage) => {
      storeMessage(msg);
      if (!registeredGroups[chatJid]) return;
      handleNewMessagesForGroup(chatJid).catch((err) =>
        logger.error({ chatJid, err }, 'Error handling new message'),
      );
    },
    onChatMetadata: (chatJid: string, timestamp: string, name?: string, channel?: string, isGroup?: boolean) =>
      storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => registeredGroups,
  };

  // Create and connect channels
  whatsapp = new WhatsAppChannel(channelOpts);
  channels.push(whatsapp);
  await whatsapp.connect();

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) => queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        console.log(`Warning: no channel owns JID ${jid}, cannot send message`);
        return;
      }
      const text = formatOutbound(rawText);
      if (text) await channel.sendMessage(jid, text);
    },
  });
  stopKbDigestLoop = startKbDigestLoop({
    getRegisteredGroups: () => registeredGroups,
  });
  startIpcWatcher({
    sendMessage: (jid, text, options) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      return channel.sendMessage(jid, text, options);
    },
    sendVoice: (jid, audioBuffer, options) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      if (!channel.sendVoice) throw new Error(`Channel ${channel.name} does not support voice`);
      return channel.sendVoice(jid, audioBuffer, options);
    },
    sendImage: (jid, imageBuffer, caption, options) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      if (!channel.sendImage) throw new Error(`Channel ${channel.name} does not support images`);
      return channel.sendImage(jid, imageBuffer, caption, options);
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    clearSession: (groupFolder) => {
      clearSessionInDb(groupFolder);
      delete sessions[groupFolder];
    },
    syncGroupMetadata: (force) => whatsapp?.syncGroupMetadata(force) ?? Promise.resolve(),
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) => writeGroupsSnapshot(gf, im, ag, rj),
  });
  queue.setProcessMessagesFn(processGroupMessages);
  queue.setOnMaxRetriesExceeded((groupJid, error) => {
    const channel = findChannel(channels, groupJid);
    if (!channel) return;
    const errorText = (error && error.slice(0, 400)) || 'Something went wrong. Please try again.';
    const msg = error?.includes('temporarily unavailable')
      ? errorText
      : `⚠️ ${errorText}\n\nSend another message to retry.`;
    channel.sendMessage(groupJid, msg, {
      idempotencyKey: outboundKey(groupJid, `max-retries-${Date.now()}`, 'error', msg),
    }).catch((err) =>
      logger.error({ groupJid, err }, 'Failed to send error notification'),
    );
  });
  recoverPendingMessages();
  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });

  // Start dashboard server if DASHBOARD_PORT is set
  if (DASHBOARD_PORT) {
    try {
      const { startDashboardServer } = await import('./dashboard-server.js');
      startDashboardServer(DASHBOARD_PORT);
    } catch (e) {
      logger.error({ err: e }, 'Failed to start dashboard server');
    }
  }
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname === new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start Stingyclaw');
    process.exit(1);
  });
}
