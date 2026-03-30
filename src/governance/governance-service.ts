/**
 * GovernanceService — runtime spending caps, rate limits, and loop detection.
 *
 * Violations surface as err(GovernanceError). ok() means "proceed".
 * When no governance config is present all checks pass through.
 */

import { randomUUID } from 'node:crypto';
import type pino from 'pino';
import { err, ok, type Result } from 'neverthrow';
import type { GovernanceConfig } from '../core/config/config-types.js';
import type { GovernanceRepository } from '../core/database/repositories/governance-repository.js';
import type { RunRepository, TokenAggregateRow } from '../core/database/repositories/run-repository.js';

const RATE_LIMIT_WINDOW_MS = 60_000;
const BUDGET_CACHE_TTL_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const INBOUND_EVENT_TYPE = 'message.inbound';

type GovernanceErrorCode = 'spending_cap_exceeded' | 'rate_limit_exceeded' | 'loop_detected';

interface BudgetCacheEntry { computedAt: number; status: BudgetStatus }
interface CapSnapshot { name: 'hourly' | 'daily'; cap: number; tokensUsed: number }

export interface ToolCall { tool: string; args: Record<string, unknown> }

export class GovernanceError extends Error {
  constructor(public readonly code: GovernanceErrorCode, message: string) {
    super(message);
    this.name = 'GovernanceError';
  }
}

export interface BudgetStatus {
  withinBudget: boolean;
  percentUsed: number;
  warningTriggered: boolean;
  tokensUsed: number;
  cap: number;
}

export interface GovernanceStatus {
  personas: Record<string, { personaId: string; hourlyTokens: number; dailyTokens: number }>;
}

export class GovernanceService {
  private readonly budgetCache = new Map<string, BudgetCacheEntry>();

  constructor(
    private readonly config: GovernanceConfig | undefined,
    private readonly runRepo: RunRepository,
    private readonly govRepo: GovernanceRepository,
    private readonly logger: pino.Logger,
  ) {}

  // ---------------------------------------------------------------------------
  // Spending budget
  // ---------------------------------------------------------------------------

  checkSpendingBudget(personaId: string): Result<BudgetStatus, GovernanceError> {
    const now = Date.now();
    const cached = this.budgetCache.get(personaId);
    if (cached !== undefined && now - cached.computedAt < BUDGET_CACHE_TTL_MS) {
      return this.toBudgetResult(personaId, cached.status);
    }

    const spendingConfig = this.config?.spending;
    if (spendingConfig === undefined) {
      const status = unlimitedStatus();
      this.budgetCache.set(personaId, { computedAt: now, status });
      return ok(status);
    }

    const override = spendingConfig.per_persona?.[personaId];
    const hourlyCap = override?.hourly_token_cap ?? spendingConfig.hourly_token_cap;
    const dailyCap = override?.daily_token_cap ?? spendingConfig.daily_token_cap;
    const warnAt = spendingConfig.warn_at_percent ?? 80;

    if (hourlyCap === undefined && dailyCap === undefined) {
      const status = unlimitedStatus();
      this.budgetCache.set(personaId, { computedAt: now, status });
      return ok(status);
    }

    const caps: CapSnapshot[] = [];

    if (hourlyCap !== undefined) {
      const r = this.runRepo.aggregateByPersona(personaId, now - HOUR_MS, now);
      if (r.isErr()) {
        this.logger.error({ personaId, err: r.error }, 'governance: hourly aggregate failed');
        return err(new GovernanceError('spending_cap_exceeded', 'Failed to evaluate hourly spending budget'));
      }
      caps.push({ name: 'hourly', cap: hourlyCap, tokensUsed: totalTokens(r.value) });
    }

    if (dailyCap !== undefined) {
      const r = this.runRepo.aggregateByPersona(personaId, now - DAY_MS, now);
      if (r.isErr()) {
        this.logger.error({ personaId, err: r.error }, 'governance: daily aggregate failed');
        return err(new GovernanceError('spending_cap_exceeded', 'Failed to evaluate daily spending budget'));
      }
      caps.push({ name: 'daily', cap: dailyCap, tokensUsed: totalTokens(r.value) });
    }

    const chosen = selectCap(caps);
    const status: BudgetStatus = {
      withinBudget: caps.every((c) => c.tokensUsed <= c.cap),
      percentUsed: chosen.cap > 0 ? (chosen.tokensUsed / chosen.cap) * 100 : 0,
      warningTriggered: caps.some((c) => c.cap > 0 && (c.tokensUsed / c.cap) * 100 >= warnAt),
      tokensUsed: chosen.tokensUsed,
      cap: chosen.cap,
    };

    this.budgetCache.set(personaId, { computedAt: now, status });
    if (status.warningTriggered) this.logger.warn({ personaId }, 'governance: approaching spending cap');
    return this.toBudgetResult(personaId, status, chosen.name);
  }

  // ---------------------------------------------------------------------------
  // Rate limiting
  // ---------------------------------------------------------------------------

  checkInboundRate(channelId: string, senderId: string): Result<void, GovernanceError> {
    const rateLimits = this.config?.rate_limits;
    if (rateLimits === undefined) return ok(undefined);

    const pruneResult = this.govRepo.pruneOldEvents(RATE_LIMIT_WINDOW_MS);
    if (pruneResult.isErr()) {
      this.logger.error({ channelId, err: pruneResult.error }, 'governance: prune failed');
      return err(new GovernanceError('rate_limit_exceeded', 'Failed to evaluate inbound rate limit'));
    }

    const chResult = this.govRepo.countRecentEvents(channelId, undefined, INBOUND_EVENT_TYPE, RATE_LIMIT_WINDOW_MS);
    if (chResult.isErr()) {
      this.logger.error({ channelId, err: chResult.error }, 'governance: channel count failed');
      return err(new GovernanceError('rate_limit_exceeded', 'Failed to evaluate inbound rate limit'));
    }

    const snResult = this.govRepo.countRecentEvents(channelId, senderId, INBOUND_EVENT_TYPE, RATE_LIMIT_WINDOW_MS);
    if (snResult.isErr()) {
      this.logger.error({ channelId, senderId, err: snResult.error }, 'governance: sender count failed');
      return err(new GovernanceError('rate_limit_exceeded', 'Failed to evaluate inbound rate limit'));
    }

    const evResult = this.govRepo.recordRateLimitEvent({ id: randomUUID(), channelId, senderId, eventType: INBOUND_EVENT_TYPE });
    if (evResult.isErr()) this.logger.warn({ channelId, senderId, err: evResult.error }, 'governance: failed to record event');

    if (chResult.value >= rateLimits.inbound_per_minute) {
      this.recordViolation({ violation: 'rate_limit', actionTaken: 'blocked', detail: { scope: 'channel', channelId, count: chResult.value, limit: rateLimits.inbound_per_minute } });
      return err(new GovernanceError('rate_limit_exceeded', `Inbound rate limit exceeded for channel ${channelId}`));
    }

    if (snResult.value >= rateLimits.inbound_per_user_per_minute) {
      this.recordViolation({ violation: 'rate_limit', actionTaken: 'blocked', detail: { scope: 'sender', channelId, senderId, count: snResult.value, limit: rateLimits.inbound_per_user_per_minute } });
      return err(new GovernanceError('rate_limit_exceeded', `Inbound rate limit exceeded for sender ${senderId} in channel ${channelId}`));
    }

    return ok(undefined);
  }

  // ---------------------------------------------------------------------------
  // Loop detection
  // ---------------------------------------------------------------------------

  checkLoopConditions(runId: string, turnCount: number, recentCalls: ToolCall[]): Result<void, GovernanceError> {
    const loopCfg = this.config?.loop_detection;
    if (loopCfg === undefined) return ok(undefined);

    if (turnCount >= loopCfg.max_turns_per_run) {
      this.recordViolation({ runId, violation: 'loop_detection', actionTaken: 'blocked', detail: { turnCount, cap: loopCfg.max_turns_per_run } });
      return err(new GovernanceError('loop_detected', `Run ${runId} exceeded max turns (${loopCfg.max_turns_per_run})`));
    }

    const counts = new Map<string, number>();
    for (const call of recentCalls) {
      const key = `${call.tool}:${JSON.stringify(call.args)}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    for (const [key, count] of counts) {
      if (count >= loopCfg.duplicate_call_threshold) {
        this.recordViolation({ runId, violation: 'loop_detection', actionTaken: 'blocked', detail: { duplicateCall: key, count, threshold: loopCfg.duplicate_call_threshold } });
        return err(new GovernanceError('loop_detected', `Run ${runId} detected duplicate tool call: ${key}`));
      }
    }

    return ok(undefined);
  }

  // ---------------------------------------------------------------------------
  // Cache / usage
  // ---------------------------------------------------------------------------

  recordUsage(personaId: string, _usage: { inputTokens: number; outputTokens: number }): void {
    this.budgetCache.delete(personaId);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private toBudgetResult(personaId: string, status: BudgetStatus, capName?: 'hourly' | 'daily'): Result<BudgetStatus, GovernanceError> {
    if (status.withinBudget) return ok(status);
    this.recordViolation({ personaId, violation: 'spending_cap', actionTaken: 'blocked', detail: { capName, cap: status.cap, tokensUsed: status.tokensUsed } });
    this.logger.warn({ personaId, capName }, 'governance: spending cap exceeded');
    return err(new GovernanceError('spending_cap_exceeded', `${capName ?? 'configured'} spending cap exceeded for persona ${personaId}`));
  }

  private recordViolation(input: { personaId?: string; runId?: string; violation: string; actionTaken: string; detail: Record<string, unknown> }): void {
    const r = this.govRepo.recordViolation({ id: randomUUID(), personaId: input.personaId, runId: input.runId, violation: input.violation, actionTaken: input.actionTaken, detail: input.detail });
    if (r.isErr()) this.logger.warn({ err: r.error }, 'governance: failed to record violation');
  }
}

// Alias used by external consumers and index.ts
export { GovernanceService as GovernanceServiceImpl };

// ---------------------------------------------------------------------------
// Pure helpers (module-level, no side effects)
// ---------------------------------------------------------------------------

function unlimitedStatus(): BudgetStatus {
  return { withinBudget: true, percentUsed: 0, warningTriggered: false, tokensUsed: 0, cap: 0 };
}

function totalTokens(row: TokenAggregateRow): number {
  return row.total_input_tokens + row.total_output_tokens;
}

function selectCap(caps: CapSnapshot[]): CapSnapshot {
  const exceeded = caps.filter((c) => c.tokensUsed > c.cap).sort((a, b) => b.tokensUsed / b.cap - a.tokensUsed / a.cap);
  if (exceeded.length > 0) return exceeded[0];
  return [...caps].sort((a, b) => b.tokensUsed / b.cap - a.tokensUsed / a.cap)[0];
}
