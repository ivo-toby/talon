/**
 * Server-owned policy for browser voice execution.
 *
 * A browser request can open transport only.  Provider, persona, capability,
 * and MCP choices are captured here and must be identical at the queue and
 * provider boundaries.
 */

import { err, ok } from '../core/types/result.js';
import { PolicyError } from '../core/errors/index.js';
import type {
  VoiceEligibilityReason,
  VoiceExecutionEligibility,
  VoiceOwnerContext,
  VoicePolicyEvaluator,
  VoicePolicySnapshot,
  VoicePolicySnapshotInput,
  VoiceResult,
  VoiceSessionRecord,
} from './voice-types.js';

export interface VoicePolicyOptions {
  readonly now?: () => number;
  /** Provider key to implementation type. Missing entries are denied. */
  readonly providerTypes?: ReadonlyMap<string, string>;
  /** MCP servers that have been explicitly proven for the voice path. */
  readonly provenMcpServers?: ReadonlySet<string>;
}

const INTERNAL_MCP_PREFIX = '__talond_';

/** Native tools that remain available when a provider has no OAuth MCP restriction. */
export const VOICE_NATIVE_TOOL_NAMES: Readonly<Record<string, readonly string[]>> = {
  'claude-code': ['WebSearch', 'WebFetch'],
  'gemini-cli': ['google_web_search', 'web_fetch'],
  'openai-compatible': [],
  'codex-cli': [],
};

export function getVoiceNativeToolNames(
  providerType: string,
  nativeToolsDisabled: boolean,
): readonly string[] {
  return nativeToolsDisabled ? [] : (VOICE_NATIVE_TOOL_NAMES[providerType] ?? []);
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function sameArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function samePolicy(left: VoicePolicySnapshot, right: VoicePolicySnapshot): boolean {
  return (
    left.generation === right.generation &&
    left.ownerId === right.ownerId &&
    left.personaId === right.personaId &&
    left.providerName === right.providerName &&
    left.modelName === right.modelName &&
    left.voiceName === right.voiceName &&
    sameArray(left.capabilityNames, right.capabilityNames) &&
    sameArray(left.allowedToolNames, right.allowedToolNames) &&
    sameArray(left.allowedMcpServerNames, right.allowedMcpServerNames) &&
    sameArray(left.nativeToolNames, right.nativeToolNames) &&
    left.requireApproval === right.requireApproval &&
    left.loginRevision === right.loginRevision
  );
}

function ineligible(
  reason: VoiceEligibilityReason,
  admitted: VoicePolicySnapshot,
  current: VoicePolicySnapshot,
  now: number,
): VoiceResult<VoiceExecutionEligibility> {
  return ok({
    eligible: false,
    reason,
    admissionPolicy: admitted,
    executionPolicy: current,
    checkedAt: now,
  });
}

/** Default-deny policy evaluator used by the lifecycle composition. */
export class VoicePolicy implements VoicePolicyEvaluator {
  private readonly now: () => number;
  private readonly providerTypes: ReadonlyMap<string, string>;
  private readonly provenMcpServers: ReadonlySet<string>;

  constructor(options: VoicePolicyOptions = {}) {
    this.now = options.now ?? Date.now;
    this.providerTypes = options.providerTypes ?? new Map();
    this.provenMcpServers = options.provenMcpServers ?? new Set();
  }

  capture(input: VoicePolicySnapshotInput): VoiceResult<VoicePolicySnapshot> {
    const generation = input.generation;
    if (!Number.isSafeInteger(generation) || generation < 0) {
      return err(new PolicyError('Voice policy generation must be a non-negative safe integer'));
    }
    if (input.ownerId.trim().length === 0 || input.personaId.trim().length === 0) {
      return err(new PolicyError('Voice policy owner and persona are required'));
    }
    if (input.providerName.trim().length === 0 || input.modelName.trim().length === 0) {
      return err(new PolicyError('Voice policy provider and model are required'));
    }
    if (input.voiceName.trim().length === 0) {
      return err(new PolicyError('Voice policy output voice is required'));
    }
    if (!Number.isSafeInteger(input.loginRevision) || input.loginRevision <= 0) {
      return err(new PolicyError('Voice policy login revision must be positive'));
    }
    if (input.allowedMcpServerNames.some((name) => name.startsWith(INTERNAL_MCP_PREFIX))) {
      return err(new PolicyError('Voice execution cannot use internal MCP servers'));
    }
    if (input.allowedMcpServerNames.some((name) => !this.provenMcpServers.has(name))) {
      return err(new PolicyError('Voice MCP access is not proven for the configured server'));
    }
    if (!this.providerTypes.has(input.providerName)) {
      return err(new PolicyError('Voice backend provider is not configured'));
    }

    return ok({
      generation,
      ownerId: input.ownerId,
      personaId: input.personaId,
      providerName: input.providerName,
      modelName: input.modelName,
      voiceName: input.voiceName,
      capabilityNames: uniqueSorted(input.capabilityNames),
      allowedToolNames: uniqueSorted(input.allowedToolNames),
      allowedMcpServerNames: uniqueSorted(input.allowedMcpServerNames),
      nativeToolNames: uniqueSorted(input.nativeToolNames),
      requireApproval: input.requireApproval,
      loginRevision: input.loginRevision,
      capturedAt: input.capturedAt ?? this.now(),
    });
  }

  checkExecution(input: {
    readonly session: VoiceSessionRecord;
    readonly admitted: VoicePolicySnapshot;
    readonly current: VoicePolicySnapshot;
    readonly now: number;
  }): VoiceResult<VoiceExecutionEligibility> {
    const { session, admitted, current, now } = input;
    if (session.status === 'closed' || session.status === 'closing' || session.status === 'failed') {
      return ineligible('session_closed', admitted, current, now);
    }
    if (session.status === 'expired' || session.deadlineAt <= now) {
      return ineligible('session_expired', admitted, current, now);
    }
    if (session.owner.ownerId !== current.ownerId || session.owner.ownerId !== admitted.ownerId) {
      return ineligible('owner_mismatch', admitted, current, now);
    }
    if (session.owner.loginRevision !== current.loginRevision || admitted.loginRevision !== current.loginRevision) {
      return ineligible('login_revoked', admitted, current, now);
    }
    if (session.personaId !== admitted.personaId || session.personaId !== current.personaId) {
      return ineligible('persona_disabled', admitted, current, now);
    }
    if (!this.providerTypes.has(current.providerName)) {
      return ineligible('provider_disabled', admitted, current, now);
    }
    if (current.allowedMcpServerNames.some((name) => !this.provenMcpServers.has(name))) {
      return ineligible('mcp_access_not_proven', admitted, current, now);
    }
    if (!samePolicy(admitted, current)) {
      return ineligible('policy_changed', admitted, current, now);
    }
    return ok({
      eligible: true,
      admissionPolicy: admitted,
      executionPolicy: current,
      checkedAt: now,
    });
  }

  /** Small helper used by the bridge execution hook. */
  checkOwner(session: VoiceSessionRecord, owner: VoiceOwnerContext): VoiceResult<void> {
    if (session.owner.ownerId !== owner.ownerId || session.owner.loginRevision !== owner.loginRevision) {
      return err(new PolicyError('Voice session owner is no longer active'));
    }
    return ok(undefined);
  }
}

export { VoicePolicy as DurableVoicePolicy };
