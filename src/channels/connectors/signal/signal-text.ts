import type { AgentOutput } from '../../channel-types.js';
import { stripMarkdown } from '../../format/markdown-converter.js';
import {
  SignalDeliveryError,
  type SignalDeliveryReason,
} from '../../../core/errors/error-types.js';
import { err, ok, type Result } from '../../../core/types/result.js';
import { SIGNAL_CHECKPOINT_TEXT_MAX_BYTES } from '../../../queue/signal-delivery-checkpoint.js';
import { SIGNAL_MAX_CHUNK_BYTES, type SignalConfig } from './signal-config.js';
import { parseSignalExternalId } from './signal-identities.js';
import type { SignalPreparedText } from './signal-types.js';

function refused(reason: SignalDeliveryReason): Result<never, SignalDeliveryError> {
  return err(
    new SignalDeliveryError({
      reason,
      outcome: 'NOT_SENT',
      acceptedChunks: 0,
      currentChunkAcceptance: 'unwritten',
      successCount: 0,
      failureCount: 0,
      retryScope: 'none',
    }),
  );
}

/** Preparation only: callers still authorize, verify and send each fixed chunk.
 * Use the saved-reply text ceiling for every purpose; never repair invalid Unicode. */
export function prepareSignalText(
  destination: string,
  output: AgentOutput,
  accountUuid: SignalConfig['accountUuid'],
): Result<SignalPreparedText, SignalDeliveryError> {
  if (output.attachments !== undefined && output.attachments.length > 0)
    return refused('UNSUPPORTED_ATTACHMENT');
  const parsed = parseSignalExternalId(destination, accountUuid);
  if (parsed.isErr()) {
    return refused(
      parsed.error.reason === 'ACCOUNT_MISMATCH' ? 'ACCOUNT_MISMATCH' : 'INVALID_DESTINATION',
    );
  }
  const body = output.body;
  if (Buffer.byteLength(body, 'utf8') > SIGNAL_CHECKPOINT_TEXT_MAX_BYTES)
    return refused('OUTPUT_TOO_LARGE');
  if (Buffer.from(body, 'utf8').toString('utf8') !== body) return refused('INVALID_RESPONSE');

  const text = stripMarkdown(body);
  if (text.length === 0) return refused('INVALID_RESPONSE');
  if (Buffer.byteLength(text, 'utf8') > SIGNAL_CHECKPOINT_TEXT_MAX_BYTES)
    return refused('OUTPUT_TOO_LARGE');

  const chunks: string[] = [];
  let chunk = '';
  let chunkBytes = 0;
  // String iteration preserves code points, not grapheme clusters or word boundaries.
  for (const point of text) {
    const pointBytes = Buffer.byteLength(point, 'utf8');
    if (chunkBytes + pointBytes > SIGNAL_MAX_CHUNK_BYTES) {
      chunks.push(chunk);
      chunk = '';
      chunkBytes = 0;
    }
    chunk += point;
    chunkBytes += pointBytes;
  }
  chunks.push(chunk);
  return ok(
    Object.freeze({
      destination: Object.freeze(parsed.value),
      chunks: Object.freeze(chunks),
    }),
  );
}
