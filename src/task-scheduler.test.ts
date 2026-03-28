import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _initTestDatabase, createTask, getTaskById } from './db.js';
import {
  _resetSchedulerLoopForTests,
  computeNextRun,
  startSchedulerLoop,
} from './task-scheduler.js';

describe('task scheduler', () => {
  beforeEach(() => {
    _initTestDatabase();
    _resetSchedulerLoopForTests();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('pauses due tasks with invalid group folders to prevent retry churn', async () => {
    createTask({
      id: 'task-invalid-folder',
      group_folder: '../../outside',
      chat_jid: 'bad@g.us',
      prompt: 'run',
      schedule_type: 'once',
      schedule_value: '2026-02-22T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-02-22T00:00:00.000Z',
    });

    const enqueueTask = vi.fn(
      (_groupJid: string, _taskId: string, fn: () => Promise<void>) => {
        void fn();
      },
    );

    startSchedulerLoop({
      registeredGroups: () => ({}),
      getSessions: () => ({}),
      queue: { enqueueTask } as any,
      onProcess: () => {},
      sendMessage: async () => {},
    });

    await vi.advanceTimersByTimeAsync(10);

    const task = getTaskById('task-invalid-folder');
    expect(task?.status).toBe('paused');
  });
});

describe('computeNextRun', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns null for once', () => {
    expect(
      computeNextRun({
        id: '1',
        group_folder: 'main',
        chat_jid: 'x@g.us',
        prompt: 'p',
        schedule_type: 'once',
        schedule_value: '',
        context_mode: 'isolated',
        next_run: null,
        last_run: null,
        last_result: null,
        status: 'active',
        created_at: '2026-01-01T00:00:00.000Z',
      }),
    ).toBeNull();
  });

  it('advances interval from scheduled next_run (anchored, not Date.now-only)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-01T11:00:00.000Z'));
    const next = computeNextRun({
      id: 'i1',
      group_folder: 'main',
      chat_jid: 'x@g.us',
      prompt: 'p',
      schedule_type: 'interval',
      schedule_value: '3600000',
      context_mode: 'isolated',
      next_run: '2026-06-01T12:00:00.000Z',
      last_run: null,
      last_result: null,
      status: 'active',
      created_at: '2026-01-01T00:00:00.000Z',
    });
    expect(next).toBe('2026-06-01T13:00:00.000Z');
  });

  it('falls forward interval when next_run is in the past', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2030-01-15T12:00:00.000Z'));
    const next = computeNextRun({
      id: 'i2',
      group_folder: 'main',
      chat_jid: 'x@g.us',
      prompt: 'p',
      schedule_type: 'interval',
      schedule_value: '60000',
      context_mode: 'isolated',
      next_run: '2020-01-01T00:00:00.000Z',
      last_run: null,
      last_result: null,
      status: 'active',
      created_at: '2026-01-01T00:00:00.000Z',
    });
    expect(next).toBe('2030-01-15T12:01:00.000Z');
  });
});
