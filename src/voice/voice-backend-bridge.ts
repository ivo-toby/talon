/**
 * Durable bridge between server-created voice delegations and Talon's normal
 * queue/AgentRunner path.
 *
 * The bridge owns the voice-specific claim CAS and the last pre-provider
 * eligibility boundary. It deliberately does not execute provider work or
 * deliver audio; those concerns remain with AgentRunner and lifecycle code.
 */

import { v4 as uuidv4 } from 'uuid';
import { err, ok } from 'neverthrow';
import type pino from 'pino';

import type {
  QueueItemRow,
  QueueRepository,
} from '../core/database/repositories/queue-repository.js';
import { DbError, PolicyError } from '../core/errors/index.js';
import { authoritativeVoiceResult } from './voice-output-sink.js';
import type {
  VoiceAdmissionReceipt,
  VoiceAsyncResult,
  VoiceBackendBridge as VoiceBackendBridgeContract,
  VoiceBackendRequest,
  VoiceBackendResult,
  VoiceDelegationRecord,
  VoiceEventHandler,
  VoiceOwnerContext,
  VoiceOutputLifecycle,
  VoiceResult,
  VoiceSessionReadProjection,
  VoiceStore,
  VoiceUnsubscribe,
} from './voice-types.js';

/** Actual runtime posture supplied by AgentRunner at the provider boundary. */
export interface VoiceExecutionGateInput {
  readonly request: VoiceBackendRequest;
  readonly owner: VoiceOwnerContext;
  readonly providerName: string;
  readonly providerType: string;
  readonly modelName: string;
  readonly capabilityNames: readonly string[];
  readonly allowedToolNames: readonly string[];
  /** Configured, non-internal MCP server names after persona resolution. */
  readonly allowedMcpServerNames: readonly string[];
  readonly nativeToolNames: readonly string[];
  readonly nativeToolsDisabled: boolean;
  readonly requireApproval: boolean;
}

/**
 * Fresh policy/revocation check injected by the lifecycle owner. A synchronous
 * Result is accepted for small in-process resolvers as well as async stores.
 */
export type VoiceExecutionGate = (
  input: VoiceExecutionGateInput,
) => VoiceResult<void> | VoiceAsyncResult<void>;

export interface VoiceBackendBridgeOptions {
  /** Current policy/auth/config resolver owned by the lifecycle task. */
  readonly executionGate?: VoiceExecutionGate;
  /** Injectable clock for deterministic persistence tests. */
  readonly now?: () => number;
  /** Optional logger for asynchronous listener failures. */
  readonly logger?: pino.Logger;
}

const SUPPORTED_RESTRICTED_PROVIDER_TYPES = new Set([
  'claude-code',
  'gemini-cli',
  'openai-compatible',
]);

const INITIAL_OUTPUT_LIFECYCLE: VoiceOutputLifecycle = {
  execution: 'not_started',
  delivery: 'not_requested',
  providerAcknowledgement: 'not_sent',
  playback: 'not_started',
};

/** Concrete implementation of the frozen VoiceBackendBridge contract. */
export class DurableVoiceBackendBridge implements VoiceBackendBridgeContract {
  private readonly listeners = new Map<string, Set<VoiceEventHandler<VoiceBackendResult>>>();
  private readonly recentResults = new Map<string, VoiceBackendResult>();
  private readonly now: () => number;

  constructor(
    private readonly store: VoiceStore,
    private readonly queueRepository?: QueueRepository,
    private readonly options: VoiceBackendBridgeOptions = {},
  ) {
    this.now = options.now ?? Date.now;
  }

  admit(request: VoiceBackendRequest): VoiceAsyncResult<VoiceAdmissionReceipt> {
    const admissionError = this.validateAdmissionRequest(request);
    if (admissionError) return Promise.resolve(err(admissionError));

    const sessionResult = this.store.findSession(request.sessionId);
    if (sessionResult.isErr()) return Promise.resolve(err(sessionResult.error));
    const session = sessionResult.value;
    if (!session)
      return Promise.resolve(err(new DbError(`Voice session not found: ${request.sessionId}`)));
    if (
      session.status === 'closing' ||
      session.status === 'closed' ||
      session.status === 'expired' ||
      session.status === 'failed'
    ) {
      return Promise.resolve(
        err(new PolicyError(`Voice session ${request.sessionId} does not accept new work`)),
      );
    }
    if (
      session.owner.ownerId !== request.policy.ownerId ||
      session.owner.loginRevision !== request.policy.loginRevision ||
      session.personaId !== request.personaId ||
      session.threadId !== request.threadId ||
      session.policy.personaId !== request.policy.personaId ||
      stableJson(session.policy) !== stableJson(request.policy)
    ) {
      return Promise.resolve(
        err(new PolicyError('Voice admission does not match the session owner or policy')),
      );
    }

    const existingResult = this.store.findDelegation(request.delegationId);
    if (existingResult.isErr()) return Promise.resolve(err(existingResult.error));
    if (existingResult.value) {
      if (stableJson(existingResult.value.request) !== stableJson(request)) {
        return Promise.resolve(
          err(new PolicyError(`Voice delegation already exists: ${request.delegationId}`)),
        );
      }
      return Promise.resolve(this.receiptForDelegation(existingResult.value));
    }

    const delegation = {
      id: request.delegationId,
      sessionId: request.sessionId,
      providerDelegationId: request.providerDelegationId,
      revision: 0,
      contextVersion: request.context.version,
      contextDigest: request.context.digest,
      request,
      status: 'admitted' as const,
      execution: 'not_started' as const,
      output: INITIAL_OUTPUT_LIFECYCLE,
      queueItemId: uuidv4(),
      createdAt: request.requestedAt,
    };

    const admitted = this.store.admitDelegation({
      delegation,
      queue: {
        queueItemId: delegation.queueItemId,
        threadId: request.threadId,
        delegationId: request.delegationId,
        request,
        maxAttempts: 1,
      },
    });
    if (admitted.isOk()) return Promise.resolve(admitted);

    // A concurrent identical admission may have committed between the lookup
    // above and this transaction. Re-read only the same internal ID; a fresh
    // internal ID with a reused provider ID remains a store conflict.
    const concurrent = this.store.findDelegation(request.delegationId);
    if (
      concurrent.isOk() &&
      concurrent.value &&
      stableJson(concurrent.value.request) === stableJson(request)
    ) {
      return Promise.resolve(this.receiptForDelegation(concurrent.value));
    }
    return Promise.resolve(admitted);
  }

  result(delegationId: string): VoiceResult<VoiceBackendResult | null> {
    const sessionResult = this.findSessionForDelegation(delegationId);
    if (sessionResult.isErr()) return err(sessionResult.error);
    if (!sessionResult.value) return ok(this.recentResults.get(delegationId) ?? null);

    const { projection } = sessionResult.value;
    const delegation = projection.delegations.find((entry) => entry.id === delegationId);
    if (!delegation) return ok(this.recentResults.get(delegationId) ?? null);
    const outputs = projection.outputs
      .filter((output) => output.delegationId === delegationId)
      .sort((left, right) => left.createdAt - right.createdAt);
    const latest = outputs.at(-1);
    if (
      delegation.execution === 'failed' ||
      delegation.execution === 'unknown' ||
      delegation.execution === 'skipped'
    ) {
      if (!latest || latest.lifecycle.execution !== delegation.execution) {
        return ok({
          delegationId,
          outputId: `voice-terminal:${delegationId}`,
          kind: delegation.execution === 'failed' ? 'error' : 'unknown',
          execution: delegation.execution,
          output: delegation.output,
          occurredAt: delegation.completedAt ?? this.now(),
        });
      }
    }
    if (!latest) return ok(this.recentResults.get(delegationId) ?? null);

    return ok({
      delegationId,
      outputId: latest.id,
      kind: latest.kind,
      ...(latest.text !== undefined ? { text: latest.text } : {}),
      execution: latest.lifecycle.execution,
      output: latest.lifecycle,
      occurredAt: latest.updatedAt,
    });
  }

  onResult(delegationId: string, handler: VoiceEventHandler<VoiceBackendResult>): VoiceUnsubscribe {
    const handlers = this.listeners.get(delegationId) ?? new Set();
    handlers.add(handler);
    this.listeners.set(delegationId, handlers);
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) this.listeners.delete(delegationId);
    };
  }

  /**
   * Persists a result and then publishes it to delivery subscribers. The
   * output sink can use `notifyResult` when it already owns the persistence.
   */
  publish(result: VoiceBackendResult): VoiceResult<VoiceBackendResult> {
    const persisted = this.store.recordBackendResult(result);
    if (persisted.isErr()) return err(persisted.error);
    const authoritative = authoritativeVoiceResult(this.store, persisted.value);
    if (authoritative.isErr()) return err(authoritative.error);
    this.recentResults.set(authoritative.value.delegationId, authoritative.value);
    this.notifyResultListeners(authoritative.value);
    return ok(authoritative.value);
  }

  /** Alias kept explicit for callers that want to emphasize durable recording. */
  record(result: VoiceBackendResult): VoiceResult<VoiceBackendResult> {
    return this.publish(result);
  }

  /** Publishes a result that the output sink has already persisted. */
  notifyResult(result: VoiceBackendResult): void {
    this.recentResults.set(result.delegationId, result);
    this.notifyResultListeners(result);
  }

  /**
   * Claims a voice queue row transactionally with its delegation. A generic
   * queue claim must never run after this method loses a supersede/skip race.
   */
  claimQueueItem(row: QueueItemRow): VoiceResult<QueueItemRow | null> {
    if (!this.queueRepository) {
      return err(new DbError('Voice queue claiming requires QueueRepository'));
    }

    let payload: unknown;
    try {
      payload = JSON.parse(row.payload) as unknown;
    } catch (cause) {
      return err(new DbError(`Invalid voice queue payload: ${String(cause)}`));
    }
    if (
      !isRecord(payload) ||
      payload.kind !== 'voice_backend' ||
      typeof payload.delegationId !== 'string'
    ) {
      return err(new DbError(`Invalid voice queue payload for item ${row.id}`));
    }

    const delegationResult = this.store.findDelegation(payload.delegationId);
    if (delegationResult.isErr()) return err(delegationResult.error);
    const delegation = delegationResult.value;
    if (!delegation) return err(new DbError(`Voice delegation not found: ${payload.delegationId}`));
    if (delegation.queueItemId !== row.id || delegation.request.threadId !== row.thread_id) {
      return err(new DbError(`Voice queue binding mismatch for item ${row.id}`));
    }
    if (
      payload.sessionId !== delegation.sessionId ||
      !isRecord(payload.request) ||
      stableJson(payload.request) !== stableJson(delegation.request)
    ) {
      return err(new DbError(`Voice queue payload does not match delegation ${delegation.id}`));
    }
    const sessionResult = this.store.findSession(delegation.sessionId);
    if (sessionResult.isErr()) return err(sessionResult.error);
    if (!sessionResult.value) {
      return err(new DbError(`Voice session not found: ${delegation.sessionId}`));
    }
    if (
      sessionResult.value.status === 'closing' ||
      sessionResult.value.status === 'closed' ||
      sessionResult.value.status === 'expired' ||
      sessionResult.value.status === 'failed'
    ) {
      // Lifecycle reconciliation owns the durable skipped transition. Do not
      // claim work from a session that can no longer admit execution.
      return ok(null);
    }

    const claimResult = this.store.claimDelegation({
      delegationId: delegation.id,
      expectedRevision: delegation.revision,
      queueItemId: row.id,
      claimedAt: this.now(),
    });
    if (claimResult.isErr()) return err(claimResult.error);
    if (claimResult.value.outcome === 'lost') return ok(null);

    const claimedQueueResult = this.queueRepository.findById(row.id);
    if (claimedQueueResult.isErr()) return err(claimedQueueResult.error);
    if (!claimedQueueResult.value || claimedQueueResult.value.status !== 'claimed') {
      return err(new DbError(`Voice queue claim did not persist for item ${row.id}`));
    }
    return ok(claimedQueueResult.value);
  }

  /**
   * Last-mile eligibility boundary invoked after MCP auth materialization and
   * immediately before a provider strategy starts. Missing or failing
   * lifecycle policy is fail-closed.
   */
  async beforeProvider(input: VoiceExecutionGateInput): VoiceAsyncResult<void> {
    const validationError = this.validateExecutionInput(input);
    if (validationError) return err(validationError);
    if (!this.options.executionGate) {
      return err(new PolicyError('Voice execution policy resolver is not configured'));
    }

    try {
      const result = await this.options.executionGate(input);
      return result;
    } catch (cause) {
      return err(
        new PolicyError(
          `Voice execution policy check failed closed: ${String(cause)}`,
          cause instanceof Error ? cause : undefined,
        ),
      );
    }
  }

  private validateAdmissionRequest(request: VoiceBackendRequest): PolicyError | undefined {
    if (
      request.sessionId.length === 0 ||
      request.delegationId.length === 0 ||
      request.providerDelegationId.length === 0 ||
      request.threadId.length === 0 ||
      request.personaId.length === 0
    ) {
      return new PolicyError('Voice admission identifiers must be non-empty');
    }
    if (
      request.policy.ownerId.length === 0 ||
      request.policy.personaId !== request.personaId ||
      request.policy.requireApproval ||
      request.policy.nativeToolNames.length > 0 ||
      request.policy.allowedMcpServerNames.some((name) => name.startsWith('__talond_'))
    ) {
      return new PolicyError('Voice admission contains an unsupported or approval-gated policy');
    }
    return undefined;
  }

  private receiptForDelegation(
    delegation: VoiceDelegationRecord,
  ): VoiceResult<VoiceAdmissionReceipt> {
    if (!delegation.queueItemId) {
      return err(new DbError(`Voice delegation has no queue binding: ${delegation.id}`));
    }
    let admittedAt = delegation.createdAt;
    if (this.queueRepository) {
      const queueResult = this.queueRepository.findById(delegation.queueItemId);
      if (queueResult.isErr()) return err(queueResult.error);
      if (queueResult.value) admittedAt = queueResult.value.created_at;
    }
    return ok({
      delegationId: delegation.id,
      queueItemId: delegation.queueItemId,
      contextVersion: delegation.contextVersion,
      contextDigest: delegation.contextDigest,
      policyGeneration: delegation.request.policy.generation,
      admittedAt,
    });
  }

  private validateExecutionInput(input: VoiceExecutionGateInput): PolicyError | undefined {
    const policy = input.request.policy;
    if (
      input.owner.ownerId !== policy.ownerId ||
      input.owner.loginRevision !== policy.loginRevision
    ) {
      return new PolicyError('Voice execution owner or login revision does not match admission');
    }
    if (input.providerName !== policy.providerName || input.modelName !== policy.modelName) {
      return new PolicyError('Voice execution provider or model does not match admission');
    }
    if (
      !SUPPORTED_RESTRICTED_PROVIDER_TYPES.has(input.providerType) ||
      !input.nativeToolsDisabled ||
      input.nativeToolNames.length > 0 ||
      input.requireApproval ||
      policy.requireApproval ||
      policy.nativeToolNames.length > 0
    ) {
      return new PolicyError('Voice provider native tools or approval posture is not proven safe');
    }
    if (
      !sameSet(input.capabilityNames, policy.capabilityNames) ||
      !sameSet(input.allowedToolNames, policy.allowedToolNames) ||
      !sameSet(input.allowedMcpServerNames, policy.allowedMcpServerNames)
    ) {
      return new PolicyError('Voice execution capabilities or MCP access changed after admission');
    }
    return undefined;
  }

  private findSessionForDelegation(
    delegationId: string,
  ): VoiceResult<{ projection: VoiceSessionReadProjection } | null> {
    const delegationResult = this.store.findDelegation(delegationId);
    if (delegationResult.isErr()) return err(delegationResult.error);
    if (!delegationResult.value) return ok(null);
    const projectionResult = this.store.readSession(delegationResult.value.sessionId);
    if (projectionResult.isErr()) return err(projectionResult.error);
    if (!projectionResult.value) return ok(null);
    return ok({ projection: projectionResult.value });
  }

  private notifyResultListeners(result: VoiceBackendResult): void {
    const handlers = this.listeners.get(result.delegationId);
    if (!handlers) return;
    for (const handler of handlers) {
      try {
        void Promise.resolve(handler(result)).catch((cause: unknown) => {
          this.options.logger?.warn(
            { delegationId: result.delegationId, err: cause },
            'voice backend result listener failed',
          );
        });
      } catch (cause) {
        this.options.logger?.warn(
          { delegationId: result.delegationId, err: cause },
          'voice backend result listener failed',
        );
      }
    }
  }
}

/** Common short name for composition code. */
export { DurableVoiceBackendBridge as VoiceBackendBridge };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((value) => rightSet.has(value));
}

function stableJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry)).join(',')}]`;
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`);
  return `{${entries.join(',')}}`;
}
