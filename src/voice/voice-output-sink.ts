/**
 * Durable voice execution output boundary.
 *
 * Persistence happens before the optional publisher is called. A publisher
 * failure is delivery state for the lifecycle owner and never causes the
 * AgentRunner to execute the delegation again.
 */

import { v4 as uuidv4 } from 'uuid';
import { err, ok } from 'neverthrow';

import type {
  VoiceBackendResult,
  VoiceDeliveryStatus,
  VoiceExecutionStatus,
  VoiceOutputLifecycle,
  VoiceResult,
  VoiceStore,
} from './voice-types.js';

/** Keep retained output bounded even if a provider returns an oversized value. */
export const MAX_VOICE_OUTPUT_CHARS = 32_000;

export type VoiceOutputPublisher = (result: VoiceBackendResult) => void | VoiceResult<unknown>;

export interface VoiceOutputSinkOptions {
  readonly now?: () => number;
  readonly maxOutputChars?: number;
}

/** Methods used by AgentRunner to persist execution and result transitions. */
export class VoiceOutputSink {
  private readonly now: () => number;
  private readonly maxOutputChars: number;

  constructor(
    private readonly store: VoiceStore,
    private readonly publisher?: VoiceOutputPublisher,
    options: VoiceOutputSinkOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.maxOutputChars = Math.max(
      1,
      Math.min(options.maxOutputChars ?? MAX_VOICE_OUTPUT_CHARS, MAX_VOICE_OUTPUT_CHARS),
    );
  }

  executionStarted(delegationId: string, occurredAt = this.now()): VoiceResult<VoiceBackendResult> {
    return this.record({
      delegationId,
      outputId: uuidv4(),
      kind: 'progress',
      execution: 'running',
      output: lifecycle('running', 'not_requested'),
      occurredAt,
    });
  }

  progress(
    delegationId: string,
    text: string,
    occurredAt = this.now(),
  ): VoiceResult<VoiceBackendResult> {
    return this.record({
      delegationId,
      outputId: uuidv4(),
      kind: 'progress',
      ...(this.boundText(text) !== undefined ? { text: this.boundText(text) } : {}),
      execution: 'running',
      output: lifecycle('running', text.length > 0 ? 'pending' : 'not_requested'),
      occurredAt,
    });
  }

  final(
    delegationId: string,
    text: string,
    occurredAt = this.now(),
  ): VoiceResult<VoiceBackendResult> {
    return this.record({
      delegationId,
      outputId: uuidv4(),
      kind: 'final',
      ...(this.boundText(text) !== undefined ? { text: this.boundText(text) } : {}),
      execution: 'succeeded',
      output: lifecycle('succeeded', text.length > 0 ? 'pending' : 'not_requested'),
      occurredAt,
    });
  }

  failure(
    delegationId: string,
    errorCode: string,
    text?: string,
    occurredAt = this.now(),
  ): VoiceResult<VoiceBackendResult> {
    return this.record({
      delegationId,
      outputId: uuidv4(),
      kind: 'error',
      ...(text !== undefined && this.boundText(text) !== undefined
        ? { text: this.boundText(text) }
        : {}),
      execution: 'failed',
      output: lifecycle('failed', 'not_requested'),
      errorCode,
      occurredAt,
    });
  }

  unknown(
    delegationId: string,
    errorCode: string,
    text?: string,
    occurredAt = this.now(),
  ): VoiceResult<VoiceBackendResult> {
    return this.record({
      delegationId,
      outputId: uuidv4(),
      kind: 'unknown',
      ...(text !== undefined && this.boundText(text) !== undefined
        ? { text: this.boundText(text) }
        : {}),
      execution: 'unknown',
      output: {
        execution: 'unknown',
        delivery: 'unknown',
        providerAcknowledgement: 'unknown',
        playback: 'unknown',
      },
      errorCode,
      occurredAt,
    });
  }

  /** Records an already constructed result for lifecycle-specific callers. */
  record(result: VoiceBackendResult): VoiceResult<VoiceBackendResult> {
    const boundedText = result.text === undefined ? undefined : this.boundText(result.text);
    const boundedResult =
      boundedText === undefined && result.text === undefined
        ? result
        : {
            ...result,
            ...(boundedText !== undefined ? { text: boundedText } : { text: undefined }),
          };
    const persisted = this.store.recordBackendResult(boundedResult);
    if (persisted.isErr()) return err(persisted.error);
    if (!this.publisher) return ok(boundedResult);

    try {
      const publication = this.publisher(boundedResult);
      if (publication && publication.isErr()) {
        // Delivery is intentionally separate from execution. The lifecycle
        // owner records this failure through recordOutputLifecycle().
        return ok(boundedResult);
      }
    } catch {
      // A sideband/delivery callback must never cause provider work to replay.
    }
    return ok(boundedResult);
  }

  private boundText(text: string): string | undefined {
    if (text.length === 0) return undefined;
    return text.slice(0, this.maxOutputChars);
  }
}

/** Alias for composition code that prefers the persistence-oriented name. */
export { VoiceOutputSink as DurableVoiceOutputSink };

function lifecycle(
  execution: VoiceExecutionStatus,
  delivery: VoiceDeliveryStatus,
): VoiceOutputLifecycle {
  return {
    execution,
    delivery,
    providerAcknowledgement: 'not_sent',
    playback: 'not_started',
  };
}
