import { afterEach, describe, expect, it, vi } from 'vitest';
import { ok } from '../../../../../src/core/types/result.js';
import { createTestDb } from '../../../../../tests/unit/core/database/repositories/helpers.js';
import { VoiceSipRepository } from '../../../../../src/core/database/repositories/voice-sip-repository.js';
import type {
  SipAuthorizationResolver,
  SipVerifiedAuthorization,
} from '../../../../../src/voice/transports/sip/sip-authorization.js';
import {
  SIP_DEFERRED_DECISION_BUDGET_MS,
  SipIngressService,
  type IncomingSipEvent,
} from '../../../../../src/voice/transports/sip/sip-ingress-service.js';

const NOW_MS = 1_000_000;
const NOW_SECONDS = NOW_MS / 1_000;

function event(sessionId: string, assertion = 'proof') : IncomingSipEvent {
  return {
    id: `event-${sessionId}`,
    createdAt: NOW_SECONDS,
    type: 'live.transport.incoming',
    data: {
      type: 'sip',
      sessionId,
      sipHeaders: [
        { name: 'From', value: 'sip:attacker@example.test' },
        { name: 'X-Talon-Voice-Assertion', value: assertion },
      ],
    },
  };
}

function authorization(providerSessionId: string): SipVerifiedAuthorization {
  return {
    version: 1,
    algorithm: 'Ed25519',
    issuer: 'operator-issuer',
    keyId: 'primary',
    audience: 'talon-incoming',
    subject: 'endpoint-1',
    nonce: `nonce-${providerSessionId}-012345`,
    callBinding: `binding-${providerSessionId}`,
    issuedAt: NOW_SECONDS - 5,
    expiresAt: NOW_SECONDS + 55,
    proofHash: `${providerSessionId}`.padEnd(64, '0'),
    principal: { ownerId: 'owner-1', personaId: 'persona-1' },
  };
}

function resolver(): SipAuthorizationResolver {
  return {
    resolve: vi.fn(({ providerSessionId }) => ok(authorization(providerSessionId))),
  };
}

function delivery(sessionId: string, suffix = '') {
  return { deliveryId: `delivery-${sessionId}${suffix}`, deliveredAt: NOW_SECONDS };
}

describe('SipIngressService', () => {
  let db: ReturnType<typeof createTestDb> | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
    vi.useRealTimers();
  });

  it('requires a separate caller assertion and durably deduplicates delivery/session retries', async () => {
    db = createTestDb();
    const repository = new VoiceSipRepository(db);
    const acceptCall = vi.fn().mockResolvedValue({ outcome: 'accepted' as const });
    const authorizationResolver = resolver();
    let currentNowMs = NOW_MS;
    const service = new SipIngressService({
      repository,
      authorization: authorizationResolver,
      now: () => currentNowMs,
      acceptCall,
    });

    const first = await service.ingest(event('session-1'), delivery('session-1'));
    expect(first.isOk()).toBe(true);
    expect(first._unsafeUnwrap()).toMatchObject({ outcome: 'accepted', externalAttempted: true });
    expect(acceptCall).toHaveBeenCalledOnce();

    const duplicateDelivery = await service.ingest(event('session-1'), delivery('session-1', '-retry'));
    expect(duplicateDelivery._unsafeUnwrap()).toMatchObject({ outcome: 'duplicate', duplicate: true });
    expect(acceptCall).toHaveBeenCalledOnce();
    const duplicateEvent = await service.ingest(event('session-1'), delivery('session-1'));
    expect(duplicateEvent._unsafeUnwrap()).toMatchObject({ outcome: 'duplicate', duplicate: true });
    expect(acceptCall).toHaveBeenCalledOnce();

    currentNowMs += 61_000;
    const lateRetry = await service.ingest(
      {
        ...event('session-1'),
        createdAt: NOW_SECONDS - 61,
        data: {
          ...event('session-1').data,
          sipHeaders: [{ name: 'From', value: 'sip:retry@example.test' }],
        },
      },
      { deliveryId: 'delivery-session-1-late-retry', deliveredAt: currentNowMs / 1_000 },
    );
    expect(lateRetry._unsafeUnwrap()).toMatchObject({ outcome: 'duplicate', duplicate: true });
    expect(authorizationResolver.resolve).toHaveBeenCalledOnce();
    expect(acceptCall).toHaveBeenCalledOnce();

    const counts = repository.counts()._unsafeUnwrap();
    expect(counts).toEqual({ decisions: 1, receipts: 1, grants: 1 });
    expect(repository.findByProviderSessionId('session-1')._unsafeUnwrap()?.grant.owner_id).toBe('owner-1');
    expect(service.revokeAllAuthority()._unsafeUnwrap()).toBe(1);
    expect(repository.findByProviderSessionId('session-1')._unsafeUnwrap()?.grant.revoked_at).toBe(currentNowMs);
  });

  it('ignores caller identity headers, rejects duplicate assertions, and enforces immutable event freshness', async () => {
    db = createTestDb();
    const repository = new VoiceSipRepository(db);
    const acceptCall = vi.fn().mockResolvedValue({ outcome: 'accepted' as const });
    const service = new SipIngressService({ repository, authorization: resolver(), now: () => NOW_MS, acceptCall });

    const forgedHeaderOnly = await service.ingest(
      { ...event('session-forged'), data: { ...event('session-forged').data, sipHeaders: [{ name: 'From', value: 'owner-1' }] } },
      delivery('session-forged'),
    );
    expect(forgedHeaderOnly._unsafeUnwrap()).toMatchObject({ outcome: 'rejected', reason: 'authority_denied' });

    const duplicateAssertion = await service.ingest(
      { ...event('session-duplicate'), data: { ...event('session-duplicate').data, sipHeaders: [
        { name: 'X-Talon-Voice-Assertion', value: 'one' },
        { name: 'x-talon-voice-assertion', value: 'two' },
      ] } },
      delivery('session-duplicate'),
    );
    expect(duplicateAssertion._unsafeUnwrap()).toMatchObject({ outcome: 'rejected', reason: 'authority_denied' });

    const stale = await service.ingest(
      { ...event('session-stale'), createdAt: NOW_SECONDS - 61 },
      delivery('session-stale', '-fresh-delivery'),
    );
    expect(stale._unsafeUnwrap()).toMatchObject({ outcome: 'rejected', reason: 'stale_event' });
    expect(acceptCall).not.toHaveBeenCalled();
  });

  it('rechecks grant freshness after a delayed reservation before accepting', async () => {
    db = createTestDb();
    const repository = new VoiceSipRepository(db);
    const acceptCall = vi.fn().mockResolvedValue({ outcome: 'accepted' as const });
    let currentNowMs = NOW_MS;
    const reserve = repository.reserve.bind(repository);
    vi.spyOn(repository, 'reserve').mockImplementation((input) => {
      const result = reserve(input);
      currentNowMs = NOW_MS + 56_000;
      return result;
    });
    const service = new SipIngressService({
      repository,
      authorization: resolver(),
      now: () => currentNowMs,
      acceptCall,
    });

    const result = await service.ingest(event('session-delayed'), delivery('session-delayed'));

    expect(result._unsafeUnwrap()).toMatchObject({
      outcome: 'rejected',
      reason: 'authority_denied',
      externalAttempted: false,
    });
    expect(acceptCall).not.toHaveBeenCalled();
    expect(repository.findByProviderSessionId('session-delayed')._unsafeUnwrap()?.decision.state).toBe(
      'reserved',
    );
  });

  it('classifies timeout and restart interruption as unknown without retrying acceptance', async () => {
    vi.useFakeTimers();
    db = createTestDb();
    const repository = new VoiceSipRepository(db);
    const acceptCall = vi.fn().mockReturnValue(new Promise(() => undefined));
    const service = new SipIngressService({ repository, authorization: resolver(), now: () => NOW_MS, acceptCall });
    const pending = service.ingest(event('session-timeout'), delivery('session-timeout'));
    await vi.advanceTimersByTimeAsync(SIP_DEFERRED_DECISION_BUDGET_MS);
    const timedOut = await pending;
    expect(timedOut._unsafeUnwrap()).toMatchObject({ outcome: 'unknown', externalAttempted: true });
    expect(repository.findByCallId(timedOut._unsafeUnwrap().callId!)._unsafeUnwrap()?.decision.state).toBe('unknown');

    const secondRepo = new VoiceSipRepository(db);
    const secondService = new SipIngressService({ repository: secondRepo, authorization: resolver(), now: () => NOW_MS });
    const reserved = await secondService.ingest(event('session-restart'), delivery('session-restart'));
    const callId = reserved._unsafeUnwrap().callId!;
    expect(secondRepo.markAttempt(callId, NOW_MS).isOk()).toBe(true);
    expect(secondService.reconcileInterruptedAttempts()._unsafeUnwrap()).toBe(1);
    expect(secondRepo.findByCallId(callId)._unsafeUnwrap()?.decision.state).toBe('unknown');
  });

  it('caps pending receipt work at 32 and releases capacity after terminal decisions', async () => {
    db = createTestDb();
    const repository = new VoiceSipRepository(db);
    const releases: Array<() => void> = [];
    const acceptCall = vi.fn().mockImplementation(
      () => new Promise<{ outcome: 'accepted' }>((resolve) => releases.push(() => resolve({ outcome: 'accepted' }))),
    );
    const service = new SipIngressService({ repository, authorization: resolver(), now: () => NOW_MS, acceptCall });
    const pending = Array.from({ length: 32 }, (_, index) =>
      service.ingest(event(`pending-${index}`), delivery(`pending-${index}`)),
    );
    await Promise.resolve();
    expect(acceptCall).toHaveBeenCalledTimes(32);
    const saturated = await service.ingest(event('pending-32'), delivery('pending-32'));
    expect(saturated._unsafeUnwrap()).toMatchObject({ outcome: 'rejected', reason: 'capacity' });
    releases.forEach((release) => release());
    const outcomes = await Promise.all(pending);
    expect(outcomes.every((result) => result._unsafeUnwrap().outcome === 'accepted')).toBe(true);
    const admittedAfterReleasePromise = service.ingest(event('after-release'), delivery('after-release'));
    await Promise.resolve();
    releases.at(-1)?.();
    const admittedAfterRelease = await admittedAfterReleasePromise;
    expect(admittedAfterRelease._unsafeUnwrap().outcome).toBe('accepted');
  });
});
