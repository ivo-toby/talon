import { randomUUID } from 'node:crypto';
import { ok, type Result } from 'neverthrow';
import type { GovernanceConfig } from '../core/config/config-types.js';
import type { GovernanceRepository } from '../core/database/repositories/governance-repository.js';
import type { RunRepository, TokenAggregateRow } from '../core/database/repositories/run-repository.js';

const RATE_LIMIT_EVENT_TYPE = 'message.inbound';
const RATE_LIMIT_WINDOW_MS = 60_000;
const HOURLY_WINDOW_MS = 3_600_000;
const DAILY_WINDOW_MS = 86_400_000;
const CACHE_TTL_MS = 60_000;

export type GovernanceCheckResult =
  | { allowed: true }
  | { allowed: false; reason: string; violation: 'rate_limit' | 'spending_cap' | 'loop_detection' };

export interface GovernanceService {
  checkInboundRate(channelId: string, senderId: string): Result<GovernanceCheckResult, never>;
  checkSpendingBudget(personaId: string): Result<GovernanceCheckResult, never>;
  checkLoopConditions(
    runId: string,
    turnCount: number,
    recentCalls: Array<{ tool: string; args: unknown }>,
  ): Result<GovernanceCheckResult, never>;
  recordUsage(personaId: string, usage: { inputTokens: number; outputTokens: number }): void;
}

interface CachedBudget {
  result: Result<GovernanceCheckResult, never>;
  expiresAt: number;
}

export class GovernanceServiceImpl implements GovernanceService {
  private readonly budgetCache = new Map<string, CachedBudget>();

  constructor(
    private readonly config: GovernanceConfig | undefined,
    private readonly runRepo: RunRepository,
    private readonly governanceRepo: GovernanceRepository,
  ) {}

  checkInboundRate(channelId: string, senderId: string): Result<GovernanceCheckResult, never> {
    const rateLimits = this.config?.rate_limits;
    if (!rateLimits) return ok({ allowed: true });

    const pruneResult = this.governanceRepo.pruneOldEvents(RATE_LIMIT_WINDOW_MS);
    if (pruneResult.isErr()) {
      console.error('governance: pruneOldEvents failed', pruneResult.error);
    }

    // Count channel-level and sender-level events BEFORE recording the new one
    const channelCountResult = this.governanceRepo.countRecentEvents(
      channelId,
      undefined,
      RATE_LIMIT_EVENT_TYPE,
      RATE_LIMIT_WINDOW_MS,
    );
    const senderCountResult = this.governanceRepo.countRecentEvents(
      channelId,
      senderId,
      RATE_LIMIT_EVENT_TYPE,
      RATE_LIMIT_WINDOW_MS,
    );

    // Always record the event (fire-and-forget)
    const recordResult = this.governanceRepo.recordRateLimitEvent({
      id: randomUUID(),
      channelId,
      senderId,
      eventType: RATE_LIMIT_EVENT_TYPE,
    });
    if (recordResult.isErr()) {
      console.error('governance: recordRateLimitEvent failed', recordResult.error);
    }

    const channelCount = channelCountResult.isOk() ? channelCountResult.value : 0;
    const senderCount = senderCountResult.isOk() ? senderCountResult.value : 0;

    if (channelCount >= rateLimits.inbound_per_minute) {
      this.governanceRepo.recordViolation({
        id: randomUUID(),
        violation: 'rate_limit',
        detail: { scope: 'channel', channelId, count: channelCount, limit: rateLimits.inbound_per_minute },
        actionTaken: 'blocked',
      });
      return ok({
        allowed: false,
        reason: `Channel rate limit reached for ${channelId}`,
        violation: 'rate_limit',
      });
    }

    if (senderCount >= rateLimits.inbound_per_user_per_minute) {
      this.governanceRepo.recordViolation({
        id: randomUUID(),
        violation: 'rate_limit',
        detail: {
          scope: 'sender',
          channelId,
          senderId,
          count: senderCount,
          limit: rateLimits.inbound_per_user_per_minute,
        },
        actionTaken: 'blocked',
      });
      return ok({
        allowed: false,
        reason: `Per-user rate limit reached for ${senderId}`,
        violation: 'rate_limit',
      });
    }

    return ok({ allowed: true });
  }

  checkSpendingBudget(personaId: string): Result<GovernanceCheckResult, never> {
    const spending = this.config?.spending;
    if (!spending) return ok({ allowed: true });

    const now = Date.now();

    // Return cached result if still fresh
    const cached = this.budgetCache.get(personaId);
    if (cached !== undefined && now < cached.expiresAt) {
      return cached.result;
    }

    const perPersona = spending.per_persona?.[personaId];
    const hourlyCap = perPersona?.hourly_token_cap ?? spending.hourly_token_cap ?? null;
    const dailyCap = perPersona?.daily_token_cap ?? spending.daily_token_cap ?? null;

    if (hourlyCap === null && dailyCap === null) return ok({ allowed: true });

    // Check hourly cap first
    if (hourlyCap !== null) {
      const result = this.runRepo.aggregateByPersona(personaId, now - HOURLY_WINDOW_MS, now);
      if (result.isOk() && sumTokens(result.value) >= hourlyCap) {
        const tokens = sumTokens(result.value);
        this.governanceRepo.recordViolation({
          id: randomUUID(),
          personaId,
          violation: 'spending_cap',
          detail: { scope: 'hourly', tokensUsed: tokens, cap: hourlyCap },
          actionTaken: 'blocked',
        });
        const blocked = ok<GovernanceCheckResult, never>({
          allowed: false,
          reason: `Hourly token cap exceeded for ${personaId}`,
          violation: 'spending_cap',
        });
        this.budgetCache.set(personaId, { result: blocked, expiresAt: now + CACHE_TTL_MS });
        return blocked;
      }
    }

    // Check daily cap
    if (dailyCap !== null) {
      const result = this.runRepo.aggregateByPersona(personaId, now - DAILY_WINDOW_MS, now);
      if (result.isOk() && sumTokens(result.value) >= dailyCap) {
        const tokens = sumTokens(result.value);
        this.governanceRepo.recordViolation({
          id: randomUUID(),
          personaId,
          violation: 'spending_cap',
          detail: { scope: 'daily', tokensUsed: tokens, cap: dailyCap },
          actionTaken: 'blocked',
        });
        const blocked = ok<GovernanceCheckResult, never>({
          allowed: false,
          reason: `Daily token cap exceeded for ${personaId}`,
          violation: 'spending_cap',
        });
        this.budgetCache.set(personaId, { result: blocked, expiresAt: now + CACHE_TTL_MS });
        return blocked;
      }
    }

    const allowed = ok<GovernanceCheckResult, never>({ allowed: true });
    this.budgetCache.set(personaId, { result: allowed, expiresAt: now + CACHE_TTL_MS });
    return allowed;
  }

  checkLoopConditions(
    runId: string,
    turnCount: number,
    recentCalls: Array<{ tool: string; args: unknown }>,
  ): Result<GovernanceCheckResult, never> {
    const loopDetection = this.config?.loop_detection;
    if (!loopDetection) return ok({ allowed: true });

    if (turnCount >= loopDetection.max_turns_per_run) {
      this.governanceRepo.recordViolation({
        id: randomUUID(),
        runId,
        violation: 'loop_detection',
        detail: { turnCount, maxTurnsPerRun: loopDetection.max_turns_per_run },
        actionTaken: 'blocked',
      });
      return ok({
        allowed: false,
        reason: `Max turns exceeded in run ${runId}`,
        violation: 'loop_detection',
      });
    }

    const counts = new Map<string, number>();
    for (const call of recentCalls) {
      const key = `${call.tool}:${JSON.stringify(call.args)}`;
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      if (count >= loopDetection.duplicate_call_threshold) {
        this.governanceRepo.recordViolation({
          id: randomUUID(),
          runId,
          violation: 'loop_detection',
          detail: { tool: call.tool, duplicateCount: count, threshold: loopDetection.duplicate_call_threshold },
          actionTaken: 'blocked',
        });
        return ok({
          allowed: false,
          reason: `Duplicate tool call loop detected in run ${runId}`,
          violation: 'loop_detection',
        });
      }
    }

    return ok({ allowed: true });
  }

  recordUsage(personaId: string, _usage: { inputTokens: number; outputTokens: number }): void {
    // Invalidate cached budget so next check re-queries fresh data
    this.budgetCache.delete(personaId);
  }
}

function sumTokens(row: TokenAggregateRow): number {
  return row.total_input_tokens + row.total_output_tokens;
}
