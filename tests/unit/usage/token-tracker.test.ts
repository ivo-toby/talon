/**
 * Unit tests for TokenTracker.
 *
 * Uses a real in-memory SQLite database (via RunRepository) to verify
 * recordUsage, getUsageByPersona, getUsageByThread, getUsageByPeriod,
 * and checkBudget behaviours.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { join } from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import pino from 'pino';
import { runMigrations } from '../../../src/core/database/migrations/runner.js';
import { RunRepository } from '../../../src/core/database/repositories/run-repository.js';
import { ChannelRepository } from '../../../src/core/database/repositories/channel-repository.js';
import { PersonaRepository } from '../../../src/core/database/repositories/persona-repository.js';
import { ThreadRepository } from '../../../src/core/database/repositories/thread-repository.js';
import { TokenTracker } from '../../../src/usage/token-tracker.js';
import type { BudgetConfig, TokenUsage } from '../../../src/usage/usage-types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function migrationsDir(): string {
  return join(import.meta.dirname, '../../../src/core/database/migrations');
}

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  const result = runMigrations(db, migrationsDir());
  if (result.isErr()) {
    throw new Error(`Test DB migration failed: ${result.error.message}`);
  }
  return db;
}

function createTestLogger(): pino.Logger {
  return pino({ level: 'silent' });
}

function uuid(): string {
  return uuidv4();
}

/** Seeds a persona, channel, and thread; returns their IDs. */
function seedContext(db: Database.Database): { personaId: string; threadId: string } {
  const channels = new ChannelRepository(db);
  const channelId = uuid();
  channels.insert({
    id: channelId,
    type: 'telegram',
    name: `ch-${uuid()}`,
    config: '{}',
    credentials_ref: null,
    enabled: 1,
  });

  const threads = new ThreadRepository(db);
  const threadId = uuid();
  threads.insert({
    id: threadId,
    channel_id: channelId,
    external_id: `ext-${uuid()}`,
    metadata: '{}',
  });

  const personas = new PersonaRepository(db);
  const personaId = uuid();
  personas.insert({
    id: personaId,
    name: `persona-${uuid()}`,
    model: 'claude-sonnet-4-6',
    system_prompt_file: null,
    skills: '[]',
    capabilities: '{}',
    max_concurrent: null,
  });

  return { personaId, threadId };
}

/** Inserts a completed run and returns its ID. */
function insertCompletedRun(
  repo: RunRepository,
  personaId: string,
  threadId: string,
  usage: TokenUsage,
  createdAt?: number,
): string {
  const id = uuid();
  const now = createdAt ?? Date.now();

  // Insert via raw SQL so we can control created_at precisely.
  const db = (repo as unknown as { db: Database.Database }).db;
  db.prepare(`
    INSERT INTO runs
      (id, thread_id, persona_id, provider_name, sandbox_id, session_id, status,
       parent_run_id, queue_item_id, input_tokens, output_tokens,
       cache_read_tokens, cache_write_tokens, cost_usd, error,
       started_at, ended_at, created_at)
    VALUES
      (?, ?, ?, 'claude-code', NULL, NULL, 'completed',
       NULL, NULL, ?, ?, ?, ?, ?, NULL,
       ?, ?, ?)
  `).run(
    id, threadId, personaId,
    usage.inputTokens, usage.outputTokens,
    usage.cacheReadTokens, usage.cacheWriteTokens, usage.costUsd,
    now, now, now,
  );

  return id;
}

/** Inserts a pending (non-completed) run. */
function insertPendingRun(repo: RunRepository, personaId: string, threadId: string): string {
  const id = uuid();
  const result = repo.insert({
    id,
    thread_id: threadId,
    persona_id: personaId,
    provider_name: 'claude-code',
    sandbox_id: null,
    session_id: null,
    status: 'pending',
    parent_run_id: null,
    queue_item_id: null,
    input_tokens: 999,
    output_tokens: 999,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    cost_usd: 0.99,
    error: null,
    started_at: null,
    ended_at: null,
  });
  if (result.isErr()) throw new Error(`insertPendingRun failed: ${result.error.message}`);
  return id;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TokenTracker', () => {
  let db: Database.Database;
  let runRepo: RunRepository;
  let tracker: TokenTracker;
  let personaId: string;
  let threadId: string;

  beforeEach(() => {
    db = createTestDb();
    runRepo = new RunRepository(db);
    tracker = new TokenTracker({ runRepo, logger: createTestLogger() });
    const ctx = seedContext(db);
    personaId = ctx.personaId;
    threadId = ctx.threadId;
  });

  afterEach(() => {
    db.close();
  });

  // -------------------------------------------------------------------------
  // recordUsage
  // -------------------------------------------------------------------------

  describe('recordUsage', () => {
    it('updates the run token fields in the database', () => {
      const runId = insertCompletedRun(runRepo, personaId, threadId, {
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0,
      });

      const usage: TokenUsage = {
        inputTokens: 100,
        outputTokens: 200,
        cacheReadTokens: 50,
        cacheWriteTokens: 25,
        costUsd: 0.005,
      };

      const result = tracker.recordUsage(runId, usage);

      expect(result.isOk()).toBe(true);

      const row = runRepo.findById(runId)._unsafeUnwrap();
      expect(row?.input_tokens).toBe(100);
      expect(row?.output_tokens).toBe(200);
      expect(row?.cache_read_tokens).toBe(50);
      expect(row?.cache_write_tokens).toBe(25);
      expect(row?.cost_usd).toBeCloseTo(0.005);
    });

    it('returns Ok(void) on success', () => {
      const runId = insertCompletedRun(runRepo, personaId, threadId, {
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0,
      });

      const result = tracker.recordUsage(runId, {
        inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.001,
      });

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toBeUndefined();
    });

    it('does not error for a non-existent run id (SQLite no-op)', () => {
      // SQLite UPDATE on a missing row is a no-op — not an error.
      const result = tracker.recordUsage(uuid(), {
        inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0,
      });
      expect(result.isOk()).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // getUsageByPersona
  // -------------------------------------------------------------------------

  describe('getUsageByPersona', () => {
    it('returns zero summary when no completed runs exist', () => {
      const result = tracker.getUsageByPersona(personaId);
      expect(result.isOk()).toBe(true);
      const summary = result._unsafeUnwrap();
      expect(summary.totalInputTokens).toBe(0);
      expect(summary.totalOutputTokens).toBe(0);
      expect(summary.runCount).toBe(0);
    });

    it('aggregates token usage across multiple completed runs', () => {
      insertCompletedRun(runRepo, personaId, threadId, {
        inputTokens: 100, outputTokens: 200, cacheReadTokens: 10, cacheWriteTokens: 5, costUsd: 0.01,
      });
      insertCompletedRun(runRepo, personaId, threadId, {
        inputTokens: 300, outputTokens: 400, cacheReadTokens: 20, cacheWriteTokens: 10, costUsd: 0.02,
      });

      const result = tracker.getUsageByPersona(personaId);
      expect(result.isOk()).toBe(true);
      const summary = result._unsafeUnwrap();
      expect(summary.totalInputTokens).toBe(400);
      expect(summary.totalOutputTokens).toBe(600);
      expect(summary.totalCacheReadTokens).toBe(30);
      expect(summary.totalCacheWriteTokens).toBe(15);
      expect(summary.totalCostUsd).toBeCloseTo(0.03);
      expect(summary.runCount).toBe(2);
    });

    it('excludes non-completed (pending) runs', () => {
      insertPendingRun(runRepo, personaId, threadId);

      const result = tracker.getUsageByPersona(personaId);
      expect(result.isOk()).toBe(true);
      const summary = result._unsafeUnwrap();
      expect(summary.runCount).toBe(0);
      expect(summary.totalInputTokens).toBe(0);
    });

    it('filters by time range (since / until)', () => {
      const base = 1_700_000_000_000; // a fixed epoch ms
      insertCompletedRun(runRepo, personaId, threadId, {
        inputTokens: 100, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.01,
      }, base - 5_000); // before window

      insertCompletedRun(runRepo, personaId, threadId, {
        inputTokens: 200, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.02,
      }, base); // inside window

      const result = tracker.getUsageByPersona(personaId, base, base + 1_000);
      const summary = result._unsafeUnwrap();
      expect(summary.runCount).toBe(1);
      expect(summary.totalInputTokens).toBe(200);
    });

    it('does not include runs from a different persona', () => {
      const ctx2 = seedContext(db);
      insertCompletedRun(runRepo, ctx2.personaId, ctx2.threadId, {
        inputTokens: 500, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.05,
      });

      insertCompletedRun(runRepo, personaId, threadId, {
        inputTokens: 100, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.01,
      });

      const result = tracker.getUsageByPersona(personaId);
      const summary = result._unsafeUnwrap();
      expect(summary.runCount).toBe(1);
      expect(summary.totalInputTokens).toBe(100);
    });
  });

  // -------------------------------------------------------------------------
  // getUsageByThread
  // -------------------------------------------------------------------------

  describe('getUsageByThread', () => {
    it('returns zero summary when no completed runs exist', () => {
      const result = tracker.getUsageByThread(threadId);
      expect(result.isOk()).toBe(true);
      const summary = result._unsafeUnwrap();
      expect(summary.runCount).toBe(0);
    });

    it('aggregates token usage across multiple completed runs for a thread', () => {
      insertCompletedRun(runRepo, personaId, threadId, {
        inputTokens: 50, outputTokens: 75, cacheReadTokens: 5, cacheWriteTokens: 2, costUsd: 0.005,
      });
      insertCompletedRun(runRepo, personaId, threadId, {
        inputTokens: 150, outputTokens: 225, cacheReadTokens: 15, cacheWriteTokens: 6, costUsd: 0.015,
      });

      const result = tracker.getUsageByThread(threadId);
      const summary = result._unsafeUnwrap();
      expect(summary.totalInputTokens).toBe(200);
      expect(summary.totalOutputTokens).toBe(300);
      expect(summary.totalCacheReadTokens).toBe(20);
      expect(summary.totalCacheWriteTokens).toBe(8);
      expect(summary.totalCostUsd).toBeCloseTo(0.02);
      expect(summary.runCount).toBe(2);
    });

    it('does not include runs from a different thread', () => {
      const ctx2 = seedContext(db);
      insertCompletedRun(runRepo, ctx2.personaId, ctx2.threadId, {
        inputTokens: 999, outputTokens: 999, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.1,
      });

      insertCompletedRun(runRepo, personaId, threadId, {
        inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.001,
      });

      const result = tracker.getUsageByThread(threadId);
      const summary = result._unsafeUnwrap();
      expect(summary.runCount).toBe(1);
      expect(summary.totalInputTokens).toBe(10);
    });

    it('filters by time range', () => {
      const base = 1_700_000_000_000;
      insertCompletedRun(runRepo, personaId, threadId, {
        inputTokens: 100, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.01,
      }, base - 10_000);

      insertCompletedRun(runRepo, personaId, threadId, {
        inputTokens: 200, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.02,
      }, base + 1_000);

      const result = tracker.getUsageByThread(threadId, base, base + 2_000);
      const summary = result._unsafeUnwrap();
      expect(summary.runCount).toBe(1);
      expect(summary.totalInputTokens).toBe(200);
    });
  });

  // -------------------------------------------------------------------------
  // getUsageByPeriod
  // -------------------------------------------------------------------------

  describe('getUsageByPeriod', () => {
    it('returns zero summary when no completed runs exist', () => {
      const result = tracker.getUsageByPeriod(0);
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().runCount).toBe(0);
    });

    it('aggregates usage across all personas and threads', () => {
      const ctx2 = seedContext(db);

      insertCompletedRun(runRepo, personaId, threadId, {
        inputTokens: 100, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.01,
      });
      insertCompletedRun(runRepo, ctx2.personaId, ctx2.threadId, {
        inputTokens: 300, outputTokens: 400, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.03,
      });

      const result = tracker.getUsageByPeriod(0);
      const summary = result._unsafeUnwrap();
      expect(summary.runCount).toBe(2);
      expect(summary.totalInputTokens).toBe(400);
      expect(summary.totalOutputTokens).toBe(600);
      expect(summary.totalCostUsd).toBeCloseTo(0.04);
    });

    it('respects since and until bounds', () => {
      const base = 1_700_000_000_000;

      insertCompletedRun(runRepo, personaId, threadId, {
        inputTokens: 100, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.01,
      }, base - 1_000); // before window

      insertCompletedRun(runRepo, personaId, threadId, {
        inputTokens: 200, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.02,
      }, base + 500); // inside window

      insertCompletedRun(runRepo, personaId, threadId, {
        inputTokens: 300, outputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.03,
      }, base + 2_000); // after window

      const result = tracker.getUsageByPeriod(base, base + 1_000);
      const summary = result._unsafeUnwrap();
      expect(summary.runCount).toBe(1);
      expect(summary.totalInputTokens).toBe(200);
    });

    it('excludes non-completed runs', () => {
      const ctx2 = seedContext(db);
      insertPendingRun(runRepo, ctx2.personaId, ctx2.threadId);

      const result = tracker.getUsageByPeriod(0);
      expect(result._unsafeUnwrap().runCount).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // checkBudget
  // -------------------------------------------------------------------------

  describe('checkBudget', () => {
    const periodStart = 0;

    it('returns withinBudget=true and warningTriggered=false when usage is below warn threshold', () => {
      insertCompletedRun(runRepo, personaId, threadId, {
        inputTokens: 100, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.001,
      });

      const config: BudgetConfig = {
        maxTokens: 10_000,
        periodStart,
        warnThresholdPercent: 80,
      };

      const result = tracker.checkBudget(personaId, config);
      expect(result.isOk()).toBe(true);
      const status = result._unsafeUnwrap();
      expect(status.withinBudget).toBe(true);
      expect(status.warningTriggered).toBe(false);
      expect(status.totalTokensUsed).toBe(200); // 100 in + 100 out
      expect(status.remainingTokens).toBe(9_800);
    });

    it('triggers warning when usage is between warnThreshold and budget limit', () => {
      // Use 85% of the budget
      insertCompletedRun(runRepo, personaId, threadId, {
        inputTokens: 4250, outputTokens: 4250, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.05,
      });

      const config: BudgetConfig = {
        maxTokens: 10_000,
        periodStart,
        warnThresholdPercent: 80,
      };

      const result = tracker.checkBudget(personaId, config);
      const status = result._unsafeUnwrap();
      expect(status.withinBudget).toBe(true);
      expect(status.warningTriggered).toBe(true);
      expect(status.percentUsed).toBeCloseTo(85);
    });

    it('uses 80% as the default warn threshold', () => {
      // 79% usage — should NOT trigger warning
      insertCompletedRun(runRepo, personaId, threadId, {
        inputTokens: 3950, outputTokens: 3950, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.04,
      });

      const config: BudgetConfig = {
        maxTokens: 10_000,
        periodStart,
        // warnThresholdPercent omitted — default 80
      };

      const result = tracker.checkBudget(personaId, config);
      const status = result._unsafeUnwrap();
      expect(status.withinBudget).toBe(true);
      expect(status.warningTriggered).toBe(false);
    });

    it('returns withinBudget=false when usage exceeds maxTokens', () => {
      insertCompletedRun(runRepo, personaId, threadId, {
        inputTokens: 6000, outputTokens: 6000, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.1,
      });

      const config: BudgetConfig = {
        maxTokens: 10_000,
        periodStart,
      };

      const result = tracker.checkBudget(personaId, config);
      const status = result._unsafeUnwrap();
      expect(status.withinBudget).toBe(false);
      expect(status.warningTriggered).toBe(false); // over budget, not just warning
      expect(status.totalTokensUsed).toBe(12_000);
      expect(status.remainingTokens).toBe(-2_000);
      expect(status.percentUsed).toBeCloseTo(120);
    });

    it('returns withinBudget=true and zero usage when no runs exist', () => {
      const config: BudgetConfig = {
        maxTokens: 5_000,
        periodStart,
      };

      const result = tracker.checkBudget(personaId, config);
      const status = result._unsafeUnwrap();
      expect(status.withinBudget).toBe(true);
      expect(status.totalTokensUsed).toBe(0);
      expect(status.remainingTokens).toBe(5_000);
      expect(status.percentUsed).toBe(0);
      expect(status.warningTriggered).toBe(false);
    });

    it('respects periodEnd when provided', () => {
      const base = 1_700_000_000_000;

      // Run inside the period
      insertCompletedRun(runRepo, personaId, threadId, {
        inputTokens: 1000, outputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.01,
      }, base + 500);

      // Run outside the period (after periodEnd)
      insertCompletedRun(runRepo, personaId, threadId, {
        inputTokens: 5000, outputTokens: 5000, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.1,
      }, base + 2_000);

      const config: BudgetConfig = {
        maxTokens: 10_000,
        periodStart: base,
        periodEnd: base + 1_000,
      };

      const result = tracker.checkBudget(personaId, config);
      const status = result._unsafeUnwrap();
      expect(status.totalTokensUsed).toBe(2000); // only the first run
      expect(status.withinBudget).toBe(true);
    });

    it('does not count cache tokens toward the budget', () => {
      // Large cache usage but small input/output
      insertCompletedRun(runRepo, personaId, threadId, {
        inputTokens: 100, outputTokens: 100,
        cacheReadTokens: 50_000, cacheWriteTokens: 10_000,
        costUsd: 0.01,
      });

      const config: BudgetConfig = {
        maxTokens: 1_000,
        periodStart,
      };

      const result = tracker.checkBudget(personaId, config);
      const status = result._unsafeUnwrap();
      // Only input+output (200) counted, not cache
      expect(status.totalTokensUsed).toBe(200);
      expect(status.withinBudget).toBe(true);
    });
  });
});
