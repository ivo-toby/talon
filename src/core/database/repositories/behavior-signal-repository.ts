/** Persona-scoped behavior evidence, candidate, promotion, activation, and rollback ledger. */

import { types } from 'node:util';
import type Database from 'better-sqlite3';
import { err, ok, type Result } from 'neverthrow';

import { DbError } from '../../errors/index.js';
import type { AuditLogger } from '../../logging/audit-logger.js';
import {
  BehaviorCandidateKindSchema,
  BehaviorCandidateStatusSchema,
  BehaviorConfidenceSchema,
  BehaviorEvidenceSentimentSchema,
  BehaviorEvidenceSourceKindSchema,
  BehaviorLineageReasonSchema,
  BehaviorPromotionStatusSchema,
  BehaviorSummarySchema,
  BehaviorTimestampSchema,
  isBehaviorIdentifier,
  isBehaviorPersona,
  isBehaviorRuntimeId,
  type BehaviorCandidateKind,
  type BehaviorCandidateStatus,
  type BehaviorEvidenceSentiment,
  type BehaviorEvidenceSourceKind,
  type BehaviorPromotionStatus,
} from '../../../lifecycle/behavior/types.js';
import {
  isBoundedWellFormedUtf8,
  snapshotBoundedPlainDataRecord,
} from './lifecycle-persistence-validation.js';
import { BaseRepository } from './base-repository.js';

type JsonScalar = string | number | boolean | null;
export type BehaviorMetadata = Record<string, JsonScalar>;

export interface BehaviorEvidenceInput {
  readonly evidenceId: string;
  readonly persona: string;
  readonly sourceKind: BehaviorEvidenceSourceKind;
  readonly sourceId: string;
  readonly sourceOccurredAt: string;
  readonly fingerprint: string;
  readonly sentiment: BehaviorEvidenceSentiment;
  readonly confidence: number;
  readonly summary: string;
  readonly metadata?: BehaviorMetadata;
}

export interface BehaviorEvidenceRow {
  evidence_id: string;
  persona: string;
  source_kind: BehaviorEvidenceSourceKind;
  source_id: string;
  source_occurred_at: string;
  fingerprint: string;
  sentiment: BehaviorEvidenceSentiment;
  confidence: number;
  summary: string;
  metadata: string;
  created_at: number;
}

export interface BehaviorCandidateInput {
  readonly candidateId: string;
  readonly persona: string;
  readonly kind: BehaviorCandidateKind;
  readonly status?: Extract<BehaviorCandidateStatus, 'collecting' | 'ready'>;
  readonly summary: string;
  readonly proposedBehavior: string;
  readonly confidence: number;
  readonly createdFromEvidenceIds?: readonly string[];
}

export interface BehaviorCandidateEvidenceInput {
  readonly candidateId: string;
  readonly persona: string;
  readonly evidenceIds: readonly string[];
}

export interface BehaviorCandidateEvidenceLinkResult {
  readonly linkedEvidenceCount: number;
  readonly distinctSourceCount: number;
}

export interface BehaviorCandidateRow {
  candidate_id: string;
  persona: string;
  kind: BehaviorCandidateKind;
  status: BehaviorCandidateStatus;
  summary: string;
  proposed_behavior: string;
  confidence: number;
  created_at: number;
  updated_at: number;
  expired_at: number | null;
}

export interface BehaviorCandidateSummaryRow extends BehaviorCandidateRow {
  evidence_sources: number;
}

export interface BehaviorPromotionInput {
  readonly promotionId: string;
  readonly persona: string;
  readonly candidateId: string;
  readonly status?: Extract<BehaviorPromotionStatus, 'proposed'>;
  readonly policy?: BehaviorMetadata;
  readonly evaluation?: BehaviorMetadata;
}

export interface BehaviorPromotionRow {
  promotion_id: string;
  persona: string;
  candidate_id: string;
  status: BehaviorPromotionStatus;
  policy: string;
  evaluation: string;
  created_at: number;
  updated_at: number;
}

export interface BehaviorPromotionActivationInput {
  readonly persona: string;
  readonly promotionId: string;
  readonly activationId: string;
  readonly promptArtifactId: string;
  readonly reloadId: string;
}

export interface BehaviorPromotionRollbackInput {
  readonly persona: string;
  readonly activationId: string;
  readonly rollbackId: string;
  readonly reason: string;
}

export interface BehaviorSignalMetricsRecorder {
  increment(name: string, labels?: Record<string, string | number | boolean>, value?: number): void;
}

export interface BehaviorSignalRepositoryOptions {
  readonly auditLogger?: Pick<AuditLogger, 'logLifecyclePromotion'>;
  readonly metrics?: BehaviorSignalMetricsRecorder;
}

function toDbError(operation: string, cause: unknown): DbError {
  void cause;
  return new DbError(`Failed to ${operation}`);
}

function readRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> | null {
  const allowed = new Set([...required, ...optional]);
  const record = snapshotBoundedPlainDataRecord(value, allowed.size);
  if (!record) return null;
  const keys = Object.keys(record);
  if (keys.some((key) => !allowed.has(key))) return null;
  for (const key of required) {
    if (!Object.hasOwn(record, key)) return null;
  }
  return record;
}

function readStringArray(value: unknown, maxLength: number): string[] | null {
  if (!Array.isArray(value) || types.isProxy(value)) return null;
  try {
    if (Reflect.getPrototypeOf(value) !== Array.prototype) return null;
    const length = Object.getOwnPropertyDescriptor(value, 'length');
    if (!length || !('value' in length) || !Number.isSafeInteger(length.value)) return null;
    if (length.value > maxLength) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== length.value + 1 || keys.some((key) => typeof key !== 'string')) {
      return null;
    }
    const result: string[] = [];
    for (let index = 0; index < length.value; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor?.enumerable || !('value' in descriptor)) return null;
      if (!isBehaviorRuntimeId(descriptor.value)) return null;
      result.push(descriptor.value);
    }
    return result;
  } catch {
    return null;
  }
}

function boundedSummary(value: unknown): value is string {
  return typeof value === 'string' && BehaviorSummarySchema.safeParse(value).success;
}

function boundedMetadata(value: unknown): BehaviorMetadata | null {
  if (value === undefined) return {};
  const record = snapshotBoundedPlainDataRecord(value, 32);
  if (!record) return null;
  const normalized = new Set<string>();
  const result: Record<string, JsonScalar> = {};
  for (const [key, item] of Object.entries(record)) {
    if (
      key.length === 0 ||
      key.trim() !== key ||
      !isBoundedWellFormedUtf8(key, 128, 512) ||
      key.indexOf('\0') !== -1
    ) {
      return null;
    }
    const normalizedKey = key.normalize('NFKC');
    if (normalized.has(normalizedKey)) return null;
    normalized.add(normalizedKey);
    if (typeof item === 'string') {
      if (!isBoundedWellFormedUtf8(item, 1024, 4096) || item.indexOf('\0') !== -1) return null;
      result[key] = item;
    } else if (typeof item === 'number') {
      if (!Number.isFinite(item)) return null;
      result[key] = item;
    } else if (typeof item === 'boolean' || item === null) {
      result[key] = item;
    } else {
      return null;
    }
  }
  return result;
}

interface NormalizedEvidence {
  evidenceId: string;
  persona: string;
  sourceKind: BehaviorEvidenceSourceKind;
  sourceId: string;
  sourceOccurredAt: string;
  fingerprint: string;
  sentiment: BehaviorEvidenceSentiment;
  confidence: number;
  summary: string;
  metadata: BehaviorMetadata;
}

interface NormalizedCandidate {
  candidateId: string;
  persona: string;
  kind: BehaviorCandidateKind;
  status: Extract<BehaviorCandidateStatus, 'collecting' | 'ready'>;
  summary: string;
  proposedBehavior: string;
  confidence: number;
  evidenceIds: string[];
}

interface NormalizedCandidateEvidence {
  candidateId: string;
  persona: string;
  evidenceIds: string[];
}

interface NormalizedPromotion {
  promotionId: string;
  persona: string;
  candidateId: string;
  policy: BehaviorMetadata;
  evaluation: BehaviorMetadata;
}

/** Repository for the native behavior-learning ledger. */
export class BehaviorSignalRepository extends BaseRepository {
  private readonly findEvidenceByIdStmt: Database.Statement;
  private readonly findEvidenceByFingerprintStmt: Database.Statement;
  private readonly insertEvidenceStmt: Database.Statement;
  private readonly findEvidenceByPersonaStmt: Database.Statement;
  private readonly insertCandidateStmt: Database.Statement;
  private readonly insertCandidateEvidenceStmt: Database.Statement;
  private readonly findCandidateStmt: Database.Statement;
  private readonly findCandidatesByPersonaStmt: Database.Statement;
  private readonly findCandidateSummariesByPersonaStmt: Database.Statement;
  private readonly transitionCandidateStmt: Database.Statement;
  private readonly expireCandidateStmt: Database.Statement;
  private readonly countDistinctSourcesStmt: Database.Statement;
  private readonly candidateEvidenceSourcesStmt: Database.Statement;
  private readonly insertPromotionStmt: Database.Statement;
  private readonly findPromotionStmt: Database.Statement;
  private readonly findPromotionsByPersonaStmt: Database.Statement;
  private readonly transitionPromotionStmt: Database.Statement;
  private readonly insertActivationStmt: Database.Statement;
  private readonly activatePromotionStmt: Database.Statement;
  private readonly findActivationStmt: Database.Statement;
  private readonly insertRollbackStmt: Database.Statement;
  private readonly rollbackPromotionStmt: Database.Statement;

  constructor(
    db: Database.Database,
    private readonly options: BehaviorSignalRepositoryOptions = {},
  ) {
    super(db);
    this.findEvidenceByIdStmt = db.prepare(`SELECT * FROM behavior_evidence WHERE evidence_id = ?`);
    this.findEvidenceByFingerprintStmt = db.prepare(`
      SELECT * FROM behavior_evidence WHERE persona = ? AND fingerprint = ?
    `);
    this.insertEvidenceStmt = db.prepare(`
      INSERT INTO behavior_evidence (
        evidence_id, persona, source_kind, source_id, source_occurred_at, fingerprint,
        sentiment, confidence, summary, metadata, created_at
      ) VALUES (
        @evidence_id, @persona, @source_kind, @source_id, @source_occurred_at, @fingerprint,
        @sentiment, @confidence, @summary, @metadata, @created_at
      )
    `);
    this.findEvidenceByPersonaStmt = db.prepare(`
      SELECT * FROM behavior_evidence WHERE persona = ? ORDER BY created_at ASC, evidence_id ASC
    `);
    this.insertCandidateStmt = db.prepare(`
      INSERT INTO behavior_candidates (
        candidate_id, persona, kind, status, summary, proposed_behavior, confidence,
        created_at, updated_at, expired_at
      ) VALUES (
        @candidate_id, @persona, @kind, @status, @summary, @proposed_behavior, @confidence,
        @created_at, @updated_at, NULL
      )
    `);
    this.insertCandidateEvidenceStmt = db.prepare(`
      INSERT OR IGNORE INTO behavior_candidate_evidence (
        candidate_id, persona, evidence_id, created_at
      )
      VALUES (@candidate_id, @persona, @evidence_id, @created_at)
    `);
    this.findCandidateStmt = db.prepare(`
      SELECT * FROM behavior_candidates WHERE persona = ? AND candidate_id = ?
    `);
    this.findCandidatesByPersonaStmt = db.prepare(`
      SELECT * FROM behavior_candidates WHERE persona = ? ORDER BY created_at ASC, candidate_id ASC
    `);
    this.findCandidateSummariesByPersonaStmt = db.prepare(`
      SELECT
        c.*,
        COALESCE((
          SELECT COUNT(*)
          FROM (
            SELECT e.source_kind, e.source_id
            FROM behavior_candidate_evidence ce
            JOIN behavior_evidence e
              ON e.evidence_id = ce.evidence_id
             AND e.persona = ce.persona
            WHERE ce.persona = c.persona
              AND ce.candidate_id = c.candidate_id
            GROUP BY e.source_kind, e.source_id
          )
        ), 0) AS evidence_sources
      FROM behavior_candidates c
      WHERE c.persona = ?
      ORDER BY c.created_at ASC, c.candidate_id ASC
      LIMIT ?
    `);
    this.transitionCandidateStmt = db.prepare(`
      UPDATE behavior_candidates
      SET status = @status, updated_at = @updated_at
      WHERE persona = @persona AND candidate_id = @candidate_id
      RETURNING *
    `);
    this.expireCandidateStmt = db.prepare(`
      UPDATE behavior_candidates
      SET status = 'expired', updated_at = @updated_at, expired_at = @updated_at
      WHERE persona = @persona AND candidate_id = @candidate_id
      RETURNING *
    `);
    this.countDistinctSourcesStmt = db.prepare(`
      SELECT COUNT(*) AS count
      FROM (
        SELECT e.source_kind, e.source_id
        FROM behavior_candidate_evidence ce
        JOIN behavior_evidence e ON e.evidence_id = ce.evidence_id AND e.persona = ce.persona
        WHERE ce.candidate_id = ?
        GROUP BY e.source_kind, e.source_id
      )
    `);
    this.candidateEvidenceSourcesStmt = db.prepare(`
      SELECT e.source_kind, e.source_id
      FROM behavior_evidence e
      WHERE e.persona = @persona
        AND EXISTS (
          SELECT 1 FROM json_each(@evidence_ids) ids WHERE ids.value = e.evidence_id
        )
      GROUP BY e.source_kind, e.source_id
    `);
    this.insertPromotionStmt = db.prepare(`
      INSERT INTO behavior_promotions (
        promotion_id, persona, candidate_id, status, policy, evaluation, created_at, updated_at
      ) VALUES (
        @promotion_id, @persona, @candidate_id, 'proposed', @policy, @evaluation,
        @created_at, @updated_at
      )
    `);
    this.findPromotionStmt = db.prepare(`
      SELECT * FROM behavior_promotions WHERE persona = ? AND promotion_id = ?
    `);
    this.findPromotionsByPersonaStmt = db.prepare(`
      SELECT * FROM behavior_promotions WHERE persona = ? ORDER BY created_at ASC, promotion_id ASC
    `);
    this.transitionPromotionStmt = db.prepare(`
      UPDATE behavior_promotions
      SET status = @status, updated_at = @updated_at
      WHERE persona = @persona AND promotion_id = @promotion_id
      RETURNING *
    `);
    this.insertActivationStmt = db.prepare(`
      INSERT INTO behavior_promotion_activations (
        activation_id, persona, promotion_id, prompt_artifact_id, reload_id, activated_at
      ) VALUES (
        @activation_id, @persona, @promotion_id, @prompt_artifact_id, @reload_id, @activated_at
      )
    `);
    this.activatePromotionStmt = db.prepare(`
      UPDATE behavior_promotions
      SET status = 'active', updated_at = @updated_at
      WHERE persona = @persona AND promotion_id = @promotion_id
        AND status = 'activating'
      RETURNING *
    `);
    this.findActivationStmt = db.prepare(`
      SELECT activation_id, persona, promotion_id FROM behavior_promotion_activations
      WHERE persona = ? AND activation_id = ?
    `);
    this.insertRollbackStmt = db.prepare(`
      INSERT INTO behavior_promotion_rollbacks (
        rollback_id, persona, activation_id, promotion_id, reason, rolled_back_at
      ) VALUES (
        @rollback_id, @persona, @activation_id, @promotion_id, @reason, @rolled_back_at
      )
    `);
    this.rollbackPromotionStmt = db.prepare(`
      UPDATE behavior_promotions
      SET status = 'rolled_back', updated_at = @updated_at
      WHERE persona = @persona AND promotion_id = @promotion_id
        AND status = 'active'
      RETURNING *
    `);
  }

  private recordPromotionTelemetry(
    operation: 'create' | 'transition' | 'activate' | 'rollback',
    row: BehaviorPromotionRow,
    metadata: Record<string, string | number | boolean | null> = {},
  ): void {
    try {
      this.options.metrics?.increment('lifecycle.behavior.promotion.count', {
        operation,
        outcome: 'success',
        status: row.status,
        persona: row.persona,
      });
    } catch {
      // Metrics are advisory and must never change durable behavior writes.
    }
    try {
      this.options.auditLogger?.logLifecyclePromotion({
        action: 'lifecycle.promotion',
        personaId: row.persona,
        details: {
          operation,
          outcome: 'success',
          persona: row.persona,
          promotionId: row.promotion_id,
          candidateId: row.candidate_id,
          status: row.status,
          updatedAt: row.updated_at,
          ...metadata,
        },
      });
    } catch {
      // Audit sink failures are contained so repository writes remain authoritative.
    }
  }

  recordEvidence(input: BehaviorEvidenceInput): Result<BehaviorEvidenceRow, DbError> {
    try {
      const normalized = this.normalizeEvidence(input);
      if (!normalized) {
        return err(new DbError('Failed to record behavior evidence: invalid evidence'));
      }
      const write = this.db.transaction((): BehaviorEvidenceRow => {
        const byId = this.findEvidenceByIdStmt.get(normalized.evidenceId) as
          | BehaviorEvidenceRow
          | undefined;
        if (byId) {
          if (byId.persona !== normalized.persona || byId.fingerprint !== normalized.fingerprint) {
            throw new Error('behavior evidence id collision');
          }
          return this.validateEvidenceRow(byId);
        }
        const byFingerprint = this.findEvidenceByFingerprintStmt.get(
          normalized.persona,
          normalized.fingerprint,
        ) as BehaviorEvidenceRow | undefined;
        if (byFingerprint) {
          return this.validateEvidenceRow(byFingerprint);
        }
        this.insertEvidenceStmt.run({
          evidence_id: normalized.evidenceId,
          persona: normalized.persona,
          source_kind: normalized.sourceKind,
          source_id: normalized.sourceId,
          source_occurred_at: normalized.sourceOccurredAt,
          fingerprint: normalized.fingerprint,
          sentiment: normalized.sentiment,
          confidence: normalized.confidence,
          summary: normalized.summary,
          metadata: JSON.stringify(normalized.metadata),
          created_at: this.now(),
        });
        const row = this.findEvidenceByIdStmt.get(normalized.evidenceId) as BehaviorEvidenceRow;
        return this.validateEvidenceRow(row);
      });
      return ok(write());
    } catch (cause) {
      return err(toDbError('record behavior evidence', cause));
    }
  }

  findEvidenceByPersona(persona: string): Result<BehaviorEvidenceRow[], DbError> {
    try {
      if (!isBehaviorPersona(persona)) {
        return err(new DbError('Failed to find behavior evidence: invalid persona'));
      }
      const rows = this.findEvidenceByPersonaStmt.all(persona) as BehaviorEvidenceRow[];
      return ok(rows.map((row) => this.validateEvidenceRow(row)));
    } catch (cause) {
      return err(toDbError('find behavior evidence', cause));
    }
  }

  createCandidate(input: BehaviorCandidateInput): Result<BehaviorCandidateRow, DbError> {
    try {
      const normalized = this.normalizeCandidate(input);
      if (!normalized) {
        return err(new DbError('Failed to create behavior candidate: invalid candidate'));
      }
      const write = this.db.transaction((): BehaviorCandidateRow => {
        const minimumDistinctSources = normalized.status === 'ready' ? 2 : 1;
        if (
          normalized.evidenceIds.length > 0 &&
          !this.hasDistinctEvidenceSources(
            normalized.persona,
            normalized.evidenceIds,
            minimumDistinctSources,
          )
        ) {
          throw new Error('behavior candidate needs distinct evidence sources');
        }
        const now = this.now();
        this.insertCandidateStmt.run({
          candidate_id: normalized.candidateId,
          persona: normalized.persona,
          kind: normalized.kind,
          status: 'collecting',
          summary: normalized.summary,
          proposed_behavior: normalized.proposedBehavior,
          confidence: normalized.confidence,
          created_at: now,
          updated_at: now,
        });
        for (const evidenceId of normalized.evidenceIds) {
          this.insertCandidateEvidenceStmt.run({
            candidate_id: normalized.candidateId,
            persona: normalized.persona,
            evidence_id: evidenceId,
            created_at: this.now(),
          });
        }
        if (normalized.status === 'ready') {
          this.transitionCandidateStmt.get({
            persona: normalized.persona,
            candidate_id: normalized.candidateId,
            status: 'ready',
            updated_at: this.now(),
          });
        }
        const row = this.findCandidateStmt.get(
          normalized.persona,
          normalized.candidateId,
        ) as BehaviorCandidateRow;
        return this.validateCandidateRow(row);
      });
      return ok(write());
    } catch (cause) {
      return err(toDbError('create behavior candidate', cause));
    }
  }

  findCandidatesByPersona(persona: string): Result<BehaviorCandidateRow[], DbError> {
    try {
      if (!isBehaviorPersona(persona)) {
        return err(new DbError('Failed to find behavior candidates: invalid persona'));
      }
      const rows = this.findCandidatesByPersonaStmt.all(persona) as BehaviorCandidateRow[];
      return ok(rows.map((row) => this.validateCandidateRow(row)));
    } catch (cause) {
      return err(toDbError('find behavior candidates', cause));
    }
  }

  findCandidateSummariesByPersona(
    persona: string,
    limit = 50,
  ): Result<BehaviorCandidateSummaryRow[], DbError> {
    try {
      if (!isBehaviorPersona(persona)) {
        return err(new DbError('Failed to summarize behavior candidates: invalid persona'));
      }
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        return err(new DbError('Failed to summarize behavior candidates: invalid limit'));
      }
      const rows = this.findCandidateSummariesByPersonaStmt.all(
        persona,
        limit,
      ) as BehaviorCandidateSummaryRow[];
      return ok(
        rows.map((row) => {
          const candidate = this.validateCandidateRow(row);
          if (!Number.isSafeInteger(row.evidence_sources) || row.evidence_sources < 0) {
            throw new Error('invalid persisted behavior candidate summary row');
          }
          return { ...candidate, evidence_sources: row.evidence_sources };
        }),
      );
    } catch (cause) {
      return err(toDbError('summarize behavior candidates', cause));
    }
  }

  linkCandidateEvidence(
    input: BehaviorCandidateEvidenceInput,
  ): Result<BehaviorCandidateEvidenceLinkResult, DbError> {
    try {
      const normalized = this.normalizeCandidateEvidence(input);
      if (!normalized) {
        return err(new DbError('Failed to link behavior candidate evidence: invalid lineage'));
      }
      const write = this.db.transaction((): BehaviorCandidateEvidenceLinkResult => {
        const candidate = this.findCandidateStmt.get(normalized.persona, normalized.candidateId) as
          | BehaviorCandidateRow
          | undefined;
        if (!candidate) {
          throw new Error('behavior candidate missing');
        }
        let linkedEvidenceCount = 0;
        for (const evidenceId of normalized.evidenceIds) {
          const result = this.insertCandidateEvidenceStmt.run({
            candidate_id: normalized.candidateId,
            persona: normalized.persona,
            evidence_id: evidenceId,
            created_at: this.now(),
          });
          linkedEvidenceCount += result.changes;
        }
        const row = this.countDistinctSourcesStmt.get(normalized.candidateId) as { count: number };
        return { linkedEvidenceCount, distinctSourceCount: row.count };
      });
      return ok(write());
    } catch (cause) {
      return err(toDbError('link behavior candidate evidence', cause));
    }
  }

  transitionCandidate(
    persona: string,
    candidateId: string,
    status: BehaviorCandidateStatus,
  ): Result<BehaviorCandidateRow, DbError> {
    try {
      if (
        !isBehaviorPersona(persona) ||
        !isBehaviorRuntimeId(candidateId) ||
        !BehaviorCandidateStatusSchema.safeParse(status).success
      ) {
        return err(new DbError('Failed to transition behavior candidate: invalid transition'));
      }
      const transition = this.db.transaction((): BehaviorCandidateRow | null => {
        if (status === 'ready' && !this.hasPersistedDistinctEvidenceSources(candidateId)) {
          throw new Error('behavior candidate needs distinct evidence sources');
        }
        const row = this.transitionCandidateStmt.get({
          persona,
          candidate_id: candidateId,
          status,
          updated_at: this.now(),
        }) as BehaviorCandidateRow | undefined;
        return row ? this.validateCandidateRow(row) : null;
      });
      const row = transition();
      return row
        ? ok(row)
        : err(new DbError('Failed to transition behavior candidate: illegal transition'));
    } catch (cause) {
      return err(toDbError('transition behavior candidate', cause));
    }
  }

  expireCandidate(persona: string, candidateId: string): Result<BehaviorCandidateRow, DbError> {
    try {
      if (!isBehaviorPersona(persona) || !isBehaviorRuntimeId(candidateId)) {
        return err(new DbError('Failed to expire behavior candidate: invalid candidate identity'));
      }
      const expire = this.db.transaction((): BehaviorCandidateRow | null => {
        const row = this.expireCandidateStmt.get({
          persona,
          candidate_id: candidateId,
          updated_at: this.now(),
        }) as BehaviorCandidateRow | undefined;
        return row ? this.validateCandidateRow(row) : null;
      });
      const row = expire();
      return row ? ok(row) : err(new DbError('Failed to expire behavior candidate'));
    } catch (cause) {
      return err(toDbError('expire behavior candidate', cause));
    }
  }

  countDistinctEvidenceSources(candidateId: string): Result<number, DbError> {
    try {
      if (!isBehaviorRuntimeId(candidateId)) {
        return err(new DbError('Failed to count behavior evidence sources: invalid candidate id'));
      }
      const row = this.countDistinctSourcesStmt.get(candidateId) as { count: number };
      return ok(row.count);
    } catch (cause) {
      return err(toDbError('count behavior evidence sources', cause));
    }
  }

  createPromotion(input: BehaviorPromotionInput): Result<BehaviorPromotionRow, DbError> {
    try {
      const normalized = this.normalizePromotion(input);
      if (!normalized) {
        return err(new DbError('Failed to create behavior promotion: invalid promotion'));
      }
      const write = this.db.transaction((): BehaviorPromotionRow => {
        const now = this.now();
        this.insertPromotionStmt.run({
          promotion_id: normalized.promotionId,
          persona: normalized.persona,
          candidate_id: normalized.candidateId,
          policy: JSON.stringify(normalized.policy),
          evaluation: JSON.stringify(normalized.evaluation),
          created_at: now,
          updated_at: now,
        });
        const row = this.findPromotionStmt.get(
          normalized.persona,
          normalized.promotionId,
        ) as BehaviorPromotionRow;
        return this.validatePromotionRow(row);
      });
      const row = write();
      this.recordPromotionTelemetry('create', row);
      return ok(row);
    } catch (cause) {
      return err(toDbError('create behavior promotion', cause));
    }
  }

  transitionPromotion(
    persona: string,
    promotionId: string,
    status: BehaviorPromotionStatus,
  ): Result<BehaviorPromotionRow, DbError> {
    try {
      if (
        !isBehaviorPersona(persona) ||
        !isBehaviorRuntimeId(promotionId) ||
        !BehaviorPromotionStatusSchema.safeParse(status).success ||
        status === 'active' ||
        status === 'rolled_back'
      ) {
        return err(new DbError('Failed to transition behavior promotion: invalid transition'));
      }
      const transition = this.db.transaction((): BehaviorPromotionRow | null => {
        const row = this.transitionPromotionStmt.get({
          persona,
          promotion_id: promotionId,
          status,
          updated_at: this.now(),
        }) as BehaviorPromotionRow | undefined;
        return row ? this.validatePromotionRow(row) : null;
      });
      const row = transition();
      if (row) {
        this.recordPromotionTelemetry('transition', row, { targetStatus: status });
      }
      return row
        ? ok(row)
        : err(new DbError('Failed to transition behavior promotion: illegal transition'));
    } catch (cause) {
      return err(toDbError('transition behavior promotion', cause));
    }
  }

  activatePromotion(
    input: BehaviorPromotionActivationInput,
  ): Result<BehaviorPromotionRow, DbError> {
    try {
      if (
        !isBehaviorPersona(input.persona) ||
        !isBehaviorRuntimeId(input.promotionId) ||
        !isBehaviorRuntimeId(input.activationId) ||
        !isBehaviorRuntimeId(input.promptArtifactId) ||
        !isBehaviorRuntimeId(input.reloadId)
      ) {
        return err(new DbError('Failed to activate behavior promotion: invalid activation'));
      }
      const write = this.db.transaction((): BehaviorPromotionRow | null => {
        const now = this.now();
        this.insertActivationStmt.run({
          activation_id: input.activationId,
          persona: input.persona,
          promotion_id: input.promotionId,
          prompt_artifact_id: input.promptArtifactId,
          reload_id: input.reloadId,
          activated_at: now,
        });
        const row = this.activatePromotionStmt.get({
          persona: input.persona,
          promotion_id: input.promotionId,
          updated_at: now,
        }) as BehaviorPromotionRow | undefined;
        if (!row) return null;
        return this.validatePromotionRow(row);
      });
      const row = write();
      if (row) {
        this.recordPromotionTelemetry('activate', row, {
          activationId: input.activationId,
          promptArtifactId: input.promptArtifactId,
          reloadId: input.reloadId,
        });
      }
      return row ? ok(row) : err(new DbError('Failed to activate behavior promotion'));
    } catch (cause) {
      return err(toDbError('activate behavior promotion', cause));
    }
  }

  rollbackActivation(input: BehaviorPromotionRollbackInput): Result<BehaviorPromotionRow, DbError> {
    try {
      if (
        !isBehaviorPersona(input.persona) ||
        !isBehaviorRuntimeId(input.activationId) ||
        !isBehaviorRuntimeId(input.rollbackId) ||
        !BehaviorLineageReasonSchema.safeParse(input.reason).success ||
        !isBehaviorIdentifier(input.reason)
      ) {
        return err(new DbError('Failed to rollback behavior promotion: invalid rollback'));
      }
      const write = this.db.transaction((): BehaviorPromotionRow | null => {
        const activation = this.findActivationStmt.get(input.persona, input.activationId) as
          | { activation_id: string; persona: string; promotion_id: string }
          | undefined;
        if (!activation) return null;
        const now = this.now();
        this.insertRollbackStmt.run({
          rollback_id: input.rollbackId,
          persona: input.persona,
          activation_id: input.activationId,
          promotion_id: activation.promotion_id,
          reason: input.reason,
          rolled_back_at: now,
        });
        const row = this.rollbackPromotionStmt.get({
          persona: input.persona,
          promotion_id: activation.promotion_id,
          updated_at: now,
        }) as BehaviorPromotionRow | undefined;
        if (!row) {
          throw new DbError('Failed to rollback behavior promotion');
        }
        return this.validatePromotionRow(row);
      });
      const row = write();
      if (row) {
        this.recordPromotionTelemetry('rollback', row, {
          activationId: input.activationId,
          rollbackId: input.rollbackId,
          reason: input.reason,
        });
      }
      return row ? ok(row) : err(new DbError('Failed to rollback behavior promotion'));
    } catch (cause) {
      return err(toDbError('rollback behavior promotion', cause));
    }
  }

  findPromotionsByPersona(persona: string): Result<BehaviorPromotionRow[], DbError> {
    try {
      if (!isBehaviorPersona(persona)) {
        return err(new DbError('Failed to find behavior promotions: invalid persona'));
      }
      const rows = this.findPromotionsByPersonaStmt.all(persona) as BehaviorPromotionRow[];
      return ok(rows.map((row) => this.validatePromotionRow(row)));
    } catch (cause) {
      return err(toDbError('find behavior promotions', cause));
    }
  }

  private normalizeEvidence(input: BehaviorEvidenceInput): NormalizedEvidence | null {
    const record = readRecord(
      input,
      [
        'evidenceId',
        'persona',
        'sourceKind',
        'sourceId',
        'sourceOccurredAt',
        'fingerprint',
        'sentiment',
        'confidence',
        'summary',
      ],
      ['metadata'],
    );
    if (!record) return null;
    const sourceKind = BehaviorEvidenceSourceKindSchema.safeParse(record.sourceKind);
    const sentiment = BehaviorEvidenceSentimentSchema.safeParse(record.sentiment);
    const confidence = BehaviorConfidenceSchema.safeParse(record.confidence);
    const occurredAt = BehaviorTimestampSchema.safeParse(record.sourceOccurredAt);
    const metadata = boundedMetadata(record.metadata);
    if (
      !isBehaviorRuntimeId(record.evidenceId) ||
      !isBehaviorPersona(record.persona) ||
      !sourceKind.success ||
      !isBehaviorRuntimeId(record.sourceId) ||
      !occurredAt.success ||
      !isBehaviorRuntimeId(record.fingerprint) ||
      !sentiment.success ||
      !confidence.success ||
      !boundedSummary(record.summary) ||
      !metadata
    ) {
      return null;
    }
    return {
      evidenceId: record.evidenceId,
      persona: record.persona,
      sourceKind: sourceKind.data,
      sourceId: record.sourceId,
      sourceOccurredAt: occurredAt.data,
      fingerprint: record.fingerprint,
      sentiment: sentiment.data,
      confidence: confidence.data,
      summary: record.summary,
      metadata,
    };
  }

  private normalizeCandidate(input: BehaviorCandidateInput): NormalizedCandidate | null {
    const record = readRecord(
      input,
      ['candidateId', 'persona', 'kind', 'summary', 'proposedBehavior', 'confidence'],
      ['status', 'createdFromEvidenceIds'],
    );
    if (!record) return null;
    const kind = BehaviorCandidateKindSchema.safeParse(record.kind);
    const status = BehaviorCandidateStatusSchema.safeParse(record.status ?? 'collecting');
    const confidence = BehaviorConfidenceSchema.safeParse(record.confidence);
    const evidenceIds =
      record.createdFromEvidenceIds === undefined
        ? []
        : readStringArray(record.createdFromEvidenceIds, 32);
    if (
      !isBehaviorRuntimeId(record.candidateId) ||
      !isBehaviorPersona(record.persona) ||
      !kind.success ||
      !status.success ||
      (status.data !== 'collecting' && status.data !== 'ready') ||
      !boundedSummary(record.summary) ||
      !boundedSummary(record.proposedBehavior) ||
      !confidence.success ||
      !evidenceIds ||
      (status.data === 'ready' && evidenceIds.length === 0) ||
      new Set(evidenceIds).size !== evidenceIds.length
    ) {
      return null;
    }
    return {
      candidateId: record.candidateId,
      persona: record.persona,
      kind: kind.data,
      status: status.data,
      summary: record.summary,
      proposedBehavior: record.proposedBehavior,
      confidence: confidence.data,
      evidenceIds,
    };
  }

  private normalizeCandidateEvidence(
    input: BehaviorCandidateEvidenceInput,
  ): NormalizedCandidateEvidence | null {
    const record = readRecord(input, ['candidateId', 'persona', 'evidenceIds']);
    if (!record) return null;
    const evidenceIds = readStringArray(record.evidenceIds, 32);
    if (
      !isBehaviorRuntimeId(record.candidateId) ||
      !isBehaviorPersona(record.persona) ||
      !evidenceIds ||
      evidenceIds.length === 0 ||
      new Set(evidenceIds).size !== evidenceIds.length
    ) {
      return null;
    }
    return {
      candidateId: record.candidateId,
      persona: record.persona,
      evidenceIds,
    };
  }

  private normalizePromotion(input: BehaviorPromotionInput): NormalizedPromotion | null {
    const record = readRecord(
      input,
      ['promotionId', 'persona', 'candidateId'],
      ['status', 'policy', 'evaluation'],
    );
    if (!record) return null;
    const status = BehaviorPromotionStatusSchema.safeParse(record.status ?? 'proposed');
    const policy = boundedMetadata(record.policy);
    const evaluation = boundedMetadata(record.evaluation);
    if (
      !isBehaviorRuntimeId(record.promotionId) ||
      !isBehaviorPersona(record.persona) ||
      !isBehaviorRuntimeId(record.candidateId) ||
      !status.success ||
      status.data !== 'proposed' ||
      !policy ||
      !evaluation
    ) {
      return null;
    }
    return {
      promotionId: record.promotionId,
      persona: record.persona,
      candidateId: record.candidateId,
      policy,
      evaluation,
    };
  }

  private hasDistinctEvidenceSources(
    persona: string,
    evidenceIds: readonly string[],
    minimumDistinctSources: number,
  ): boolean {
    if (evidenceIds.length === 0) return minimumDistinctSources === 0;
    if (evidenceIds.length < minimumDistinctSources) return false;
    const rows = this.candidateEvidenceSourcesStmt.all({
      persona,
      evidence_ids: JSON.stringify(evidenceIds),
    }) as Array<{ source_kind: string; source_id: string }>;
    return rows.length === evidenceIds.length && rows.length >= minimumDistinctSources;
  }

  private hasPersistedDistinctEvidenceSources(candidateId: string): boolean {
    const row = this.countDistinctSourcesStmt.get(candidateId) as { count: number };
    return row.count >= 2;
  }

  private validateEvidenceRow(row: BehaviorEvidenceRow): BehaviorEvidenceRow {
    if (
      !isBehaviorRuntimeId(row.evidence_id) ||
      !isBehaviorPersona(row.persona) ||
      !BehaviorEvidenceSourceKindSchema.safeParse(row.source_kind).success ||
      !isBehaviorRuntimeId(row.source_id) ||
      !BehaviorTimestampSchema.safeParse(row.source_occurred_at).success ||
      !isBehaviorRuntimeId(row.fingerprint) ||
      !BehaviorEvidenceSentimentSchema.safeParse(row.sentiment).success ||
      !BehaviorConfidenceSchema.safeParse(row.confidence).success ||
      !boundedSummary(row.summary) ||
      !this.parseMetadata(row.metadata) ||
      !Number.isSafeInteger(row.created_at)
    ) {
      throw new Error('invalid persisted behavior evidence row');
    }
    return row;
  }

  private validateCandidateRow(row: BehaviorCandidateRow): BehaviorCandidateRow {
    if (
      !isBehaviorRuntimeId(row.candidate_id) ||
      !isBehaviorPersona(row.persona) ||
      !BehaviorCandidateKindSchema.safeParse(row.kind).success ||
      !BehaviorCandidateStatusSchema.safeParse(row.status).success ||
      !boundedSummary(row.summary) ||
      !boundedSummary(row.proposed_behavior) ||
      !BehaviorConfidenceSchema.safeParse(row.confidence).success ||
      !Number.isSafeInteger(row.created_at) ||
      !Number.isSafeInteger(row.updated_at) ||
      (row.expired_at !== null && !Number.isSafeInteger(row.expired_at))
    ) {
      throw new Error('invalid persisted behavior candidate row');
    }
    return row;
  }

  private validatePromotionRow(row: BehaviorPromotionRow): BehaviorPromotionRow {
    if (
      !isBehaviorRuntimeId(row.promotion_id) ||
      !isBehaviorPersona(row.persona) ||
      !isBehaviorRuntimeId(row.candidate_id) ||
      !BehaviorPromotionStatusSchema.safeParse(row.status).success ||
      !this.parseMetadata(row.policy) ||
      !this.parseMetadata(row.evaluation) ||
      !Number.isSafeInteger(row.created_at) ||
      !Number.isSafeInteger(row.updated_at)
    ) {
      throw new Error('invalid persisted behavior promotion row');
    }
    return row;
  }

  private parseMetadata(raw: string): BehaviorMetadata | null {
    if (typeof raw !== 'string' || raw.length > 32768 || Buffer.byteLength(raw, 'utf8') > 32768) {
      return null;
    }
    try {
      return boundedMetadata(JSON.parse(raw) as unknown);
    } catch {
      return null;
    }
  }
}
