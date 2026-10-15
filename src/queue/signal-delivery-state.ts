import { err, ok, type Result } from 'neverthrow';
import { DeliveryCancelled } from '../core/errors/error-types.js';
import {
  SignalStateError,
  type SignalAccountState,
  type SignalPause,
  type SignalSendReservation,
} from '../core/database/repositories/signal-account-state-repository.js';
import {
  SIGNAL_DELIVERY_CHECKPOINT_KEY,
  SIGNAL_DELIVERY_STARTED_KEY,
  SignalCheckpointError,
  parseSignalDeliveryCheckpoint,
  parseSignalDeliveryStartedMarker,
  type SignalDeliveryCheckpoint,
  type SignalDeliveryStartedMarker,
} from './signal-delivery-checkpoint.js';
import type { SignalDeliveryError } from '../core/errors/error-types.js';
import type { SignalDestinationLease } from '../core/database/repositories/signal-destination-lease-repository.js';

export type SignalQueueFailure = SignalCheckpointError | SignalStateError | DeliveryCancelled;

export type SignalDeliveryState =
  | { readonly kind: 'ordinary' }
  | { readonly kind: 'invoked'; readonly marker: SignalDeliveryStartedMarker }
  | { readonly kind: 'checkpoint'; readonly checkpoint: SignalDeliveryCheckpoint };

export interface SignalChunkOwnership {
  readonly checkpoint: SignalDeliveryCheckpoint;
  readonly account: SignalAccountState;
  readonly reservation: SignalSendReservation;
  readonly lease: SignalDestinationLease;
}

/** Counts in a failure are cumulative; an accepted receipt supplies this chunk's successes. */
export type SignalChunkSettlement =
  | { readonly kind: 'accepted'; readonly successCount: number }
  | {
      readonly kind: 'deferred' | 'terminal';
      readonly failure: SignalDeliveryError;
      readonly pause?: SignalPause;
    };

export interface SignalQueueRecovery {
  readonly ordinaryReset: number;
  readonly ready: number;
  readonly delivered: number;
  readonly terminal: number;
  readonly invalid: number;
  readonly reservationsClassified: number;
  readonly orphanLeasesReleased: number;
  /** Internal identities for safe operation audits; never contains account/target/body/RPC data. */
  readonly interruptedInvocations: readonly SignalDeliveryStartedMarker[];
}

export function parseSignalQueuePayload(
  payload: string,
): Result<Record<string, unknown>, SignalCheckpointError> {
  try {
    const parsed: unknown = JSON.parse(payload);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? ok(parsed as Record<string, unknown>)
      : err(new SignalCheckpointError('INVALID'));
  } catch {
    return err(new SignalCheckpointError('INVALID'));
  }
}

/**
 * Detection only for malformed/non-object legacy payloads. Normalize JSON Unicode escapes so
 * escaped/truncated reserved keys cannot hide a replay boundary; never repair partial JSON.
 * Parsed root objects instead use own-key presence, not incidental text/nested key matches.
 */
export function hasSignalPayloadEvidence(payload: string): boolean {
  const normalized = payload.replace(/\\u([0-9a-f]{4})/gi, (_escape: string, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
  return normalized.includes('__talond_sig');
}

/** Marker presence (including null/malformed values) never permits ordinary provider replay. */
export function inspectSignalDeliveryState(
  payload: Readonly<Record<string, unknown>>,
  queueItemId: string,
  now: number,
  allowExpired = false,
): Result<SignalDeliveryState, SignalCheckpointError> {
  const hasCheckpoint = Object.hasOwn(payload, SIGNAL_DELIVERY_CHECKPOINT_KEY);
  const hasMarker = Object.hasOwn(payload, SIGNAL_DELIVERY_STARTED_KEY);
  const marker = hasMarker
    ? parseSignalDeliveryStartedMarker(payload[SIGNAL_DELIVERY_STARTED_KEY], queueItemId)
    : ok(null);
  if (marker.isErr()) return err(marker.error);
  if (hasCheckpoint) {
    return parseSignalDeliveryCheckpoint(payload[SIGNAL_DELIVERY_CHECKPOINT_KEY], {
      queueItemId,
      now,
      allowExpired,
    }).map((checkpoint) => ({ kind: 'checkpoint' as const, checkpoint }));
  }
  return ok(
    marker.value === null ? { kind: 'ordinary' } : { kind: 'invoked', marker: marker.value },
  );
}
