import { describe, expect, it } from 'vitest';
import { err, ok } from '../../../../../src/core/types/result.js';
import { SignalDeliveryError } from '../../../../../src/core/errors/error-types.js';
import {
  SignalRpcTransportError,
  type SignalRpcResult,
  type SignalTransportCode,
} from '../../../../../src/channels/connectors/signal/signal-rpc-client.js';
import {
  parseSignalRpcFrame,
  parseSignalSendEvidence,
  SignalRpcRemoteError,
  type SignalSendEvidence,
} from '../../../../../src/channels/connectors/signal/signal-wire.js';
import {
  classifySignalSendResult,
  interpretSignalRestrictions,
  type SignalSendProgress,
} from '../../../../../src/channels/connectors/signal/signal-send-result.js';
import {
  parseSignalDeliveryCheckpoint,
  SIGNAL_CHECKPOINT_LIFETIME_MS,
} from '../../../../../src/queue/signal-delivery-checkpoint.js';

// Source contracts only, NOT live-device evidence. Pinned signal-cli v0.14.9,
// commit 3997429779095ff3a2d64c877126e84fce9852aa; paths below are upstream-relative.
// research/signal-cli-v0.14.9/src/main/java/org/asamk/signal/json/
// JsonSendMessageResult.java:10-48 and JsonRecipientAddress.java:9-15 define these fields.
const recipientAddress = {
  uuid: 'cccccccc-1111-2222-3333-dddddddddddd',
  number: null,
  username: null,
};
const now = 1_000_000;
const empty: SignalSendProgress = { acceptedChunks: 0, successCount: 0, failureCount: 0 };
const previous: SignalSendProgress = { acceptedChunks: 2, successCount: 5, failureCount: 0 };
const entry = (type: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  recipientAddress,
  type,
  ...extra,
});
function evidence(results: readonly unknown[], timestamp: unknown = 100): SignalSendEvidence {
  return parseSignalSendEvidence({ timestamp, results });
}
function send(results: readonly unknown[], timestamp: unknown = 100): SignalRpcResult {
  return ok({ kind: 'send', evidence: evidence(results, timestamp) });
}
function remote(code: number, response?: unknown): SignalRpcRemoteError {
  // research/signal-cli-v0.14.9/src/main/java/org/asamk/signal/jsonrpc/
  // SignalJsonRpcCommandHandler.java:40-44,249-290: output survives under error.data.response.
  // JsonRpcResponse.java:13-46,75-105: an error is not a success envelope.
  const frame = parseSignalRpcFrame(
    Buffer.from(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 'fixture',
        error: {
          code,
          message: 'private-message',
          data: { response, privateField: 'private-data' },
        },
      }),
    ),
  )._unsafeUnwrap();
  if (frame.kind !== 'failure') throw new Error('Expected fixture failure');
  return frame.error;
}
function failure(
  result: SignalRpcResult,
  progress: SignalSendProgress = empty,
): SignalDeliveryError {
  return classifySignalSendResult(result, progress, now).result._unsafeUnwrapErr();
}

// The implementation must consume sanitized producer evidence, not demand discarded fields.
describe('classifySignalSendResult', () => {
  it('accepts only an ordinary, complete, nonempty all-SUCCESS result and returns chunk-local counts', () => {
    // research/signal-cli-v0.14.9/src/main/java/org/asamk/signal/util/
    // SendMessageResultUtils.java:43-68 writes timestamp/results before throwing on no success.
    const input: SignalRpcResult = ok({
      kind: 'send',
      evidence: {
        complete: true,
        timestampValid: true,
        results: [
          {
            valid: true,
            type: 'SUCCESS',
            challengeRequired: false,
            retryAfter: { kind: 'absent' },
          },
        ],
      },
    });
    expect(classifySignalSendResult(input, previous, now)).toMatchObject({ restrictions: [] });
    expect(classifySignalSendResult(input, previous, now).result._unsafeUnwrap()).toEqual({
      acceptance: 'complete',
      successCount: 1,
      failureCount: 0,
    });
    expect(
      classifySignalSendResult(
        send([entry('SUCCESS'), entry('SUCCESS')]),
        empty,
        now,
      ).result._unsafeUnwrap().successCount,
    ).toBe(2);
  });

  it.each([undefined, null, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '100'])(
    'rejects missing/malformed timestamp %j while retaining valid counts',
    (timestamp) => {
      const outcome = failure(
        ok({
          kind: 'send',
          evidence: parseSignalSendEvidence({
            timestamp,
            results: [entry('SUCCESS'), entry('IDENTITY_FAILURE')],
          }),
        }),
        previous,
      );
      expect(outcome).toMatchObject({
        outcome: 'UNKNOWN',
        currentChunkAcceptance: 'unknown',
        acceptedChunks: 2,
        successCount: 6,
        failureCount: 1,
        retryScope: 'none',
      });
    },
  );

  it.each([
    undefined,
    {},
    { timestamp: 100 },
    { timestamp: 100, results: [] },
    { timestamp: 100, results: {} },
    { timestamp: 100, results: [entry('FUTURE_RESULT')] },
    { timestamp: 100, results: [entry('SUCCESS'), null] },
    {
      timestamp: 100,
      results: [entry('SUCCESS'), entry('IDENTITY_FAILURE', { recipientAddress: {} })],
    },
  ])('treats malformed/empty/unknown evidence as UNKNOWN: %j', (value) => {
    const classified = classifySignalSendResult(
      ok({ kind: 'send', evidence: parseSignalSendEvidence(value) }),
      empty,
      now,
    );
    expect(classified.result._unsafeUnwrapErr()).toMatchObject({
      outcome: 'UNKNOWN',
      retryScope: 'none',
    });
    expect(classified.restrictions).toEqual([{ kind: 'recovery' }]);
  });

  it('counts only entirely valid known entries, retaining valid failures beside malformed ones', () => {
    expect(
      failure(
        send([
          entry('SUCCESS'),
          entry('SUCCESS', { recipientAddress: {} }),
          entry('UNREGISTERED_FAILURE'),
          entry('RATE_LIMIT_FAILURE', { retryAfterSeconds: 'bad' }),
          entry('FUTURE_RESULT'),
        ]),
        previous,
      ),
    ).toMatchObject({ outcome: 'UNKNOWN', successCount: 6, failureCount: 1 });
  });

  it.each(['NETWORK_FAILURE', 'UNKNOWN'])(
    'gives uncertainty precedence over valid successes/failures for %s',
    (type) => {
      const classified = classifySignalSendResult(
        send([entry('SUCCESS'), entry(type), entry('IDENTITY_FAILURE')]),
        previous,
        now,
      );
      expect(classified.result._unsafeUnwrapErr()).toMatchObject({
        outcome: 'UNKNOWN',
        successCount: 6,
        failureCount: type === 'NETWORK_FAILURE' ? 2 : 1,
      });
      expect(classified.restrictions).toEqual([{ kind: 'recovery' }]);
    },
  );

  it.each(['UNREGISTERED_FAILURE', 'IDENTITY_FAILURE', 'INVALID_PRE_KEY_FAILURE'])(
    'distinguishes whole permanent %s refusal from earlier complete chunks',
    (type) => {
      expect(failure(send([entry(type)]))).toMatchObject({
        reason: 'RECIPIENT_REFUSED',
        outcome: 'NOT_SENT',
        currentChunkAcceptance: 'refused',
        acceptedChunks: 0,
        successCount: 0,
        failureCount: 1,
        retryScope: 'none',
      });
      expect(failure(send([entry(type)]), previous)).toMatchObject({
        outcome: 'PARTIAL',
        currentChunkAcceptance: 'refused',
        acceptedChunks: 2,
        successCount: 5,
        failureCount: 1,
      });
    },
  );

  it('marks valid current mixed acceptance PARTIAL without advancing acceptedChunks', () => {
    expect(failure(send([entry('SUCCESS'), entry('IDENTITY_FAILURE')]), previous)).toMatchObject({
      reason: 'PARTIAL_ACCEPTANCE',
      outcome: 'PARTIAL',
      currentChunkAcceptance: 'partial',
      acceptedChunks: 2,
      successCount: 6,
      failureCount: 1,
      retryScope: 'none',
    });
  });

  it.each([-1, -3, -4, -5, -6, -32603, 123])(
    'never turns error envelope %s with nested successes into Ok/complete',
    (code) => {
      for (const progress of [empty, previous]) {
        expect(
          failure(err(remote(code, { timestamp: 100, results: [entry('SUCCESS')] })), progress),
        ).toMatchObject({
          outcome: 'UNKNOWN',
          currentChunkAcceptance: 'unknown',
          acceptedChunks: progress.acceptedChunks,
          successCount: progress.successCount + 1,
          retryScope: 'none',
        });
      }
    },
  );

  it('uses sanitized nested error results for whole refusal and mixed acceptance', () => {
    expect(
      failure(err(remote(-4, { timestamp: 100, results: [entry('IDENTITY_FAILURE')] }))),
    ).toMatchObject({ outcome: 'NOT_SENT', currentChunkAcceptance: 'refused', failureCount: 1 });
    expect(
      failure(
        err(remote(-1, { timestamp: 100, results: [entry('SUCCESS'), entry('IDENTITY_FAILURE')] })),
      ),
    ).toMatchObject({
      outcome: 'PARTIAL',
      currentChunkAcceptance: 'partial',
      successCount: 1,
      failureCount: 1,
    });
  });

  it.each([-3, -5, -6])(
    'keeps bare send error %s UNKNOWN, retaining only observed restrictions',
    (code) => {
      const classified = classifySignalSendResult(err(remote(code)), previous, now);
      expect(classified.result._unsafeUnwrapErr()).toMatchObject({
        outcome: 'UNKNOWN',
        currentChunkAcceptance: 'unknown',
        successCount: 5,
        acceptedChunks: 2,
        retryScope: 'none',
      });
      expect(classified.restrictions).toEqual([
        ...(code === -5 ? [{ kind: 'rate_limit', notBefore: now + 900_000 }] : []),
        ...(code === -6 ? [{ kind: 'challenge' }] : []),
        { kind: 'recovery' },
      ]);
    },
  );

  it('defers only whole rate refusals, including earlier chunks and manual challenges', () => {
    const response = {
      timestamp: 100,
      results: [entry('RATE_LIMIT_FAILURE', { token: 'secret-token' })],
    };
    expect(failure(err(remote(-5, response)), previous)).toMatchObject({
      reason: 'CHALLENGE_REQUIRED',
      outcome: 'PARTIAL',
      currentChunkAcceptance: 'refused',
      acceptedChunks: 2,
      successCount: 5,
      failureCount: 1,
      retryScope: 'delivery_only',
    });
    expect(failure(send([entry('RATE_LIMIT_FAILURE')]))).toMatchObject({
      reason: 'RATE_LIMITED',
      outcome: 'NOT_SENT',
      retryScope: 'delivery_only',
      notBefore: now + 900_000,
    });
    expect(
      failure(
        err(
          remote(-5, {
            timestamp: 100,
            results: [entry('RATE_LIMIT_FAILURE'), entry('UNREGISTERED_FAILURE')],
          }),
        ),
      ),
    ).toMatchObject({ retryScope: 'none', currentChunkAcceptance: 'refused' });
    expect(failure(send([entry('SUCCESS'), entry('RATE_LIMIT_FAILURE')]))).toMatchObject({
      outcome: 'PARTIAL',
      retryScope: 'none',
      currentChunkAcceptance: 'partial',
    });
  });

  it.each<SignalTransportCode>([
    'DISCONNECTED',
    'TIMEOUT',
    'CANCELLED',
    'STOPPED',
    'CAPACITY',
    'INVALID_REQUEST',
    'PROTOCOL_FAILURE',
    'FRAME_TOO_LARGE',
    'PRE_RESPONSE_OVERFLOW',
    'UNTRUSTED_SOCKET',
  ])('preserves before-write transient versus handed-to-socket %s evidence', (code) => {
    const unwritten = new SignalRpcTransportError(code);
    const before = classifySignalSendResult(err(unwritten), previous, now);
    expect(before.result._unsafeUnwrapErr()).toMatchObject({
      reason: unwritten.reason,
      outcome: 'PARTIAL',
      currentChunkAcceptance: 'unwritten',
      acceptedChunks: 2,
      successCount: 5,
      failureCount: 0,
      retryScope: unwritten.retryScope,
    });
    expect(before.restrictions).toEqual([]);
    const after = classifySignalSendResult(
      err(new SignalRpcTransportError(code, true)),
      previous,
      now,
    );
    expect(after.result._unsafeUnwrapErr()).toMatchObject({
      outcome: 'UNKNOWN',
      currentChunkAcceptance: 'unknown',
      retryScope: 'none',
      successCount: 5,
    });
    expect(after.restrictions).toEqual([{ kind: 'recovery' }]);
  });

  it('does not reinterpret a raw metadata result as a send response', () => {
    expect(failure(ok({ kind: 'result', value: { timestamp: 100, results: [] } }))).toMatchObject({
      outcome: 'UNKNOWN',
      reason: 'INVALID_RESPONSE',
    });
  });

  it.each([
    { acceptedChunks: -1, successCount: 0, failureCount: 0 },
    { acceptedChunks: 1, successCount: 0, failureCount: 0 },
    { acceptedChunks: 0, successCount: 1, failureCount: 0 },
    { acceptedChunks: 0, successCount: 0, failureCount: NaN },
    { acceptedChunks: 1, successCount: Number.MAX_SAFE_INTEGER, failureCount: 0 },
    {
      acceptedChunks: Number.MAX_SAFE_INTEGER,
      successCount: Number.MAX_SAFE_INTEGER,
      failureCount: 0,
    },
  ])('never yields Ok/retry on invalid or overflowing progress %j', (progress) => {
    const classified = classifySignalSendResult(send([entry('SUCCESS')]), progress, now);
    const result = classified.result._unsafeUnwrapErr();
    expect(result).toMatchObject({ outcome: 'UNKNOWN', retryScope: 'none' });
    for (const count of [result.acceptedChunks, result.successCount, result.failureCount]) {
      expect(Number.isSafeInteger(count) && count >= 0).toBe(true);
    }
    expect(classified.restrictions.at(-1)).toEqual({ kind: 'recovery' });
  });

  it('preserves safe prior lower bounds when cumulative success/failure addition overflows', () => {
    expect(
      failure(send([entry('SUCCESS')]), { ...previous, successCount: Number.MAX_SAFE_INTEGER }),
    ).toMatchObject({
      outcome: 'UNKNOWN',
      successCount: Number.MAX_SAFE_INTEGER,
      acceptedChunks: 2,
    });
    expect(
      failure(send([entry('IDENTITY_FAILURE')]), {
        ...previous,
        failureCount: Number.MAX_SAFE_INTEGER,
      }),
    ).toMatchObject({
      outcome: 'UNKNOWN',
      failureCount: Number.MAX_SAFE_INTEGER,
      acceptedChunks: 2,
    });
  });

  it.each([-1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER])(
    'does not accept/retry with unusable now %s',
    (time) => {
      const classified = classifySignalSendResult(send([entry('SUCCESS')]), empty, time);
      expect(classified.result._unsafeUnwrapErr()).toMatchObject({
        outcome: 'UNKNOWN',
        retryScope: 'none',
      });
    },
  );
});

describe('interpretSignalRestrictions shared send/read-only metadata policy', () => {
  it('does not add a send recovery fence to metadata IO/unknown errors or infer challenge', () => {
    expect(interpretSignalRestrictions(remote(-3), now)).toEqual([]);
    expect(interpretSignalRestrictions(remote(123), now)).toEqual([]);
    expect(interpretSignalRestrictions(evidence([entry('NETWORK_FAILURE')]), now)).toEqual([]);
    expect(interpretSignalRestrictions(remote(-5), now)).toEqual([
      { kind: 'rate_limit', notBefore: now + 900_000 },
    ]);
    expect(interpretSignalRestrictions(remote(-6), now)).toEqual([{ kind: 'challenge' }]);
  });

  it.each([undefined, 0, 1, 899, 900, 901, 10_000_000])(
    'uses minimum 15 minutes without capping delay %s',
    (seconds) => {
      const extra = seconds === undefined ? {} : { retryAfterSeconds: seconds };
      expect(
        interpretSignalRestrictions(evidence([entry('RATE_LIMIT_FAILURE', extra)]), now),
      ).toEqual([{ kind: 'rate_limit', notBefore: now + Math.max(900, seconds ?? 0) * 1000 }]);
    },
  );

  it('preserves max of every safe server delay even when entries are otherwise malformed', () => {
    expect(
      interpretSignalRestrictions(
        evidence([
          entry('RATE_LIMIT_FAILURE', { retryAfterSeconds: 1000 }),
          entry('FUTURE_RESULT', { recipientAddress: {}, retryAfterSeconds: 5000 }),
          entry('RATE_LIMIT_FAILURE', { retryAfterSeconds: 2000 }),
        ]),
        now,
      ),
    ).toEqual([{ kind: 'rate_limit', notBefore: now + 5_000_000 }]);
    expect(
      interpretSignalRestrictions(evidence([entry('SUCCESS', { retryAfterSeconds: 2000 })]), now),
    ).toEqual([{ kind: 'rate_limit', notBefore: now + 2_000_000 }]);
  });

  it.each([-1, 1.5, null, '900', Number.MAX_SAFE_INTEGER + 1, NaN, Infinity])(
    'escalates malformed delay %j while retaining another longer known rate restriction',
    (delay) => {
      expect(
        interpretSignalRestrictions(
          evidence([
            entry('RATE_LIMIT_FAILURE', { retryAfterSeconds: 5000 }),
            entry('RATE_LIMIT_FAILURE', { retryAfterSeconds: delay }),
          ]),
          now,
        ),
      ).toEqual([{ kind: 'rate_limit', notBefore: now + 5_000_000 }, { kind: 'challenge' }]);
    },
  );

  it('detects multiplication and addition overflow, never shortening other safe delay evidence', () => {
    for (const time of [0, 992]) {
      const seconds =
        time === 0 ? Number.MAX_SAFE_INTEGER : Math.floor(Number.MAX_SAFE_INTEGER / 1000);
      expect(
        interpretSignalRestrictions(
          evidence([
            entry('RATE_LIMIT_FAILURE', { retryAfterSeconds: 5000 }),
            entry('RATE_LIMIT_FAILURE', { retryAfterSeconds: seconds }),
          ]),
          time,
        ),
      ).toEqual([{ kind: 'rate_limit', notBefore: time + 5_000_000 }, { kind: 'challenge' }]);
    }
    expect(
      interpretSignalRestrictions(evidence([entry('RATE_LIMIT_FAILURE')]), Number.MAX_SAFE_INTEGER),
    ).toEqual([{ kind: 'challenge' }]);
  });

  it.each(['secret-token', '', 42, {}])(
    'honors token-presence evidence %j without retaining token',
    (token) => {
      const restrictions = interpretSignalRestrictions(
        evidence([entry('RATE_LIMIT_FAILURE', { retryAfterSeconds: 5000, token })]),
        now,
      );
      expect(restrictions).toEqual([
        { kind: 'rate_limit', notBefore: now + 5_000_000 },
        { kind: 'challenge' },
      ]);
      expect(JSON.stringify(restrictions)).not.toContain('secret-token');
    },
  );

  it('returns all independent restrictions in rate/challenge/recovery order on UNKNOWN', () => {
    const input = err(
      remote(-6, {
        timestamp: 100,
        results: [
          entry('RATE_LIMIT_FAILURE', { retryAfterSeconds: 5000 }),
          entry('NETWORK_FAILURE'),
        ],
      }),
    );
    const classified = classifySignalSendResult(input, previous, now);
    expect(classified.restrictions).toEqual([
      { kind: 'rate_limit', notBefore: now + 5_000_000 },
      { kind: 'challenge' },
      { kind: 'recovery' },
    ]);
    expect(classified.result._unsafeUnwrapErr().notBefore).toBe(now + 5_000_000);
  });

  it('retains restriction hints alongside accepted ordinary results and freezes safe DTOs', () => {
    const classified = classifySignalSendResult(
      send([
        entry('SUCCESS', {
          retryAfterSeconds: 5000,
          token: 'secret-token',
        }),
      ]),
      empty,
      now,
    );
    expect(classified.result.isOk()).toBe(true);
    expect(classified.restrictions).toEqual([
      { kind: 'rate_limit', notBefore: now + 5_000_000 },
      { kind: 'challenge' },
    ]);
    expect(Object.isFrozen(classified)).toBe(true);
    expect(Object.isFrozen(classified.result._unsafeUnwrap())).toBe(true);
    expect(Object.isFrozen(classified.restrictions)).toBe(true);
    expect(classified.restrictions.every(Object.isFrozen)).toBe(true);
  });

  it('does not expose remote messages/data/recipient identity/timestamps/tokens/causes', () => {
    // research/review-1-source-additions/src/main/java/org/asamk/signal/json/
    // JsonError.java:5-9 copies throwable message/type: neither is policy or safe diagnostic data.
    // SendMessageResultUtils.java:90-118 formats identity/challenge secrets; never copy its text.
    const classified = classifySignalSendResult(
      err(
        remote(-5, {
          timestamp: 123456789,
          results: [
            entry('RATE_LIMIT_FAILURE', { retryAfterSeconds: 2000, token: 'secret-token' }),
          ],
        }),
      ),
      previous,
      now,
    );
    const safe = classified.result._unsafeUnwrapErr();
    expect(safe).toBeInstanceOf(SignalDeliveryError);
    expect(safe.providerRetryable).toBe(false);
    expect(safe.cause).toBeUndefined();
    expect(JSON.stringify(classified)).not.toMatch(
      /private-message|private-data|secret-token|cccccccc|123456789|recipientAddress|timestamp|sendEvidence/,
    );
    expect(safe.message).toBe('Signal delivery failed: CHALLENGE_REQUIRED');
  });
});

describe('actual TASK006 checkpoint terminal conformance', () => {
  it('round trips every policy branch for valid progress through the real terminal/ready codec', () => {
    const types = [
      'SUCCESS',
      'NETWORK_FAILURE',
      'UNREGISTERED_FAILURE',
      'IDENTITY_FAILURE',
      'RATE_LIMIT_FAILURE',
      'INVALID_PRE_KEY_FAILURE',
      'FUTURE_RESULT',
    ];
    const currentResults = [
      [],
      [null],
      ...types.flatMap((type) => [
        [entry(type)],
        [entry('SUCCESS'), entry(type)],
        [entry(type, { retryAfterSeconds: 5000, token: 'secret-token' })],
        [entry(type, { retryAfterSeconds: 'invalid' })],
      ]),
    ];
    for (const progress of [empty, previous]) {
      for (const results of currentResults) {
        for (const code of [undefined, -1, -3, -4, -5, -6, 123]) {
          const input =
            code === undefined ? send(results) : err(remote(code, { timestamp: 100, results }));
          const classified = classifySignalSendResult(input, progress, now);
          if (classified.result.isOk()) continue;
          const failed = classified.result.error;
          const terminal = failed.retryScope === 'none';
          const accountUuid = 'aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb';
          expect(
            parseSignalDeliveryCheckpoint(
              {
                version: 1,
                queueItemId: 'queue-1',
                deliveryId: 'delivery-1',
                kind: 'reply',
                personaId: 'persona-1',
                threadId: 'thread-1',
                channelName: 'signal-test',
                accountUuid,
                destination: `signal:v1:${accountUuid}:self`,
                body: 'one two three',
                chunks: ['one', 'two', 'three'],
                nextChunk: progress.acceptedChunks,
                phase: terminal ? 'terminal' : 'ready',
                acceptedChunks: failed.acceptedChunks,
                currentChunkAcceptance: failed.currentChunkAcceptance,
                successCount: failed.successCount,
                failureCount: failed.failureCount,
                ...(terminal
                  ? { terminalReason: failed.reason, terminalOutcome: failed.outcome }
                  : {}),
                createdAt: 1000,
                expiresAt: 1000 + SIGNAL_CHECKPOINT_LIFETIME_MS,
              },
              { queueItemId: 'queue-1', now },
            ).isOk(),
          ).toBe(true);
          expect(failed.acceptedChunks).toBe(progress.acceptedChunks);
          expect(failed.successCount).toBeGreaterThanOrEqual(progress.successCount);
          expect(failed.failureCount).toBeGreaterThanOrEqual(progress.failureCount);
          if (!terminal) expect(failed.successCount).toBe(progress.successCount);
        }
      }
    }
  });

  const terminalInputs: readonly SignalRpcResult[] = [
    send([entry('IDENTITY_FAILURE')]),
    send([entry('SUCCESS'), entry('IDENTITY_FAILURE')]),
    send([entry('NETWORK_FAILURE')]),
    send([]),
    send([entry('SUCCESS')], -1),
    err(remote(-1, { timestamp: 100, results: [entry('SUCCESS')] })),
    err(remote(-1, { timestamp: 100, results: [entry('SUCCESS'), entry('UNREGISTERED_FAILURE')] })),
    err(remote(-5)),
    err(remote(-6)),
    err(new SignalRpcTransportError('INVALID_REQUEST')),
    err(new SignalRpcTransportError('TIMEOUT', true)),
  ];
  it.each(terminalInputs.map((input, index) => ({ input, index })))(
    'emits codec-representable terminal acceptance for source-shaped outcome $index',
    ({ input }) => {
      for (const progress of [empty, previous]) {
        const failed = failure(input, progress);
        expect(failed.retryScope).toBe('none');
        // Actual merged codec signal-delivery-checkpoint.ts:72-86; settlement copies
        // failure acceptance/counts in queue-repository.ts:936-967. No duplicate schema.
        const accountUuid = 'aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb';
        expect(
          parseSignalDeliveryCheckpoint(
            {
              version: 1,
              queueItemId: 'queue-1',
              deliveryId: 'delivery-1',
              kind: 'reply',
              personaId: 'persona-1',
              threadId: 'thread-1',
              channelName: 'signal-test',
              accountUuid,
              destination: `signal:v1:${accountUuid}:self`,
              body: 'one two three',
              chunks: ['one', 'two', 'three'],
              nextChunk: progress.acceptedChunks,
              phase: 'terminal',
              acceptedChunks: failed.acceptedChunks,
              currentChunkAcceptance: failed.currentChunkAcceptance,
              successCount: failed.successCount,
              failureCount: failed.failureCount,
              terminalReason: failed.reason,
              terminalOutcome: failed.outcome,
              createdAt: 1000,
              expiresAt: 1000 + SIGNAL_CHECKPOINT_LIFETIME_MS,
            },
            { queueItemId: 'queue-1', now },
          ).isOk(),
        ).toBe(true);
      }
    },
  );
});
