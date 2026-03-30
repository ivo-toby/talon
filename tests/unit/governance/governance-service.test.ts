import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ok } from 'neverthrow';
import type { GovernanceConfig } from '../../../src/core/config/config-types.js';
import type { GovernanceRepository } from '../../../src/core/database/repositories/governance-repository.js';
import type {
  RunRepository,
  TokenAggregateRow,
} from '../../../src/core/database/repositories/run-repository.js';
import { GovernanceError, GovernanceServiceImpl } from '../../../src/governance/governance-service.js';

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
    listViolations: vi.fn().mockReturnValue(ok([])),
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

  it('returns permissive defaults when governance config is undefined', () => {
    const service = new GovernanceServiceImpl(
      undefined,
      runRepo as unknown as RunRepository,
      governanceRepo as unknown as GovernanceRepository,
    );

    expect(service.checkInboundRate('ch', 'snd')._unsafeUnwrap()).toBeUndefined();
    expect(service.checkSpendingBudget('p1', 'p1')._unsafeUnwrap()).toEqual({
      withinBudget: true,
      percentUsed: 0,
      warningTriggered: false,
      tokensUsed: 0,
      cap: 0,
    });
    expect(service.checkLoopConditions('r1', 99, [])._unsafeUnwrap()).toBeUndefined();

    expect(governanceRepo.pruneOldEvents).not.toHaveBeenCalled();
    expect(governanceRepo.recordRateLimitEvent).not.toHaveBeenCalled();
    expect(governanceRepo.recordViolation).not.toHaveBeenCalled();
    expect(runRepo.aggregateByPersona).not.toHaveBeenCalled();
  });

  it('checkInboundRate allows requests under both channel and sender limits', () => {
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
      runRepo as unknown as RunRepository,
      governanceRepo as unknown as GovernanceRepository,
    );

    const result = service.checkInboundRate('channel-1', 'sender-1');

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBeUndefined();
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

  it('checkInboundRate blocks when channel count reaches the per-minute limit', () => {
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
      runRepo as unknown as RunRepository,
      governanceRepo as unknown as GovernanceRepository,
    );

    const result = service.checkInboundRate('channel-1', 'sender-1');

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(GovernanceError);
    expect(result._unsafeUnwrapErr()).toMatchObject({ code: 'rate_limit_exceeded' });
    expect(governanceRepo.recordViolation).toHaveBeenCalledWith(
      expect.objectContaining({ violation: 'rate_limit', actionTaken: 'blocked' }),
    );
  });

  it('checkInboundRate blocks when the per-sender limit is reached', () => {
    governanceRepo.countRecentEvents
      .mockReturnValueOnce(ok(1))
      .mockReturnValueOnce(ok(3));

    const service = new GovernanceServiceImpl(
      {
        rate_limits: {
          inbound_per_minute: 10,
          inbound_per_user_per_minute: 3,
          api_calls_per_minute: 60,
        },
      } satisfies GovernanceConfig,
      runRepo as unknown as RunRepository,
      governanceRepo as unknown as GovernanceRepository,
    );

    const result = service.checkInboundRate('channel-1', 'sender-1');

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(GovernanceError);
    expect(result._unsafeUnwrapErr()).toMatchObject({ code: 'rate_limit_exceeded' });
    expect(governanceRepo.recordViolation).toHaveBeenCalledWith(
      expect.objectContaining({ violation: 'rate_limit', actionTaken: 'blocked' }),
    );
  });

  it('checkSpendingBudget allows when usage is under all caps', () => {
    runRepo.aggregateByPersona
      .mockReturnValueOnce(ok(makeAggregateRow({ total_input_tokens: 10, total_output_tokens: 10 })))
      .mockReturnValueOnce(ok(makeAggregateRow({ total_input_tokens: 30, total_output_tokens: 20 })));

    const service = new GovernanceServiceImpl(
      { spending: { daily_token_cap: 100, hourly_token_cap: 50, warn_at_percent: 80 } } satisfies GovernanceConfig,
      runRepo as unknown as RunRepository,
      governanceRepo as unknown as GovernanceRepository,
    );

    const result = service.checkSpendingBudget('persona-1', 'persona-1');

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({
      withinBudget: true,
      percentUsed: 50,
      warningTriggered: false,
      tokensUsed: 50,
      cap: 100,
    });
    expect(runRepo.aggregateByPersona).toHaveBeenNthCalledWith(1, 'persona-1', 1_000_000 - 3_600_000, 1_000_000);
    expect(runRepo.aggregateByPersona).toHaveBeenNthCalledWith(2, 'persona-1', 1_000_000 - 86_400_000, 1_000_000);
  });

  it('checkSpendingBudget blocks when the daily cap is exceeded', () => {
    runRepo.aggregateByPersona
      .mockReturnValueOnce(ok(makeAggregateRow({ total_input_tokens: 10, total_output_tokens: 10 })))
      .mockReturnValueOnce(ok(makeAggregateRow({ total_input_tokens: 60, total_output_tokens: 50 })));

    const service = new GovernanceServiceImpl(
      { spending: { daily_token_cap: 100, hourly_token_cap: 50, warn_at_percent: 80 } } satisfies GovernanceConfig,
      runRepo as unknown as RunRepository,
      governanceRepo as unknown as GovernanceRepository,
    );

    const result = service.checkSpendingBudget('persona-1', 'persona-1');

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(GovernanceError);
    expect(result._unsafeUnwrapErr()).toMatchObject({ code: 'spending_cap_exceeded' });
    expect(governanceRepo.recordViolation).toHaveBeenCalledWith(
      expect.objectContaining({ personaId: 'persona-1', violation: 'spending_cap', actionTaken: 'blocked' }),
    );
  });

  it('checkSpendingBudget blocks when the hourly cap is exceeded', () => {
    runRepo.aggregateByPersona.mockReturnValueOnce(
      ok(makeAggregateRow({ total_input_tokens: 30, total_output_tokens: 25 })),
    );

    const service = new GovernanceServiceImpl(
      { spending: { hourly_token_cap: 50, warn_at_percent: 80 } } satisfies GovernanceConfig,
      runRepo as unknown as RunRepository,
      governanceRepo as unknown as GovernanceRepository,
    );

    const result = service.checkSpendingBudget('persona-1', 'persona-1');

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(GovernanceError);
    expect(result._unsafeUnwrapErr()).toMatchObject({ code: 'spending_cap_exceeded' });
    expect(governanceRepo.recordViolation).toHaveBeenCalledWith(
      expect.objectContaining({ personaId: 'persona-1', violation: 'spending_cap', actionTaken: 'blocked' }),
    );
  });

  it('checkSpendingBudget does not cache successful checks (race protection)', () => {
    runRepo.aggregateByPersona.mockReturnValue(
      ok(makeAggregateRow({ total_input_tokens: 10, total_output_tokens: 10 })),
    );

    const service = new GovernanceServiceImpl(
      { spending: { daily_token_cap: 200, hourly_token_cap: 100, warn_at_percent: 80 } } satisfies GovernanceConfig,
      runRepo as unknown as RunRepository,
      governanceRepo as unknown as GovernanceRepository,
    );

    service.checkSpendingBudget('persona-1', 'persona-1');
    service.checkSpendingBudget('persona-1', 'persona-1');

    // Each call queries both hourly and daily — no caching on success.
    expect(runRepo.aggregateByPersona).toHaveBeenCalledTimes(4);
  });

  it('checkLoopConditions blocks when max_turns_per_run is reached', () => {
    const service = new GovernanceServiceImpl(
      { loop_detection: { max_turns_per_run: 5, duplicate_call_threshold: 3, max_queue_depth_per_thread: 100 } } satisfies GovernanceConfig,
      runRepo as unknown as RunRepository,
      governanceRepo as unknown as GovernanceRepository,
    );

    const result = service.checkLoopConditions('run-1', 5, []);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(GovernanceError);
    expect(result._unsafeUnwrapErr()).toMatchObject({ code: 'loop_detected' });
    expect(governanceRepo.recordViolation).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run-1', violation: 'loop_detection', actionTaken: 'blocked' }),
    );
  });

  it('checkLoopConditions blocks on duplicate tool calls at the configured threshold', () => {
    const service = new GovernanceServiceImpl(
      { loop_detection: { max_turns_per_run: 10, duplicate_call_threshold: 3, max_queue_depth_per_thread: 100 } } satisfies GovernanceConfig,
      runRepo as unknown as RunRepository,
      governanceRepo as unknown as GovernanceRepository,
    );

    const result = service.checkLoopConditions('run-1', 2, [
      { tool: 'web_search', args: { q: 'a' } },
      { tool: 'web_search', args: { q: 'a' } },
      { tool: 'web_search', args: { q: 'a' } },
    ]);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(GovernanceError);
    expect(result._unsafeUnwrapErr()).toMatchObject({ code: 'loop_detected' });
    expect(governanceRepo.recordViolation).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run-1', violation: 'loop_detection', actionTaken: 'blocked' }),
    );
  });

  it('checkLoopConditions allows when under all thresholds', () => {
    const service = new GovernanceServiceImpl(
      { loop_detection: { max_turns_per_run: 10, duplicate_call_threshold: 3, max_queue_depth_per_thread: 100 } } satisfies GovernanceConfig,
      runRepo as unknown as RunRepository,
      governanceRepo as unknown as GovernanceRepository,
    );

    const result = service.checkLoopConditions('run-1', 3, [
      { tool: 'web_search', args: { q: 'a' } },
      { tool: 'web_search', args: { q: 'b' } },
    ]);

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBeUndefined();
    expect(governanceRepo.recordViolation).not.toHaveBeenCalled();
  });
});
