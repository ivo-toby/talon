import { createHash } from 'node:crypto';

import {
  BehaviorFeedbackDetectedSignalEnvelopeSchema,
  type BehaviorSignalMetadata,
} from './contracts.js';
import type { LifecycleReference, LifecycleSignalEnvelope } from '../contracts/index.js';

function digestId(prefix: string, value: unknown): string {
  return `${prefix}${createHash('sha256')
    .update('talon.behavior.evidence.v1\0', 'utf8')
    .update(JSON.stringify(value), 'utf8')
    .digest('base64url')
    .slice(0, 32)}`;
}

function normalizedText(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
}

function metadata(signal: LifecycleSignalEnvelope): BehaviorSignalMetadata {
  return BehaviorFeedbackDetectedSignalEnvelopeSchema.parse(signal).payload
    .metadata as BehaviorSignalMetadata;
}

function canonicalSource(
  signal: LifecycleSignalEnvelope,
  source: LifecycleReference,
): LifecycleReference {
  if (source.type !== 'schedule' && source.type !== 'manual') {
    return source;
  }

  const message = signal.payload.references.find((reference) => reference.type === 'message');
  return message ?? source;
}

export function behaviorEvidenceFingerprint(
  signal: LifecycleSignalEnvelope,
  source: LifecycleReference,
): string {
  const meta = metadata(signal);
  const canonical = canonicalSource(signal, source);
  return digestId('bef.v1.', {
    source: canonical,
    category: meta.category,
    candidateKind: meta.candidateKind,
    sentiment: meta.sentiment,
    summary: normalizedText(meta.summary),
    proposedBehavior: normalizedText(meta.proposedBehavior),
  });
}

export function behaviorEvidenceId(
  signal: LifecycleSignalEnvelope,
  source: LifecycleReference,
): string {
  return digestId('behavior-evidence-', {
    signalId: signal.signalId,
    source,
    fingerprint: behaviorEvidenceFingerprint(signal, source),
  });
}

export function behaviorCandidateId(persona: string, signal: LifecycleSignalEnvelope): string {
  const meta = metadata(signal);
  return digestId('behavior-candidate-', {
    persona,
    category: meta.category,
    candidateKind: meta.candidateKind,
    proposedBehavior: normalizedText(meta.proposedBehavior),
  });
}
