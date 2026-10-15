import type { SignalIgnoreReason } from './signal-inbound-policy.js';

export interface SignalClock {
  now(): number;
  setTimer(callback: () => void, delayMs: number): () => void;
}

export const signalSystemClock: SignalClock = {
  now: () => Date.now(),
  setTimer: (callback, delayMs) => {
    const timer = setTimeout(callback, delayMs);
    timer.unref();
    return () => clearTimeout(timer);
  },
};

export type SignalBufferReason =
  | 'ALIAS_OVERFLOW'
  | 'ALIAS_EXPIRED'
  | 'PROOF_OVERFLOW'
  | 'PROOF_EXPIRED'
  | 'RECEIPT_OVERFLOW'
  | 'RECEIPT_EXPIRED'
  | 'RECEIPT_FAILED';
export type SignalDiagnosticReason = SignalIgnoreReason | SignalBufferReason;
export interface SignalDiagnosticPayload {
  readonly channelName: string;
  readonly counts: Readonly<Partial<Record<SignalDiagnosticReason, number>>>;
}
export interface SignalDiagnosticSink {
  debug(payload: SignalDiagnosticPayload, message: string): void;
  warn(payload: SignalDiagnosticPayload, message: string): void;
}

const reasons: readonly SignalDiagnosticReason[] = [
  'INVALID_EVENT',
  'RECEIVE_EXCEPTION',
  'CONTROL',
  'EPHEMERAL',
  'EMPTY_TEXT',
  'STALE_SUBSCRIPTION',
  'UNSELECTED',
  'UNAUTHORIZED',
  'BOT_OUTPUT',
  'UNKNOWN_DEVICE',
  'UNVERIFIED_DEVICE',
  'DEVICE_REPLAY',
  'UNKNOWN_ALIAS',
  'ALIAS_OVERFLOW',
  'ALIAS_EXPIRED',
  'PROOF_OVERFLOW',
  'PROOF_EXPIRED',
  'RECEIPT_OVERFLOW',
  'RECEIPT_EXPIRED',
  'RECEIPT_FAILED',
];

/** Deliberately no raw value, error, identifier, or arbitrary schema-path parameter. */
export class SignalDiagnostics {
  private counts: Partial<Record<SignalDiagnosticReason, number>> = {};
  private episodes: ReadonlySet<SignalBufferReason> = new Set();
  private cancelTimer?: () => void;
  private stopped = false;

  constructor(
    private readonly channelName: string,
    private readonly sink: SignalDiagnosticSink,
    private readonly clock: SignalClock = signalSystemClock,
  ) {}

  count(reason: SignalDiagnosticReason): void {
    if (this.stopped || !reasons.includes(reason)) return;
    this.counts = { ...this.counts, [reason]: (this.counts[reason] ?? 0) + 1 };
    this.cancelTimer ??= this.clock.setTimer(() => {
      this.cancelTimer = undefined;
      const counts = Object.freeze(this.counts);
      this.counts = {};
      this.sink.debug({ channelName: this.channelName, counts }, 'Signal ignored input counts');
    }, 60_000);
  }

  episode(reason: SignalBufferReason): void {
    if (this.stopped || !reasons.includes(reason)) return;
    this.count(reason);
    if (this.episodes.has(reason)) return;
    this.episodes = new Set([...this.episodes, reason]);
    this.sink.warn(
      { channelName: this.channelName, counts: Object.freeze({ [reason]: 1 }) },
      'Signal input loss before acceptance; resend expired commands after recovery',
    );
  }

  recovered(reason: SignalBufferReason): void {
    this.episodes = new Set([...this.episodes].filter((entry) => entry !== reason));
  }

  stop(): void {
    this.stopped = true;
    this.cancelTimer?.();
    this.cancelTimer = undefined;
    this.counts = {};
    this.episodes = new Set();
  }
}
