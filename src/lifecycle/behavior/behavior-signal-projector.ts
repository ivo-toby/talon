import { err, ok, type Result } from 'neverthrow';

import { DbError, LifecycleError } from '../../core/errors/index.js';
import type {
  BehaviorCandidateRow,
  BehaviorEvidenceRow,
  BehaviorSignalRepository,
  LifecycleSignalRepository,
} from '../../core/database/repositories/index.js';
import type { AuditLogger } from '../../core/logging/audit-logger.js';
import {
  BehaviorEvidenceSourceKindSchema,
  isBehaviorPersona,
  type BehaviorEvidenceSourceKind,
} from './types.js';
import {
  BEHAVIOR_FEEDBACK_DETECTED_SIGNAL_TYPE,
  BehaviorFeedbackDetectedSignalEnvelopeSchema,
  type BehaviorFeedbackKind,
  type BehaviorSignalMetadata,
} from './contracts.js';
import {
  behaviorCandidateId,
  behaviorEvidenceFingerprint,
  behaviorEvidenceId,
} from './evidence-fingerprint.js';
import {
  LifecycleEventTypeSchema,
  type LifecycleReference,
  type LifecycleSignalEnvelope,
} from '../contracts/index.js';
import type { LifecycleSignalHandoff, LifecycleSignalRouter } from '../lifecycle-dispatcher.js';
import type { LifecycleHandlerRegistry, ResolvedLifecycleHandler } from '../handler-registry.js';

export const NATIVE_BEHAVIOR_SIGNAL_PROJECTOR_REF = 'native-behavior-signal-projector';
export const NATIVE_BEHAVIOR_SIGNAL_PROJECTOR_VERSION = '1.0.0';
const BEHAVIOR_FEEDBACK_DETECTOR_REF = 'behavior-feedback-detector';

const INFERRED_PATTERN_MIN_DISTINCT_SOURCES = 3;

export type BehaviorSignalProjectionOutcome =
  | 'candidate_created'
  | 'candidate_exists'
  | 'evidence_recorded'
  | 'suppressed_candidate_threshold'
  | 'suppressed_duplicate_evidence'
  | 'suppressed_invalid_signal'
  | 'suppressed_unsubscribed';

export interface BehaviorSignalProjectionResult {
  readonly outcome: BehaviorSignalProjectionOutcome;
  readonly signalId?: string;
  readonly candidateId?: string;
  readonly category?: BehaviorFeedbackKind;
  readonly evidenceIds: readonly string[];
  readonly distinctSourceCount: number;
  readonly signalCount: 0;
}

export interface BehaviorSignalProjectInput {
  readonly persona: string;
  readonly handlerId: string;
  readonly signal: unknown;
}

export interface BehaviorSignalProjectorOptions {
  readonly auditLogger?: Pick<AuditLogger, 'logLifecycleProjection'>;
}

type BehaviorRepository = Pick<
  BehaviorSignalRepository,
  | 'recordEvidence'
  | 'createCandidate'
  | 'findCandidatesByPersona'
  | 'linkCandidateEvidence'
  | 'transitionCandidate'
>;

export class BehaviorSignalProjector {
  constructor(
    private readonly repository: BehaviorRepository,
    private readonly options: BehaviorSignalProjectorOptions = {},
  ) {}

  project(
    input: BehaviorSignalProjectInput,
  ): Result<BehaviorSignalProjectionResult, LifecycleError> {
    if (!isBehaviorPersona(input.persona)) {
      return err(new LifecycleError('invalid behavior projection persona scope'));
    }

    const parsed = BehaviorFeedbackDetectedSignalEnvelopeSchema.safeParse(input.signal);
    if (!parsed.success) {
      return ok(
        this.audit(input.persona, input.handlerId, {
          outcome: 'suppressed_invalid_signal',
          evidenceIds: [],
          distinctSourceCount: 0,
          signalCount: 0,
        }),
      );
    }

    const signal = parsed.data;
    const meta = signal.payload.metadata as BehaviorSignalMetadata;
    const sources = behaviorSources(signal);
    if (!hasPrimarySource(sources, meta)) {
      return ok(
        this.audit(input.persona, input.handlerId, {
          outcome: 'suppressed_invalid_signal',
          signalId: signal.signalId,
          category: meta.category,
          evidenceIds: [],
          distinctSourceCount: 0,
          signalCount: 0,
        }),
      );
    }

    const evidenceRows = this.recordEvidence(input.persona, signal, meta, sources);
    if (evidenceRows.isErr()) return err(evidenceRows.error);

    const uniqueRows = uniqueEvidenceRows(evidenceRows.value);
    const evidenceIds = uniqueRows.map((row) => row.evidence_id);
    const currentDistinctSourceCount = distinctSources(uniqueRows);
    const candidateId = behaviorCandidateId(input.persona, signal);
    const existing = this.findCandidate(input.persona, candidateId);
    if (existing.isErr()) return err(existing.error);

    if (existing.value) {
      const linked = this.repository.linkCandidateEvidence({
        persona: input.persona,
        candidateId,
        evidenceIds,
      });
      if (linked.isErr()) {
        return err(toLifecycleError('failed to link behavior candidate evidence', linked.error));
      }
      const distinctSourceCount = linked.value.distinctSourceCount;
      if (
        meta.category === 'inferred_pattern' &&
        distinctSourceCount < INFERRED_PATTERN_MIN_DISTINCT_SOURCES
      ) {
        return ok(
          this.audit(input.persona, input.handlerId, {
            outcome: 'suppressed_candidate_threshold',
            signalId: signal.signalId,
            candidateId,
            category: meta.category,
            evidenceIds,
            distinctSourceCount,
            signalCount: 0,
          }),
        );
      }
      if (
        meta.category === 'inferred_pattern' &&
        existing.value.status === 'collecting' &&
        distinctSourceCount >= INFERRED_PATTERN_MIN_DISTINCT_SOURCES
      ) {
        const transitioned = this.repository.transitionCandidate(
          input.persona,
          candidateId,
          'ready',
        );
        if (transitioned.isErr()) {
          return err(toLifecycleError('failed to ready behavior candidate', transitioned.error));
        }
      }
      return ok(
        this.audit(input.persona, input.handlerId, {
          outcome:
            linked.value.linkedEvidenceCount > 0
              ? 'evidence_recorded'
              : 'suppressed_duplicate_evidence',
          signalId: signal.signalId,
          candidateId,
          category: meta.category,
          evidenceIds,
          distinctSourceCount,
          signalCount: 0,
        }),
      );
    }

    if (
      meta.category === 'inferred_pattern' &&
      currentDistinctSourceCount < INFERRED_PATTERN_MIN_DISTINCT_SOURCES
    ) {
      const collectingCandidate = this.repository.createCandidate({
        candidateId,
        persona: input.persona,
        kind: meta.candidateKind,
        status: 'collecting',
        summary: meta.summary,
        proposedBehavior: meta.proposedBehavior,
        confidence: meta.confidence,
        createdFromEvidenceIds: evidenceIds,
      });
      if (collectingCandidate.isErr()) {
        return err(
          toLifecycleError(
            'failed to create collecting behavior candidate',
            collectingCandidate.error,
          ),
        );
      }
      return ok(
        this.audit(input.persona, input.handlerId, {
          outcome: 'suppressed_candidate_threshold',
          signalId: signal.signalId,
          candidateId,
          category: meta.category,
          evidenceIds,
          distinctSourceCount: currentDistinctSourceCount,
          signalCount: 0,
        }),
      );
    }

    const candidate = this.repository.createCandidate({
      candidateId,
      persona: input.persona,
      kind: meta.candidateKind,
      status: meta.category === 'inferred_pattern' ? 'ready' : 'collecting',
      summary: meta.summary,
      proposedBehavior: meta.proposedBehavior,
      confidence: meta.confidence,
      createdFromEvidenceIds: evidenceIds,
    });
    if (candidate.isErr()) {
      return err(toLifecycleError('failed to create behavior candidate', candidate.error));
    }

    return ok(
      this.audit(input.persona, input.handlerId, {
        outcome: 'candidate_created',
        signalId: signal.signalId,
        candidateId: candidate.value.candidate_id,
        category: meta.category,
        evidenceIds,
        distinctSourceCount: currentDistinctSourceCount,
        signalCount: 0,
      }),
    );
  }

  suppressUnsubscribed(
    persona: string,
    handlerId: string,
    signal: LifecycleSignalEnvelope,
  ): BehaviorSignalProjectionResult {
    return this.audit(persona, handlerId, {
      outcome: 'suppressed_unsubscribed',
      signalId: signal.signalId,
      evidenceIds: [],
      distinctSourceCount: 0,
      signalCount: 0,
    });
  }

  suppressInvalidSignal(
    persona: string,
    handlerId: string,
    signal: LifecycleSignalEnvelope,
  ): BehaviorSignalProjectionResult {
    const parsed = BehaviorFeedbackDetectedSignalEnvelopeSchema.safeParse(signal);
    const meta = parsed.success ? (parsed.data.payload.metadata as BehaviorSignalMetadata) : null;
    return this.audit(persona, handlerId, {
      outcome: 'suppressed_invalid_signal',
      signalId: parsed.success ? parsed.data.signalId : undefined,
      category: meta?.category,
      evidenceIds: [],
      distinctSourceCount: 0,
      signalCount: 0,
    });
  }

  private recordEvidence(
    persona: string,
    signal: LifecycleSignalEnvelope,
    meta: BehaviorSignalMetadata,
    sources: readonly LifecycleReference[],
  ): Result<BehaviorEvidenceRow[], LifecycleError> {
    const rows: BehaviorEvidenceRow[] = [];
    for (const source of sources) {
      const recorded = this.repository.recordEvidence({
        evidenceId: behaviorEvidenceId(signal, source),
        persona,
        sourceKind: source.type as BehaviorEvidenceSourceKind,
        sourceId: source.id,
        sourceOccurredAt: meta.sourceOccurredAt,
        fingerprint: behaviorEvidenceFingerprint(signal, source),
        sentiment: meta.sentiment,
        confidence: meta.confidence,
        summary: meta.summary,
        metadata: {
          category: meta.category,
          candidateKind: meta.candidateKind,
          provenanceDetector: meta.provenanceDetector,
          provenanceInputEventId: meta.provenanceInputEventId,
          provenanceInputEventType: meta.provenanceInputEventType,
          ...(meta.provenanceHandlerId ? { provenanceHandlerId: meta.provenanceHandlerId } : {}),
        },
      });
      if (recorded.isErr()) {
        return err(toLifecycleError('failed to record behavior evidence', recorded.error));
      }
      rows.push(recorded.value);
    }
    return ok(rows);
  }

  private findCandidate(
    persona: string,
    candidateId: string,
  ): Result<BehaviorCandidateRow | undefined, LifecycleError> {
    const candidates = this.repository.findCandidatesByPersona(persona);
    if (candidates.isErr()) {
      return err(toLifecycleError('failed to find behavior candidates', candidates.error));
    }
    return ok(candidates.value.find((candidate) => candidate.candidate_id === candidateId));
  }

  private audit(
    persona: string,
    handlerId: string,
    result: BehaviorSignalProjectionResult,
  ): BehaviorSignalProjectionResult {
    try {
      this.options.auditLogger?.logLifecycleProjection({
        action: 'lifecycle.behavior_projection',
        personaId: persona,
        details: {
          handlerId,
          outcome: result.outcome,
          signalId: result.signalId ?? null,
          candidateId: result.candidateId ?? null,
          category: result.category ?? null,
          evidenceCount: result.evidenceIds.length,
          distinctSourceCount: result.distinctSourceCount,
          signalCount: result.signalCount,
        },
      });
    } catch {
      // Audit is advisory at the projection boundary; repository writes remain authoritative.
    }
    return result;
  }
}

export interface BehaviorSignalRouterOptions {
  readonly signalRepository: Pick<LifecycleSignalRepository, 'handoff'>;
  readonly projector: BehaviorSignalProjector;
  readonly registry: Pick<
    LifecycleHandlerRegistry,
    'resolveEventHandlers' | 'resolveSignalHandlers'
  >;
}

export function createBehaviorSignalRouter(
  options: BehaviorSignalRouterOptions,
): LifecycleSignalRouter {
  return {
    handoff(handoff: LifecycleSignalHandoff): Promise<Result<void, LifecycleError>> {
      const persisted = options.signalRepository.handoff(handoff);
      if (persisted.isErr()) {
        return Promise.resolve(
          err(
            new LifecycleError(`Failed to persist lifecycle signals: ${persisted.error.message}`),
          ),
        );
      }

      for (const rawSignal of handoff.signals) {
        const parsed = BehaviorFeedbackDetectedSignalEnvelopeSchema.safeParse(rawSignal);
        if (!parsed.success) continue;
        if (!isTrustedBehaviorDetectorHandoff(handoff, parsed.data, options.registry)) {
          options.projector.suppressInvalidSignal(
            handoff.persona,
            NATIVE_BEHAVIOR_SIGNAL_PROJECTOR_REF,
            parsed.data,
          );
          continue;
        }

        const projectorHandler = behaviorProjectorHandler(
          options.registry.resolveSignalHandlers({
            persona: handoff.persona,
            signalType: BEHAVIOR_FEEDBACK_DETECTED_SIGNAL_TYPE,
          }),
        );
        if (!projectorHandler) {
          options.projector.suppressUnsubscribed(
            handoff.persona,
            NATIVE_BEHAVIOR_SIGNAL_PROJECTOR_REF,
            parsed.data,
          );
          continue;
        }

        const projected = options.projector.project({
          persona: handoff.persona,
          handlerId: projectorHandler.identity.handlerId,
          signal: parsed.data,
        });
        if (projected.isErr()) return Promise.resolve(err(projected.error));
      }

      return Promise.resolve(ok(undefined));
    },
  };
}

function isTrustedBehaviorDetectorHandoff(
  handoff: LifecycleSignalHandoff,
  signal: LifecycleSignalEnvelope,
  registry: Pick<LifecycleHandlerRegistry, 'resolveSignalHandlers' | 'resolveEventHandlers'>,
): boolean {
  const meta = signal.payload.metadata as BehaviorSignalMetadata;
  if (meta.provenanceInputEventId !== handoff.eventId) return false;
  if (meta.provenanceHandlerId !== handoff.handlerId) return false;
  const eventType = LifecycleEventTypeSchema.safeParse(meta.provenanceInputEventType);
  if (!eventType.success) return false;
  return registry
    .resolveEventHandlers({
      persona: handoff.persona,
      eventType: eventType.data,
    })
    .some(
      (handler) =>
        handler.identity.handlerId === handoff.handlerId &&
        handler.identity.runtimeKind === 'subagent' &&
        handler.identity.implementationRef === BEHAVIOR_FEEDBACK_DETECTOR_REF &&
        handler.identity.outputContract === 'talon.lifecycle.signal.envelopes.v1',
    );
}

function behaviorProjectorHandler(
  handlers: readonly ResolvedLifecycleHandler[],
): ResolvedLifecycleHandler | undefined {
  return handlers.find(
    (handler) =>
      handler.identity.runtimeKind === 'native' &&
      handler.identity.implementationRef === NATIVE_BEHAVIOR_SIGNAL_PROJECTOR_REF,
  );
}

function behaviorSources(signal: LifecycleSignalEnvelope): LifecycleReference[] {
  const seen = new Set<string>();
  const sources: LifecycleReference[] = [];
  for (const reference of signal.payload.references) {
    if (!BehaviorEvidenceSourceKindSchema.safeParse(reference.type).success) continue;
    const key = `${reference.type}:${reference.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sources.push(reference);
  }
  return sources;
}

function hasPrimarySource(
  sources: readonly LifecycleReference[],
  meta: BehaviorSignalMetadata,
): boolean {
  return sources.some((source) => source.type === meta.sourceKind && source.id === meta.sourceId);
}

function uniqueEvidenceRows(rows: readonly BehaviorEvidenceRow[]): BehaviorEvidenceRow[] {
  const seen = new Set<string>();
  const unique: BehaviorEvidenceRow[] = [];
  for (const row of rows) {
    if (seen.has(row.evidence_id)) continue;
    seen.add(row.evidence_id);
    unique.push(row);
  }
  return unique;
}

function distinctSources(rows: readonly BehaviorEvidenceRow[]): number {
  return new Set(rows.map((row) => `${row.source_kind}:${row.source_id}`)).size;
}

function toLifecycleError(message: string, error: DbError): LifecycleError {
  return new LifecycleError(`${message}: ${error.message}`);
}
