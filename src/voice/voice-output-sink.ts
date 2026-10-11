/**
 * Durable voice execution output boundary.
 *
 * Persistence happens before the optional publisher is called. A publisher
 * failure is delivery state for the lifecycle owner and never causes the
 * AgentRunner to execute the delegation again.
 */

import { v4 as uuidv4 } from 'uuid';
import { err, ok } from 'neverthrow';

import { DbError } from '../core/errors/index.js';
import type {
  VoiceBackendResult,
  VoiceDelegationRecord,
  VoiceDeliveryStatus,
  VoiceExecutionStatus,
  VoiceOutputLifecycle,
  VoiceOutputStatusDto,
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

/**
 * Reconstructs the result represented by the state accepted by the store.
 *
 * The store deliberately returns the current delegation for duplicate and
 * stale writes. Callers must publish that durable state instead of the
 * rejected incoming result.
 */
export function authoritativeVoiceResult(
  store: Pick<VoiceStore, 'readSession'>,
  persisted: VoiceDelegationRecord,
): VoiceResult<VoiceBackendResult> {
  const projectionResult = store.readSession(persisted.sessionId);
  if (projectionResult.isErr()) return err(projectionResult.error);
  if (!projectionResult.value) {
    return err(new DbError(`Voice session not found: ${persisted.sessionId}`));
  }

  const outputs = projectionResult.value.outputs
    .filter((output) => output.delegationId === persisted.id)
    .sort(compareOutputStatus);
  if (persisted.execution === 'succeeded') {
    const retainedFinal = outputs.find(
      (output) => output.kind === 'final' && output.lifecycle.execution === 'succeeded',
    );
    if (!retainedFinal) {
      return err(new DbError(`Voice delegation has no retained final output: ${persisted.id}`));
    }
    return ok(resultFromOutput(retainedFinal));
  }

  const retainedExecutionOutputs = outputs.filter(
    (output) => output.lifecycle.execution === persisted.execution,
  );
  const retainedExecution = retainedExecutionOutputs.at(-1);
  if (isTerminalExecution(persisted.execution) && !retainedExecution) {
    return ok({
      delegationId: persisted.id,
      outputId: `voice-terminal:${persisted.id}`,
      kind: persisted.execution === 'failed' ? 'error' : 'unknown',
      execution: persisted.execution,
      output: persisted.output,
      occurredAt: persisted.completedAt ?? persisted.createdAt,
    });
  }

  const latest = outputs.at(-1);
  if (!latest) {
    return err(new DbError(`Voice delegation has no retained output: ${persisted.id}`));
  }
  return ok(resultFromOutput(retainedExecution ?? latest));
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
    const authoritative = authoritativeVoiceResult(this.store, persisted.value);
    if (authoritative.isErr()) return err(authoritative.error);
    if (!this.publisher) return authoritative;

    try {
      const publication = this.publisher(authoritative.value);
      if (publication && publication.isErr()) {
        // Delivery is intentionally separate from execution. The lifecycle
        // owner records this failure through recordOutputLifecycle().
        return authoritative;
      }
    } catch {
      // A sideband/delivery callback must never cause provider work to replay.
    }
    return authoritative;
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

function isTerminalExecution(execution: VoiceExecutionStatus): boolean {
  return execution === 'failed' || execution === 'unknown' || execution === 'skipped';
}

function compareOutputStatus(left: VoiceOutputStatusDto, right: VoiceOutputStatusDto): number {
  return left.createdAt - right.createdAt;
}

function resultFromOutput(output: VoiceOutputStatusDto): VoiceBackendResult {
  return {
    delegationId: output.delegationId,
    outputId: output.id,
    kind: output.kind,
    ...(output.text !== undefined ? { text: output.text } : {}),
    execution: output.lifecycle.execution,
    output: output.lifecycle,
    occurredAt: output.createdAt,
  };
}
