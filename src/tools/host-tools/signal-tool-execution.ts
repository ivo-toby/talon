import { randomUUID } from 'node:crypto';
import { err, ok, type Result } from 'neverthrow';
import type { AgentOutput, ChannelConnector } from '../../channels/channel-types.js';
import { SignalConnector } from '../../channels/connectors/signal/signal-connector.js';
import { parseSignalExternalId } from '../../channels/connectors/signal/signal-identities.js';
import type { QueueRepository } from '../../core/database/repositories/queue-repository.js';
import type { RunRepository } from '../../core/database/repositories/run-repository.js';
import type { PersonaLoader } from '../../personas/persona-loader.js';
import { parseSignalQueuePayload } from '../../queue/signal-delivery-state.js';
import type { SignalInvocationGuard } from '../../daemon/signal-invocation-guard.js';
import type { ToolExecutionContext } from './channel-send.js';
import { isToolAllowed } from '../tool-filter.js';

import type { SignalDeliveryFailure, SignalDeliveryReason } from '../../core/errors/error-types.js';
import {
  DbError,
  DeliveryCancelled,
  DeliveryDeferredError,
  NonRetryableRunError,
  SignalDeliveryError,
} from '../../core/errors/error-types.js';
import { SignalCheckpointError } from '../../queue/signal-delivery-checkpoint.js';
import { SignalIdentityError } from '../../channels/connectors/signal/signal-identities.js';

export type SignalToolFailure = Readonly<
  {
    reason: SignalDeliveryReason | 'EXECUTION_UNAVAILABLE' | 'CAPABILITY_DENIED' | 'INTERNAL_ERROR';
    providerRetryable: false;
    queued: false;
    action: 'repair_context' | 'later_explicit_call' | 'inspect_do_not_repeat';
  } & Partial<
    Pick<
      SignalDeliveryFailure,
      | 'outcome'
      | 'acceptedChunks'
      | 'currentChunkAcceptance'
      | 'successCount'
      | 'failureCount'
      | 'notBefore'
    >
  >
>;

/** Intentional model boundary: never serialize retained producer Error/cause objects. */
export function signalToolFailure(error?: Error): SignalToolFailure {
  const failure =
    error instanceof DeliveryDeferredError || error instanceof NonRetryableRunError
      ? error.deliveryError
      : error;
  if (failure instanceof SignalDeliveryError)
    return {
      reason: failure.reason,
      outcome: failure.outcome,
      acceptedChunks: failure.acceptedChunks,
      currentChunkAcceptance: failure.currentChunkAcceptance,
      successCount: failure.successCount,
      failureCount: failure.failureCount,
      ...(failure.notBefore === undefined ? {} : { notBefore: failure.notBefore }),
      providerRetryable: false,
      queued: false,
      action:
        failure.outcome === 'NOT_SENT' && failure.reason !== 'TARGET_LATCHED'
          ? 'later_explicit_call'
          : 'inspect_do_not_repeat',
    };
  let reason: SignalToolFailure['reason'] = 'INTERNAL_ERROR';
  if (error === undefined) reason = 'EXECUTION_UNAVAILABLE';
  else if (error instanceof SignalToolExecutionError) reason = error.reason;
  else if (error instanceof DbError) reason = 'STATE_WRITE_FAILED';
  else if (error instanceof SignalCheckpointError) reason = 'CHECKPOINT_INVALID';
  else if (error instanceof SignalIdentityError)
    reason = error.reason === 'ACCOUNT_MISMATCH' ? 'ACCOUNT_MISMATCH' : 'INVALID_DESTINATION';
  else if (error instanceof DeliveryCancelled) reason = 'CANCELLED';
  return {
    reason,
    providerRetryable: false,
    queued: false,
    action:
      error === undefined || error instanceof SignalToolExecutionError
        ? 'repair_context'
        : 'inspect_do_not_repeat',
  };
}

export interface SignalToolExecutionIdentity {
  readonly runId: string;
  readonly threadId: string;
  readonly personaId: string;
  readonly queueItemId: string;
  readonly guard: SignalInvocationGuard;
}
export interface SignalToolExecutionRegistration {
  /** Runner finally only. Does not cancel submitted sends or certify producer/handler drain. */
  close(): void;
}
export interface SignalToolExecutionDependencies {
  readonly queue: QueueRepository;
  readonly runs: Pick<RunRepository, 'findById'>;
  readonly personas: Pick<PersonaLoader, 'getById'>;
}

export class SignalToolExecutionError extends Error {
  constructor(readonly reason: 'EXECUTION_UNAVAILABLE' | 'CAPABILITY_DENIED') {
    super('Signal tool execution refused');
  }
}
const unavailable = (): SignalToolExecutionError =>
  new SignalToolExecutionError('EXECUTION_UNAVAILABLE');

/** Per-daemon injected live registry, NOT bridge authentication. Only trusted Runner code registers
 * an already issued guard after REAL run insertion; request/model context cannot register one.
 * 012 must share this instance, retain bridge authentication, and quiesce before replacement. */
export class SignalToolExecutionRegistry {
  private readonly executions = new Map<string, Readonly<SignalToolExecutionIdentity>>();
  private readonly registeredGuards = new WeakSet<SignalInvocationGuard>();

  constructor(private readonly dependencies: SignalToolExecutionDependencies) {}

  register(input: SignalToolExecutionIdentity): Result<SignalToolExecutionRegistration, Error> {
    if (this.executions.has(input.runId) || this.registeredGuards.has(input.guard))
      return err(unavailable());
    const identity = Object.freeze({
      runId: input.runId,
      threadId: input.threadId,
      personaId: input.personaId,
      queueItemId: input.queueItemId,
      guard: input.guard,
    });
    const checked = this.validate(identity);
    if (checked.isErr()) return err(checked.error);
    this.executions.set(identity.runId, identity);
    this.registeredGuards.add(identity.guard);
    let closed = false;
    return ok(
      Object.freeze({
        close: (): void => {
          if (closed) return;
          closed = true;
          if (this.executions.get(identity.runId) !== identity) return;
          this.executions.delete(identity.runId);
          identity.guard.close();
        },
      }),
    );
  }

  resolve(
    context: Pick<ToolExecutionContext, 'runId' | 'threadId' | 'personaId'>,
  ): Result<SignalInvocationGuard, Error> {
    const current = this.executions.get(context.runId);
    if (
      current === undefined ||
      current.threadId !== context.threadId ||
      current.personaId !== context.personaId
    )
      return err(unavailable());
    return this.validate(current).map(() => current.guard);
  }

  async invoke(
    context: Pick<ToolExecutionContext, 'runId' | 'threadId' | 'personaId'>,
    connector: ChannelConnector,
    destination: string,
    output: AgentOutput,
  ): Promise<Result<void, Error>> {
    const resolved = this.resolve(context);
    if (resolved.isErr()) return err(resolved.error);
    const persona = this.dependencies.personas.getById(context.personaId);
    if (persona.isErr()) return err(persona.error);
    if (persona.value === undefined) return err(new SignalToolExecutionError('CAPABILITY_DENIED'));
    // Preserve the existing prefix-only filter, including requireApproval exposure. This is
    // compatibility, not confirmation or fine-grained channel-scope enforcement.
    if (!isToolAllowed('channel.send', persona.value.resolvedCapabilities))
      return err(new SignalToolExecutionError('CAPABILITY_DENIED'));
    if (!(connector instanceof SignalConnector)) return err(unavailable());
    const target = parseSignalExternalId(destination);
    if (target.isErr()) return err(target.error);
    try {
      return await resolved.value.invoke(
        {
          deliveryId: randomUUID(),
          purpose: 'explicit',
          accountUuid: target.value.accountUuid,
          destination,
        },
        (trustedDelivery) => connector.send(destination, { ...output, trustedDelivery }),
      );
    } catch (cause) {
      // Guard already latches unclassified acceptance. Retain Error identity internally; the
      // handler's fixed projection is the ONLY model/diagnostic boundary for this Result.
      return err(cause instanceof Error ? cause : new Error('Signal operation failed'));
    }
  }

  private validate(identity: SignalToolExecutionIdentity): Result<void, Error> {
    const issued = identity.guard.context('tool-registration', 'explicit');
    if (issued.isErr()) return err(issued.error);
    if (issued.value.queueItemId !== identity.queueItemId || issued.value.runId !== identity.runId)
      return err(unavailable());
    const row = this.dependencies.queue.findById(identity.queueItemId);
    if (row.isErr()) return err(row.error);
    if (row.value === null) return err(new DeliveryCancelled());
    if (
      row.value.thread_id !== identity.threadId ||
      !['pending', 'failed', 'claimed', 'processing'].includes(row.value.status)
    )
      return err(unavailable());
    const payload = parseSignalQueuePayload(row.value.payload);
    if (payload.isErr()) return err(payload.error);
    if (payload.value.personaId !== identity.personaId) return err(unavailable());
    const run = this.dependencies.runs.findById(identity.runId);
    if (run.isErr()) return err(run.error);
    if (
      run.value === null ||
      run.value.queue_item_id !== identity.queueItemId ||
      run.value.thread_id !== identity.threadId ||
      run.value.persona_id !== identity.personaId ||
      run.value.status !== 'running'
    )
      return err(unavailable());
    return ok(undefined);
  }
}

/** Actual account/transport restrictions, not recipient refusal, target latch or local contention. */
export function stopsSignalBroadcastAccount(error: Error): boolean {
  const failure =
    error instanceof DeliveryDeferredError || error instanceof NonRetryableRunError
      ? error.deliveryError
      : error;
  return (
    failure instanceof SignalDeliveryError &&
    (failure.outcome === 'UNKNOWN' ||
      [
        'RATE_LIMITED',
        'CHALLENGE_REQUIRED',
        'RECOVERY_PENDING',
        'STATE_WRITE_FAILED',
        'UNAVAILABLE',
        'VERIFICATION_PENDING',
        'VERIFICATION_STALE',
        'DISCONNECTED',
        'TIMEOUT',
        'NETWORK_FAILURE',
        'UNKNOWN_ACCEPTANCE',
      ].includes(failure.reason))
  );
}
