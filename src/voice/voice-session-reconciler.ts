/**
 * Startup reconciliation for durable browservoice state.
 *
 * Reconciliation never replays provider work. A claimed/running delegation
 * whose final result is not durable becomes explicitly unknown; an unclaimed
 * delegation belonging to a terminal session is skipped transactionally.
 */

import { err, ok } from '../core/types/result.js';
import { applyVoiceCost } from './voice-session-service.js';
import type {
  VoiceBackendResult,
  VoiceResult,
  VoiceSessionReadProjection,
  VoiceStore,
} from './voice-types.js';

export interface VoiceReconciliationReport {
  readonly sessions: number;
  readonly unknownDelegations: readonly string[];
  readonly skippedDelegations: readonly string[];
  readonly preservedFinalResults: readonly string[];
}

export interface VoiceSessionReconcilerOptions {
  readonly now?: () => number;
  readonly usdPerMinute?: number;
}

export class VoiceSessionReconciler {
  private readonly now: () => number;
  private readonly usdPerMinute: number | undefined;

  constructor(
    private readonly store: VoiceStore,
    options: VoiceSessionReconcilerOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.usdPerMinute = options.usdPerMinute;
  }

  reconcile(): VoiceResult<VoiceReconciliationReport> {
    const sessions = this.store.listSessions({});
    if (sessions.isErr()) return err(sessions.error);
    const unknownDelegations: string[] = [];
    const skippedDelegations: string[] = [];
    const preservedFinalResults: string[] = [];

    for (const projection of sessions.value) {
      const result = this.reconcileSession(
        projection,
        unknownDelegations,
        skippedDelegations,
        preservedFinalResults,
      );
      if (result.isErr()) return err(result.error);
    }

    return ok({
      sessions: sessions.value.length,
      unknownDelegations,
      skippedDelegations,
      preservedFinalResults,
    });
  }

  private reconcileSession(
    projection: VoiceSessionReadProjection,
    unknownDelegations: string[],
    skippedDelegations: string[],
    preservedFinalResults: string[],
  ): VoiceResult<void> {
    const terminalSession =
      projection.session.status === 'closed' ||
      projection.session.status === 'expired' ||
      projection.session.status === 'failed';
    const restartClosesSession = !terminalSession;
    const skipReason = projection.session.status === 'expired' ? 'deadline' : 'shutdown';

    for (const delegation of projection.delegations) {
      const hasFinal = projection.outputs.some(
        (output) =>
          output.delegationId === delegation.id &&
          output.kind === 'final' &&
          output.lifecycle.execution === 'succeeded',
      );
      if (hasFinal) {
        preservedFinalResults.push(delegation.id);
        continue;
      }

      if (
        delegation.status === 'claimed' ||
        delegation.status === 'running' ||
        delegation.execution === 'running'
      ) {
        const unknown = unknownResult(delegation.id, this.now());
        const saved = this.store.recordBackendResult(unknown);
        if (saved.isErr()) return err(saved.error);
        unknownDelegations.push(delegation.id);
        continue;
      }

      if (
        (terminalSession || restartClosesSession) &&
        (delegation.status === 'admitted' || delegation.status === 'queued')
      ) {
        const skipped = this.store.skipDelegation({
          delegationId: delegation.id,
          expectedRevision: delegation.revision,
          reason: skipReason,
          skippedAt: this.now(),
        });
        if (skipped.isErr()) return err(skipped.error);
        skippedDelegations.push(delegation.id);
      }
    }

    const finalization = terminalSession
      ? projection.session.finalization.status === 'pending'
        ? { status: 'incomplete' as const }
        : projection.session.finalization
      : { status: 'incomplete' as const, providerReason: 'daemon_restart' };
    const usage = applyVoiceCost(
      projection.session.usage,
      this.usdPerMinute,
      finalization.status,
      true,
    );
    const usageChanged = JSON.stringify(usage) !== JSON.stringify(projection.session.usage);
    const finalizationChanged =
      JSON.stringify(finalization) !== JSON.stringify(projection.session.finalization);

    // A daemon restart cannot recreate the browser/provider transport. Close
    // any leftover non-terminal session after its work has been classified so
    // a pending queue row cannot become an orphaned execution.
    if (!terminalSession || usageChanged || finalizationChanged) {
      const closed = this.store.updateSession({
        sessionId: projection.session.id,
        expectedRevision: projection.session.revision,
        patch: {
          ...(terminalSession ? {} : { status: 'expired' as const, closedAt: this.now() }),
          usage,
          finalization,
          ...(terminalSession ? {} : { activeDelegationId: undefined }),
        },
        updatedAt: this.now(),
      });
      if (closed.isErr()) return err(closed.error);
    }
    return ok(undefined);
  }
}

function unknownResult(delegationId: string, occurredAt: number): VoiceBackendResult {
  return {
    delegationId,
    outputId: `voice-recovery:${delegationId}`,
    kind: 'unknown',
    execution: 'unknown',
    output: {
      execution: 'unknown',
      delivery: 'unknown',
      providerAcknowledgement: 'unknown',
      playback: 'unknown',
    },
    errorCode: 'VOICE_EXECUTION_UNKNOWN',
    occurredAt,
  };
}

export function reconcileVoiceSessions(
  store: VoiceStore,
  options: VoiceSessionReconcilerOptions = {},
): VoiceResult<VoiceReconciliationReport> {
  return new VoiceSessionReconciler(store, options).reconcile();
}

export { VoiceSessionReconciler as DurableVoiceSessionReconciler };
