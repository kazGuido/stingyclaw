import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME, DATA_DIR, STORE_DIR } from './config.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import { NewMessage, RegisteredGroup, ScheduledTask, TaskRunLog } from './types.js';

let db: Database.Database;
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

function messageCursorFilter(cursor: MessageCursor): { where: string; params: string[] } {
  if (!cursor.timestamp) {
    return {
      where: 'timestamp > ?',
      params: [''],
    };
  }

  if (!cursor.messageId) {
    return {
      where: 'timestamp > ?',
      params: [cursor.timestamp],
    };
  }

  return {
    where: '(timestamp > ? OR (timestamp = ? AND id > ?))',
    params: [cursor.timestamp, cursor.timestamp, cursor.messageId],
  };
}

export type MessagePipelineState =
  | 'received'
  | 'queued'
  | 'running'
  | 'sent'
  | 'committed';

function createSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      jid TEXT PRIMARY KEY,
      name TEXT,
      last_message_time TEXT,
      channel TEXT,
      is_group INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT,
      chat_jid TEXT,
      sender TEXT,
      sender_name TEXT,
      content TEXT,
      timestamp TEXT,
      is_from_me INTEGER,
      is_bot_message INTEGER DEFAULT 0,
      PRIMARY KEY (id, chat_jid),
      FOREIGN KEY (chat_jid) REFERENCES chats(jid)
    );
    CREATE INDEX IF NOT EXISTS idx_timestamp ON messages(timestamp);

    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule_type TEXT NOT NULL,
      schedule_value TEXT NOT NULL,
      next_run TEXT,
      last_run TEXT,
      last_result TEXT,
      status TEXT DEFAULT 'active',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_next_run ON scheduled_tasks(next_run);
    CREATE INDEX IF NOT EXISTS idx_status ON scheduled_tasks(status);

    CREATE TABLE IF NOT EXISTS task_run_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      run_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      result TEXT,
      error TEXT,
      FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id)
    );
    CREATE INDEX IF NOT EXISTS idx_task_run_logs ON task_run_logs(task_id, run_at);

    CREATE TABLE IF NOT EXISTS router_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      group_folder TEXT PRIMARY KEY,
      session_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS registered_groups (
      jid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      folder TEXT NOT NULL UNIQUE,
      trigger_pattern TEXT NOT NULL,
      added_at TEXT NOT NULL,
      container_config TEXT,
      requires_trigger INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS kb_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_folder TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      tags TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_kb_group ON kb_entries(group_folder);
    CREATE INDEX IF NOT EXISTS idx_kb_title ON kb_entries(title);

    CREATE TABLE IF NOT EXISTS group_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_folder TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT DEFAULT 'pending',
      due_date TEXT,
      type TEXT DEFAULT 'todo',
      priority INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_group ON group_tasks(group_folder);
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON group_tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_due ON group_tasks(due_date);
    CREATE INDEX IF NOT EXISTS idx_tasks_type ON group_tasks(type);

    CREATE TABLE IF NOT EXISTS outbound_deliveries (
      idempotency_key TEXT PRIMARY KEY,
      chat_jid TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      sent_at TEXT,
      last_error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_outbound_deliveries_status
      ON outbound_deliveries(status, created_at);

    CREATE TABLE IF NOT EXISTS message_pipeline (
      message_id TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      state TEXT NOT NULL,
      run_id TEXT,
      last_error TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (message_id, chat_jid)
    );
    CREATE INDEX IF NOT EXISTS idx_message_pipeline_state
      ON message_pipeline(state, updated_at);

    -- Pending confirmations for tool approvals (persisted across restarts)
    CREATE TABLE IF NOT EXISTS pending_confirmations (
      group_folder TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      tool_call_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      args TEXT NOT NULL,
      preview TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);

  // Add context_mode column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE scheduled_tasks ADD COLUMN context_mode TEXT DEFAULT 'isolated'`,
    );
  } catch {
    /* column already exists */
  }

  // Add is_bot_message column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE messages ADD COLUMN is_bot_message INTEGER DEFAULT 0`,
    );
    // Backfill: mark existing bot messages that used the content prefix pattern
    database.prepare(
      `UPDATE messages SET is_bot_message = 1 WHERE content LIKE ?`,
    ).run(`${ASSISTANT_NAME}:%`);
  } catch {
    /* column already exists */
  }

  // Add channel and is_group columns if they don't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE chats ADD COLUMN channel TEXT`,
    );
    database.exec(
      `ALTER TABLE chats ADD COLUMN is_group INTEGER DEFAULT 0`,
    );
    // Backfill from JID patterns
    database.exec(`UPDATE chats SET channel = 'whatsapp', is_group = 1 WHERE jid LIKE '%@g.us'`);
    database.exec(`UPDATE chats SET channel = 'whatsapp', is_group = 0 WHERE jid LIKE '%@s.whatsapp.net'`);
    database.exec(`UPDATE chats SET channel = 'discord', is_group = 1 WHERE jid LIKE 'dc:%'`);
    database.exec(`UPDATE chats SET channel = 'telegram', is_group = 1 WHERE jid LIKE 'tg:%'`);
  } catch {
    /* columns already exist */
  }
}

export function initDatabase(): void {
  const dbPath = path.join(STORE_DIR, 'messages.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  db = new Database(dbPath);
  createSchema(db);

  // Migrate from JSON files if they exist
  migrateJsonState();
}

/** @internal - for tests only. Creates a fresh in-memory database. */
export function _initTestDatabase(): void {
  db = new Database(':memory:');
  createSchema(db);
}

/**
 * Store chat metadata only (no message content).
 * Used for all chats to enable group discovery without storing sensitive content.
 */
export function storeChatMetadata(
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
): void {
  const ch = channel ?? null;
  const group = isGroup === undefined ? null : isGroup ? 1 : 0;

  if (name) {
    // Update with name, preserving existing timestamp if newer
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        name = excluded.name,
        last_message_time = MAX(last_message_time, excluded.last_message_time),
        channel = COALESCE(excluded.channel, channel),
        is_group = COALESCE(excluded.is_group, is_group)
    `,
    ).run(chatJid, name, timestamp, ch, group);
  } else {
    // Update timestamp only, preserve existing name if any
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        last_message_time = MAX(last_message_time, excluded.last_message_time),
        channel = COALESCE(excluded.channel, channel),
        is_group = COALESCE(excluded.is_group, is_group)
    `,
    ).run(chatJid, chatJid, timestamp, ch, group);
  }
}

/**
 * Update chat name without changing timestamp for existing chats.
 * New chats get the current time as their initial timestamp.
 * Used during group metadata sync.
 */
export function updateChatName(chatJid: string, name: string): void {
  db.prepare(
    `
    INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
    ON CONFLICT(jid) DO UPDATE SET name = excluded.name
  `,
  ).run(chatJid, name, new Date().toISOString());
}

export interface ChatInfo {
  jid: string;
  name: string;
  last_message_time: string;
  channel: string;
  is_group: number;
}

/**
 * Get all known chats, ordered by most recent activity.
 */
export function getAllChats(): ChatInfo[] {
  return db
    .prepare(
      `
    SELECT jid, name, last_message_time, channel, is_group
    FROM chats
    ORDER BY last_message_time DESC
  `,
    )
    .all() as ChatInfo[];
}

/**
 * Get timestamp of last group metadata sync.
 */
export function getLastGroupSync(): string | null {
  // Store sync time in a special chat entry
  const row = db
    .prepare(`SELECT last_message_time FROM chats WHERE jid = '__group_sync__'`)
    .get() as { last_message_time: string } | undefined;
  return row?.last_message_time || null;
}

/**
 * Record that group metadata was synced.
 */
export function setLastGroupSync(): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR REPLACE INTO chats (jid, name, last_message_time) VALUES ('__group_sync__', '__group_sync__', ?)`,
  ).run(now);
}

/**
 * Store a message with full content.
 * Only call this for registered groups where message history is needed.
 */
export function storeMessage(msg: NewMessage): void {
  db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
    msg.is_bot_message ? 1 : 0,
  );
  if (!msg.is_bot_message && !msg.is_from_me) {
    setMessagePipelineState(msg.chat_jid, msg.id, 'received');
  }
}

/**
 * Store a message directly (for non-WhatsApp channels that don't use Baileys proto).
 */
export function storeMessageDirect(msg: {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me: boolean;
  is_bot_message?: boolean;
}): void {
  db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
    msg.is_bot_message ? 1 : 0,
  );
  if (!msg.is_bot_message && !msg.is_from_me) {
    setMessagePipelineState(msg.chat_jid, msg.id, 'received');
  }
}

export function registerOutboundDelivery(
  idempotencyKey: string,
  chatJid: string,
  kind: 'message' | 'voice' | 'image',
): boolean {
  const now = new Date().toISOString();
  const result = db.prepare(
    `
    INSERT OR IGNORE INTO outbound_deliveries
      (idempotency_key, chat_jid, kind, status, created_at)
    VALUES (?, ?, ?, 'pending', ?)
  `,
  ).run(idempotencyKey, chatJid, kind, now);

  if (result.changes > 0) return true;

  const existing = db
    .prepare(
      'SELECT status FROM outbound_deliveries WHERE idempotency_key = ?',
    )
    .get(idempotencyKey) as { status: string } | undefined;

  if (existing?.status === 'failed') {
    db.prepare(
      `
      UPDATE outbound_deliveries
      SET status = 'pending', last_error = NULL
      WHERE idempotency_key = ?
    `,
    ).run(idempotencyKey);
    return true;
  }

  return false;
}

export function markOutboundDeliverySent(idempotencyKey: string): void {
  db.prepare(
    `
    UPDATE outbound_deliveries
    SET status = 'sent', sent_at = ?, last_error = NULL
    WHERE idempotency_key = ?
  `,
  ).run(new Date().toISOString(), idempotencyKey);
}

export function markOutboundDeliveryFailed(
  idempotencyKey: string,
  error: string,
): void {
  db.prepare(
    `
    UPDATE outbound_deliveries
    SET status = 'failed', last_error = ?
    WHERE idempotency_key = ?
  `,
  ).run(error.slice(0, 400), idempotencyKey);
}

export function setMessagePipelineState(
  chatJid: string,
  messageId: string,
  state: MessagePipelineState,
  runId?: string,
  lastError?: string,
): void {
  db.prepare(
    `
    INSERT INTO message_pipeline (message_id, chat_jid, state, run_id, last_error, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(message_id, chat_jid) DO UPDATE SET
      state = excluded.state,
      run_id = excluded.run_id,
      last_error = excluded.last_error,
      updated_at = excluded.updated_at
  `,
  ).run(
    messageId,
    chatJid,
    state,
    runId || null,
    lastError || null,
    new Date().toISOString(),
  );
}

export function setMessagePipelineStateBulk(
  chatJid: string,
  messageIds: string[],
  state: MessagePipelineState,
  runId?: string,
  lastError?: string,
): void {
  for (const messageId of messageIds) {
    setMessagePipelineState(chatJid, messageId, state, runId, lastError);
  }
}

export function getMessagePipelineState(
  chatJid: string,
  messageId: string,
): {
  message_id: string;
  chat_jid: string;
  state: MessagePipelineState;
  run_id: string | null;
  last_error: string | null;
  updated_at: string;
} | undefined {
  return db
    .prepare(
      'SELECT * FROM message_pipeline WHERE chat_jid = ? AND message_id = ?',
    )
    .get(chatJid, messageId) as
    | {
        message_id: string;
        chat_jid: string;
        state: MessagePipelineState;
        run_id: string | null;
        last_error: string | null;
        updated_at: string;
      }
    | undefined;
}

export function getNewMessages(
  jids: string[],
  lastTimestamp: string,
  botPrefix: string,
): { messages: NewMessage[]; newTimestamp: string } {
  if (jids.length === 0) return { messages: [], newTimestamp: lastTimestamp };

  const placeholders = jids.map(() => '?').join(',');
  const cursor = parseMessageCursor(lastTimestamp);
  const messageFilter = messageCursorFilter(cursor);
  // Filter bot messages using both the is_bot_message flag AND the content
  // prefix as a backstop for messages written before the migration ran.
  const sql = `
    SELECT id, chat_jid, sender, sender_name, content, timestamp
    FROM messages
    WHERE ${messageFilter.where} AND chat_jid IN (${placeholders})
      AND is_bot_message = 0 AND content NOT LIKE ?
      AND content != '' AND content IS NOT NULL
    ORDER BY timestamp
  `;

  const rows = db
    .prepare(sql)
    .all(...messageFilter.params, ...jids, `${botPrefix}:%`) as NewMessage[];

  let newTimestamp = lastTimestamp;
  for (const row of rows) {
    if (row.timestamp > newTimestamp) newTimestamp = row.timestamp;
  }

  return { messages: rows, newTimestamp };
}

export function getMessagesSince(
  chatJid: string,
  sinceTimestamp: string,
  botPrefix: string,
): NewMessage[] {
  const cursor = parseMessageCursor(sinceTimestamp);
  const messageFilter = messageCursorFilter(cursor);
  // Filter bot messages using both the is_bot_message flag AND the content
  // prefix as a backstop for messages written before the migration ran.
  const sql = `
    SELECT id, chat_jid, sender, sender_name, content, timestamp
    FROM messages
    WHERE chat_jid = ? AND ${messageFilter.where}
      AND is_bot_message = 0 AND content NOT LIKE ?
      AND content != '' AND content IS NOT NULL
    ORDER BY timestamp
  `;
  return db
    .prepare(sql)
    .all(chatJid, ...messageFilter.params, `${botPrefix}:%`) as NewMessage[];
}

/**
 * Get recent messages for a chat (for read_group_messages tool).
 * Returns up to `limit` messages, newest first, excluding bot messages.
 */
export function getRecentMessages(
  chatJid: string,
  limit: number,
  botPrefix: string,
): NewMessage[] {
  const sql = `
    SELECT id, chat_jid, sender, sender_name, content, timestamp
    FROM messages
    WHERE chat_jid = ?
      AND is_bot_message = 0 AND content NOT LIKE ?
      AND content != '' AND content IS NOT NULL
    ORDER BY timestamp DESC
    LIMIT ?
  `;
  const rows = db
    .prepare(sql)
    .all(chatJid, `${botPrefix}:%`, limit) as NewMessage[];
  return rows.reverse(); // Return chronological order (oldest first)
}

export function createTask(
  task: Omit<ScheduledTask, 'last_run' | 'last_result'>,
): void {
  db.prepare(
    `
    INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode, next_run, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    task.id,
    task.group_folder,
    task.chat_jid,
    task.prompt,
    task.schedule_type,
    task.schedule_value,
    task.context_mode || 'isolated',
    task.next_run,
    task.status,
    task.created_at,
  );
}

export function getTaskById(id: string): ScheduledTask | undefined {
  return db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as
    | ScheduledTask
    | undefined;
}

export function getTasksForGroup(groupFolder: string): ScheduledTask[] {
  return db
    .prepare(
      'SELECT * FROM scheduled_tasks WHERE group_folder = ? ORDER BY created_at DESC',
    )
    .all(groupFolder) as ScheduledTask[];
}

export function getAllTasks(): ScheduledTask[] {
  return db
    .prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC')
    .all() as ScheduledTask[];
}

export function updateTask(
  id: string,
  updates: Partial<
    Pick<
      ScheduledTask,
      'prompt' | 'schedule_type' | 'schedule_value' | 'next_run' | 'status'
    >
  >,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.prompt !== undefined) {
    fields.push('prompt = ?');
    values.push(updates.prompt);
  }
  if (updates.schedule_type !== undefined) {
    fields.push('schedule_type = ?');
    values.push(updates.schedule_type);
  }
  if (updates.schedule_value !== undefined) {
    fields.push('schedule_value = ?');
    values.push(updates.schedule_value);
  }
  if (updates.next_run !== undefined) {
    fields.push('next_run = ?');
    values.push(updates.next_run);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }

  if (fields.length === 0) return;

  values.push(id);
  db.prepare(
    `UPDATE scheduled_tasks SET ${fields.join(', ')} WHERE id = ?`,
  ).run(...values);
}

export function deleteTask(id: string): void {
  // Delete child records first (FK constraint)
  db.prepare('DELETE FROM task_run_logs WHERE task_id = ?').run(id);
  db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
}

export function getDueTasks(): ScheduledTask[] {
  const now = new Date().toISOString();
  return db
    .prepare(
      `
    SELECT * FROM scheduled_tasks
    WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= ?
    ORDER BY next_run
  `,
    )
    .all(now) as ScheduledTask[];
}

export function updateTaskAfterRun(
  id: string,
  nextRun: string | null,
  lastResult: string,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `
    UPDATE scheduled_tasks
    SET next_run = ?, last_run = ?, last_result = ?, status = CASE WHEN ? IS NULL THEN 'completed' ELSE status END
    WHERE id = ?
  `,
  ).run(nextRun, now, lastResult, nextRun, id);
}

export function logTaskRun(log: TaskRunLog): void {
  db.prepare(
    `
    INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
  ).run(
    log.task_id,
    log.run_at,
    log.duration_ms,
    log.status,
    log.result,
    log.error,
  );
}

// --- Router state accessors ---

export function getRouterState(key: string): string | undefined {
  const row = db
    .prepare('SELECT value FROM router_state WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value;
}

export function setRouterState(key: string, value: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)',
  ).run(key, value);
}

// --- Session accessors ---

export function getSession(groupFolder: string): string | undefined {
  const row = db
    .prepare('SELECT session_id FROM sessions WHERE group_folder = ?')
    .get(groupFolder) as { session_id: string } | undefined;
  return row?.session_id;
}

export function setSession(groupFolder: string, sessionId: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO sessions (group_folder, session_id) VALUES (?, ?)',
  ).run(groupFolder, sessionId);
}

export function clearSession(groupFolder: string): void {
  db.prepare('DELETE FROM sessions WHERE group_folder = ?').run(groupFolder);
}

/**
 * Reset router state and all sessions for a clean slate (no pending cursors, no retries, fresh conversations).
 * Does not touch registered groups, messages, chats, or auth.
 */
export function resetRouterAndSessionState(): void {
  db.prepare('DELETE FROM router_state').run();
  db.prepare('DELETE FROM sessions').run();
}

export function getAllSessions(): Record<string, string> {
  const rows = db
    .prepare('SELECT group_folder, session_id FROM sessions')
    .all() as Array<{ group_folder: string; session_id: string }>;
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.group_folder] = row.session_id;
  }
  return result;
}

// --- Pending confirmation accessors (persisted across restarts) ---

export interface PendingConfirmation {
  sessionId: string;
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  preview: string;
}

export function getPendingConfirmation(groupFolder: string): PendingConfirmation | undefined {
  const row = db
    .prepare('SELECT session_id, tool_call_id, tool_name, args, preview FROM pending_confirmations WHERE group_folder = ?')
    .get(groupFolder) as { session_id: string; tool_call_id: string; tool_name: string; args: string; preview: string } | undefined;
  if (!row) return undefined;
  return {
    sessionId: row.session_id,
    toolCallId: row.tool_call_id,
    toolName: row.tool_name,
    args: JSON.parse(row.args),
    preview: row.preview,
  };
}

export function setPendingConfirmation(
  groupFolder: string,
  confirmation: PendingConfirmation,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO pending_confirmations
     (group_folder, session_id, tool_call_id, tool_name, args, preview, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    groupFolder,
    confirmation.sessionId,
    confirmation.toolCallId,
    confirmation.toolName,
    JSON.stringify(confirmation.args),
    confirmation.preview,
    new Date().toISOString(),
  );
}

export function clearPendingConfirmation(groupFolder: string): void {
  db.prepare('DELETE FROM pending_confirmations WHERE group_folder = ?').run(groupFolder);
}

// --- Registered group accessors ---

export function getRegisteredGroup(
  jid: string,
): (RegisteredGroup & { jid: string }) | undefined {
  const row = db
    .prepare('SELECT * FROM registered_groups WHERE jid = ?')
    .get(jid) as
    | {
        jid: string;
        name: string;
        folder: string;
        trigger_pattern: string;
        added_at: string;
        container_config: string | null;
        requires_trigger: number | null;
      }
    | undefined;
  if (!row) return undefined;
  if (!isValidGroupFolder(row.folder)) {
    logger.warn(
      { jid: row.jid, folder: row.folder },
      'Skipping registered group with invalid folder',
    );
    return undefined;
  }
  return {
    jid: row.jid,
    name: row.name,
    folder: row.folder,
    trigger: row.trigger_pattern,
    added_at: row.added_at,
    containerConfig: row.container_config
      ? JSON.parse(row.container_config)
      : undefined,
    requiresTrigger: row.requires_trigger === null ? undefined : row.requires_trigger === 1,
  };
}

export function setRegisteredGroup(
  jid: string,
  group: RegisteredGroup,
): void {
  if (!isValidGroupFolder(group.folder)) {
    throw new Error(`Invalid group folder "${group.folder}" for JID ${jid}`);
  }
  db.prepare(
    `INSERT OR REPLACE INTO registered_groups (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    jid,
    group.name,
    group.folder,
    group.trigger,
    group.added_at,
    group.containerConfig ? JSON.stringify(group.containerConfig) : null,
    group.requiresTrigger === undefined ? 1 : group.requiresTrigger ? 1 : 0,
  );
}

export function getAllRegisteredGroups(): Record<string, RegisteredGroup> {
  const rows = db
    .prepare('SELECT * FROM registered_groups')
    .all() as Array<{
    jid: string;
    name: string;
    folder: string;
    trigger_pattern: string;
    added_at: string;
    container_config: string | null;
    requires_trigger: number | null;
  }>;
  const result: Record<string, RegisteredGroup> = {};
  for (const row of rows) {
    if (!isValidGroupFolder(row.folder)) {
      logger.warn(
        { jid: row.jid, folder: row.folder },
        'Skipping registered group with invalid folder',
      );
      continue;
    }
    result[row.jid] = {
      name: row.name,
      folder: row.folder,
      trigger: row.trigger_pattern,
      added_at: row.added_at,
      containerConfig: row.container_config
        ? JSON.parse(row.container_config)
        : undefined,
      requiresTrigger: row.requires_trigger === null ? undefined : row.requires_trigger === 1,
    };
  }
  return result;
}

// --- JSON migration ---

function migrateJsonState(): void {
  const migrateFile = (filename: string) => {
    const filePath = path.join(DATA_DIR, filename);
    if (!fs.existsSync(filePath)) return null;
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      fs.renameSync(filePath, `${filePath}.migrated`);
      return data;
    } catch {
      return null;
    }
  };

  // Migrate router_state.json
  const routerState = migrateFile('router_state.json') as {
    last_timestamp?: string;
    last_agent_timestamp?: Record<string, string>;
  } | null;
  if (routerState) {
    if (routerState.last_timestamp) {
      setRouterState('last_timestamp', routerState.last_timestamp);
    }
    if (routerState.last_agent_timestamp) {
      setRouterState(
        'last_agent_timestamp',
        JSON.stringify(routerState.last_agent_timestamp),
      );
    }
  }

  // Migrate sessions.json
  const sessions = migrateFile('sessions.json') as Record<
    string,
    string
  > | null;
  if (sessions) {
    for (const [folder, sessionId] of Object.entries(sessions)) {
      setSession(folder, sessionId);
    }
  }

  // Migrate registered_groups.json
  const groups = migrateFile('registered_groups.json') as Record<
    string,
    RegisteredGroup
  > | null;
  if (groups) {
    for (const [jid, group] of Object.entries(groups)) {
      try {
        setRegisteredGroup(jid, group);
      } catch (err) {
        logger.warn(
          { jid, folder: group.folder, err },
          'Skipping migrated registered group with invalid folder',
        );
      }
    }
  }
}

// --- KB entries accessors (group scoped) ---

export interface KBEntry {
  id: number;
  group_folder: string;
  title: string;
  content: string;
  tags?: string;
  created_at: string;
  updated_at: string;
}

export function addKBEntry(groupFolder: string, title: string, content: string, tags?: string): number {
  const now = new Date().toISOString();
  const result = db.prepare(
    `INSERT INTO kb_entries (group_folder, title, content, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(groupFolder, title, content, tags || null, now, now);
  return result.lastInsertRowid as number;
}

export function updateKBEntry(id: number, title: string, content: string, tags?: string): boolean {
  const now = new Date().toISOString();
  const result = db.prepare(
    `UPDATE kb_entries SET title = ?, content = ?, tags = ?, updated_at = ? WHERE id = ?`,
  ).run(title, content, tags || null, now, id);
  return result.changes > 0;
}

export function deleteKBEntry(id: number): boolean {
  const result = db.prepare(`DELETE FROM kb_entries WHERE id = ?`).run(id);
  return result.changes > 0;
}

export function getKBEntry(id: number): KBEntry | undefined {
  const row = db
    .prepare('SELECT * FROM kb_entries WHERE id = ?')
    .get(id) as KBEntry | undefined;
  return row;
}

export function getKBEntriesByGroup(groupFolder: string): KBEntry[] {
  return db
    .prepare('SELECT * FROM kb_entries WHERE group_folder = ? ORDER BY updated_at DESC')
    .all(groupFolder) as KBEntry[];
}

export function searchKBEntries(groupFolder: string, query: string): KBEntry[] {
  const term = `%${query}%`;
  return db
    .prepare(`
      SELECT * FROM kb_entries 
      WHERE group_folder = ? 
        AND (title LIKE ? OR content LIKE ?)
      ORDER BY updated_at DESC
    `)
    .all(groupFolder, term, term) as KBEntry[];
}

// --- Group tasks accessors (group scoped) ---

export interface GroupTask {
  id: number;
  group_folder: string;
  title: string;
  description?: string;
  status: string;
  due_date?: string;
  type: string;
  priority: number;
  created_at: string;
  updated_at: string;
}

export function addGroupTask(groupFolder: string, title: string, description?: string, status = 'pending', dueDate?: string, type = 'todo', priority = 0): number {
  const now = new Date().toISOString();
  const result = db.prepare(
    `INSERT INTO group_tasks (group_folder, title, description, status, due_date, type, priority, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(groupFolder, title, description || null, status, dueDate || null, type, priority, now, now);
  return result.lastInsertRowid as number;
}

export function updateGroupTask(id: number, updates: Partial<Pick<GroupTask, 'title' | 'description' | 'status' | 'due_date' | 'type' | 'priority'>>): boolean {
  const now = new Date().toISOString();
  const sets: string[] = [];
  const values: any[] = [];
  const allowedKeys: ReadonlyArray<keyof typeof updates> = ['title', 'description', 'status', 'due_date', 'type', 'priority'];
  for (const key of Object.keys(updates) as Array<keyof typeof updates>) {
    if (allowedKeys.includes(key) && updates[key] !== undefined) {
      sets.push(`${key} = ?`);
      values.push(updates[key]);
    }
  }
  if (sets.length === 0) return false;
  values.push(now);
  values.push(id);
  sets.push('updated_at = ?');
  const result = db.prepare(
    `UPDATE group_tasks SET ${sets.join(', ')} WHERE id = ?`,
  ).run(...values);
  return result.changes > 0;
}

export function deleteGroupTask(id: number): boolean {
  const result = db.prepare(`DELETE FROM group_tasks WHERE id = ?`).run(id);
  return result.changes > 0;
}

export function getGroupTask(id: number): GroupTask | undefined {
  const row = db
    .prepare('SELECT * FROM group_tasks WHERE id = ?')
    .get(id) as GroupTask | undefined;
  return row;
}

export function getGroupTasksByGroup(groupFolder: string): GroupTask[] {
  return db
    .prepare('SELECT * FROM group_tasks WHERE group_folder = ? ORDER BY created_at DESC')
    .all(groupFolder) as GroupTask[];
}

export function getGroupTasksByStatus(groupFolder: string, status: string): GroupTask[] {
  return db
    .prepare('SELECT * FROM group_tasks WHERE group_folder = ? AND status = ? ORDER BY created_at DESC')
    .all(groupFolder, status) as GroupTask[];
}

export function getGroupTasksByDueDate(groupFolder: string, beforeDate: string): GroupTask[] {
  return db
    .prepare('SELECT * FROM group_tasks WHERE group_folder = ? AND due_date <= ? AND status != \'done\' ORDER BY due_date ASC')
    .all(groupFolder, beforeDate) as GroupTask[];
}

export function getGroupTasksByType(groupFolder: string, type: string): GroupTask[] {
  return db
    .prepare('SELECT * FROM group_tasks WHERE group_folder = ? AND type = ? ORDER BY created_at DESC')
    .all(groupFolder, type) as GroupTask[];
}

export function deleteAllGroupTasksForGroup(groupFolder: string): void {
  db.prepare('DELETE FROM group_tasks WHERE group_folder = ?').run(groupFolder);
}

export function deleteAllKBEntriesForGroup(groupFolder: string): void {
  db.prepare('DELETE FROM kb_entries WHERE group_folder = ?').run(groupFolder);
}
