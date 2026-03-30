import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { err, ok } from 'neverthrow';
import type { GovernanceConfig } from '../../../src/core/config/config-types.js';
import type { GovernanceRepository } from '../../../src/core/database/repositories/governance-repository.js';
import type {
  RunRepository,
  TokenAggregateRow,
} from '../../../src/core/database/repositories/run-repository.js';
import { GovernanceError, GovernanceService } from '../../../src/governance/governance-service.js';

function makeAggregateRow(overrides: Partial<TokenAggregateRow> = {}): TokenAggregateRow {
  return {
    total_input_tokens: 0,
    total_output_tokens: 0,
    total_cache_read_tokens: 0,
    total_cache_write_tokens: 0,
    total_cost_usd: 0,
    run_count: 0,
    ...overrides,
  };
}

function createGovernanceRepoMock() {
  return {
    recordRateLimitEvent: vi.fn().mockReturnValue(ok(undefined)),
    countRecentEvents: vi.fn().mockReturnValue(ok(0)),
    pruneOldEvents: vi.fn().mockReturnValue(ok(undefined)),
    recordViolation: vi.fn().mockReturnValue(ok(undefined)),
  };
}

function createRunRepoMock() {
  return {
    aggregateByPersona: vi.fn().mockReturnValue(ok(makeAggregateRow())),
  };
}

describe('GovernanceService', () => {
  let governanceRepo: ReturnType<typeof createGovernanceRepoMock>;
  let runRepo: ReturnType<typeof createRunRepoMock>;
  let logger: pino.Logger;

  beforeEach(() => {
    governanceRepo = createGovernanceRepoMock();
    runRepo = createRunRepoMock();
    logger = pino({ level: 'silent' });
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns ok budget status when within configured caps', () => {
    runRepo.aggregateByPersona
      .mockReturnValueOnce(
        ok(makeAggregateRow({ total_input_tokens: 20, total_output_tokens: 10 })),
      )
      .mockReturnValueOnce(
        ok(makeAggregateRow({ total_input_tokens: 40, total_output_tokens: 20 })),
      );

    const service = new GovernanceService(
      {
        spending: {
          daily_token_cap: 100,
          hourly_token_cap: 50,
          warn_at_percent: 80,
        },
      } satisfies GovernanceConfig,
      runRepo as unknown as RunRepository,
      governanceRepo as unknown as GovernanceRepository,
      logger,
    );

    const result = service.checkSpendingBudget('persona-1');

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({
      withinBudget: true,
      percentUsed: 60,
      warningTriggered: false,
      tokensUsed: 30,
      cap: 50,
    });
    expect(runRepo.aggregateByPersona).toHaveBeenNthCalledWith(
      1,
      'persona-1',
      1_000_000 - 3_600_000,
      1_000_000,
    );
    expect(runRepo.aggregateByPersona).toHaveBeenNthCalledWith(
      2,
      'persona-1',
      1_000_000 - 86_400_000,
      1_000_000,
    );
  });

  it('caches budget checks for 60 seconds and invalidates on usage recording', () => {
    runRepo.aggregateByPersona
      .mockReturnValueOnce(
        ok(makeAggregateRow({ total_input_tokens: 20, total_output_tokens: 20 })),
      )
      .mockReturnValueOnce(
        ok(makeAggregateRow({ total_input_tokens: 40, total_output_tokens: 30 })),
      )
      .mockReturnValueOnce(
        ok(makeAggregateRow({ total_input_tokens: 25, total_output_tokens: 15 })),
      )
      .mockReturnValueOnce(
        ok(makeAggregateRow({ total_input_tokens: 55, total_output_tokens: 20 })),
      );

    const service = new GovernanceService(
      {
        spending: {
          daily_token_cap: 100,
          hourly_token_cap: 50,
          warn_at_percent: 80,
        },
      } satisfies GovernanceConfig,
      runRepo as unknown as RunRepository,
      governanceRepo as unknown as GovernanceRepository,
      logger,
    );

    expect(service.checkSpendingBudget('persona-1').isOk()).toBe(true);
    expect(service.checkSpendingBudget('persona-1').isOk()).toBe(true);
    expect(runRepo.aggregateByPersona).toHaveBeenCalledTimes(2);

    service.recordUsage('persona-1', { inputTokens: 1, outputTokens: 2 });
    expect(service.checkSpendingBudget('persona-1').isOk()).toBe(true);
    expect(runRepo.aggregateByPersona).toHaveBeenCalledTimes(4);
  });

  it('returns err when a spending cap is exceeded', () => {
    runRepo.aggregateByPersona
      .mockReturnValueOnce(
        ok(makeAggregateRow({ total_input_tokens: 15, total_output_tokens: 10 })),
      )
      .mockReturnValueOnce(
        ok(makeAggregateRow({ total_input_tokens: 80, total_output_tokens: 30 })),
      );

    const service = new GovernanceService(
      {
        spending: {
          daily_token_cap: 100,
          hourly_token_cap: 50,
          warn_at_percent: 80,
        },
      } satisfies GovernanceConfig,
      runRepo as unknown as RunRepository,
      governanceRepo as unknown as GovernanceRepository,
      logger,
    );

    const result = service.checkSpendingBudget('persona-1');

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toEqual(
      new GovernanceError('spending_cap_exceeded', 'daily spending cap exceeded for persona persona-1'),
    );
    expect(governanceRepo.recordViolation).toHaveBeenCalledWith(
      expect.objectContaining({
        personaId: 'persona-1',
        violation: 'spending_cap',
        actionTaken: 'blocked',
      }),
    );
  });

  it('returns err when channel inbound rate exceeds the configured limit', () => {
    governanceRepo.countRecentEvents
      .mockReturnValueOnce(ok(2))
      .mockReturnValueOnce(ok(0));

    const service = new GovernanceService(
      {
        rate_limits: {
          inbound_per_minute: 2,
          inbound_per_user_per_minute: 5,
          api_calls_per_minute: 60,
        },
      } satisfies GovernanceConfig,
      runRepo as unknown as RunRepository,
      governanceRepo as unknown as GovernanceRepository,
      logger,
    );

    const result = service.checkInboundRate('channel-1', 'sender-1');

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toEqual(
      new GovernanceError('rate_limit_exceeded', 'Inbound rate limit exceeded for channel channel-1'),
    );
    expect(governanceRepo.pruneOldEvents).toHaveBeenCalledWith(60_000);
    expect(governanceRepo.countRecentEvents).toHaveBeenNthCalledWith(
      1,
      'channel-1',
      undefined,
      'message.inbound',
      60_000,
    );
    expect(governanceRepo.countRecentEvents).toHaveBeenNthCalledWith(
      2,
      'channel-1',
      'sender-1',
      'message.inbound',
      60_000,
    );
    expect(governanceRepo.recordRateLimitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: 'channel-1',
        senderId: 'sender-1',
        eventType: 'message.inbound',
      }),
    );
  });

  it('returns ok when inbound traffic is under both limits', () => {
    governanceRepo.countRecentEvents
      .mockReturnValueOnce(ok(1))
      .mockReturnValueOnce(ok(0));

    const service = new GovernanceService(
      {
        rate_limits: {
          inbound_per_minute: 2,
          inbound_per_user_per_minute: 1,
          api_calls_per_minute: 60,
        },
      } satisfies GovernanceConfig,
      runRepo as unknown as RunRepository,
      governanceRepo as unknown as GovernanceRepository,
      logger,
    );

    const result = service.checkInboundRate('channel-1', 'sender-1');

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBeUndefined();
    expect(governanceRepo.recordViolation).not.toHaveBeenCalled();
  });

  it('returns permissive defaults when governance config is undefined', () => {
    const service = new GovernanceService(
      undefined,
      runRepo as unknown as RunRepository,
      governanceRepo as unknown as GovernanceRepository,
      logger,
    );

    expect(service.checkInboundRate('channel-1', 'sender-1')._unsafeUnwrap()).toBeUndefined();
    expect(service.checkSpendingBudget('persona-1')._unsafeUnwrap()).toEqual({
      withinBudget: true,
      percentUsed: 0,
      warningTriggered: false,
      tokensUsed: 0,
      cap: 0,
    });
    expect(governanceRepo.pruneOldEvents).not.toHaveBeenCalled();
    expect(governanceRepo.recordRateLimitEvent).not.toHaveBeenCalled();
    expect(runRepo.aggregateByPersona).not.toHaveBeenCalled();
  });

  it('returns err when repository aggregation fails during budget checks', () => {
    runRepo.aggregateByPersona.mockReturnValueOnce(err(new Error('db down')));

    const service = new GovernanceService(
      {
        spending: {
          hourly_token_cap: 50,
          warn_at_percent: 80,
        },
      } satisfies GovernanceConfig,
      runRepo as unknown as RunRepository,
      governanceRepo as unknown as GovernanceRepository,
      logger,
    );

    const result = service.checkSpendingBudget('persona-1');

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toEqual(
      new GovernanceError('spending_cap_exceeded', 'Failed to evaluate hourly spending budget'),
    );
  });
});
