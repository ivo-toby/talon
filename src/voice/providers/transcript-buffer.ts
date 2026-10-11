import { createHash } from 'node:crypto';
import type {
  VoiceContextSnapshot,
  VoiceTranscriptFragment,
  VoiceTranscriptRole,
} from '../voice-types.js';

export const DEFAULT_MAX_TRANSCRIPT_FRAGMENTS = 256;
export const DEFAULT_MAX_TRANSCRIPT_CHARACTERS = 32_000;

export interface TranscriptBufferOptions {
  readonly maxFragments?: number;
  readonly maxCharacters?: number;
  readonly now?: () => number;
}

export type TranscriptAppendOutcome = 'added' | 'corrected' | 'duplicate';

export interface TranscriptAppendResult {
  readonly outcome: TranscriptAppendOutcome;
  readonly fragment: VoiceTranscriptFragment;
}

export type TranscriptContextReason =
  | 'missing_transcript'
  | 'truncated'
  | 'boundary_fragment'
  | 'untimed_fragment'
  | 'transcript_changed'
  | 'delegation_replay_conflict';

export interface TranscriptContextResult {
  readonly snapshot: VoiceContextSnapshot | null;
  readonly uncertain: boolean;
  readonly reason?: TranscriptContextReason;
}

interface ContextSelection {
  readonly fragments: readonly VoiceTranscriptFragment[];
  readonly uncertain: boolean;
  readonly reason?: TranscriptContextReason;
}

interface SemanticTranscriptFragment {
  readonly id: string;
  readonly role: VoiceTranscriptRole;
  readonly kind: 'transcript' | 'correction';
  readonly text: string;
  readonly startMs?: number;
  readonly endMs?: number;
}

/**
 * Bounded, server-owned transcript storage for one live provider session.
 *
 * Provider event IDs are handled by the sideband adapter. Fragment IDs are
 * still deduplicated here because providers may resend equivalent transcript
 * items under a different event ID.
 */
export class TranscriptBuffer {
  private readonly maxFragments: number;
  private readonly maxCharacters: number;
  private readonly now: () => number;
  private storedFragments: readonly VoiceTranscriptFragment[] = [];
  private storedCharacters = 0;
  private storedVersion = 0;
  private storedTruncated = false;
  private readonly deltaFingerprints = new Map<string, string[]>();

  constructor(options: TranscriptBufferOptions = {}) {
    this.maxFragments = positiveLimit(
      options.maxFragments ?? DEFAULT_MAX_TRANSCRIPT_FRAGMENTS,
      'maxFragments',
    );
    this.maxCharacters = positiveLimit(
      options.maxCharacters ?? DEFAULT_MAX_TRANSCRIPT_CHARACTERS,
      'maxCharacters',
    );
    this.now = options.now ?? Date.now;
  }

  get version(): number {
    return this.storedVersion;
  }

  get truncated(): boolean {
    return this.storedTruncated;
  }

  get characterCount(): number {
    return this.storedCharacters;
  }

  get size(): number {
    return this.storedFragments.length;
  }

  get fragments(): readonly VoiceTranscriptFragment[] {
    return this.storedFragments;
  }

  append(fragment: VoiceTranscriptFragment): TranscriptAppendResult {
    const boundedFragment = this.boundFragment(fragment);
    const existingIndex = this.storedFragments.findIndex((item) => item.id === fragment.id);

    if (existingIndex >= 0) {
      const existing = this.storedFragments[existingIndex];
      if (sameFragment(existing, boundedFragment)) {
        return { outcome: 'duplicate', fragment: existing };
      }

      if (existing.kind === 'delta' && boundedFragment.kind === 'delta') {
        const fingerprint = deltaFingerprint(boundedFragment);
        if (this.hasDeltaFingerprint(boundedFragment.id, fingerprint)) {
          return { outcome: 'duplicate', fragment: existing };
        }
        this.rememberDeltaFingerprint(boundedFragment.id, fingerprint);
        const combinedText = existing.text + boundedFragment.text;
        if (combinedText.length > this.maxCharacters) this.storedTruncated = true;
        const combined: VoiceTranscriptFragment = {
          ...existing,
          text: combinedText.slice(0, this.maxCharacters),
          sequence: boundedFragment.sequence,
          ...(existing.startMs !== undefined || boundedFragment.startMs !== undefined
            ? { startMs: existing.startMs ?? boundedFragment.startMs }
            : {}),
          ...(boundedFragment.endMs !== undefined || existing.endMs !== undefined
            ? { endMs: boundedFragment.endMs ?? existing.endMs }
            : {}),
          receivedAt: boundedFragment.receivedAt,
        };
        const next = [...this.storedFragments];
        next[existingIndex] = combined;
        this.replace(next);
        return { outcome: 'added', fragment: combined };
      }

      const replacement =
        boundedFragment.kind === 'correction' || boundedFragment.kind === 'completed'
          ? boundedFragment
          : { ...boundedFragment, kind: 'correction' as const };
      this.deltaFingerprints.delete(boundedFragment.id);
      const next = [...this.storedFragments];
      next[existingIndex] = replacement;
      this.replace(next);
      return { outcome: 'corrected', fragment: replacement };
    }

    if (boundedFragment.kind === 'delta') {
      this.rememberDeltaFingerprint(boundedFragment.id, deltaFingerprint(boundedFragment));
    }
    this.replace([...this.storedFragments, boundedFragment]);
    return { outcome: 'added', fragment: boundedFragment };
  }

  /** Capture all currently known context, including fragments without timing. */
  snapshot(): TranscriptContextResult {
    return this.captureAt(Number.POSITIVE_INFINITY);
  }

  /**
   * Capture context at a provider delegation offset. The caller must treat an
   * uncertain result as requiring clarification before backend admission.
   */
  captureAt(offsetMs: number): TranscriptContextResult {
    if (!Number.isFinite(offsetMs) && offsetMs !== Number.POSITIVE_INFINITY) {
      return { snapshot: null, uncertain: true, reason: 'missing_transcript' };
    }

    const selection = this.selectAt(offsetMs);
    const userFragmentPresent = selection.fragments.some((fragment) => fragment.role === 'user');
    if (!userFragmentPresent) {
      return {
        snapshot: null,
        uncertain: true,
        reason: selection.reason ?? 'missing_transcript',
      };
    }

    const snapshotFragments = selection.fragments.map((fragment) => ({ ...fragment }));
    const text = snapshotFragments
      .map((fragment) => `${fragment.role}: ${fragment.text}`)
      .join('\n');
    const digest = semanticDigest(snapshotFragments);

    return {
      snapshot: {
        version: this.storedVersion,
        digest,
        capturedAt: this.now(),
        text,
        fragments: snapshotFragments,
        truncated: this.storedTruncated,
      },
      uncertain: selection.uncertain,
      ...(selection.reason ? { reason: selection.reason } : {}),
    };
  }

  clear(): void {
    this.storedFragments = [];
    this.storedCharacters = 0;
    this.storedVersion += 1;
    this.storedTruncated = false;
    this.deltaFingerprints.clear();
  }

  private selectAt(offsetMs: number): ContextSelection {
    const fragments: VoiceTranscriptFragment[] = [];
    let uncertain = this.storedTruncated;
    let reason: TranscriptContextReason | undefined = this.storedTruncated
      ? 'truncated'
      : undefined;

    for (const fragment of this.storedFragments) {
      const start = fragment.startMs;
      const end = fragment.endMs ?? start;
      if (start === undefined && end === undefined) {
        fragments.push(fragment);
        uncertain = true;
        reason ??= 'untimed_fragment';
        continue;
      }
      if (start !== undefined && start > offsetMs) continue;
      if (end !== undefined && end > offsetMs) {
        uncertain = true;
        reason ??= 'boundary_fragment';
        continue;
      }
      fragments.push(fragment);
    }

    return { fragments, uncertain, ...(reason ? { reason } : {}) };
  }

  private boundFragment(fragment: VoiceTranscriptFragment): VoiceTranscriptFragment {
    if (fragment.text.length <= this.maxCharacters) return { ...fragment };
    this.storedTruncated = true;
    return { ...fragment, text: fragment.text.slice(0, this.maxCharacters) };
  }

  private replace(fragments: readonly VoiceTranscriptFragment[]): void {
    const next = [...fragments].sort(compareFragments);
    let characters = next.reduce((total, fragment) => total + fragment.text.length, 0);

    while (next.length > this.maxFragments || characters > this.maxCharacters) {
      const removed = next.shift();
      if (!removed) break;
      characters -= removed.text.length;
      this.storedTruncated = true;
    }

    this.storedFragments = next;
    this.storedCharacters = characters;
    this.storedVersion += 1;
    const retained = new Set(next.map((fragment) => fragment.id));
    for (const id of this.deltaFingerprints.keys()) {
      if (!retained.has(id)) this.deltaFingerprints.delete(id);
    }
  }

  private hasDeltaFingerprint(id: string, fingerprint: string): boolean {
    return this.deltaFingerprints.get(id)?.includes(fingerprint) ?? false;
  }

  private rememberDeltaFingerprint(id: string, fingerprint: string): void {
    const fingerprints = this.deltaFingerprints.get(id) ?? [];
    if (!fingerprints.includes(fingerprint)) fingerprints.push(fingerprint);
    while (fingerprints.length > this.maxFragments) fingerprints.shift();
    this.deltaFingerprints.set(id, fingerprints);
  }
}

function positiveLimit(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function sameFragment(left: VoiceTranscriptFragment, right: VoiceTranscriptFragment): boolean {
  return (
    left.role === right.role &&
    left.kind === right.kind &&
    left.text === right.text &&
    left.startMs === right.startMs &&
    left.endMs === right.endMs
  );
}

function deltaFingerprint(fragment: VoiceTranscriptFragment): string {
  return JSON.stringify([fragment.text, fragment.startMs, fragment.endMs]);
}

/**
 * Provider sequence, receipt time, and delta/completion state are transport
 * metadata. Keep correction as a semantic marker while hashing the context
 * that can affect backend admission.
 */
function semanticDigest(fragments: readonly VoiceTranscriptFragment[]): string {
  const semanticFragments: readonly SemanticTranscriptFragment[] = fragments.map((fragment) => ({
    id: fragment.id,
    role: fragment.role,
    kind: fragment.kind === 'correction' ? 'correction' : 'transcript',
    text: fragment.text,
    ...(fragment.startMs !== undefined ? { startMs: fragment.startMs } : {}),
    ...(fragment.endMs !== undefined ? { endMs: fragment.endMs } : {}),
  }));
  return createHash('sha256').update(JSON.stringify(semanticFragments)).digest('hex');
}

function compareFragments(left: VoiceTranscriptFragment, right: VoiceTranscriptFragment): number {
  const leftStart = left.startMs ?? Number.POSITIVE_INFINITY;
  const rightStart = right.startMs ?? Number.POSITIVE_INFINITY;
  if (leftStart !== rightStart) return leftStart - rightStart;

  const leftEnd = left.endMs ?? Number.POSITIVE_INFINITY;
  const rightEnd = right.endMs ?? Number.POSITIVE_INFINITY;
  if (leftEnd !== rightEnd) return leftEnd - rightEnd;
  return left.sequence - right.sequence;
}

export function fragmentIdForProviderEvent(
  eventId: string,
  payload: Readonly<Record<string, unknown>>,
): string {
  const candidate = firstString(payload, ['item_id', 'transcript_id', 'id']);
  return candidate ?? eventId;
}

export function firstString(
  payload: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return undefined;
}

export function transcriptRoleForEvent(type: string): VoiceTranscriptRole | undefined {
  if (type.startsWith('session.input_transcript.')) return 'user';
  if (type.startsWith('session.output_transcript.')) return 'assistant';
  return undefined;
}
