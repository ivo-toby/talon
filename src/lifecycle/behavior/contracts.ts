import { createHash } from 'node:crypto';
import { z } from 'zod';

import {
  LifecycleEventEnvelopeSchema,
  LifecycleReferenceSchema,
  LifecycleRuntimeIdSchema,
  LifecycleSignalEnvelopeSchema,
  LifecycleVersionedTypeNameSchema,
  type LifecycleEventEnvelope,
  type LifecycleReference,
  type LifecycleSignalEnvelope,
} from '../contracts/index.js';
import {
  BehaviorCandidateKindSchema,
  BehaviorConfidenceSchema,
  BehaviorEvidenceSentimentSchema,
  BehaviorEvidenceSourceKindSchema,
  BehaviorTimestampSchema,
} from './types.js';
import { isBoundedWellFormedUtf8 } from '../contracts/common.js';

export const BEHAVIOR_SIGNAL_CONTRACT = 'talon.behavior.signal.v1';
export const BEHAVIOR_FEEDBACK_DETECTED_SIGNAL_TYPE = 'behavior.feedback.detected.v1';

const MAX_BEHAVIOR_DETECTOR_SIGNALS = 16;
const MAX_BEHAVIOR_SUPPORTING_SOURCES = 8;
const MAX_BEHAVIOR_SIGNAL_TEXT_CHARS = 1_024;
const MAX_BEHAVIOR_SIGNAL_TEXT_BYTES = 4_096;

function isBoundedBehaviorText(value: string): boolean {
  return (
    value.indexOf('\0') === -1 &&
    value.trim() === value &&
    isBoundedWellFormedUtf8(
      value,
      MAX_BEHAVIOR_SIGNAL_TEXT_CHARS,
      MAX_BEHAVIOR_SIGNAL_TEXT_BYTES,
    )
  );
}

const BehaviorSignalTextSchema = z
  .string()
  .min(1)
  .max(MAX_BEHAVIOR_SIGNAL_TEXT_CHARS)
  .refine(isBoundedBehaviorText, {
    message: 'behavior signal text must be bounded, trimmed, well-formed Unicode without NUL',
  });

export const BehaviorFeedbackKindSchema = z.enum([
  'explicit_correction',
  'positive_feedback',
  'inferred_pattern',
  'missed_action',
  'noise',
  'tool_failure',
]);

export const BehaviorDetectorSourceSchema = z
  .object({
    kind: BehaviorEvidenceSourceKindSchema,
    id: LifecycleRuntimeIdSchema,
    occurredAt: BehaviorTimestampSchema.optional(),
    excerpt: BehaviorSignalTextSchema.optional(),
  })
  .strict();

export const BehaviorDetectorSignalSchema = z
  .object({
    category: BehaviorFeedbackKindSchema,
    source: BehaviorDetectorSourceSchema,
    supportingSources: z
      .array(BehaviorDetectorSourceSchema)
      .max(MAX_BEHAVIOR_SUPPORTING_SOURCES)
      .default([]),
    sentiment: BehaviorEvidenceSentimentSchema,
    candidateKind: BehaviorCandidateKindSchema,
    confidence: BehaviorConfidenceSchema,
    summary: BehaviorSignalTextSchema,
    proposedBehavior: BehaviorSignalTextSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.category === 'inferred_pattern') {
      const distinctSources = new Set([
        `${value.source.kind}:${value.source.id}`,
        ...value.supportingSources.map((source) => `${source.kind}:${source.id}`),
      ]);
      if (distinctSources.size < 2) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['supportingSources'],
          message: 'inferred behavior patterns require at least two distinct sources',
        });
      }
    }
  });

export const BehaviorSignalMetadataSchema = z
  .object({
    contract: z.literal(BEHAVIOR_SIGNAL_CONTRACT),
    category: BehaviorFeedbackKindSchema,
    sourceKind: BehaviorEvidenceSourceKindSchema,
    sourceId: LifecycleRuntimeIdSchema,
    sourceOccurredAt: BehaviorTimestampSchema,
    provenanceDetector: z.literal('behavior-feedback-detector'),
    provenanceInputEventId: LifecycleRuntimeIdSchema,
    provenanceInputEventType: LifecycleVersionedTypeNameSchema,
    provenanceHandlerId: LifecycleRuntimeIdSchema.optional(),
    sentiment: BehaviorEvidenceSentimentSchema,
    candidateKind: BehaviorCandidateKindSchema,
    confidence: BehaviorConfidenceSchema,
    summary: BehaviorSignalTextSchema,
    proposedBehavior: BehaviorSignalTextSchema,
    supportingSourceCount: z.number().int().min(0).max(MAX_BEHAVIOR_SUPPORTING_SOURCES),
  })
  .strict()
  .refine(
    (value) =>
      value.provenanceInputEventId !== '' &&
      value.provenanceInputEventType !== '' &&
      value.sourceId !== '',
    {
      path: ['provenanceInputEventId'],
      message: 'behavior signal metadata must carry trusted event provenance and source id',
    },
  );

const BehaviorDetectorOutputBaseSchema = z
  .object({
    contract: z.literal(BEHAVIOR_SIGNAL_CONTRACT),
    signals: z.array(BehaviorDetectorSignalSchema).max(MAX_BEHAVIOR_DETECTOR_SIGNALS),
  })
  .strict();

export const BehaviorDetectorOutputSchema = BehaviorDetectorOutputBaseSchema.transform((value) =>
  Object.freeze({
    contract: BEHAVIOR_SIGNAL_CONTRACT,
    signals: Object.freeze(
      value.signals.map((signal) =>
        Object.freeze({
          ...signal,
          source: Object.freeze({ ...signal.source }),
          supportingSources: Object.freeze(
            signal.supportingSources.map((source) => Object.freeze({ ...source })),
          ),
        }),
      ),
    ),
  }),
);

export const BehaviorFeedbackDetectedSignalEnvelopeSchema = LifecycleSignalEnvelopeSchema.refine(
  (signal) =>
    signal.type === BEHAVIOR_FEEDBACK_DETECTED_SIGNAL_TYPE &&
    BehaviorSignalMetadataSchema.safeParse(signal.payload.metadata).success,
  {
    message: 'behavior feedback signals must carry talon.behavior.signal.v1 metadata',
  },
);

export type BehaviorFeedbackKind = z.infer<typeof BehaviorFeedbackKindSchema>;
export type BehaviorDetectorSource = z.infer<typeof BehaviorDetectorSourceSchema>;
export type BehaviorDetectorSignal = z.infer<typeof BehaviorDetectorSignalSchema>;
export type BehaviorSignalMetadata = z.infer<typeof BehaviorSignalMetadataSchema>;
export type BehaviorDetectorOutput = z.output<typeof BehaviorDetectorOutputSchema>;

export function parseBehaviorDetectorInputEvent(input: unknown): LifecycleEventEnvelope {
  return LifecycleEventEnvelopeSchema.parse(input);
}

export function trustedBehaviorSourceReferences(event: LifecycleEventEnvelope): LifecycleReference[] {
  const references = [
    ...event.payload.references,
    ...(event.context.provenance.sourceReferences ?? []),
  ];
  const seen = new Set<string>();
  const trusted: LifecycleReference[] = [];

  for (const reference of references) {
    if (!BehaviorEvidenceSourceKindSchema.safeParse(reference.type).success) continue;
    const parsed = LifecycleReferenceSchema.safeParse(reference);
    if (!parsed.success) continue;

    const key = `${parsed.data.type}:${parsed.data.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    trusted.push(parsed.data);
  }

  return trusted;
}

function assertTrustedBehaviorSource(
  event: LifecycleEventEnvelope,
  source: BehaviorDetectorSource,
): LifecycleReference {
  const match = trustedBehaviorSourceReferences(event).find(
    (reference) => reference.type === source.kind && reference.id === source.id,
  );
  if (!match) {
    throw new Error(
      `behavior feedback source ${source.kind}:${source.id} is not present in trusted lifecycle references for event ${event.eventId}`,
    );
  }
  return match;
}

function trustedBehaviorSignalReferences(
  event: LifecycleEventEnvelope,
  signal: BehaviorDetectorSignal,
): LifecycleReference[] {
  const references = [
    assertTrustedBehaviorSource(event, signal.source),
    ...signal.supportingSources.map((source) => assertTrustedBehaviorSource(event, source)),
  ];
  const seen = new Set<string>();

  return references.filter((reference) => {
    const key = `${reference.type}:${reference.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function behaviorSignalMetadata(
  event: LifecycleEventEnvelope,
  signal: BehaviorDetectorSignal,
  source: LifecycleReference,
  handlerId?: string,
): BehaviorSignalMetadata {
  return {
    contract: BEHAVIOR_SIGNAL_CONTRACT,
    category: signal.category,
    sourceKind: source.type as BehaviorDetectorSource['kind'],
    sourceId: source.id,
    sourceOccurredAt: event.occurredAt,
    provenanceDetector: 'behavior-feedback-detector',
    provenanceInputEventId: event.eventId,
    provenanceInputEventType: event.type,
    ...(handlerId ? { provenanceHandlerId: handlerId } : {}),
    sentiment: signal.sentiment,
    candidateKind: signal.candidateKind,
    confidence: signal.confidence,
    summary: signal.summary,
    proposedBehavior: signal.proposedBehavior,
    supportingSourceCount: signal.supportingSources.length,
  };
}

export function toBehaviorFeedbackDetectedSignalEnvelope(
  event: LifecycleEventEnvelope,
  signal: BehaviorDetectorSignal,
  index: number,
  handlerId?: string,
): LifecycleSignalEnvelope {
  const references = trustedBehaviorSignalReferences(event, signal);
  const primarySource = references[0];
  const signalId = stableBehaviorSignalId(event.eventId, signal, primarySource, index);
  return BehaviorFeedbackDetectedSignalEnvelopeSchema.parse({
    version: 'v1',
    type: BEHAVIOR_FEEDBACK_DETECTED_SIGNAL_TYPE,
    signalId,
    occurredAt: event.occurredAt,
    context: {
      ...event.context,
      causationId: event.eventId,
      recursion: {
        depth: event.context.recursion.depth + 1,
        maxDepth: event.context.recursion.maxDepth,
      },
    },
    payload: {
      references,
      metadata: behaviorSignalMetadata(event, signal, primarySource, handlerId),
    },
  });
}

function stableBehaviorSignalId(
  eventId: string,
  signal: BehaviorDetectorSignal,
  source: LifecycleReference,
  index: number,
): string {
  const digest = createHash('sha256')
    .update(
      JSON.stringify({
        eventId,
        index,
        category: signal.category,
        source,
        summary: signal.summary,
        proposedBehavior: signal.proposedBehavior,
      }),
    )
    .digest('hex')
    .slice(0, 24);
  return `behavior-feedback-${digest}`;
}
