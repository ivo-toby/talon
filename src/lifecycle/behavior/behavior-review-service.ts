import { createHash } from 'node:crypto';
import { err, ok, type Result } from 'neverthrow';

import { DbError, LifecycleError } from '../../core/errors/index.js';
import type {
  BehaviorCandidateRow,
  BehaviorCandidateReviewRow,
  BehaviorEvidenceRow,
  BehaviorPromotionRow,
} from '../../core/database/repositories/index.js';
import type { AuditLogger } from '../../core/logging/audit-logger.js';
import { BEHAVIOR_REVIEW_PROPOSAL_CONTRACT } from './review-contracts.js';
import { BehaviorTimestampSchema, isBehaviorPersona } from './types.js';

export const NATIVE_BEHAVIOR_REVIEW_SERVICE_REF = 'native-behavior-review-service';

export type BehaviorReviewCadence = 'daily' | 'weekly';
export type BehaviorReviewOutcome =
  | 'proposal_created'
  | 'nothing_to_review'
  | 'suppressed_duplicate'
  | 'suppressed_conflict'
  | 'suppressed_threshold'
  | 'expired_only';

export type BehaviorTraceEvidenceResult =
  | { readonly status: 'available'; readonly traceIds: readonly string[] }
  | { readonly status: 'unavailable'; readonly reason?: string };

export interface BehaviorReviewTrigger {
  readonly kind: 'schedule' | 'manual';
  readonly scheduleId?: string;
  readonly firedAt?: string;
}

export interface BehaviorReviewInput {
  readonly persona: string;
  readonly cadence: BehaviorReviewCadence;
  readonly now: string;
  readonly trigger: BehaviorReviewTrigger;
}

export interface BehaviorReviewResult {
  readonly outcome: BehaviorReviewOutcome;
  readonly cadence: BehaviorReviewCadence;
  readonly reviewedCandidateCount: number;
  readonly createdPromotionIds: readonly string[];
  readonly skippedCandidateIds: readonly string[];
  readonly expiredCandidateIds: readonly string[];
  readonly traceEvidenceStatus: BehaviorTraceEvidenceResult['status'];
  readonly signalCount: 0;
}

export interface BehaviorReviewServiceOptions {
  readonly maxCandidates?: number;
  readonly maxEvidencePerCandidate?: number;
  readonly traceEvidenceProvider?: (
    input: BehaviorReviewInput,
  ) => Promise<BehaviorTraceEvidenceResult>;
  readonly auditLogger?: Pick<AuditLogger, 'logLifecycleProjection'>;
}

type BehaviorReviewRepository = Pick<
  {
    findReviewCandidatesByPersona(
      persona: string,
      limit: number,
    ): Result<BehaviorCandidateReviewRow[], DbError>;
    findEvidenceByCandidate(
      persona: string,
      candidateId: string,
      limit?: number,
    ): Result<BehaviorEvidenceRow[], DbError>;
    findPromotionsByPersona(persona: string): Result<BehaviorPromotionRow[], DbError>;
    transitionCandidate(
      persona: string,
      candidateId: string,
      status: 'ready',
    ): Result<BehaviorCandidateRow, DbError>;
    createPromotion(input: {
      promotionId: string;
      persona: string;
      candidateId: string;
      policy?: Record<string, string | number | boolean | null>;
      evaluation?: Record<string, string | number | boolean | null>;
    }): Result<BehaviorPromotionRow, DbError>;
    expireCandidate(persona: string, candidateId: string): Result<BehaviorCandidateRow, DbError>;
  },
  | 'findReviewCandidatesByPersona'
  | 'findEvidenceByCandidate'
  | 'findPromotionsByPersona'
  | 'transitionCandidate'
  | 'createPromotion'
  | 'expireCandidate'
>;

interface CandidateReviewState {
  readonly candidate: BehaviorCandidateReviewRow;
  readonly evidence: readonly BehaviorEvidenceRow[];
  readonly evidenceCount: number;
  readonly distinctSourceCount: number;
  readonly latestSourceOccurredAt: string | null;
}

const DEFAULT_MAX_CANDIDATES = 16;
const DEFAULT_MAX_EVIDENCE_PER_CANDIDATE = 16;
const DAILY_WINDOW_MS = 24 * 60 * 60 * 1000;
const WEEKLY_WINDOW_MS = 7 * DAILY_WINDOW_MS;
const ACTIVE_PROMOTION_STATUSES = new Set([
  'proposed',
  'evaluating',
  'approved',
  'activating',
  'active',
  'reopened',
]);

export class BehaviorReviewService {
  private readonly maxCandidates: number;
  private readonly maxEvidencePerCandidate: number;

  constructor(
    private readonly repository: BehaviorReviewRepository,
    private readonly options: BehaviorReviewServiceOptions = {},
  ) {
    this.maxCandidates = boundedPositiveInteger(options.maxCandidates, DEFAULT_MAX_CANDIDATES);
    this.maxEvidencePerCandidate = boundedPositiveInteger(
      options.maxEvidencePerCandidate,
      DEFAULT_MAX_EVIDENCE_PER_CANDIDATE,
    );
  }

  async review(input: BehaviorReviewInput): Promise<Result<BehaviorReviewResult, LifecycleError>> {
    const parsedNow = BehaviorTimestampSchema.safeParse(input.now);
    if (!isBehaviorPersona(input.persona) || !parsedNow.success) {
      return err(new LifecycleError('invalid behavior review request'));
    }
    if (
      input.trigger.kind === 'schedule' &&
      (!input.trigger.scheduleId ||
        (input.trigger.firedAt !== undefined &&
          !BehaviorTimestampSchema.safeParse(input.trigger.firedAt).success))
    ) {
      return err(new LifecycleError('invalid behavior review schedule provenance'));
    }

    const trace = await this.resolveTraceEvidence(input);
    const loaded = this.loadCandidates(input.persona);
    if (loaded.isErr()) return err(loaded.error);

    const nowMs = Date.parse(input.now);
    const cutoffMs = nowMs - reviewWindowMs(input.cadence);
    const expiredCandidateIds: string[] = [];
    const skippedCandidateIds: string[] = [];
    const reviewable: CandidateReviewState[] = [];

    for (const state of loaded.value) {
      if (isExpired(state, cutoffMs)) {
        const expired = this.repository.expireCandidate(
          input.persona,
          state.candidate.candidate_id,
        );
        if (expired.isErr()) {
          return err(toLifecycleError('failed to expire behavior review candidate', expired.error));
        }
        expiredCandidateIds.push(state.candidate.candidate_id);
        continue;
      }
      reviewable.push(state);
    }

    const promotions = this.repository.findPromotionsByPersona(input.persona);
    if (promotions.isErr()) {
      return err(toLifecycleError('failed to find behavior review promotions', promotions.error));
    }
    const promotedCandidateIds = new Set(
      promotions.value
        .filter((promotion) => ACTIVE_PROMOTION_STATUSES.has(promotion.status))
        .map((promotion) => promotion.candidate_id),
    );

    const createdPromotionIds: string[] = [];
    const acceptedKinds = new Map<string, string>();
    for (const state of reviewable) {
      if (promotedCandidateIds.has(state.candidate.candidate_id)) {
        acceptedKinds.set(state.candidate.kind, normalizeText(state.candidate.proposed_behavior));
      }
    }
    let duplicateSuppressed = false;
    let conflictSuppressed = false;
    let thresholdSuppressed = false;

    for (const state of reviewable) {
      const candidateId = state.candidate.candidate_id;
      if (promotedCandidateIds.has(candidateId)) {
        skippedCandidateIds.push(candidateId);
        duplicateSuppressed = true;
        continue;
      }

      const threshold = sourceThreshold(input.cadence);
      if (state.distinctSourceCount < threshold) {
        skippedCandidateIds.push(candidateId);
        thresholdSuppressed = true;
        continue;
      }

      const normalizedProposal = normalizeText(state.candidate.proposed_behavior);
      const accepted = acceptedKinds.get(state.candidate.kind);
      if (accepted !== undefined && accepted !== normalizedProposal) {
        skippedCandidateIds.push(candidateId);
        conflictSuppressed = true;
        continue;
      }

      const promotionId = behaviorReviewPromotionId(input.persona, input.cadence, candidateId);
      if (state.candidate.status === 'collecting') {
        const ready = this.repository.transitionCandidate(input.persona, candidateId, 'ready');
        if (ready.isErr()) {
          return err(toLifecycleError('failed to ready behavior review candidate', ready.error));
        }
      }
      const created = this.repository.createPromotion({
        promotionId,
        persona: input.persona,
        candidateId,
        policy: {
          contract: BEHAVIOR_REVIEW_PROPOSAL_CONTRACT,
          reviewer: NATIVE_BEHAVIOR_REVIEW_SERVICE_REF,
          cadence: input.cadence,
          notesOnly: true,
          scheduleId: input.trigger.scheduleId ?? null,
          firedAt: input.trigger.firedAt ?? input.now,
          evidenceCount: Math.min(state.evidenceCount, this.maxEvidencePerCandidate),
          distinctSourceCount: state.distinctSourceCount,
        },
        evaluation: {
          reviewer: NATIVE_BEHAVIOR_REVIEW_SERVICE_REF,
          sourceThreshold: threshold,
          traceEvidenceStatus: trace.status,
          traceEvidenceCount: trace.status === 'available' ? trace.traceIds.length : 0,
          conflictPolicy: 'same-kind-one-proposal-per-review',
          signalCount: 0,
        },
      });
      if (created.isErr()) {
        return err(toLifecycleError('failed to create behavior review promotion', created.error));
      }
      createdPromotionIds.push(created.value.promotion_id);
      acceptedKinds.set(state.candidate.kind, normalizedProposal);
      promotedCandidateIds.add(candidateId);
    }

    const result: BehaviorReviewResult = {
      outcome: reviewOutcome({
        createdPromotionIds,
        skippedCandidateIds,
        expiredCandidateIds,
        duplicateSuppressed,
        conflictSuppressed,
        thresholdSuppressed,
      }),
      cadence: input.cadence,
      reviewedCandidateCount: reviewable.length,
      createdPromotionIds,
      skippedCandidateIds,
      expiredCandidateIds,
      traceEvidenceStatus: trace.status,
      signalCount: 0,
    };
    this.audit(input, result);
    return ok(result);
  }

  private loadCandidates(persona: string): Result<CandidateReviewState[], LifecycleError> {
    const candidates = this.repository.findReviewCandidatesByPersona(persona, this.maxCandidates);
    if (candidates.isErr()) {
      return err(toLifecycleError('failed to find behavior review candidates', candidates.error));
    }

    const states: CandidateReviewState[] = [];
    for (const candidate of candidates.value) {
      const evidence = this.repository.findEvidenceByCandidate(
        persona,
        candidate.candidate_id,
        this.maxEvidencePerCandidate,
      );
      if (evidence.isErr()) {
        return err(toLifecycleError('failed to find behavior review evidence', evidence.error));
      }
      states.push({
        candidate,
        evidence: evidence.value,
        evidenceCount: candidate.evidence_count,
        distinctSourceCount: candidate.distinct_source_count,
        latestSourceOccurredAt: candidate.latest_source_occurred_at,
      });
    }

    return ok(states);
  }

  private async resolveTraceEvidence(
    input: BehaviorReviewInput,
  ): Promise<BehaviorTraceEvidenceResult> {
    try {
      return (
        (await this.options.traceEvidenceProvider?.(input)) ?? {
          status: 'unavailable',
          reason: 'trace-provider-unconfigured',
        }
      );
    } catch {
      return { status: 'unavailable', reason: 'trace-provider-failed' };
    }
  }

  private audit(input: BehaviorReviewInput, result: BehaviorReviewResult): void {
    try {
      this.options.auditLogger?.logLifecycleProjection({
        action: 'lifecycle.behavior_review',
        personaId: input.persona,
        details: {
          outcome: result.outcome,
          cadence: result.cadence,
          scheduleId: input.trigger.scheduleId ?? null,
          reviewedCandidateCount: result.reviewedCandidateCount,
          createdPromotionCount: result.createdPromotionIds.length,
          skippedCandidateCount: result.skippedCandidateIds.length,
          expiredCandidateCount: result.expiredCandidateIds.length,
          traceEvidenceStatus: result.traceEvidenceStatus,
          signalCount: result.signalCount,
        },
      });
    } catch {
      // Audit is advisory; review writes remain repository-owned.
    }
  }
}

export function behaviorReviewPromotionId(
  persona: string,
  cadence: BehaviorReviewCadence,
  candidateId: string,
): string {
  return `behavior-review-${createHash('sha256')
    .update('talon.behavior.review.v1\0', 'utf8')
    .update(JSON.stringify({ persona, cadence, candidateId }), 'utf8')
    .digest('base64url')
    .slice(0, 32)}`;
}

function sourceThreshold(cadence: BehaviorReviewCadence): number {
  return cadence === 'weekly' ? 3 : 2;
}

function reviewWindowMs(cadence: BehaviorReviewCadence): number {
  return cadence === 'weekly' ? WEEKLY_WINDOW_MS : DAILY_WINDOW_MS;
}

function isExpired(state: CandidateReviewState, cutoffMs: number): boolean {
  if (state.candidate.status === 'ready') return false;
  if (state.latestSourceOccurredAt === null) return state.candidate.updated_at < cutoffMs;
  return Date.parse(state.latestSourceOccurredAt) < cutoffMs;
}

function normalizeText(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
}

function reviewOutcome(input: {
  readonly createdPromotionIds: readonly string[];
  readonly skippedCandidateIds: readonly string[];
  readonly expiredCandidateIds: readonly string[];
  readonly duplicateSuppressed: boolean;
  readonly conflictSuppressed: boolean;
  readonly thresholdSuppressed: boolean;
}): BehaviorReviewOutcome {
  if (input.createdPromotionIds.length > 0 && input.conflictSuppressed) {
    return 'suppressed_conflict';
  }
  if (input.createdPromotionIds.length > 0) return 'proposal_created';
  if (input.duplicateSuppressed) return 'suppressed_duplicate';
  if (input.conflictSuppressed) return 'suppressed_conflict';
  if (input.thresholdSuppressed) return 'suppressed_threshold';
  if (input.expiredCandidateIds.length > 0) return 'expired_only';
  return 'nothing_to_review';
}

function boundedPositiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && value !== undefined && value > 0 && value <= 64
    ? value
    : fallback;
}

function toLifecycleError(message: string, error: DbError): LifecycleError {
  return new LifecycleError(`${message}: ${error.message}`);
}
