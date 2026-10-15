import { z } from 'zod';
import { QueueError, SIGNAL_DELIVERY_REASONS } from '../core/errors/error-types.js';
import { err, ok, type Result } from '../core/types/result.js';
import {
  SignalUuidSchema,
  SIGNAL_MAX_CHUNK_BYTES,
} from '../channels/connectors/signal/signal-config.js';
import { parseSignalExternalId } from '../channels/connectors/signal/signal-identities.js';

export const SIGNAL_DELIVERY_CHECKPOINT_KEY = '__talond_signal_delivery_v1';
export const SIGNAL_DELIVERY_STARTED_KEY = '__talond_signal_delivery_started_v1';
export const SIGNAL_CHECKPOINT_TEXT_MAX_BYTES = 1_048_576;
export const SIGNAL_CHECKPOINT_MAX_BYTES = 3 * 1_048_576;
export const SIGNAL_CHECKPOINT_LIFETIME_MS = 24 * 60 * 60 * 1_000;

const SafeInteger = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const Id = z.string().min(1);
const Text = z.string().refine((value) => Buffer.from(value, 'utf8').toString('utf8') === value);
const Chunk = Text.refine(
  (value) =>
    Buffer.byteLength(value, 'utf8') > 0 &&
    Buffer.byteLength(value, 'utf8') <= SIGNAL_MAX_CHUNK_BYTES,
);

const CheckpointSchema = z
  .object({
    version: z.literal(1),
    queueItemId: Id,
    deliveryId: Id,
    runId: Id.optional(),
    kind: z.enum(['reply', 'background']),
    personaId: Id,
    threadId: Id,
    channelName: Id,
    accountUuid: SignalUuidSchema,
    destination: Id,
    body: Text.refine(
      (value) => Buffer.byteLength(value, 'utf8') <= SIGNAL_CHECKPOINT_TEXT_MAX_BYTES,
    ),
    chunks: z.array(Chunk).min(1),
    nextChunk: SafeInteger,
    phase: z.enum(['ready', 'in_flight', 'delivered', 'terminal']),
    currentChunkAcceptance: z.enum(['unwritten', 'refused', 'complete', 'partial', 'unknown']),
    acceptedChunks: SafeInteger,
    successCount: SafeInteger,
    failureCount: SafeInteger,
    terminalReason: z.enum(SIGNAL_DELIVERY_REASONS).optional(),
    terminalOutcome: z.enum(['NOT_SENT', 'PARTIAL', 'UNKNOWN']).optional(),
    createdAt: SafeInteger,
    expiresAt: SafeInteger,
  })
  .strict()
  .superRefine((value, ctx) => {
    const destination = parseSignalExternalId(value.destination, value.accountUuid);
    const identityValid =
      destination.isOk() &&
      value.accountUuid === value.destination.split(':')[2] &&
      (value.kind !== 'background' || value.runId === undefined);
    const countsValid =
      value.successCount >= value.acceptedChunks &&
      (!(value.phase === 'ready' || value.phase === 'in_flight') ||
        value.nextChunk > 0 ||
        value.successCount === 0);
    const boundsValid =
      value.expiresAt - value.createdAt === SIGNAL_CHECKPOINT_LIFETIME_MS &&
      value.nextChunk <= value.chunks.length &&
      value.acceptedChunks === value.nextChunk &&
      countsValid &&
      value.chunks.reduce((bytes, chunk) => bytes + Buffer.byteLength(chunk, 'utf8'), 0) <=
        SIGNAL_CHECKPOINT_TEXT_MAX_BYTES;
    const currentUnsent =
      value.currentChunkAcceptance === 'unwritten' || value.currentChunkAcceptance === 'refused';
    const partialOutcomeValid = currentUnsent
      ? value.acceptedChunks > 0
      : value.currentChunkAcceptance === 'partial' && value.successCount > value.acceptedChunks;
    const terminalOutcomeValid =
      value.terminalOutcome === 'UNKNOWN'
        ? value.currentChunkAcceptance === 'unknown'
        : value.terminalOutcome === 'PARTIAL'
          ? partialOutcomeValid
          : value.terminalOutcome === 'NOT_SENT' &&
            currentUnsent &&
            value.successCount === 0 &&
            value.acceptedChunks === 0;
    const terminalFieldsValid =
      value.phase === 'terminal'
        ? value.terminalReason !== undefined && terminalOutcomeValid
        : value.terminalReason === undefined && value.terminalOutcome === undefined;
    const phaseValid =
      value.phase === 'delivered'
        ? value.nextChunk === value.chunks.length && value.currentChunkAcceptance === 'complete'
        : value.nextChunk < value.chunks.length &&
          ((value.phase === 'ready' && currentUnsent) ||
            (value.phase === 'in_flight' && value.currentChunkAcceptance === 'unknown') ||
            value.phase === 'terminal');
    if (!identityValid || !boundsValid || !terminalFieldsValid || !phaseValid) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid Signal checkpoint state' });
    }
  });

export type SignalDeliveryCheckpoint = Readonly<
  Omit<z.infer<typeof CheckpointSchema>, 'chunks'> & {
    chunks: readonly string[];
  }
>;

/** Separate replay guard, not a saved reply or model argument. */
const StartedMarkerSchema = z
  .object({
    version: z.literal(1),
    queueItemId: Id,
    deliveryId: Id,
    runId: Id.optional(),
    purpose: z.enum(['reply', 'background', 'explicit', 'progress']),
    startedAt: SafeInteger,
  })
  .strict();
export type SignalDeliveryStartedMarker = Readonly<z.infer<typeof StartedMarkerSchema>>;

export class SignalCheckpointError extends QueueError {
  constructor(readonly reason: 'INVALID' | 'TOO_LARGE' | 'EXPIRED' | 'IDENTITY_MISMATCH') {
    super(`Signal checkpoint rejected: ${reason}`);
  }
}

/** Persisted input is untrusted. Never return raw JSON/Zod errors or dynamic paths. */
export function parseSignalDeliveryCheckpoint(
  input: unknown,
  context: { readonly queueItemId: string; readonly now: number },
): Result<SignalDeliveryCheckpoint, SignalCheckpointError> {
  try {
    const serialized = typeof input === 'string' ? input : JSON.stringify(input);
    if (serialized === undefined) return err(new SignalCheckpointError('INVALID'));
    if (Buffer.byteLength(serialized, 'utf8') > SIGNAL_CHECKPOINT_MAX_BYTES)
      return err(new SignalCheckpointError('TOO_LARGE'));
    const parsed: unknown = JSON.parse(serialized);
    const result = CheckpointSchema.safeParse(parsed);
    if (!result.success || !Number.isSafeInteger(context.now) || context.now < 0)
      return err(new SignalCheckpointError('INVALID'));
    if (result.data.queueItemId !== context.queueItemId)
      return err(new SignalCheckpointError('IDENTITY_MISMATCH'));
    if (result.data.createdAt > context.now) return err(new SignalCheckpointError('INVALID'));
    // Delivered work must still be locally finalizable after expiry, without sending again.
    if (
      result.data.expiresAt <= context.now &&
      result.data.phase !== 'delivered' &&
      result.data.phase !== 'terminal'
    ) {
      return err(new SignalCheckpointError('EXPIRED'));
    }
    return ok(Object.freeze({ ...result.data, chunks: Object.freeze(result.data.chunks) }));
  } catch {
    return err(new SignalCheckpointError('INVALID'));
  }
}

export function parseSignalDeliveryStartedMarker(
  input: unknown,
  queueItemId: string,
): Result<SignalDeliveryStartedMarker, SignalCheckpointError> {
  const result = StartedMarkerSchema.safeParse(input);
  if (!result.success) return err(new SignalCheckpointError('INVALID'));
  return result.data.queueItemId === queueItemId
    ? ok(Object.freeze(result.data))
    : err(new SignalCheckpointError('IDENTITY_MISMATCH'));
}
