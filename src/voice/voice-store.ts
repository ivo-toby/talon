/**
 * Durable store for browservoice sessions, delegations, and output state.
 *
 * The store owns compare-and-set transitions and the reservation/queue
 * transaction. Provider events are idempotent by their durable IDs; a reused
 * ID with a different immutable payload is rejected as a conflict.
 */

import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { err, ok } from 'neverthrow';
import type { TalonError } from '../core/errors/error-types.js';
import { DbError } from '../core/errors/index.js';
import type { QueueItemRow } from '../core/database/repositories/queue-repository.js';
import { QueueRepository } from '../core/database/repositories/queue-repository.js';
import {
  VoiceRepository,
  type VoiceDelegationRow,
  type VoiceOutputRow,
  type VoiceSessionRow,
} from '../core/database/repositories/voice-repository.js';
import type {
  VoiceAdmissionReceipt,
  VoiceAdmissionRequest,
  VoiceBackendRequest,
  VoiceBackendResult,
  VoiceClaimRequest,
  VoiceClaimResult,
  VoiceDelegationRecord,
  VoiceExecutionStatus,
  VoiceOutputLifecycle,
  VoiceOutputLifecycleUpdate,
  VoiceOutputStatusDto,
  VoiceResult,
  VoiceSessionListQuery,
  VoiceSessionReadProjection,
  VoiceSessionRecord,
  VoiceSessionRecoveryQuery,
  VoiceSessionUpdateRequest,
  VoiceSkipRequest,
  VoiceStore as VoiceStoreContract,
  VoiceStoreTransaction,
  VoiceSupersedeRequest,
  VoiceSupersedeResult,
} from './voice-types.js';

/** Internal exception used to make a Result error roll back a SQLite tx. */
class TransactionRollback extends Error {
  constructor(readonly error: TalonError) {
    super(error.message);
    this.name = 'TransactionRollback';
  }
}

interface VoiceTransactionState {
  active: boolean;
  reservedDelegationIds: Set<string>;
  enqueuedDelegationIds: Set<string>;
}

/** Stable JSON keeps idempotency comparisons independent of object key order. */
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

function digest(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function optional(value: string | null): string | undefined {
  return value ?? undefined;
}

function lifecycleToColumns(lifecycle: VoiceOutputLifecycle): Pick<
  VoiceDelegationRow,
  'execution_status' | 'delivery_status' | 'provider_ack_status' | 'playback_status'
> {
  return {
    execution_status: lifecycle.execution,
    delivery_status: lifecycle.delivery,
    provider_ack_status: lifecycle.providerAcknowledgement,
    playback_status: lifecycle.playback,
  };
}

function lifecycleFromColumns(row: Pick<
  VoiceDelegationRow,
  'execution_status' | 'delivery_status' | 'provider_ack_status' | 'playback_status'
>): VoiceOutputLifecycle {
  return {
    execution: row.execution_status,
    delivery: row.delivery_status,
    providerAcknowledgement: row.provider_ack_status,
    playback: row.playback_status,
  };
}

function isTerminalExecution(status: VoiceExecutionStatus): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'unknown' || status === 'skipped';
}

function conflict(message: string): DbError {
  return new DbError(`Voice persistence conflict: ${message}`);
}

/** Durable implementation of the frozen VoiceStore contract. */
export class DurableVoiceStore implements VoiceStoreContract {
  private readonly db: Database.Database;
  private readonly repository: VoiceRepository;
  private readonly queueRepository: QueueRepository;

  constructor(db: Database.Database, queueRepository?: QueueRepository, repository?: VoiceRepository);
  constructor(repository: VoiceRepository, queueRepository?: QueueRepository);
  constructor(
    dbOrRepository: Database.Database | VoiceRepository,
    queueRepository?: QueueRepository,
    repository?: VoiceRepository,
  ) {
    if (dbOrRepository instanceof VoiceRepository) {
      this.repository = dbOrRepository;
      this.db = dbOrRepository.database;
    } else {
      this.db = dbOrRepository;
      this.repository = repository ?? new VoiceRepository(dbOrRepository);
    }
    this.queueRepository = queueRepository ?? new QueueRepository(this.db);
  }

  findSession(id: string): VoiceResult<VoiceSessionRecord | null> {
    const result = this.repository.findSessionById(id);
    if (result.isErr()) return err(result.error);
    return result.value ? this.sessionFromRow(result.value) : ok(null);
  }

  createSession(session: VoiceSessionRecord): VoiceResult<VoiceSessionRecord> {
    const row = this.sessionToRow(session);
    const existing = this.repository.findSessionById(session.id);
    if (existing.isErr()) return err(existing.error);
    if (existing.value) {
      if (existing.value.record_digest !== row.record_digest) {
        return err(conflict(`session id ${session.id} has different content`));
      }
      return this.sessionFromRow(existing.value);
    }

    if (session.providerSessionId !== undefined) {
      const providerExisting = this.repository.findSessionByProviderId(session.providerSessionId);
      if (providerExisting.isErr()) return err(providerExisting.error);
      if (providerExisting.value && providerExisting.value.id !== session.id) {
        return err(conflict(`provider session id ${session.providerSessionId} is already bound`));
      }
    }

    const inserted = this.repository.insertSession(row);
    if (inserted.isErr()) return err(inserted.error);
    return this.sessionFromRow(inserted.value);
  }

  updateSession(input: VoiceSessionUpdateRequest): VoiceResult<VoiceSessionRecord> {
    const currentResult = this.repository.findSessionById(input.sessionId);
    if (currentResult.isErr()) return err(currentResult.error);
    if (!currentResult.value) return err(new DbError(`Voice session not found: ${input.sessionId}`));
    if (currentResult.value.revision !== input.expectedRevision) {
      return err(new DbError(`Stale voice session revision: ${input.sessionId}`));
    }

    const current = this.sessionFromRow(currentResult.value);
    if (current.isErr()) return err(current.error);
    const next: VoiceSessionRecord = {
      ...current.value,
      ...input.patch,
      revision: input.expectedRevision + 1,
    };
    if (
      current.value.providerSessionId !== undefined &&
      next.providerSessionId !== current.value.providerSessionId
    ) {
      return err(new DbError('Provider session identity is immutable once assigned'));
    }

    if (next.providerSessionId !== undefined && next.providerSessionId !== current.value.providerSessionId) {
      const providerExisting = this.repository.findSessionByProviderId(next.providerSessionId);
      if (providerExisting.isErr()) return err(providerExisting.error);
      if (providerExisting.value && providerExisting.value.id !== next.id) {
        return err(conflict(`provider session id ${next.providerSessionId} is already bound`));
      }
    }

    const nextRow = this.sessionToRow(next);
    nextRow.updated_at = input.updatedAt;
    const updated = this.repository.updateSession(nextRow, input.expectedRevision);
    if (updated.isErr()) return err(updated.error);
    if (!updated.value) return err(new DbError(`Stale voice session revision: ${input.sessionId}`));
    return this.sessionFromRow(updated.value);
  }

  readSession(id: string): VoiceResult<VoiceSessionReadProjection | null> {
    const sessionResult = this.repository.findSessionById(id);
    if (sessionResult.isErr()) return err(sessionResult.error);
    if (!sessionResult.value) return ok(null);
    return this.projectionFromRow(sessionResult.value);
  }

  listSessions(input: VoiceSessionListQuery): VoiceResult<readonly VoiceSessionReadProjection[]> {
    const rows = this.repository.findSessions({
      ownerId: input.ownerId,
      statuses: input.statuses,
    });
    if (rows.isErr()) return err(rows.error);
    const projections: VoiceSessionReadProjection[] = [];
    for (const row of rows.value) {
      const projection = this.projectionFromRow(row);
      if (projection.isErr()) return err(projection.error);
      projections.push(projection.value);
    }
    return ok(projections);
  }

  recoverSessions(
    input: VoiceSessionRecoveryQuery,
  ): VoiceResult<readonly VoiceSessionReadProjection[]> {
    const rows = this.repository.findSessions({ statuses: input.statuses, before: input.before });
    if (rows.isErr()) return err(rows.error);
    const projections: VoiceSessionReadProjection[] = [];
    for (const row of rows.value) {
      const projection = this.projectionFromRow(row);
      if (projection.isErr()) return err(projection.error);
      projections.push(projection.value);
    }
    return ok(projections);
  }

  findDelegation(id: string): VoiceResult<VoiceDelegationRecord | null> {
    const result = this.repository.findDelegationById(id);
    if (result.isErr()) return err(result.error);
    return result.value ? this.delegationFromRow(result.value) : ok(null);
  }

  claimDelegation(input: VoiceClaimRequest): VoiceResult<VoiceClaimResult> {
    return this.runInTransaction((tx) => tx.claimDelegation(input));
  }

  private claimDelegationInTransaction(input: VoiceClaimRequest): VoiceResult<VoiceClaimResult> {
    const currentResult = this.repository.findDelegationById(input.delegationId);
    if (currentResult.isErr()) return err(currentResult.error);
    if (!currentResult.value) return ok({ outcome: 'lost', reason: 'missing' });

    const current = currentResult.value;
    const currentRecord = this.delegationFromRow(current);
    if (currentRecord.isErr()) return err(currentRecord.error);
    if (current.revision !== input.expectedRevision) {
      return ok({ outcome: 'lost', reason: 'stale_revision', delegation: currentRecord.value });
    }
    if (current.status === 'superseded') {
      return ok({ outcome: 'lost', reason: 'superseded', delegation: currentRecord.value });
    }
    if (current.status === 'skipped') {
      return ok({ outcome: 'lost', reason: 'skipped', delegation: currentRecord.value });
    }
    if (current.status === 'claimed' || current.status === 'running') {
      return ok({ outcome: 'lost', reason: 'already_claimed', delegation: currentRecord.value });
    }
    if (current.status !== 'admitted' && current.status !== 'queued') {
      return ok({ outcome: 'lost', reason: 'already_claimed', delegation: currentRecord.value });
    }
    if (current.queue_item_id !== input.queueItemId) {
      return ok({ outcome: 'lost', reason: 'missing', delegation: currentRecord.value });
    }

    const claimedQueue = this.claimQueueItem(input.queueItemId, input.claimedAt);
    if (claimedQueue.isErr()) return err(claimedQueue.error);
    if (!claimedQueue.value) {
      const queueState = this.queueRepository.findById(input.queueItemId);
      if (queueState.isErr()) return err(queueState.error);
      const reason = queueState.value?.status === 'claimed' || queueState.value?.status === 'processing'
        ? 'already_claimed'
        : queueState.value?.status === 'completed' || queueState.value?.status === 'dead_letter'
          ? 'skipped'
          : 'missing';
      return ok({ outcome: 'lost', reason, delegation: currentRecord.value });
    }

    const next: VoiceDelegationRow = {
      ...current,
      revision: current.revision + 1,
      status: 'claimed',
      execution_status: 'not_started',
      claimed_at: input.claimedAt,
      updated_at: input.claimedAt,
    };
    const updated = this.repository.updateDelegation(next, current.revision);
    if (updated.isErr()) return err(updated.error);
    if (!updated.value) return err(new DbError(`Voice delegation claim lost: ${input.delegationId}`));
    const delegation = this.delegationFromRow(updated.value);
    if (delegation.isErr()) return err(delegation.error);
    return ok({ outcome: 'claimed', delegation: delegation.value });
  }

  supersedeDelegation(input: VoiceSupersedeRequest): VoiceResult<VoiceSupersedeResult> {
    return this.runInTransaction((tx) => tx.supersedeDelegation(input));
  }

  private supersedeDelegationInTransaction(
    input: VoiceSupersedeRequest,
  ): VoiceResult<VoiceSupersedeResult> {
    const originalResult = this.repository.findDelegationById(input.originalDelegationId);
    if (originalResult.isErr()) return err(originalResult.error);
    if (!originalResult.value) return ok({ outcome: 'not_replaceable', reason: 'missing' });

    const original = originalResult.value;
    const originalRecord = this.delegationFromRow(original);
    if (originalRecord.isErr()) return err(originalRecord.error);
    if (original.revision !== input.expectedRevision) {
      return ok({ outcome: 'not_replaceable', reason: 'stale_revision', original: originalRecord.value });
    }

    const terminalReason = {
      claimed: 'claimed',
      running: 'running',
      completed: 'completed',
      failed: 'failed',
      unknown: 'unknown',
    } as const;
    if (original.status in terminalReason) {
      return ok({
        outcome: 'not_replaceable',
        reason: terminalReason[original.status as keyof typeof terminalReason],
        original: originalRecord.value,
      });
    }
    if (original.status !== 'admitted' && original.status !== 'queued') {
      return ok({ outcome: 'not_replaceable', reason: 'missing', original: originalRecord.value });
    }
    if (original.queue_item_id) {
      const queueState = this.queueRepository.findById(original.queue_item_id);
      if (queueState.isErr()) return err(queueState.error);
      if (queueState.value?.status === 'claimed' || queueState.value?.status === 'processing') {
        return ok({ outcome: 'not_replaceable', reason: 'claimed', original: originalRecord.value });
      }
      if (queueState.value?.status === 'completed') {
        return ok({ outcome: 'not_replaceable', reason: 'completed', original: originalRecord.value });
      }
      if (queueState.value?.status === 'dead_letter') {
        return ok({ outcome: 'not_replaceable', reason: 'failed', original: originalRecord.value });
      }
    }

    const replacement = input.replacement;
    if (replacement.id === original.id || replacement.supersedesDelegationId !== original.id) {
      return err(new DbError('Voice replacement must have a new id and reference the original delegation'));
    }
    if (replacement.sessionId !== original.session_id) {
      return err(new DbError('Voice replacement must remain in the original session'));
    }

    const replacementRow = this.delegationToRow(replacement);
    const duplicateId = this.repository.findDelegationById(replacement.id);
    if (duplicateId.isErr()) return err(duplicateId.error);
    if (duplicateId.value && duplicateId.value.record_digest !== replacementRow.record_digest) {
      return err(conflict(`delegation id ${replacement.id} has different content`));
    }
    if (duplicateId.value) {
      const existingReplacement = this.delegationFromRow(duplicateId.value);
      if (existingReplacement.isErr()) return err(existingReplacement.error);
      const supersededOriginal = this.markSuperseded(original, input.supersededAt);
      if (supersededOriginal.isErr()) return err(supersededOriginal.error);
      return ok({
        outcome: 'superseded',
        original: supersededOriginal.value,
        replacement: existingReplacement.value,
      });
    }

    const providerDuplicate = this.repository.findDelegationByProviderId(
      replacement.sessionId,
      replacement.providerDelegationId,
    );
    if (providerDuplicate.isErr()) return err(providerDuplicate.error);
    if (providerDuplicate.value) {
      return err(
        conflict(`provider delegation id ${replacement.providerDelegationId} is already bound in the session`),
      );
    }

    const supersededOriginal = this.markSuperseded(original, input.supersededAt);
    if (supersededOriginal.isErr()) return err(supersededOriginal.error);
    const inserted = this.repository.insertDelegation(replacementRow);
    if (inserted.isErr()) return err(inserted.error);
    const replacementRecord = this.delegationFromRow(inserted.value);
    if (replacementRecord.isErr()) return err(replacementRecord.error);
    return ok({
      outcome: 'superseded',
      original: supersededOriginal.value,
      replacement: replacementRecord.value,
    });
  }

  skipDelegation(input: VoiceSkipRequest): VoiceResult<VoiceDelegationRecord> {
    return this.runInTransaction((tx) => tx.skipDelegation(input));
  }

  private skipDelegationInTransaction(input: VoiceSkipRequest): VoiceResult<VoiceDelegationRecord> {
    const currentResult = this.repository.findDelegationById(input.delegationId);
    if (currentResult.isErr()) return err(currentResult.error);
    if (!currentResult.value) return err(new DbError(`Voice delegation not found: ${input.delegationId}`));
    const current = currentResult.value;
    if (current.revision !== input.expectedRevision) {
      return err(new DbError(`Stale voice delegation revision: ${input.delegationId}`));
    }
    if (current.status !== 'admitted' && current.status !== 'queued') {
      return err(new DbError(`Voice delegation cannot be skipped from ${current.status}`));
    }
    if (current.queue_item_id) {
      const queueState = this.queueRepository.findById(current.queue_item_id);
      if (queueState.isErr()) return err(queueState.error);
      if (
        queueState.value?.status === 'claimed' ||
        queueState.value?.status === 'processing' ||
        queueState.value?.status === 'completed' ||
        queueState.value?.status === 'dead_letter'
      ) {
        return err(new DbError(`Voice delegation queue item is no longer unclaimed: ${current.queue_item_id}`));
      }
    }

    const updated: VoiceDelegationRow = {
      ...current,
      revision: current.revision + 1,
      status: 'skipped',
      execution_status: 'skipped',
      updated_at: input.skippedAt,
      completed_at: input.skippedAt,
    };
    const saved = this.repository.updateDelegation(updated, current.revision);
    if (saved.isErr()) return err(saved.error);
    if (!saved.value) return err(new DbError(`Voice delegation skip lost: ${input.delegationId}`));
    if (current.queue_item_id) {
      const queueResult = this.skipQueueItem(current.queue_item_id, input.reason, input.skippedAt);
      if (queueResult.isErr()) return err(queueResult.error);
    }
    return this.delegationFromRow(saved.value);
  }

  recordBackendResult(result: VoiceBackendResult): VoiceResult<VoiceDelegationRecord> {
    return this.runInTransaction((tx) => tx.recordBackendResult(result));
  }

  private recordBackendResultInTransaction(result: VoiceBackendResult): VoiceResult<VoiceDelegationRecord> {
    const currentResult = this.repository.findDelegationById(result.delegationId);
    if (currentResult.isErr()) return err(currentResult.error);
    if (!currentResult.value) return err(new DbError(`Voice delegation not found: ${result.delegationId}`));
    const current = currentResult.value;
    if (result.output.execution !== result.execution) {
      return err(conflict(`backend result execution disagrees with its output lifecycle`));
    }

    const latestOutputResult = current.latest_output_id
      ? this.repository.findOutputById(current.latest_output_id)
      : ok(null);
    if (latestOutputResult.isErr()) return err(latestOutputResult.error);
    const staleResult =
      latestOutputResult.value?.kind === 'final' ||
      (isTerminalExecution(current.execution_status) && result.kind !== 'final');

    let outputId: string | null = null;
    let duplicateOutput = false;
    if (result.kind === 'progress' || result.kind === 'final') {
      outputId = result.outputId;
      const outputIdentity = {
        id: result.outputId,
        delegationId: result.delegationId,
        kind: result.kind,
        text: result.text,
      };
      const outputDigest = digest(outputIdentity);
      const existingOutput = this.repository.findOutputById(result.outputId);
      if (existingOutput.isErr()) return err(existingOutput.error);
      if (existingOutput.value) {
        if (existingOutput.value.record_digest !== outputDigest) {
          return err(conflict(`output id ${result.outputId} has different content`));
        }
        duplicateOutput = true;
      } else if (!staleResult) {
        const lifecycle = lifecycleToColumns(result.output);
        const inserted = this.repository.insertOutput({
          id: result.outputId,
          delegation_id: result.delegationId,
          kind: result.kind,
          text: result.text ?? null,
          ...lifecycle,
          created_at: result.occurredAt,
          updated_at: result.occurredAt,
          record_digest: outputDigest,
        });
        if (inserted.isErr()) return err(inserted.error);
      }
    }

    if (staleResult || duplicateOutput) {
      return this.delegationFromRow(current);
    }

    const status = this.statusForResult(current.status, result);
    const completedAt = isTerminalExecution(result.execution) ? result.occurredAt : current.completed_at;
    const next: VoiceDelegationRow = {
      ...current,
      revision: current.revision + 1,
      status,
      ...lifecycleToColumns(result.output),
      latest_output_id: outputId ?? current.latest_output_id,
      error_code: result.errorCode ?? current.error_code,
      completed_at: completedAt,
      updated_at: result.occurredAt,
    };
    const updated = this.repository.updateDelegation(next, current.revision);
    if (updated.isErr()) return err(updated.error);
    if (!updated.value) return err(new DbError(`Voice backend result lost: ${result.delegationId}`));
    return this.delegationFromRow(updated.value);
  }

  recordOutputLifecycle(input: VoiceOutputLifecycleUpdate): VoiceResult<VoiceOutputStatusDto> {
    return this.runInTransaction((tx) => tx.recordOutputLifecycle(input));
  }

  private recordOutputLifecycleInTransaction(
    input: VoiceOutputLifecycleUpdate,
  ): VoiceResult<VoiceOutputStatusDto> {
    const outputResult = this.repository.findOutputById(input.outputId);
    if (outputResult.isErr()) return err(outputResult.error);
    if (!outputResult.value) return err(new DbError(`Voice output not found: ${input.outputId}`));
    if (outputResult.value.delegation_id !== input.delegationId) {
      return err(conflict(`output ${input.outputId} belongs to another delegation`));
    }

    const current = outputResult.value;
    if (input.lifecycle.execution !== current.execution_status) {
      return err(conflict(`output ${input.outputId} cannot change backend execution status`));
    }

    const delegationResult = this.repository.findDelegationById(input.delegationId);
    if (delegationResult.isErr()) return err(delegationResult.error);
    if (!delegationResult.value) return err(new DbError(`Voice delegation not found: ${input.delegationId}`));
    const delegation = delegationResult.value;
    if (
      delegation.latest_output_id === input.outputId &&
      input.lifecycle.execution !== delegation.execution_status
    ) {
      return err(conflict(`output ${input.outputId} disagrees with delegation execution status`));
    }

    const updatedOutput: VoiceOutputRow = {
      ...current,
      ...lifecycleToColumns(input.lifecycle),
      updated_at: Date.now(),
    };
    const savedOutput = this.repository.updateOutput(updatedOutput);
    if (savedOutput.isErr()) return err(savedOutput.error);
    if (!savedOutput.value) return err(new DbError(`Voice output update lost: ${input.outputId}`));

    if (delegation.latest_output_id === input.outputId) {
      const lifecycle = lifecycleToColumns(input.lifecycle);
      const updatedDelegation: VoiceDelegationRow = {
        ...delegation,
        revision: delegation.revision + 1,
        ...lifecycle,
        execution_status: delegation.execution_status,
        updated_at: updatedOutput.updated_at,
      };
      const savedDelegation = this.repository.updateDelegation(updatedDelegation, delegation.revision);
      if (savedDelegation.isErr()) return err(savedDelegation.error);
      if (!savedDelegation.value) return err(new DbError(`Voice delegation update lost: ${input.delegationId}`));
    }

    return this.outputDtoFromRow(savedOutput.value);
  }

  private createTransactionView(state: VoiceTransactionState): VoiceStoreTransaction {
    const invoke = <T>(operation: () => VoiceResult<T>): VoiceResult<T> => {
      if (!state.active) return err(new DbError('Voice transaction is no longer active'));
      return operation();
    };

    return {
      findSession: (id) => invoke(() => this.findSession(id)),
      createSession: (session) => invoke(() => this.createSession(session)),
      updateSession: (input) => invoke(() => this.updateSession(input)),
      readSession: (id) => invoke(() => this.readSession(id)),
      listSessions: (input) => invoke(() => this.listSessions(input)),
      recoverSessions: (input) => invoke(() => this.recoverSessions(input)),
      findDelegation: (id) => invoke(() => this.findDelegation(id)),
      claimDelegation: (input) => invoke(() => this.claimDelegationInTransaction(input)),
      supersedeDelegation: (input) => invoke(() => this.supersedeDelegationInTransaction(input)),
      skipDelegation: (input) => invoke(() => this.skipDelegationInTransaction(input)),
      recordBackendResult: (result) => invoke(() => this.recordBackendResultInTransaction(result)),
      recordOutputLifecycle: (input) => invoke(() => this.recordOutputLifecycleInTransaction(input)),
      reserveDelegation: (input) => invoke(() => {
        const result = this.reserveDelegationInTransaction(input);
        if (result.isOk()) state.reservedDelegationIds.add(result.value.id);
        return result;
      }),
      enqueueVoiceWork: (input) => invoke(() => {
        if (!state.reservedDelegationIds.has(input.delegationId)) {
          return err(new DbError(`Voice queue work was not paired with a reservation: ${input.delegationId}`));
        }
        if (state.enqueuedDelegationIds.has(input.delegationId)) {
          return err(new DbError(`Voice queue work was already enqueued: ${input.delegationId}`));
        }
        const result = this.enqueueVoiceWorkInTransaction(input);
        if (result.isOk()) state.enqueuedDelegationIds.add(input.delegationId);
        return result;
      }),
    };
  }

  runInTransaction<T>(operation: (transaction: VoiceStoreTransaction) => VoiceResult<T>): VoiceResult<T> {
    let outcome: VoiceResult<T> | undefined;
    const state: VoiceTransactionState = {
      active: true,
      reservedDelegationIds: new Set(),
      enqueuedDelegationIds: new Set(),
    };
    const transaction = this.createTransactionView(state);
    try {
      this.db.transaction(() => {
        const result = operation(transaction);
        outcome = result;
        if (result.isErr()) throw new TransactionRollback(result.error);
        const unpaired = [...state.reservedDelegationIds].find(
          (id) => !state.enqueuedDelegationIds.has(id),
        );
        if (unpaired !== undefined) {
          throw new TransactionRollback(
            new DbError(`Voice reservation was not paired with queue work: ${unpaired}`),
          );
        }
        return result.value;
      })();
      return outcome ?? err(new DbError('Voice transaction returned no result'));
    } catch (cause) {
      if (cause instanceof TransactionRollback) return err(cause.error);
      return err(new DbError(`Voice transaction failed: ${String(cause)}`, cause instanceof Error ? cause : undefined));
    } finally {
      state.active = false;
    }
  }

  admitDelegation(input: VoiceAdmissionRequest): VoiceResult<VoiceAdmissionReceipt> {
    return this.runInTransaction((tx) => {
      const reservation = tx.reserveDelegation(input);
      if (reservation.isErr()) return err(reservation.error);
      const queue = tx.enqueueVoiceWork(input.queue);
      if (queue.isErr()) return err(queue.error);
      return ok({
        delegationId: reservation.value.id,
        queueItemId: queue.value.queueItemId,
        contextVersion: reservation.value.contextVersion,
        contextDigest: reservation.value.contextDigest,
        policyGeneration: reservation.value.request.policy.generation,
        admittedAt: queue.value.admittedAt,
      });
    });
  }

  private reserveDelegationInTransaction(
    input: VoiceAdmissionRequest,
  ): VoiceResult<VoiceDelegationRecord> {
    const delegation = input.delegation;
    const validationError = this.validateAdmission(input);
    if (validationError) return err(validationError);

    const session = this.repository.findSessionById(delegation.sessionId);
    if (session.isErr()) return err(session.error);
    if (!session.value) return err(new DbError(`Voice session not found: ${delegation.sessionId}`));

    const row = this.delegationToRow(delegation);
    const existingId = this.repository.findDelegationById(delegation.id);
    if (existingId.isErr()) return err(existingId.error);
    if (existingId.value) {
      if (existingId.value.record_digest !== row.record_digest) {
        return err(conflict(`delegation id ${delegation.id} has different content`));
      }
      return this.delegationFromRow(existingId.value);
    }

    const existingProvider = this.repository.findDelegationByProviderId(
      delegation.sessionId,
      delegation.providerDelegationId,
    );
    if (existingProvider.isErr()) return err(existingProvider.error);
    if (existingProvider.value) {
      if (existingProvider.value.record_digest !== row.record_digest) {
        return err(
          conflict(`provider delegation id ${delegation.providerDelegationId} has different content`),
        );
      }
      return this.delegationFromRow(existingProvider.value);
    }

    const inserted = this.repository.insertDelegation(row);
    if (inserted.isErr()) return err(inserted.error);
    return this.delegationFromRow(inserted.value);
  }

  private validateAdmission(input: VoiceAdmissionRequest): DbError | undefined {
    const { delegation, queue } = input;
    const request = delegation.request;
    if (
      delegation.id !== request.delegationId ||
      delegation.sessionId !== request.sessionId ||
      delegation.providerDelegationId !== request.providerDelegationId ||
      delegation.contextVersion !== request.context.version ||
      delegation.contextDigest !== request.context.digest ||
      queue.delegationId !== delegation.id ||
      queue.threadId !== request.threadId ||
      stableJson(queue.request) !== stableJson(request)
    ) {
      return new DbError(
        'Voice admission must preserve the complete delegation request and context identity',
      );
    }
    if (queue.maxAttempts !== 1) {
      return new DbError('Voice queue work must use maxAttempts=1');
    }
    return undefined;
  }

  private validateQueueAdmission(
    input: VoiceAdmissionRequest['queue'],
    delegation: VoiceDelegationRow,
    persistedRequest: VoiceBackendRequest,
  ): DbError | undefined {
    if (
      input.delegationId !== delegation.id ||
      input.threadId !== persistedRequest.threadId ||
      input.request.sessionId !== delegation.session_id ||
      input.request.delegationId !== delegation.id ||
      input.request.providerDelegationId !== delegation.provider_delegation_id ||
      delegation.context_version !== persistedRequest.context.version ||
      delegation.context_digest !== persistedRequest.context.digest ||
      stableJson(input.request) !== stableJson(persistedRequest)
    ) {
      return new DbError(
        'Voice queue work must preserve the persisted delegation request and context identity',
      );
    }
    return undefined;
  }

  private enqueueVoiceWorkInTransaction(input: VoiceAdmissionRequest['queue']): VoiceResult<{
    queueItemId: string;
    delegationId: string;
    admittedAt: number;
  }> {
    const delegationResult = this.repository.findDelegationById(input.delegationId);
    if (delegationResult.isErr()) return err(delegationResult.error);
    if (!delegationResult.value) return err(new DbError(`Voice delegation not found: ${input.delegationId}`));
    const delegation = delegationResult.value;
    const persistedRecord = this.delegationFromRow(delegation);
    if (persistedRecord.isErr()) return err(persistedRecord.error);
    const queueValidationError = this.validateQueueAdmission(input, delegation, persistedRecord.value.request);
    if (queueValidationError) return err(queueValidationError);
    if (delegation.queue_item_id !== null && delegation.queue_item_id !== input.queueItemId) {
      return err(conflict(`delegation ${input.delegationId} is bound to another queue item`));
    }
    if (delegation.status !== 'admitted' && delegation.queue_item_id !== input.queueItemId) {
      return err(new DbError(`Voice delegation ${input.delegationId} has no matching queue binding`));
    }

    const payload = JSON.stringify({
      kind: 'voice_backend',
      delegationId: input.delegationId,
      sessionId: input.request.sessionId,
      request: input.request,
    });
    const existing = this.queueRepository.findById(input.queueItemId);
    if (existing.isErr()) return err(existing.error);
    let queueRow: QueueItemRow;
    if (existing.value) {
      if (
        existing.value.thread_id !== input.threadId ||
        existing.value.type !== 'collaboration' ||
        existing.value.max_attempts !== 1 ||
        stableJson(parseQueuePayload(existing.value.payload)) !== stableJson(parseQueuePayload(payload))
      ) {
        return err(conflict(`queue item ${input.queueItemId} has different content`));
      }
      queueRow = existing.value;
    } else {
      if (delegation.status !== 'admitted' || delegation.queue_item_id !== null) {
        return err(new DbError(`Voice delegation ${input.delegationId} has no retained queue binding`));
      }
      const inserted = this.queueRepository.enqueue({
        id: input.queueItemId,
        thread_id: input.threadId,
        message_id: null,
        type: 'collaboration',
        payload,
        max_attempts: 1,
      });
      if (inserted.isErr()) return err(inserted.error);
      queueRow = inserted.value;
    }

    if (delegation.status === 'admitted') {
      const next: VoiceDelegationRow = {
        ...delegation,
        revision: delegation.revision + 1,
        status: 'queued',
        queue_item_id: input.queueItemId,
        updated_at: queueRow.created_at,
      };
      const updated = this.repository.updateDelegation(next, delegation.revision);
      if (updated.isErr()) return err(updated.error);
      if (!updated.value) return err(new DbError(`Voice delegation queue admission lost: ${input.delegationId}`));
    }

    return ok({
      queueItemId: queueRow.id,
      delegationId: input.delegationId,
      admittedAt: queueRow.created_at,
    });
  }

  private markSuperseded(
    original: VoiceDelegationRow,
    supersededAt: number,
  ): VoiceResult<VoiceDelegationRecord> {
    const updated: VoiceDelegationRow = {
      ...original,
      revision: original.revision + 1,
      status: 'superseded',
      execution_status: 'skipped',
      updated_at: supersededAt,
      completed_at: supersededAt,
    };
    const saved = this.repository.updateDelegation(updated, original.revision);
    if (saved.isErr()) return err(saved.error);
    if (!saved.value) return err(new DbError(`Voice delegation supersede lost: ${original.id}`));
    if (original.queue_item_id) {
      const queueResult = this.skipQueueItem(original.queue_item_id, 'superseded', supersededAt);
      if (queueResult.isErr()) return err(queueResult.error);
    }
    return this.delegationFromRow(saved.value);
  }

  private claimQueueItem(id: string, claimedAt: number): VoiceResult<QueueItemRow | null> {
    try {
      const row = this.db
        .prepare(
          `UPDATE queue_items
              SET status = 'claimed', claimed_at = @claimed_at, updated_at = @claimed_at
            WHERE id = @id
              AND status IN ('pending', 'failed')
              AND (next_retry_at IS NULL OR next_retry_at <= @claimed_at)
            RETURNING *`,
        )
        .get({ id, claimed_at: claimedAt }) as QueueItemRow | undefined;
      return ok(row ?? null);
    } catch (cause) {
      return err(new DbError(`Failed to claim voice queue item: ${String(cause)}`, cause instanceof Error ? cause : undefined));
    }
  }

  private skipQueueItem(id: string, reason: string, at: number): VoiceResult<void> {
    try {
      this.db
        .prepare(
          `UPDATE queue_items
              SET status = 'completed', error = COALESCE(error, @error), updated_at = @updated_at
            WHERE id = @id AND status IN ('pending', 'failed')`,
        )
        .run({ id, error: `voice work skipped: ${reason}`, updated_at: at });
      return ok(undefined);
    } catch (cause) {
      return err(new DbError(`Failed to skip voice queue item: ${String(cause)}`, cause instanceof Error ? cause : undefined));
    }
  }

  private sessionToRow(session: VoiceSessionRecord): VoiceSessionRow {
    const identity = {
      id: session.id,
      owner: session.owner,
      personaId: session.personaId,
      threadId: session.threadId,
      transport: session.transport,
      providerSessionId: session.providerSessionId ?? null,
      deadlineAt: session.deadlineAt,
      policy: session.policy,
    };
    return {
      id: session.id,
      revision: session.revision,
      owner_id: session.owner.ownerId,
      login_revision: session.owner.loginRevision,
      persona_id: session.personaId,
      thread_id: session.threadId,
      transport: session.transport,
      status: session.status,
      provider_session_id: session.providerSessionId ?? null,
      created_at: session.createdAt,
      started_at: session.startedAt ?? null,
      deadline_at: session.deadlineAt,
      closing_at: session.closingAt ?? null,
      closed_at: session.closedAt ?? null,
      policy_json: JSON.stringify(session.policy),
      usage_json: JSON.stringify(session.usage),
      finalization_json: JSON.stringify(session.finalization),
      active_delegation_id: session.activeDelegationId ?? null,
      record_digest: digest(identity),
      updated_at: session.createdAt,
    };
  }

  private sessionFromRow(row: VoiceSessionRow): VoiceResult<VoiceSessionRecord> {
    try {
      return ok({
        id: row.id,
        revision: row.revision,
        owner: { ownerId: row.owner_id, loginRevision: row.login_revision },
        personaId: row.persona_id,
        threadId: row.thread_id,
        transport: row.transport,
        status: row.status,
        providerSessionId: optional(row.provider_session_id),
        createdAt: row.created_at,
        startedAt: row.started_at ?? undefined,
        deadlineAt: row.deadline_at,
        closingAt: row.closing_at ?? undefined,
        closedAt: row.closed_at ?? undefined,
        policy: JSON.parse(row.policy_json) as VoiceSessionRecord['policy'],
        usage: JSON.parse(row.usage_json) as VoiceSessionRecord['usage'],
        finalization: JSON.parse(row.finalization_json) as VoiceSessionRecord['finalization'],
        activeDelegationId: optional(row.active_delegation_id),
      });
    } catch (cause) {
      return err(new DbError(`Failed to decode voice session ${row.id}: ${String(cause)}`));
    }
  }

  private delegationToRow(delegation: VoiceDelegationRecord): VoiceDelegationRow {
    const lifecycle = delegation.output;
    const lifecycleColumns = lifecycleToColumns(lifecycle);
    const identity = {
      id: delegation.id,
      sessionId: delegation.sessionId,
      providerDelegationId: delegation.providerDelegationId,
      revision: delegation.revision,
      contextVersion: delegation.contextVersion,
      contextDigest: delegation.contextDigest,
      request: delegation.request,
      queueItemId: delegation.queueItemId ?? null,
      runId: delegation.runId ?? null,
      supersedesDelegationId: delegation.supersedesDelegationId ?? null,
    };
    return {
      id: delegation.id,
      session_id: delegation.sessionId,
      provider_delegation_id: delegation.providerDelegationId,
      revision: delegation.revision,
      context_version: delegation.contextVersion,
      context_digest: delegation.contextDigest,
      request_json: JSON.stringify(delegation.request),
      status: delegation.status,
      ...lifecycleColumns,
      queue_item_id: delegation.queueItemId ?? null,
      run_id: delegation.runId ?? null,
      supersedes_delegation_id: delegation.supersedesDelegationId ?? null,
      latest_output_id: null,
      error_code: null,
      created_at: delegation.createdAt,
      claimed_at: delegation.claimedAt ?? null,
      completed_at: delegation.completedAt ?? null,
      updated_at: delegation.createdAt,
      record_digest: digest(identity),
    };
  }

  private delegationFromRow(row: VoiceDelegationRow): VoiceResult<VoiceDelegationRecord> {
    try {
      return ok({
        id: row.id,
        sessionId: row.session_id,
        providerDelegationId: row.provider_delegation_id,
        revision: row.revision,
        contextVersion: row.context_version,
        contextDigest: row.context_digest,
        request: JSON.parse(row.request_json) as VoiceBackendRequest,
        status: row.status,
        execution: row.execution_status,
        output: lifecycleFromColumns(row),
        queueItemId: optional(row.queue_item_id),
        runId: optional(row.run_id),
        supersedesDelegationId: optional(row.supersedes_delegation_id),
        createdAt: row.created_at,
        claimedAt: row.claimed_at ?? undefined,
        completedAt: row.completed_at ?? undefined,
      });
    } catch (cause) {
      return err(new DbError(`Failed to decode voice delegation ${row.id}: ${String(cause)}`));
    }
  }

  private outputDtoFromRow(row: VoiceOutputRow): VoiceResult<VoiceOutputStatusDto> {
    return ok({
      delegationId: row.delegation_id,
      id: row.id,
      kind: row.kind,
      text: row.text ?? undefined,
      lifecycle: lifecycleFromColumns(row),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }

  private projectionFromRow(row: VoiceSessionRow): VoiceResult<VoiceSessionReadProjection> {
    const session = this.sessionFromRow(row);
    if (session.isErr()) return err(session.error);
    const delegationRows = this.repository.findDelegationsBySession(row.id);
    if (delegationRows.isErr()) return err(delegationRows.error);
    const outputRows = this.repository.findOutputsBySession(row.id);
    if (outputRows.isErr()) return err(outputRows.error);

    const allOutputs: VoiceOutputStatusDto[] = [];
    for (const outputRow of outputRows.value) {
      const output = this.outputDtoFromRow(outputRow);
      if (output.isErr()) return err(output.error);
      allOutputs.push(output.value);
    }

    const delegations: VoiceDelegationRecord[] = [];
    for (const delegationRow of delegationRows.value) {
      const delegation = this.delegationFromRow(delegationRow);
      if (delegation.isErr()) return err(delegation.error);
      delegations.push(delegation.value);
    }

    return ok({
      session: session.value,
      delegations,
      outputs: allOutputs,
    });
  }

  private statusForResult(
    current: VoiceDelegationRow['status'],
    result: VoiceBackendResult,
  ): VoiceDelegationRow['status'] {
    if (result.kind === 'unknown' || result.execution === 'unknown') return 'unknown';
    if (result.execution === 'succeeded') return 'completed';
    if (result.execution === 'failed') return 'failed';
    if (result.execution === 'skipped') return 'skipped';
    if (result.execution === 'running') return 'running';
    return current;
  }
}

/** Compatibility alias for callers that use the frozen interface name. */
export { DurableVoiceStore as VoiceStore };

function parseQueuePayload(payload: string): unknown {
  try {
    return JSON.parse(payload) as unknown;
  } catch {
    return payload;
  }
}
