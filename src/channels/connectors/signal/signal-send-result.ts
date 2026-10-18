import {
  SignalDeliveryError,
  type SignalChunkAcceptance,
  type SignalDeliveryOutcome,
  type SignalDeliveryReason,
  type SignalRetryScope,
} from '../../../core/errors/error-types.js';
import { err, ok, type Result } from '../../../core/types/result.js';
import type { SignalPause } from '../../../core/database/repositories/signal-account-state-repository.js';
import { SignalRpcTransportError, type SignalRpcResult } from './signal-rpc-client.js';
import { SignalRpcRemoteError, type SignalSendEvidence } from './signal-wire.js';
import type { SignalChunkReceipt } from './signal-types.js';

/** Cumulative counts BEFORE this chunk; acceptedChunks never includes a failed current chunk. */
export interface SignalSendProgress {
  readonly acceptedChunks: number;
  readonly successCount: number;
  readonly failureCount: number;
}

export interface SignalSendClassification {
  readonly result: Result<SignalChunkReceipt, SignalDeliveryError>;
  /** Persist every hint before releasing the account gate, including on Ok. */
  readonly restrictions: readonly SignalPause[];
}

function isSafeCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/**
 * Shared by sends and read-only metadata failures. Consumes ONLY sanitized TASK003 evidence.
 * Rate then challenge are independent hints, not alternatives. No metadata recovery fence:
 * a failed read does not establish uncertainty about a send. Caller supplies trusted epoch ms.
 */
export function interpretSignalRestrictions(
  source: SignalSendEvidence | SignalRpcRemoteError,
  now: number,
): readonly SignalPause[] {
  const remote = source instanceof SignalRpcRemoteError ? source : undefined;
  const evidence = source instanceof SignalRpcRemoteError ? source.sendEvidence : source;
  let rate = remote?.remoteCode === 'RATE_LIMIT';
  let challenge = remote?.remoteCode === 'CHALLENGE_REQUIRED';
  let longestDelay = 0;
  for (const entry of evidence.results) {
    rate ||= entry.type === 'RATE_LIMIT_FAILURE';
    challenge ||= entry.challengeRequired || entry.retryAfter.kind === 'invalid';
    if (entry.retryAfter.kind !== 'valid') continue;
    rate = true;
    const milliseconds = entry.retryAfter.seconds * 1000;
    const deadline = now + milliseconds;
    if (
      !isSafeCount(now) ||
      !isSafeCount(entry.retryAfter.seconds) ||
      !isSafeCount(milliseconds) ||
      !isSafeCount(deadline)
    ) {
      challenge = true;
    } else {
      longestDelay = Math.max(longestDelay, deadline);
    }
  }
  const restrictions: SignalPause[] = [];
  if (rate) {
    const minimum = now + 900_000;
    if (isSafeCount(now) && isSafeCount(minimum)) {
      restrictions.push(
        Object.freeze({ kind: 'rate_limit', notBefore: Math.max(minimum, longestDelay) }),
      );
    } else {
      challenge = true;
    }
  }
  if (challenge) restrictions.push(Object.freeze({ kind: 'challenge' }));
  return Object.freeze(restrictions);
}

function validProgress(previous: SignalSendProgress): boolean {
  return (
    [previous.acceptedChunks, previous.successCount, previous.failureCount].every(isSafeCount) &&
    previous.successCount >= previous.acceptedChunks &&
    (previous.acceptedChunks > 0 || previous.successCount === 0)
  );
}

/**
 * Pure single-send policy; never reparse raw entries or retain remote data. The caller must
 * validate progress/time BEFORE dispatch and persist all returned restrictions atomically
 * with settlement. This cannot repair a corrupt checkpoint. Receipts are chunk-local;
 * failures include prior counts but leave acceptedChunks/cursor at the previous value.
 */
export function classifySignalSendResult(
  rpcResult: SignalRpcResult,
  previous: SignalSendProgress,
  now: number,
): SignalSendClassification {
  const source = rpcResult.isErr()
    ? rpcResult.error instanceof SignalRpcRemoteError
      ? rpcResult.error
      : undefined
    : rpcResult.value.kind === 'send'
      ? rpcResult.value.evidence
      : undefined;
  const restrictions =
    source === undefined ? Object.freeze([]) : interpretSignalRestrictions(source, now);
  const prior: SignalSendProgress = {
    acceptedChunks: isSafeCount(previous.acceptedChunks) ? previous.acceptedChunks : 0,
    successCount: isSafeCount(previous.successCount) ? previous.successCount : 0,
    failureCount: isSafeCount(previous.failureCount) ? previous.failureCount : 0,
  };

  function failed(
    reason: SignalDeliveryReason,
    outcome: SignalDeliveryOutcome,
    currentChunkAcceptance: SignalChunkAcceptance,
    counts: SignalSendProgress = prior,
    retryScope: SignalRetryScope = 'none',
  ): SignalSendClassification {
    const hints: readonly SignalPause[] =
      outcome === 'UNKNOWN'
        ? Object.freeze([...restrictions, Object.freeze({ kind: 'recovery' as const })])
        : restrictions;
    let notBefore: number | undefined;
    for (const hint of hints) {
      if (hint.kind === 'rate_limit') notBefore = Math.max(notBefore ?? 0, hint.notBefore);
      if (hint.kind === 'recovery' && isSafeCount(now) && isSafeCount(now + 60_000))
        notBefore = Math.max(notBefore ?? 0, now + 60_000);
    }
    return Object.freeze({
      result: err(
        new SignalDeliveryError({
          reason,
          outcome,
          currentChunkAcceptance,
          ...counts,
          retryScope,
          notBefore,
        }),
      ),
      restrictions: hints,
    });
  }

  if (!validProgress(previous) || !isSafeCount(now) || !isSafeCount(now + 60_000))
    return failed('INVALID_RESPONSE', 'UNKNOWN', 'unknown');

  if (rpcResult.isErr() && rpcResult.error instanceof SignalRpcTransportError) {
    const transport = rpcResult.error;
    return transport.currentChunkAcceptance === 'unwritten'
      ? failed(
          transport.reason,
          prior.acceptedChunks > 0 ? 'PARTIAL' : 'NOT_SENT',
          'unwritten',
          prior,
          transport.retryScope,
        )
      : failed(transport.reason, 'UNKNOWN', 'unknown');
  }
  const evidence = source instanceof SignalRpcRemoteError ? source.sendEvidence : source;
  if (evidence === undefined) return failed('INVALID_RESPONSE', 'UNKNOWN', 'unknown');

  const successes = evidence.results.filter(
    (entry) => entry.valid && entry.type === 'SUCCESS',
  ).length;
  const failures = evidence.results.filter(
    (entry) => entry.valid && entry.type !== 'SUCCESS' && entry.type !== 'UNKNOWN',
  ).length;
  const successCount = prior.successCount + successes;
  const failureCount = prior.failureCount + failures;
  const counts: SignalSendProgress = {
    acceptedChunks: prior.acceptedChunks,
    successCount: isSafeCount(successCount) ? successCount : prior.successCount,
    failureCount: isSafeCount(failureCount) ? failureCount : prior.failureCount,
  };
  if (!isSafeCount(successCount) || !isSafeCount(failureCount))
    return failed('INVALID_RESPONSE', 'UNKNOWN', 'unknown', counts);

  const networkFailure = evidence.results.some((entry) => entry.type === 'NETWORK_FAILURE');
  if (
    !evidence.complete ||
    !evidence.timestampValid ||
    evidence.results.length === 0 ||
    evidence.results.some((entry) => !entry.valid || entry.type === 'UNKNOWN') ||
    networkFailure
  )
    return failed(
      networkFailure ? 'NETWORK_FAILURE' : 'INVALID_RESPONSE',
      'UNKNOWN',
      'unknown',
      counts,
    );

  if (failures === 0) {
    // Pinned Utils throws only on !hasSuccess. An error with all successes is contradictory;
    // UNKNOWN also matches TASK006's terminal codec (which cannot persist complete/PARTIAL).
    if (rpcResult.isErr()) return failed('RPC_ERROR', 'UNKNOWN', 'unknown', counts);
    if (!isSafeCount(prior.acceptedChunks + 1))
      return failed('INVALID_RESPONSE', 'UNKNOWN', 'unknown', counts);
    return Object.freeze({
      result: ok(
        Object.freeze({
          acceptance: 'complete' as const,
          successCount: successes,
          failureCount: 0 as const,
        }),
      ),
      restrictions,
    });
  }
  const reason: SignalDeliveryReason = restrictions.some((hint) => hint.kind === 'challenge')
    ? 'CHALLENGE_REQUIRED'
    : restrictions.some((hint) => hint.kind === 'rate_limit')
      ? 'RATE_LIMITED'
      : successes > 0
        ? 'PARTIAL_ACCEPTANCE'
        : 'RECIPIENT_REFUSED';
  if (successes > 0) return failed(reason, 'PARTIAL', 'partial', counts);

  const retryScope = evidence.results.every((entry) => entry.type === 'RATE_LIMIT_FAILURE')
    ? 'delivery_only'
    : 'none';
  return failed(
    reason,
    prior.acceptedChunks > 0 ? 'PARTIAL' : 'NOT_SENT',
    'refused',
    counts,
    retryScope,
  );
}
