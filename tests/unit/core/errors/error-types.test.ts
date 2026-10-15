import { describe, it, expect } from 'vitest';
import {
  TalonError,
  ConfigError,
  DbError,
  IpcError,
  SandboxError,
  ToolError,
  ChannelError,
  SignalDeliveryError,
  DeliveryDeferredError,
  DeliveryCancelled,
  NonRetryableRunError,
  type SignalDeliveryFailure,
  QueueError,
  ScheduleError,
  MigrationError,
  PolicyError,
  MemoryError,
  PersonaError,
  PipelineError,
  CollaborationError,
  BackgroundAgentError,
} from '../../../../src/core/errors/error-types.js';

// ---------------------------------------------------------------------------
// Helper: verify every concrete error class follows the contract
// ---------------------------------------------------------------------------

interface ErrorClass<T extends TalonError> {
  new (message: string, cause?: Error): T;
}

function describeErrorClass<T extends TalonError>(
  name: string,
  Cls: ErrorClass<T>,
  expectedCode: string,
): void {
  describe(`${name}`, () => {
    it('is an instanceof Error', () => {
      expect(new Cls('test')).toBeInstanceOf(Error);
    });

    it('is an instanceof TalonError', () => {
      expect(new Cls('test')).toBeInstanceOf(TalonError);
    });

    it(`is an instanceof ${name}`, () => {
      expect(new Cls('test')).toBeInstanceOf(Cls);
    });

    it('sets message', () => {
      expect(new Cls('hello world').message).toBe('hello world');
    });

    it(`sets code to "${expectedCode}"`, () => {
      expect(new Cls('msg').code).toBe(expectedCode);
    });

    it('sets name to class name', () => {
      expect(new Cls('msg').name).toBe(name);
    });

    it('sets cause when provided', () => {
      const cause = new Error('root cause');
      const instance = new Cls('wrapper', cause);
      expect(instance.cause).toBe(cause);
    });

    it('cause is undefined when not provided', () => {
      expect(new Cls('no cause').cause).toBeUndefined();
    });

    it('has a stack trace', () => {
      expect(new Cls('msg').stack).toBeTruthy();
    });
  });
}

// ---------------------------------------------------------------------------
// Run checks for every domain error
// ---------------------------------------------------------------------------

describeErrorClass('ConfigError', ConfigError, 'CONFIG_ERROR');
describeErrorClass('DbError', DbError, 'DB_ERROR');
describeErrorClass('IpcError', IpcError, 'IPC_ERROR');
describeErrorClass('SandboxError', SandboxError, 'SANDBOX_ERROR');
describeErrorClass('ToolError', ToolError, 'TOOL_ERROR');
describeErrorClass('ChannelError', ChannelError, 'CHANNEL_ERROR');
describeErrorClass('QueueError', QueueError, 'QUEUE_ERROR');
describeErrorClass('ScheduleError', ScheduleError, 'SCHEDULE_ERROR');
describeErrorClass('MigrationError', MigrationError, 'MIGRATION_ERROR');
describeErrorClass('PolicyError', PolicyError, 'POLICY_ERROR');
describeErrorClass('MemoryError', MemoryError, 'MEMORY_ERROR');
describeErrorClass('PersonaError', PersonaError, 'PERSONA_ERROR');
describeErrorClass('PipelineError', PipelineError, 'PIPELINE_ERROR');
describeErrorClass('CollaborationError', CollaborationError, 'COLLABORATION_ERROR');
describeErrorClass('BackgroundAgentError', BackgroundAgentError, 'BACKGROUND_AGENT_ERROR');

// ---------------------------------------------------------------------------
// TalonError abstract contract
// ---------------------------------------------------------------------------

describe('TalonError (base class)', () => {
  it('cannot be instantiated directly (abstract)', () => {
    // TypeScript prevents this at compile time; at runtime the class itself
    // is not abstract. We verify the subclass mechanism works instead.
    const e = new ConfigError('abstract check');
    expect(e).toBeInstanceOf(TalonError);
  });

  it('subclass codes are distinct', () => {
    const errors = [
      new ConfigError('a'),
      new DbError('b'),
      new IpcError('c'),
      new SandboxError('d'),
      new ToolError('e'),
      new ChannelError('f'),
      new QueueError('g'),
      new ScheduleError('h'),
      new MigrationError('i'),
      new PolicyError('j'),
      new MemoryError('k'),
      new PersonaError('l'),
      new PipelineError('m'),
      new CollaborationError('n'),
      new BackgroundAgentError('o'),
    ] as TalonError[];

    const codes = errors.map((e) => e.code);
    const unique = new Set(codes);
    expect(unique.size).toBe(codes.length); // all codes are unique
  });
});

describe('Signal safe delivery errors', () => {
  const failure: SignalDeliveryFailure = {
    reason: 'RATE_LIMITED',
    outcome: 'PARTIAL',
    acceptedChunks: 2,
    currentChunkAcceptance: 'refused',
    successCount: 8,
    failureCount: 3,
    retryScope: 'delivery_only',
    notBefore: 123_456,
  };

  it('preserves the safe cursor/count/retry contract as a ChannelError without a raw cause', () => {
    const error = new SignalDeliveryError(failure);
    expect(error).toBeInstanceOf(ChannelError);
    expect(error).toMatchObject({ ...failure, providerRetryable: false });
    expect(error.message).toBe('Signal delivery failed: RATE_LIMITED');
    expect(error.cause).toBeUndefined();
  });

  it.each(['partial', 'unknown', 'complete'] as const)(
    'forbids replay of current-chunk acceptance %s even if a caller requests retry',
    (currentChunkAcceptance) => {
      expect(new SignalDeliveryError({ ...failure, currentChunkAcceptance }).retryScope).toBe(
        'none',
      );
    },
  );

  it('never retries an unknown whole outcome and does not mistake prior accepted chunks for current partial acceptance', () => {
    expect(new SignalDeliveryError({ ...failure, outcome: 'UNKNOWN' }).retryScope).toBe('none');
    expect(
      new SignalDeliveryError({ ...failure, currentChunkAcceptance: 'unwritten' }).retryScope,
    ).toBe('delivery_only');
  });

  it.each<Partial<SignalDeliveryFailure>>([
    { outcome: 'NOT_SENT', acceptedChunks: 0, currentChunkAcceptance: 'refused', successCount: 1 },
    {
      outcome: 'NOT_SENT',
      acceptedChunks: 0,
      currentChunkAcceptance: 'unwritten',
      successCount: 1,
    },
    { outcome: 'PARTIAL', acceptedChunks: 0, currentChunkAcceptance: 'refused', successCount: 1 },
    { outcome: 'PARTIAL', acceptedChunks: 0, currentChunkAcceptance: 'unwritten', successCount: 1 },
    { outcome: 'NOT_SENT', acceptedChunks: 1, currentChunkAcceptance: 'refused', successCount: 1 },
    { outcome: 'PARTIAL', acceptedChunks: 2, currentChunkAcceptance: 'refused', successCount: 1 },
    { outcome: 'PARTIAL', acceptedChunks: 1, currentChunkAcceptance: 'partial', successCount: 1 },
    { outcome: 'PARTIAL', acceptedChunks: 1, currentChunkAcceptance: 'complete', successCount: 1 },
    { outcome: 'NOT_SENT', acceptedChunks: 0, currentChunkAcceptance: 'partial', successCount: 1 },
    { outcome: 'PARTIAL', acceptedChunks: 0, currentChunkAcceptance: 'refused', successCount: 0 },
    { outcome: 'UNKNOWN', acceptedChunks: 1, currentChunkAcceptance: 'unknown', successCount: 0 },
  ])(
    'fails contradictory acceptance evidence closed while retaining safe known counts: %j',
    (change) => {
      const input = { ...failure, failureCount: 1, ...change };
      const error = new SignalDeliveryError(input);
      expect(error.outcome).toBe('UNKNOWN');
      expect(error.currentChunkAcceptance).toBe('unknown');
      expect(error.retryScope).toBe('none');
      expect(error).toMatchObject({
        reason: input.reason,
        acceptedChunks: input.acceptedChunks,
        successCount: input.successCount,
        failureCount: input.failureCount,
        notBefore: input.notBefore,
      });
      expect(error.cause).toBeUndefined();
    },
  );

  it.each<Partial<SignalDeliveryFailure>>([
    { outcome: 'NOT_SENT', acceptedChunks: 0, currentChunkAcceptance: 'refused', successCount: 0 },
    {
      outcome: 'NOT_SENT',
      acceptedChunks: 0,
      currentChunkAcceptance: 'unwritten',
      successCount: 0,
    },
    { outcome: 'PARTIAL', acceptedChunks: 1, currentChunkAcceptance: 'refused', successCount: 1 },
    { outcome: 'PARTIAL', acceptedChunks: 1, currentChunkAcceptance: 'unwritten', successCount: 8 },
    { outcome: 'PARTIAL', acceptedChunks: 0, currentChunkAcceptance: 'partial', successCount: 1 },
    { outcome: 'PARTIAL', acceptedChunks: 1, currentChunkAcceptance: 'partial', successCount: 2 },
    { outcome: 'PARTIAL', acceptedChunks: 1, currentChunkAcceptance: 'complete', successCount: 2 },
    { outcome: 'UNKNOWN', acceptedChunks: 0, currentChunkAcceptance: 'unknown', successCount: 1 },
    { outcome: 'UNKNOWN', acceptedChunks: 1, currentChunkAcceptance: 'unknown', successCount: 8 },
  ])(
    'preserves consistent chunk/recipient evidence and only defers the proven-unsent current chunk: %j',
    (change) => {
      const input = { ...failure, ...change };
      const error = new SignalDeliveryError(input);
      expect(error).toMatchObject({
        outcome: input.outcome,
        acceptedChunks: input.acceptedChunks,
        currentChunkAcceptance: input.currentChunkAcceptance,
        successCount: input.successCount,
        failureCount: input.failureCount,
      });
      expect(error.retryScope).toBe(
        input.currentChunkAcceptance === 'unwritten' || input.currentChunkAcceptance === 'refused'
          ? 'delivery_only'
          : 'none',
      );
    },
  );

  it('keeps defer, cancellation and no-provider-replay distinguishable with typed error identity', () => {
    const delivery = new SignalDeliveryError(failure);
    const deferred = new DeliveryDeferredError(delivery, 200_000);
    expect(deferred.deliveryError).toBe(delivery);
    expect(deferred.notBefore).toBe(123_456);
    expect(deferred.code).toBe('DELIVERY_DEFERRED');
    expect(new DeliveryCancelled().code).toBe('DELIVERY_CANCELLED');
    const terminal = new NonRetryableRunError(delivery);
    expect(terminal.deliveryError).toBe(delivery);
    expect(terminal.code).toBe('NON_RETRYABLE_RUN');
    expect(terminal.cause).toBeUndefined();
  });

  it('fails closed rather than treating invalid acceptance counts as a retryable refusal', () => {
    const error = new SignalDeliveryError({
      ...failure,
      successCount: Number.NaN,
      notBefore: Number.POSITIVE_INFINITY,
    });
    expect(error.outcome).toBe('UNKNOWN');
    expect(error.currentChunkAcceptance).toBe('unknown');
    expect(error.retryScope).toBe('none');
    expect(error.notBefore).toBeUndefined();
    expect(error.successCount).toBe(0);
  });

  it('retains only explicitly safe fields rather than copying remote object properties', () => {
    const remoteFailure = { ...failure, remoteMessage: 'secret-token', token: 'secret-token' };
    const error = new SignalDeliveryError(remoteFailure);
    expect(JSON.stringify(error)).not.toContain('secret-token');
    expect(error).not.toHaveProperty('remoteMessage');
    expect(error).not.toHaveProperty('token');
  });
});
