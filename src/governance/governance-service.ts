import { randomUUID } from 'node:crypto';
import { ok, err, type Result } from 'neverthrow';
import type { GovernanceConfig } from '../core/config/config-types.js';
import type { GovernanceRepository } from '../core/database/repositories/governance-repository.js';
import type { RunRepository, TokenAggregateRow } from '../core/database/repositories/run-repository.js';

const RATE_LIMIT_EVENT_TYPE = 'message.inbound';
const RATE_LIMIT_WINDOW_MS = 60_000;
const BUDGET_CACHE_TTL_MS = 60_000;
const HOURLY_WINDOW_MS = 3_600_000;
const DAILY_WINDOW_MS = 86_400_000;

export type GovernanceViolationType = 'rate_limit' | 'spending_cap' | 'loop_detection';
export type GovernanceActionTaken = 'blocked' | 'warned';
export type GovernanceErrorCode = 'rate_limit_exceeded' | 'spending_cap_exceeded' | 'loop_detected' | 'query_failed';

export class GovernanceError extends Error {
  constructor(
    public readonly code: GovernanceErrorCode,
    message: string,
  ) {
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

export interface ToolCall {
  tool: string;
  args: unknown;
}

export interface GovernanceStatus {
  personaId: string;
  dailyTokensUsed: number;
  dailyTokenCap?: number;
  hourlyTokensUsed: number;
  hourlyTokenCap?: number;
}

export interface GovernanceService {
  checkInboundRate(channelId: string, senderId: string): Result<void, GovernanceError>;
  checkSpendingBudget(personaId: string): Result<BudgetStatus, GovernanceError>;
  checkLoopConditions(runId: string, turnCount: number, recentCalls: ToolCall[]): Result<void, GovernanceError>;
  recordUsage(personaId: string, usage: { inputTokens: number; outputTokens: number }): void;
  getStatus(personaId: string): Result<GovernanceStatus, GovernanceError>;
}

interface CachedBudget {
  status: BudgetStatus;
  computedAt: number;
}

export class GovernanceServiceImpl implements GovernanceService {
  private readonly budgetCache = new Map<string, CachedBudget>();

  constructor(
    private readonly config: GovernanceConfig | undefined,
    private readonly runRepo: RunRepository,
    private readonly governanceRepo: GovernanceRepository,
  ) {}

  checkInboundRate(channelId: string, senderId: string): Result<void, GovernanceError> {
    const rateLimits = this.config?.rate_limits;
    if (!rateLimits) return ok(undefined);

    this.governanceRepo.pruneOldEvents(RATE_LIMIT_WINDOW_MS);

    const channelCountResult = this.governanceRepo.countRecentEvents(channelId, undefined, RATE_LIMIT_EVENT_TYPE, RATE_LIMIT_WINDOW_MS);
    if (channelCountResult.isErr()) {
      return err(new GovernanceError('rate_limit_exceeded', 'Unable to verify rate limits (DB error) — fail-closed'));
    }

    const senderCountResult = this.governanceRepo.countRecentEvents(channelId, senderId, RATE_LIMIT_EVENT_TYPE, RATE_LIMIT_WINDOW_MS);
    if (senderCountResult.isErr()) {
      return err(new GovernanceError('rate_limit_exceeded', 'Unable to verify rate limits (DB error) — fail-closed'));
    }

    this.governanceRepo.recordRateLimitEvent({ id: randomUUID(), channelId, senderId, eventType: RATE_LIMIT_EVENT_TYPE });

    const channelCount = channelCountResult.value;
    const senderCount = senderCountResult.value;

    if (channelCount >= rateLimits.inbound_per_minute) {
      this.governanceRepo.recordViolation({ id: randomUUID(), violation: 'rate_limit', detail: { scope: 'channel', channelId, count: channelCount, limit: rateLimits.inbound_per_minute }, actionTaken: 'blocked' });
      return err(new GovernanceError('rate_limit_exceeded', `Channel rate limit reached for ${channelId}`));
    }

    if (senderCount >= rateLimits.inbound_per_user_per_minute) {
      this.governanceRepo.recordViolation({ id: randomUUID(), violation: 'rate_limit', detail: { scope: 'sender', channelId, senderId, count: senderCount, limit: rateLimits.inbound_per_user_per_minute }, actionTaken: 'blocked' });
      return err(new GovernanceError('rate_limit_exceeded', `Per-user rate limit reached for ${senderId}`));
    }

    return ok(undefined);
  }

  checkSpendingBudget(personaId: string): Result<BudgetStatus, GovernanceError> {
    const spending = this.config?.spending;
    if (!spending) return ok(zeroBudgetStatus());

    const now = Date.now();
    const cached = this.budgetCache.get(personaId);
    if (cached && cached.computedAt + BUDGET_CACHE_TTL_MS > now) {
      if (!cached.status.withinBudget) {
        return err(new GovernanceError('spending_cap_exceeded', `Spending cap exceeded for ${personaId} (cached)`));
      }
      return ok(cached.status);
    }

    const perPersona = spending.per_persona?.[personaId];
    const hourlyCap = perPersona?.hourly_token_cap ?? spending.hourly_token_cap ?? null;
    const dailyCap = perPersona?.daily_token_cap ?? spending.daily_token_cap ?? null;
    const warnAt = spending.warn_at_percent ?? 80;

    if (hourlyCap === null && dailyCap === null) return ok(zeroBudgetStatus());

    let hourlyTokens = 0;
    let dailyTokens = 0;

    if (hourlyCap !== null) {
      const result = this.runRepo.aggregateByPersona(personaId, now - HOURLY_WINDOW_MS, now);
      if (result.isErr()) return err(new GovernanceError('spending_cap_exceeded', `Failed to query hourly usage for ${personaId} — fail-closed`));
      hourlyTokens = sumTokens(result.value);
      if (hourlyTokens >= hourlyCap) {
        const status: BudgetStatus = { withinBudget: false, percentUsed: (hourlyTokens / hourlyCap) * 100, warningTriggered: true, tokensUsed: hourlyTokens, cap: hourlyCap };
        this.governanceRepo.recordViolation({ id: randomUUID(), personaId, violation: 'spending_cap', detail: { scope: 'hourly', tokensUsed: hourlyTokens, cap: hourlyCap }, actionTaken: 'blocked' });
        this.budgetCache.set(personaId, { status, computedAt: now });
        return err(new GovernanceError('spending_cap_exceeded', `Hourly token cap exceeded for ${personaId}`));
      }
    }

    if (dailyCap !== null) {
      const result = this.runRepo.aggregateByPersona(personaId, now - DAILY_WINDOW_MS, now);
      if (result.isErr()) return err(new GovernanceError('spending_cap_exceeded', `Failed to query daily usage for ${personaId} — fail-closed`));
      dailyTokens = sumTokens(result.value);
      if (dailyTokens >= dailyCap) {
        const status: BudgetStatus = { withinBudget: false, percentUsed: (dailyTokens / dailyCap) * 100, warningTriggered: true, tokensUsed: dailyTokens, cap: dailyCap };
        this.governanceRepo.recordViolation({ id: randomUUID(), personaId, violation: 'spending_cap', detail: { scope: 'daily', tokensUsed: dailyTokens, cap: dailyCap }, actionTaken: 'blocked' });
        this.budgetCache.set(personaId, { status, computedAt: now });
        return err(new GovernanceError('spending_cap_exceeded', `Daily token cap exceeded for ${personaId}`));
      }
    }

    const candidates: BudgetStatus[] = [];
    if (hourlyCap !== null) candidates.push({ withinBudget: true, percentUsed: (hourlyTokens / hourlyCap) * 100, warningTriggered: (hourlyTokens / hourlyCap) * 100 >= warnAt, tokensUsed: hourlyTokens, cap: hourlyCap });
    if (dailyCap !== null) candidates.push({ withinBudget: true, percentUsed: (dailyTokens / dailyCap) * 100, warningTriggered: (dailyTokens / dailyCap) * 100 >= warnAt, tokensUsed: dailyTokens, cap: dailyCap });
    const status = candidates.sort((a, b) => b.percentUsed - a.percentUsed)[0];
    this.budgetCache.set(personaId, { status, computedAt: now });
    return ok(status);
  }

  checkLoopConditions(runId: string, turnCount: number, recentCalls: ToolCall[]): Result<void, GovernanceError> {
    const loopDetection = this.config?.loop_detection;
    if (!loopDetection) return ok(undefined);

    if (turnCount >= loopDetection.max_turns_per_run) {
      this.governanceRepo.recordViolation({ id: randomUUID(), runId, violation: 'loop_detection', detail: { turnCount, maxTurnsPerRun: loopDetection.max_turns_per_run }, actionTaken: 'blocked' });
      return err(new GovernanceError('loop_detected', `Max turns exceeded in run ${runId}`));
    }

    const counts = new Map<string, number>();
    for (const call of recentCalls) {
      const key = `${call.tool}:${JSON.stringify(call.args)}`;
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      if (count >= loopDetection.duplicate_call_threshold) {
        this.governanceRepo.recordViolation({ id: randomUUID(), runId, violation: 'loop_detection', detail: { tool: call.tool, duplicateCount: count, threshold: loopDetection.duplicate_call_threshold }, actionTaken: 'blocked' });
        return err(new GovernanceError('loop_detected', `Duplicate tool call loop detected in run ${runId}`));
      }
    }

    return ok(undefined);
  }

  recordUsage(personaId: string, _usage: { inputTokens: number; outputTokens: number }): void {
    this.budgetCache.delete(personaId);
  }

  getStatus(personaId: string): Result<GovernanceStatus, GovernanceError> {
    const spending = this.config?.spending;
    const perPersona = spending?.per_persona?.[personaId];
    const hourlyCap = perPersona?.hourly_token_cap ?? spending?.hourly_token_cap;
    const dailyCap = perPersona?.daily_token_cap ?? spending?.daily_token_cap;
    const now = Date.now();

    const hourlyResult = this.runRepo.aggregateByPersona(personaId, now - HOURLY_WINDOW_MS, now);
    if (hourlyResult.isErr()) return err(new GovernanceError('query_failed', 'Failed to query hourly usage'));
    const dailyResult = this.runRepo.aggregateByPersona(personaId, now - DAILY_WINDOW_MS, now);
    if (dailyResult.isErr()) return err(new GovernanceError('query_failed', 'Failed to query daily usage'));

    return ok({ personaId, hourlyTokensUsed: sumTokens(hourlyResult.value), hourlyTokenCap: hourlyCap, dailyTokensUsed: sumTokens(dailyResult.value), dailyTokenCap: dailyCap });
  }
}

function sumTokens(row: TokenAggregateRow): number {
  return row.total_input_tokens + row.total_output_tokens;
}

function zeroBudgetStatus(): BudgetStatus {
  return { withinBudget: true, percentUsed: 0, warningTriggered: false, tokensUsed: 0, cap: 0 };
}
