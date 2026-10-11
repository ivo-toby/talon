import { describe, expect, it } from 'vitest';

import { VoicePolicy } from '../../../../src/voice/voice-policy.js';
import type { VoicePolicySnapshot, VoiceSessionRecord } from '../../../../src/voice/voice-types.js';

const baseInput = {
  generation: 1,
  ownerId: 'owner-1',
  personaId: 'persona-1',
  providerName: 'agent-provider',
  modelName: 'voice-model',
  voiceName: 'marin',
  capabilityNames: [],
  allowedToolNames: [],
  allowedMcpServerNames: [],
  nativeToolNames: [],
  requireApproval: false,
  loginRevision: 1,
} as const;

function session(policy: VoicePolicySnapshot): VoiceSessionRecord {
  return {
    id: 'session-1',
    revision: 1,
    owner: { ownerId: policy.ownerId, loginRevision: policy.loginRevision },
    personaId: policy.personaId,
    threadId: 'thread-1',
    transport: 'webrtc',
    status: 'connected',
    createdAt: 1,
    startedAt: 2,
    deadlineAt: 10_000,
    policy,
    usage: { voiceCostStatus: 'unavailable', backendCostStatus: 'unavailable' },
    finalization: { status: 'pending' },
  };
}

describe('VoicePolicy', () => {
  it('denies unsupported provider, approval, native tools, and unproven MCP at capture', () => {
    const policy = new VoicePolicy({
      providerTypes: new Map([['agent-provider', 'openai-compatible'], ['claude', 'claude-code']]),
      provenMcpServers: new Set(['proven']),
    });
    expect(policy.capture({ ...baseInput, providerName: 'claude' }).isErr()).toBe(true);
    expect(policy.capture({ ...baseInput, requireApproval: true }).isErr()).toBe(true);
    expect(policy.capture({ ...baseInput, nativeToolNames: ['WebSearch'] }).isErr()).toBe(true);
    expect(policy.capture({ ...baseInput, allowedMcpServerNames: ['unknown'] }).isErr()).toBe(true);
  });

  it('rejects policy drift and terminal sessions at the execution boundary', () => {
    const policy = new VoicePolicy({
      providerTypes: new Map([['agent-provider', 'openai-compatible']]),
    });
    const admitted = policy.capture(baseInput)._unsafeUnwrap();
    const changed = policy.capture({ ...baseInput, generation: 2 })._unsafeUnwrap();
    const drift = policy.checkExecution({
      session: session(admitted),
      admitted,
      current: changed,
      now: 3,
    });
    expect(drift.isOk()).toBe(true);
    expect(drift._unsafeUnwrap().reason).toBe('policy_changed');

    const closed = policy.checkExecution({
      session: { ...session(admitted), status: 'closed' },
      admitted,
      current: admitted,
      now: 3,
    });
    expect(closed._unsafeUnwrap().reason).toBe('session_closed');

    const personaChanged = policy.checkExecution({
      session: session(admitted),
      admitted,
      current: { ...admitted, personaId: 'persona-2' },
      now: 3,
    });
    expect(personaChanged._unsafeUnwrap().reason).toBe('persona_disabled');
  });
});
