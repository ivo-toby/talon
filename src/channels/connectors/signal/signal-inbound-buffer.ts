import { ChannelError } from '../../../core/errors/error-types.js';
import { err, ok, type Result } from '../../../core/types/result.js';
import type { InboundReceiptHandler } from '../../channel-types.js';
import {
  evaluateSignalCandidate,
  normalizeSignalReceive,
  type SignalAdmission,
  type SignalInboundContext,
  SignalInboundError,
  type SignalTextCandidate,
} from './signal-inbound-policy.js';
import {
  type SignalClock,
  SignalDiagnostics,
  signalSystemClock,
  type SignalBufferReason,
} from './signal-diagnostics.js';
import type { SignalInboundEvent } from './signal-types.js';
import type { SignalDeviceRegistry } from './signal-device-registry.js';

export class SignalInboundBufferError extends ChannelError {
  constructor(
    readonly reason: 'STOPPED' | 'ALIAS_OVERFLOW' | 'PROOF_OVERFLOW' | 'RECEIPT_OVERFLOW',
  ) {
    super(`Signal input buffer unavailable: ${reason}`);
  }
}
export interface SignalInboundDependencies {
  readonly context: () => SignalInboundContext;
  readonly devices: SignalDeviceRegistry;
  readonly receipt: InboundReceiptHandler;
  readonly refreshAliases: () => Promise<Result<void, ChannelError>>;
  /** Notify the generation-wide account owner; its persisted scheduler alone starts listDevices. */
  readonly refreshDevices: (accountUuid: string) => void;
  /** Receipt overflow must close the current socket/subscription, without clearing retained FIFO. */
  readonly reconnect: () => void;
  readonly diagnostics: SignalDiagnostics;
  readonly clock?: SignalClock;
  readonly random?: () => number;
}
export interface SignalBufferStatus {
  readonly alias: { readonly held: number; readonly bytes: number; readonly dropped: number };
  readonly proof: { readonly held: number; readonly bytes: number; readonly dropped: number };
  readonly receipt: { readonly held: number; readonly bytes: number; readonly dropped: number };
}
interface HeldEntry {
  readonly candidate: SignalTextCandidate;
  readonly bytes: number;
  readonly deadline: number;
}
interface ReceiptEntry extends HeldEntry {
  readonly event: SignalInboundEvent;
  readonly due: number;
  readonly attempts: number;
  readonly waitingForProof: boolean;
}
type BufferKind = 'alias' | 'proof' | 'receipt';
type ReceiveResult = Result<'queued' | 'held', SignalInboundError | SignalInboundBufferError>;
const MAX_ENTRIES = 64;
const MAX_BYTES = 1_048_576;
const TTL = { alias: 30_000, proof: 600_000, receipt: 300_000 };
const overflowReason = {
  alias: 'ALIAS_OVERFLOW',
  proof: 'PROOF_OVERFLOW',
  receipt: 'RECEIPT_OVERFLOW',
} as const;
const expiryReason = {
  alias: 'ALIAS_EXPIRED',
  proof: 'PROOF_EXPIRED',
  receipt: 'RECEIPT_EXPIRED',
} as const;

/** Pre-acceptance memory only: no upstream acknowledgement or replay guarantee.
 * TASK-012 supplies lifecycle, current config/proof and the ordinary transaction receipt. */
export class SignalInboundBuffer {
  private alias: readonly HeldEntry[] = [];
  private proof: readonly HeldEntry[] = [];
  private receipt: readonly ReceiptEntry[] = [];
  private dropped = { alias: 0, proof: 0, receipt: 0 };
  private readonly clock: SignalClock;
  private cancelTimer?: () => void;
  private stopped = false;
  private processing = false;
  private aliasRefreshing = false;
  private lastAliasRefresh = -Infinity;
  private receiptOverflowed = false;

  constructor(private readonly dependencies: SignalInboundDependencies) {
    this.clock = dependencies.clock ?? signalSystemClock;
  }

  receive(params: unknown, connectionGeneration: number): ReceiveResult {
    if (this.stopped) return err(new SignalInboundBufferError('STOPPED'));
    const context = this.dependencies.context();
    const candidate = normalizeSignalReceive(params, connectionGeneration, context);
    if (candidate.isErr()) {
      this.dependencies.diagnostics.count(candidate.error.reason);
      return err(candidate.error);
    }
    const admission = evaluateSignalCandidate(candidate.value, context);
    if (admission.isErr()) {
      this.exclude(admission.error, candidate.value);
      return err(admission.error);
    }
    return this.retain(admission.value);
  }

  /** Call after atomic proof publication, account-alias renewal, or config replacement. */
  revalidate(): void {
    if (this.stopped) return;
    const head = this.receipt[0];
    if (head?.waitingForProof && !this.processing)
      this.receipt = [{ ...head, due: this.clock.now() }, ...this.receipt.slice(1)];
    this.schedule(true);
  }

  status(): SignalBufferStatus {
    const state = (kind: BufferKind): SignalBufferStatus['alias'] =>
      Object.freeze({
        held: this[kind].length,
        bytes: this.bytes(kind),
        dropped: this.dropped[kind],
      });
    return Object.freeze({
      alias: state('alias'),
      proof: state('proof'),
      receipt: state('receipt'),
    });
  }

  stop(): void {
    this.stopped = true;
    this.cancelTimer?.();
    this.cancelTimer = undefined;
    this.dropped = {
      alias: this.dropped.alias + this.alias.length,
      proof: this.dropped.proof + this.proof.length,
      receipt: this.dropped.receipt + this.receipt.length,
    };
    this.alias = [];
    this.proof = [];
    this.receipt = [];
  }

  private bytes(kind: BufferKind): number {
    return this[kind].reduce((total, entry) => total + entry.bytes, 0);
  }

  private exclude(error: SignalInboundError, candidate: SignalTextCandidate): void {
    this.dependencies.diagnostics.count(error.reason);
    if (error.reason === 'UNKNOWN_DEVICE' || error.reason === 'UNVERIFIED_DEVICE')
      this.refreshDevice(candidate);
  }

  private refreshDevice(candidate: SignalTextCandidate): void {
    this.dependencies.devices.requestRefresh(
      candidate.authorUuid,
      this.clock.now(),
      this.dependencies.refreshDevices,
    );
  }

  private retain(admission: SignalAdmission): ReceiveResult {
    const kind = admission.kind === 'admit' ? 'receipt' : admission.kind;
    const bytes = Buffer.byteLength(
      JSON.stringify(
        kind === 'receipt'
          ? { candidate: admission.candidate, event: admission.event }
          : admission.candidate,
      ),
      'utf8',
    );
    if (this[kind].length >= MAX_ENTRIES || this.bytes(kind) + bytes > MAX_BYTES) {
      this.drop(kind, overflowReason[kind]);
      if (kind === 'receipt' && !this.receiptOverflowed) {
        this.receiptOverflowed = true;
        this.dependencies.reconnect();
      }
      return err(new SignalInboundBufferError(overflowReason[kind]));
    }
    if (this[kind].length === 0) this.dependencies.diagnostics.recovered(expiryReason[kind]);
    this.dependencies.diagnostics.recovered(overflowReason[kind]);
    if (kind === 'receipt') this.receiptOverflowed = false;
    const entry: HeldEntry = {
      candidate: admission.candidate,
      bytes,
      deadline:
        kind === 'receipt'
          ? this.clock.now() + TTL.receipt
          : admission.candidate.receivedAt + TTL[kind],
    };
    if (kind === 'receipt') {
      this.receipt = [
        ...this.receipt,
        {
          ...entry,
          event: admission.event,
          due: this.clock.now(),
          attempts: 0,
          waitingForProof: false,
        },
      ];
    } else {
      this[kind] = [...this[kind], entry];
      if (kind === 'proof') this.refreshDevice(admission.candidate);
    }
    this.schedule(true);
    return ok(kind === 'receipt' ? 'queued' : 'held');
  }

  private drop(kind: BufferKind, reason?: SignalBufferReason): void {
    this.dropped = { ...this.dropped, [kind]: this.dropped[kind] + 1 };
    if (reason) this.dependencies.diagnostics.episode(reason);
  }

  private expire(): void {
    const now = this.clock.now();
    for (const kind of ['alias', 'proof'] as const) {
      this[kind] = this[kind].filter((entry) => {
        if (now < entry.deadline) return true;
        this.drop(kind, expiryReason[kind]);
        return false;
      });
    }
    this.receipt = this.receipt.filter((entry) => {
      if (now < entry.deadline) return true;
      this.drop('receipt', 'RECEIPT_EXPIRED');
      return false;
    });
  }

  private releaseHeld(kind: 'alias' | 'proof', discardUnknownAlias = false): void {
    const entries = this[kind];
    this[kind] = [];
    for (const entry of entries) {
      const admission = evaluateSignalCandidate(entry.candidate, this.dependencies.context());
      if (admission.isErr()) {
        // A reconnect may temporarily remove proof. It cannot authorize release.
        if (admission.error.reason === 'UNVERIFIED_DEVICE') this[kind] = [...this[kind], entry];
        else {
          this.exclude(admission.error, entry.candidate);
          this.drop(kind);
        }
      } else if (admission.value.kind === kind) {
        if (kind === 'alias' && discardUnknownAlias) {
          this.dependencies.diagnostics.count('UNKNOWN_ALIAS');
          this.drop(kind);
        } else this[kind] = [...this[kind], entry];
      } else if (kind === 'proof' && admission.value.kind === 'alias') {
        // Alias ownership was verified before entering this proof quarantine.
        const verified = evaluateSignalCandidate(
          { ...entry.candidate, accountAlias: entry.candidate.destination.accountUuid },
          this.dependencies.context(),
        );
        if (verified.isOk() && verified.value.kind === 'admit') this.retain(verified.value);
        else this[kind] = [...this[kind], entry];
      } else this.retain(admission.value);
    }
  }

  private async refreshAliases(): Promise<void> {
    this.aliasRefreshing = true;
    this.lastAliasRefresh = this.clock.now();
    try {
      const result = await this.dependencies.refreshAliases();
      if (!this.stopped && result.isOk()) {
        this.expire();
        this.releaseHeld('alias', true);
      }
    } catch {
      // A misbehaving dependency is treated as unavailable, never as alias evidence.
    } finally {
      this.aliasRefreshing = false;
      if (!this.stopped) this.schedule(true);
    }
  }

  private async pump(): Promise<void> {
    if (this.stopped) return;
    this.expire();
    this.releaseHeld('alias');
    this.releaseHeld('proof');
    if (
      this.alias.length &&
      !this.aliasRefreshing &&
      this.clock.now() - this.lastAliasRefresh >= 5_000
    )
      void this.refreshAliases();
    if (this.processing) {
      this.schedule();
      return;
    }
    this.processing = true;
    try {
      while (!this.stopped && this.receipt.length) {
        const head = this.receipt[0];
        if (this.clock.now() >= head.deadline) {
          this.receipt = this.receipt.slice(1);
          this.drop('receipt', 'RECEIPT_EXPIRED');
          continue;
        }
        if (head.due > this.clock.now()) break;
        // Admission already established alias ownership; number changes cannot revoke it.
        const candidate = {
          ...head.candidate,
          accountAlias: head.candidate.destination.accountUuid,
        };
        const admission = evaluateSignalCandidate(candidate, this.dependencies.context());
        if (admission.isErr() && admission.error.reason !== 'UNVERIFIED_DEVICE') {
          this.exclude(admission.error, head.candidate);
          this.receipt = this.receipt.slice(1);
          this.drop('receipt');
          continue;
        }
        if (admission.isErr() || admission.value.kind !== 'admit') {
          this.refreshDevice(head.candidate);
          this.receipt = [
            { ...head, due: this.clock.now() + 1_000, waitingForProof: true },
            ...this.receipt.slice(1),
          ];
          break;
        }
        let completed = false;
        // Deadlines still run while an asynchronous handler is unresolved. Its late result
        // cannot revive expired/stopped work, and no second handler runs concurrently.
        this.schedule();
        try {
          completed = (await this.dependencies.receipt(head.event)).isOk();
        } catch {
          // No raw rejection crosses the diagnostic boundary.
        }
        if (this.stopped) return;
        if (this.receipt[0] !== head) continue;
        if (completed) {
          this.receipt = this.receipt.slice(1);
          continue;
        }
        this.dependencies.diagnostics.count('RECEIPT_FAILED');
        const random = Math.max(0, Math.min(1, (this.dependencies.random ?? Math.random)()));
        const delay = Math.min(
          10_000,
          Math.max(250, 250 * 2 ** Math.min(head.attempts, 6) * (0.8 + random * 0.4)),
        );
        this.receipt = [
          {
            ...head,
            attempts: head.attempts + 1,
            due: this.clock.now() + delay,
            waitingForProof: false,
          },
          ...this.receipt.slice(1),
        ];
        break;
      }
    } finally {
      this.processing = false;
      if (!this.stopped) this.schedule();
    }
  }

  private schedule(immediate = false): void {
    this.cancelTimer?.();
    this.cancelTimer = undefined;
    if (this.stopped || (!this.alias.length && !this.proof.length && !this.receipt.length)) return;
    const now = this.clock.now();
    const deadlines = [...this.alias, ...this.proof].map((entry) => entry.deadline);
    if (this.alias.length && !this.aliasRefreshing)
      deadlines.push(Math.max(now, this.lastAliasRefresh + 5_000));
    if (this.receipt.length) {
      deadlines.push(...this.receipt.map((entry) => entry.deadline));
      if (!this.processing) deadlines.push(this.receipt[0].due);
    }
    const delay = immediate ? 0 : Math.max(1, Math.min(...deadlines) - now);
    if (!Number.isFinite(delay)) return;
    this.cancelTimer = this.clock.setTimer(() => {
      this.cancelTimer = undefined;
      void this.pump();
    }, delay);
  }
}
