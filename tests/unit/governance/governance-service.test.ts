import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ok } from 'neverthrow';
import type { GovernanceConfig } from '../../../src/core/config/config-types.js';
import type { GovernanceRepository } from '../../../src/core/database/repositories/governance-repository.js';
import type {
  RunRepository,
  TokenAggregateRow,
} from '../../../src/core/database/repositories/run-repository.js';
import { GovernanceServiceImpl } from '../../../src/governance/governance-service.js';

function makeAggregateRow(
  overrides: Partial<TokenAggregateRow> = {},
): TokenAggregateRow {
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

describe('GovernanceServiceImpl', () => {
  let governanceRepo: ReturnType<typeof createGovernanceRepoMock>;
  let runRepo: ReturnType<typeof createRunRepoMock>;

  beforeEach(() => {
    governanceRepo = createGovernanceRepoMock();
    runRepo = createRunRepoMock();
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('checkInboundRate allows under limit', () => {
    governanceRepo.countRecentEvents
      .mockReturnValueOnce(ok(1))
      .mockReturnValueOnce(ok(0));

    const service = new GovernanceServiceImpl(
      {
        rate_limits: {
          inbound_per_minute: 2,
          inbound_per_user_per_minute: 1,
          api_calls_per_minute: 60,
        },
      } satisfies GovernanceConfig,
      governanceRepo as unknown as GovernanceRepository,
      runRepo as unknown as RunRepository,
    );

    const result = service.checkInboundRate('channel-1', 'sender-1');

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({ allowed: true });
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
    expect(governanceRepo.recordViolation).not.toHaveBeenCalled();
  });

  it('checkInboundRate blocks at limit', () => {
    governanceRepo.countRecentEvents
      .mockReturnValueOnce(ok(2))
      .mockReturnValueOnce(ok(0));

    const service = new GovernanceServiceImpl(
      {
        rate_limits: {
          inbound_per_minute: 2,
          inbound_per_user_per_minute: 5,
          api_calls_per_minute: 60,
        },
      } satisfies GovernanceConfig,
      governanceRepo as unknown as GovernanceRepository,
      runRepo as unknown as RunRepository,
    );

    const result = service.checkInboundRate('channel-1', 'sender-1');

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toMatchObject({
      allowed: false,
      violation: 'rate_limit',
    });
    expect(governanceRepo.recordRateLimitEvent).toHaveBeenCalledTimes(1);
    expect(governanceRepo.recordViolation).toHaveBeenCalledWith(
      expect.objectContaining({
        violation: 'rate_limit',
        actionTaken: 'blocked',
      }),
    );
  });

  it('checkSpendingBudget blocks when daily cap exceeded', async () => {
    runRepo.aggregateByPersona
      .mockReturnValueOnce(
        ok(makeAggregateRow({ total_input_tokens: 10, total_output_tokens: 10 })),
      )
      .mockReturnValueOnce(
        ok(makeAggregateRow({ total_input_tokens: 60, total_output_tokens: 50 })),
      );

    const service = new GovernanceServiceImpl(
      {
        spending: {
          daily_token_cap: 100,
          hourly_token_cap: 50,
          warn_at_percent: 80,
        },
      } satisfies GovernanceConfig,
      governanceRepo as unknown as GovernanceRepository,
      runRepo as unknown as RunRepository,
    );

    const result = await service.checkSpendingBudget('persona-1');

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toMatchObject({
      allowed: false,
      violation: 'spending_cap',
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
    expect(governanceRepo.recordViolation).toHaveBeenCalledWith(
      expect.objectContaining({
        personaId: 'persona-1',
        violation: 'spending_cap',
        actionTaken: 'blocked',
      }),
    );
  });

  it('checkLoopConditions blocks at max_turns_per_run', () => {
    const service = new GovernanceServiceImpl(
      {
        loop_detection: {
          max_turns_per_run: 5,
          duplicate_call_threshold: 3,
          max_queue_depth_per_thread: 100,
        },
      } satisfies GovernanceConfig,
      governanceRepo as unknown as GovernanceRepository,
      runRepo as unknown as RunRepository,
    );

    const result = service.checkLoopConditions('run-1', 5, []);

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toMatchObject({
      allowed: false,
      violation: 'loop_detection',
    });
    expect(governanceRepo.recordViolation).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-1',
        violation: 'loop_detection',
        actionTaken: 'blocked',
      }),
    );
  });

  it('checkLoopConditions blocks on duplicate tool calls', () => {
    const service = new GovernanceServiceImpl(
      {
        loop_detection: {
          max_turns_per_run: 10,
          duplicate_call_threshold: 3,
          max_queue_depth_per_thread: 100,
        },
      } satisfies GovernanceConfig,
      governanceRepo as unknown as GovernanceRepository,
      runRepo as unknown as RunRepository,
    );

    const result = service.checkLoopConditions('run-1', 2, [
      { tool: 'web_search', args: { q: 'a' } },
      { tool: 'web_search', args: { q: 'a' } },
      { tool: 'web_search', args: { q: 'a' } },
    ]);

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toMatchObject({
      allowed: false,
      violation: 'loop_detection',
    });
    expect(governanceRepo.recordViolation).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-1',
        violation: 'loop_detection',
        actionTaken: 'blocked',
      }),
    );
  });

  it('returns allowed when governance config is undefined', async () => {
    const service = new GovernanceServiceImpl(
      undefined,
      governanceRepo as unknown as GovernanceRepository,
      runRepo as unknown as RunRepository,
    );

    expect(service.checkInboundRate('channel-1', 'sender-1')._unsafeUnwrap()).toEqual({
      allowed: true,
    });
    expect(
      (await service.checkSpendingBudget('persona-1'))._unsafeUnwrap(),
    ).toEqual({ allowed: true });
    expect(
      service.checkLoopConditions('run-1', 999, [
        { tool: 'tool', args: { a: 1 } },
        { tool: 'tool', args: { a: 1 } },
      ])._unsafeUnwrap(),
    ).toEqual({ allowed: true });

    expect(governanceRepo.pruneOldEvents).not.toHaveBeenCalled();
    expect(governanceRepo.recordRateLimitEvent).not.toHaveBeenCalled();
    expect(governanceRepo.recordViolation).not.toHaveBeenCalled();
    expect(runRepo.aggregateByPersona).not.toHaveBeenCalled();
  });
});
