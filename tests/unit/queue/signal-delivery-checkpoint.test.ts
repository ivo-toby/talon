import { describe, expect, it } from 'vitest';
import {
  parseSignalDeliveryCheckpoint,
  parseSignalDeliveryStartedMarker,
  SIGNAL_CHECKPOINT_LIFETIME_MS,
  SIGNAL_CHECKPOINT_MAX_BYTES,
  SIGNAL_CHECKPOINT_TEXT_MAX_BYTES,
  SIGNAL_DELIVERY_CHECKPOINT_KEY,
  SIGNAL_DELIVERY_STARTED_KEY,
  type SignalDeliveryCheckpoint,
} from '../../../src/queue/signal-delivery-checkpoint.js';

const accountUuid = 'aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb';
const checkpoint: SignalDeliveryCheckpoint = {
  version: 1,
  queueItemId: 'queue-1',
  deliveryId: 'delivery-1',
  runId: 'run-1',
  kind: 'reply',
  personaId: 'persona-1',
  threadId: 'thread-1',
  channelName: 'signal-main',
  accountUuid,
  destination: `signal:v1:${accountUuid}:self`,
  body: 'hello 😀',
  chunks: ['hello ', '😀'],
  nextChunk: 0,
  phase: 'ready',
  currentChunkAcceptance: 'unwritten',
  acceptedChunks: 0,
  successCount: 0,
  failureCount: 0,
  createdAt: 1_000,
  expiresAt: 1_000 + SIGNAL_CHECKPOINT_LIFETIME_MS,
};
const context = { queueItemId: 'queue-1', now: 2_000 };

function parse(
  change: Record<string, unknown> = {},
): ReturnType<typeof parseSignalDeliveryCheckpoint> {
  return parseSignalDeliveryCheckpoint({ ...checkpoint, ...change }, context);
}

describe('Signal saved final/background delivery contract', () => {
  it('round trips exact original and fixed prepared text with immutable returned chunks', () => {
    const parsed = parseSignalDeliveryCheckpoint(
      JSON.stringify(checkpoint),
      context,
    )._unsafeUnwrap();
    expect(parsed).toEqual(checkpoint);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.chunks)).toBe(true);
  });

  it('does not fabricate a run for a background notification', () => {
    const { runId: _runId, ...background } = checkpoint;
    const parsed = parseSignalDeliveryCheckpoint(
      { ...background, kind: 'background' },
      context,
    )._unsafeUnwrap();
    expect(parsed.runId).toBeUndefined();
    expect(parsed.queueItemId).toBe('queue-1');
  });

  it('represents ready deferral after accepted chunks, in-flight recovery, delivered and terminal phases', () => {
    const advanced = { nextChunk: 1, acceptedChunks: 1, successCount: 2 };
    expect(parse({ ...advanced, currentChunkAcceptance: 'refused' }).isOk()).toBe(true);
    expect(
      parse({ ...advanced, phase: 'in_flight', currentChunkAcceptance: 'unknown' }).isOk(),
    ).toBe(true);
    expect(
      parse({
        nextChunk: 2,
        acceptedChunks: 2,
        successCount: 4,
        phase: 'delivered',
        currentChunkAcceptance: 'complete',
      }).isOk(),
    ).toBe(true);
    expect(
      parse({
        ...advanced,
        phase: 'terminal',
        currentChunkAcceptance: 'partial',
        terminalReason: 'PARTIAL_ACCEPTANCE',
        terminalOutcome: 'PARTIAL',
        failureCount: 1,
      }).isOk(),
    ).toBe(true);
  });

  it.each<Partial<SignalDeliveryCheckpoint>>([
    { nextChunk: 0, acceptedChunks: 0, successCount: 1, currentChunkAcceptance: 'refused' },
    { nextChunk: 0, acceptedChunks: 0, successCount: 1, currentChunkAcceptance: 'unwritten' },
    { nextChunk: 1, acceptedChunks: 1, successCount: 1, currentChunkAcceptance: 'partial' },
    { nextChunk: 2, acceptedChunks: 2, successCount: 2, currentChunkAcceptance: 'partial' },
    { nextChunk: 0, acceptedChunks: 0, successCount: 0, currentChunkAcceptance: 'partial' },
    { nextChunk: 1, acceptedChunks: 1, successCount: 0, currentChunkAcceptance: 'refused' },
  ])(
    'rejects terminal PARTIAL evidence without the required earlier/current successes: %j',
    (change) => {
      const result = parse({
        chunks: ['one', 'two', 'three'],
        phase: 'terminal',
        terminalReason: 'TARGET_REFUSED',
        terminalOutcome: 'PARTIAL',
        failureCount: 1,
        ...change,
      });
      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.reason).toBe('INVALID');
        expect(result.error.cause).toBeUndefined();
      }
    },
  );

  it.each<Partial<SignalDeliveryCheckpoint>>([
    {
      terminalOutcome: 'NOT_SENT',
      nextChunk: 0,
      acceptedChunks: 0,
      successCount: 0,
      currentChunkAcceptance: 'refused',
    },
    {
      terminalOutcome: 'NOT_SENT',
      nextChunk: 0,
      acceptedChunks: 0,
      successCount: 0,
      currentChunkAcceptance: 'unwritten',
    },
    {
      terminalOutcome: 'PARTIAL',
      nextChunk: 1,
      acceptedChunks: 1,
      successCount: 1,
      currentChunkAcceptance: 'refused',
    },
    {
      terminalOutcome: 'PARTIAL',
      nextChunk: 1,
      acceptedChunks: 1,
      successCount: 8,
      currentChunkAcceptance: 'unwritten',
    },
    {
      terminalOutcome: 'PARTIAL',
      nextChunk: 0,
      acceptedChunks: 0,
      successCount: 1,
      currentChunkAcceptance: 'partial',
    },
    {
      terminalOutcome: 'PARTIAL',
      nextChunk: 1,
      acceptedChunks: 1,
      successCount: 2,
      currentChunkAcceptance: 'partial',
    },
    {
      terminalOutcome: 'PARTIAL',
      nextChunk: 1,
      acceptedChunks: 1,
      successCount: 8,
      currentChunkAcceptance: 'partial',
    },
    {
      terminalOutcome: 'PARTIAL',
      nextChunk: 2,
      acceptedChunks: 2,
      successCount: 3,
      currentChunkAcceptance: 'partial',
    },
    {
      terminalOutcome: 'UNKNOWN',
      nextChunk: 0,
      acceptedChunks: 0,
      successCount: 1,
      currentChunkAcceptance: 'unknown',
    },
    {
      terminalOutcome: 'UNKNOWN',
      nextChunk: 1,
      acceptedChunks: 1,
      successCount: 1,
      currentChunkAcceptance: 'unknown',
    },
  ])('preserves adjacent legal terminal chunk/recipient combinations: %j', (change) => {
    const result = parse({
      chunks: ['one', 'two', 'three'],
      phase: 'terminal',
      terminalReason: 'TARGET_REFUSED',
      failureCount: 1,
      ...change,
    });
    expect(result.isOk()).toBe(true);
    if (result.isOk()) expect(result.value).toMatchObject(change);
  });

  it.each([
    { version: 2 },
    { queueItemId: 'other' },
    { deliveryId: '' },
    { runId: '' },
    { accountUuid: 'other' },
    { destination: `signal:v1:cccccccc-1111-2222-3333-dddddddddddd:self` },
    { chunks: [] },
    { chunks: [''] },
    { chunks: ['😀'.repeat(501)] },
    { chunks: ['\ud800'] },
    { nextChunk: -1 },
    { nextChunk: 3 },
    { nextChunk: 0.5 },
    { acceptedChunks: 1 },
    { phase: 'ready', currentChunkAcceptance: 'partial' },
    { phase: 'in_flight' },
    { phase: 'delivered', currentChunkAcceptance: 'complete' },
    { phase: 'terminal' },
    { expiresAt: checkpoint.expiresAt + 1 },
    { createdAt: 3_000, expiresAt: 3_000 + SIGNAL_CHECKPOINT_LIFETIME_MS },
    { successCount: Number.MAX_SAFE_INTEGER + 1 },
    { failureCount: -1 },
    { terminalReason: 'TIMEOUT' },
    { phase: 'provider' },
    { secretRemoteKey: 'private' },
    { kind: 'background' },
    { nextChunk: 1, acceptedChunks: 1, successCount: 0 },
    { successCount: 1 },
    { phase: 'in_flight', currentChunkAcceptance: 'unknown', successCount: 1 },
    {
      phase: 'terminal',
      terminalReason: 'NETWORK_FAILURE',
      terminalOutcome: 'NOT_SENT',
      currentChunkAcceptance: 'unknown',
    },
    {
      phase: 'terminal',
      terminalReason: 'PARTIAL_ACCEPTANCE',
      terminalOutcome: 'PARTIAL',
      currentChunkAcceptance: 'partial',
      successCount: 0,
    },
    {
      phase: 'terminal',
      terminalReason: 'UNKNOWN_ACCEPTANCE',
      terminalOutcome: 'UNKNOWN',
      currentChunkAcceptance: 'unwritten',
    },
  ])('fails closed on malformed identity/bounds/state: %j', (change) => {
    expect(parse(change).isErr()).toBe(true);
  });

  it('enforces 1MiB UTF-8 original-body and combined-chunk limits, not character counts', () => {
    expect(parse({ body: 'a'.repeat(SIGNAL_CHECKPOINT_TEXT_MAX_BYTES) }).isOk()).toBe(true);
    expect(parse({ body: 'a'.repeat(SIGNAL_CHECKPOINT_TEXT_MAX_BYTES + 1) }).isErr()).toBe(true);
    expect(parse({ body: '😀'.repeat(SIGNAL_CHECKPOINT_TEXT_MAX_BYTES / 4 + 1) }).isErr()).toBe(
      true,
    );
    const full = [...Array.from({ length: 524 }, () => 'a'.repeat(2_000)), 'b'.repeat(576)];
    expect(parse({ chunks: full }).isOk()).toBe(true);
    expect(parse({ chunks: [...full, 'x'] }).isErr()).toBe(true);
  });

  it('enforces serialized size independently of body/chunk bytes (JSON escaping)', () => {
    const body = '\0'.repeat(SIGNAL_CHECKPOINT_TEXT_MAX_BYTES);
    expect(parse({ body })._unsafeUnwrapErr().reason).toBe('TOO_LARGE');
    expect(
      parseSignalDeliveryCheckpoint(
        ' '.repeat(SIGNAL_CHECKPOINT_MAX_BYTES + 1),
        context,
      )._unsafeUnwrapErr().reason,
    ).toBe('TOO_LARGE');
  });

  it('keeps a fixed 24h deadline, rejects expired pending work, but permits delivered local finalization', () => {
    expect(SIGNAL_CHECKPOINT_LIFETIME_MS).toBe(86_400_000);
    expect(
      parseSignalDeliveryCheckpoint(checkpoint, {
        ...context,
        now: checkpoint.expiresAt - 1,
      }).isOk(),
    ).toBe(true);
    expect(
      parseSignalDeliveryCheckpoint(checkpoint, {
        ...context,
        now: checkpoint.expiresAt,
      })._unsafeUnwrapErr().reason,
    ).toBe('EXPIRED');
    const delivered = {
      ...checkpoint,
      nextChunk: 2,
      acceptedChunks: 2,
      successCount: 2,
      phase: 'delivered',
      currentChunkAcceptance: 'complete',
    };
    expect(
      parseSignalDeliveryCheckpoint(delivered, {
        ...context,
        now: checkpoint.expiresAt + 1,
      }).isOk(),
    ).toBe(true);
  });

  it('returns safe typed errors for invalid persisted JSON and never includes input or dynamic paths', () => {
    for (const input of ['{"secret-token":', null, [], { privateIdentifier: 'private-body' }]) {
      const result = parseSignalDeliveryCheckpoint(input, context);
      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.message).toBe('Signal checkpoint rejected: INVALID');
        expect(result.error.cause).toBeUndefined();
        expect(JSON.stringify(result.error)).not.toContain('private');
      }
    }
  });

  it('keeps the invocation guard separate from a saved reply and tied to the trusted queue item', () => {
    const marker = {
      version: 1,
      queueItemId: 'queue-1',
      deliveryId: 'explicit-1',
      purpose: 'explicit',
      startedAt: 1_000,
    };
    expect(SIGNAL_DELIVERY_CHECKPOINT_KEY).not.toBe(SIGNAL_DELIVERY_STARTED_KEY);
    expect(parseSignalDeliveryStartedMarker(marker, 'queue-1').isOk()).toBe(true);
    expect(parseSignalDeliveryStartedMarker(marker, 'other')._unsafeUnwrapErr().reason).toBe(
      'IDENTITY_MISMATCH',
    );
    expect(parseSignalDeliveryStartedMarker(checkpoint, 'queue-1').isErr()).toBe(true);
    expect(parseSignalDeliveryCheckpoint(marker, context).isErr()).toBe(true);
  });
});
