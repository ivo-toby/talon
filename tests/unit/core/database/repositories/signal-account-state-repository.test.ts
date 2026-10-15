import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { err, ok } from 'neverthrow';
import {
  ChannelRepository,
  QueueRepository,
  SignalAccountStateRepository,
  SignalDestinationLeaseRepository,
  SignalStateError,
  ThreadRepository,
} from '../../../../../src/core/database/repositories/index.js';
import { runMigrations } from '../../../../../src/core/database/migrations/runner.js';
import { createDatabase } from '../../../../../src/core/database/connection.js';
import { runResultTransaction } from '../../../../../src/core/database/transaction.js';
import type { TrustedDeliveryContext } from '../../../../../src/channels/channel-types.js';

const ACCOUNT = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const OTHER_ACCOUNT = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const NOW = 1_000_000;
const CONTEXT: TrustedDeliveryContext = {
  queueItemId: 'queue-a',
  deliveryId: 'delivery-a',
  purpose: 'reply',
};
const migrations = join(import.meta.dirname, '../../../../../src/core/database/migrations');

describe('SignalAccountStateRepository', () => {
  let db: Database.Database;
  let repo: SignalAccountStateRepository;
  let directory: string;
  let filename: string;

  function open(): void {
    db = createDatabase(filename)._unsafeUnwrap();
    expect(runMigrations(db, migrations).isOk()).toBe(true);
    repo = new SignalAccountStateRepository(db);
  }

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'talon-signal-account-'));
    filename = join(directory, 'test.sqlite');
    open();
    new ChannelRepository(db)
      .insert({
        id: 'channel',
        type: 'signal',
        name: 'signal-test',
        config: '{}',
        credentials_ref: null,
        enabled: 1,
      })
      ._unsafeUnwrap();
    new ThreadRepository(db)
      .insert({
        id: 'thread',
        channel_id: 'channel',
        external_id: `signal:v1:${ACCOUNT}:self`,
        metadata: '{}',
      })
      ._unsafeUnwrap();
    new QueueRepository(db)
      .enqueue({
        id: CONTEXT.queueItemId,
        thread_id: 'thread',
        message_id: null,
        type: 'message',
        payload: '{"existing":true}',
        max_attempts: 3,
      })
      ._unsafeUnwrap();
  });

  afterEach(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  function initial() {
    return repo.getOrCreate(ACCOUNT, NOW)._unsafeUnwrap();
  }

  it('migrates durable account-keyed budgets and reservations', () => {
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'signal_account_state'",
        )
        .get(),
    ).toBeDefined();
    expect(initial()).toMatchObject({
      accountUuid: ACCOUNT,
      revision: 0,
      lastSendStart: null,
      lastDeviceCheckStart: null,
      reservation: null,
      pauseKind: 'none',
      notBefore: 0,
    });
  });

  it('normalizes account keys, never using display names or channel names', () => {
    const first = initial();
    expect(repo.getOrCreate(ACCOUNT.toUpperCase(), NOW + 1)._unsafeUnwrap()).toEqual(first);
    expect(repo.getOrCreate(OTHER_ACCOUNT, NOW)._unsafeUnwrap().accountUuid).toBe(OTHER_ACCOUNT);
    expect(repo.getOrCreate('signal-test', NOW)._unsafeUnwrapErr().reason).toBe('INVALID_INPUT');
    expect(repo.findByAccount('display name')._unsafeUnwrapErr().reason).toBe('INVALID_INPUT');
    expect(repo.findByAccount('cccccccc-cccc-cccc-cccc-cccccccccccc')._unsafeUnwrap()).toBeNull();
  });

  it('persists reservation provenance and the send-start budget through reopen', () => {
    const state = repo.reserveSend(ACCOUNT, initial().revision, CONTEXT, NOW)._unsafeUnwrap();
    expect(state.reservation).toEqual({
      queueItemId: 'queue-a',
      deliveryId: 'delivery-a',
      purpose: 'reply',
      startedAt: NOW,
    });
    db.close();
    open();
    expect(repo.findByAccount(ACCOUNT)._unsafeUnwrap()).toEqual(state);
    expect(repo.findReserved()._unsafeUnwrap()).toEqual([state]);
    expect(
      repo
        .reserveSend(
          ACCOUNT,
          state.revision,
          { ...CONTEXT, deliveryId: 'competitor' },
          NOW + 10_000,
        )
        ._unsafeUnwrapErr().reason,
    ).toBe('BUSY');
  });

  it('allows a single send start per second and never resets it on clock rewind or restart', () => {
    const reserved = repo.reserveSend(ACCOUNT, initial().revision, CONTEXT, NOW)._unsafeUnwrap();
    const cleared = repo
      .clearReservation(ACCOUNT, reserved.revision, reserved.reservation!, NOW)
      ._unsafeUnwrap();
    db.close();
    open();
    for (const time of [NOW - 100_000, NOW + 999]) {
      const failure = repo.reserveSend(ACCOUNT, cleared.revision, CONTEXT, time)._unsafeUnwrapErr();
      expect(failure).toMatchObject({ reason: 'BUDGET', nextAttemptAt: NOW + 1_000 });
      expect(repo.findByAccount(ACCOUNT)._unsafeUnwrap()).toEqual(cleared);
    }
    expect(
      repo.reserveSend(ACCOUNT, cleared.revision, CONTEXT, NOW + 1_000)._unsafeUnwrap()
        .lastSendStart,
    ).toBe(NOW + 1_000);
  });

  it('commits one device-check start per 60 seconds across repository instances, restart and time changes', () => {
    const state = repo.startDeviceCheck(ACCOUNT, initial().revision, NOW)._unsafeUnwrap();
    db.close();
    open();
    for (const time of [NOW - 1, NOW, NOW + 59_999]) {
      expect(
        new SignalAccountStateRepository(db)
          .startDeviceCheck(ACCOUNT, state.revision, time)
          ._unsafeUnwrapErr(),
      ).toMatchObject({ reason: 'BUDGET', nextAttemptAt: NOW + 60_000 });
    }
    const next = repo.startDeviceCheck(ACCOUNT, state.revision, NOW + 60_000)._unsafeUnwrap();
    expect(next.lastDeviceCheckStart).toBe(NOW + 60_000);
    expect(
      repo.startDeviceCheck(ACCOUNT, state.revision, NOW + 120_000)._unsafeUnwrapErr().reason,
    ).toBe('CONFLICT');
  });

  it('rejects a competing connection with a stale revision instead of replacing its reservation', () => {
    const state = initial();
    const competingDb = createDatabase(filename)._unsafeUnwrap();
    try {
      const competitor = new SignalAccountStateRepository(competingDb);
      expect(competitor.findByAccount(ACCOUNT)._unsafeUnwrap()).toEqual(state);
      const owner = repo.reserveSend(ACCOUNT, state.revision, CONTEXT, NOW)._unsafeUnwrap();
      expect(
        competitor
          .reserveSend(ACCOUNT, state.revision, { ...CONTEXT, deliveryId: 'competitor' }, NOW)
          ._unsafeUnwrapErr().reason,
      ).toBe('CONFLICT');
      expect(competitor.findByAccount(ACCOUNT)._unsafeUnwrap()).toEqual(owner);
    } finally {
      competingDb.close();
    }
  });

  it('rejects stale state and a wrong reservation owner without changing any budget', () => {
    const first = initial();
    const current = repo.reserveSend(ACCOUNT, first.revision, CONTEXT, NOW)._unsafeUnwrap();
    expect(repo.startDeviceCheck(ACCOUNT, first.revision, NOW)._unsafeUnwrapErr().reason).toBe(
      'CONFLICT',
    );
    for (const wrong of [
      { ...current.reservation!, deliveryId: 'other' },
      { ...current.reservation!, queueItemId: 'other' },
      { ...current.reservation!, purpose: 'explicit' as const },
      { ...current.reservation!, startedAt: NOW - 1 },
    ]) {
      expect(
        repo.clearReservation(ACCOUNT, current.revision, wrong, NOW)._unsafeUnwrapErr().reason,
      ).toBe('CONFLICT');
    }
    expect(repo.findByAccount(ACCOUNT)._unsafeUnwrap()).toEqual(current);
  });

  it('keeps later rate deadlines, a 15-minute minimum, and no downward cap', () => {
    const short = repo
      .recordPause(ACCOUNT, initial().revision, { kind: 'rate_limit', notBefore: NOW + 1 }, NOW)
      ._unsafeUnwrap();
    expect(short.notBefore).toBe(NOW + 900_000);
    const longDeadline = NOW + 90 * 24 * 60 * 60 * 1_000;
    const long = repo
      .recordPause(ACCOUNT, short.revision, { kind: 'rate_limit', notBefore: longDeadline }, NOW)
      ._unsafeUnwrap();
    const later = repo
      .recordPause(ACCOUNT, long.revision, { kind: 'rate_limit', notBefore: NOW + 10 }, NOW - 5_000)
      ._unsafeUnwrap();
    expect(later).toMatchObject({
      pauseKind: 'rate_limit',
      notBefore: longDeadline,
      updatedAt: NOW,
    });
    db.close();
    open();
    expect(repo.findByAccount(ACCOUNT)._unsafeUnwrap()).toEqual(later);
    expect(
      repo.startDeviceCheck(ACCOUNT, later.revision, NOW + 60_000)._unsafeUnwrapErr(),
    ).toMatchObject({ reason: 'PAUSED', nextAttemptAt: longDeadline });
    expect(
      repo.reserveSend(ACCOUNT, later.revision, CONTEXT, NOW + 60_000)._unsafeUnwrapErr().reason,
    ).toBe('PAUSED');
  });

  it('preserves manual challenge over rate/recovery and retains their deadlines after explicit challenge clear', () => {
    const rate = repo
      .recordPause(
        ACCOUNT,
        initial().revision,
        { kind: 'rate_limit', notBefore: NOW + 2_000_000 },
        NOW,
      )
      ._unsafeUnwrap();
    const challenge = repo
      .recordPause(ACCOUNT, rate.revision, { kind: 'challenge' }, NOW)
      ._unsafeUnwrap();
    const recovered = repo
      .recordPause(ACCOUNT, challenge.revision, { kind: 'recovery' }, NOW)
      ._unsafeUnwrap();
    const smallerRate = repo
      .recordPause(ACCOUNT, recovered.revision, { kind: 'rate_limit', notBefore: NOW }, NOW)
      ._unsafeUnwrap();
    expect(smallerRate).toMatchObject({
      pauseKind: 'challenge',
      notBefore: NOW + 2_000_000,
      recoveryNotBefore: NOW + 60_000,
    });
    db.close();
    open();
    const failure = repo
      .startDeviceCheck(ACCOUNT, smallerRate.revision, NOW + 10_000_000)
      ._unsafeUnwrapErr();
    expect(failure.reason).toBe('PAUSED');
    expect(failure.nextAttemptAt).toBeUndefined();
    const cleared = repo.clearChallenge(ACCOUNT, smallerRate.revision, NOW + 1)._unsafeUnwrap();
    expect(cleared).toMatchObject({ pauseKind: 'rate_limit', notBefore: NOW + 2_000_000 });
    expect(repo.clearChallenge(ACCOUNT, cleared.revision, NOW + 1)._unsafeUnwrapErr().reason).toBe(
      'CONFLICT',
    );
    expect(
      repo.reserveSend(ACCOUNT, cleared.revision, CONTEXT, NOW + 1)._unsafeUnwrapErr().reason,
    ).toBe('PAUSED');
    expect(repo.reserveSend(ACCOUNT, cleared.revision, CONTEXT, cleared.notBefore).isOk()).toBe(
      true,
    );
  });

  it('automatically permits a distinct delivery when a recovery fence expires without clearing it on reload', () => {
    const recovery = repo
      .recordPause(ACCOUNT, initial().revision, { kind: 'recovery' }, NOW)
      ._unsafeUnwrap();
    db.close();
    open();
    expect(repo.getOrCreate(ACCOUNT, NOW + 1)._unsafeUnwrap()).toEqual(recovery);
    expect(
      repo.reserveSend(ACCOUNT, recovery.revision, CONTEXT, NOW + 59_999)._unsafeUnwrapErr(),
    ).toMatchObject({ reason: 'PAUSED', nextAttemptAt: NOW + 60_000 });
    const fresh = { ...CONTEXT, deliveryId: 'distinct-delivery' };
    expect(
      repo.reserveSend(ACCOUNT, recovery.revision, fresh, NOW + 60_000)._unsafeUnwrap().reservation
        ?.deliveryId,
    ).toBe('distinct-delivery');
  });

  it('preserves a longer recovery fence when a manual challenge is resolved', () => {
    const challenge = repo
      .recordPause(ACCOUNT, initial().revision, { kind: 'challenge' }, NOW)
      ._unsafeUnwrap();
    const recovery = repo
      .recordPause(ACCOUNT, challenge.revision, { kind: 'recovery' }, NOW + 100)
      ._unsafeUnwrap();
    const cleared = repo.clearChallenge(ACCOUNT, recovery.revision, NOW + 101)._unsafeUnwrap();
    expect(cleared).toMatchObject({ pauseKind: 'recovery', notBefore: NOW + 60_100 });
  });

  it('keeps accounts isolated while one account is paused or has an active reservation', () => {
    const blocked = repo
      .recordPause(ACCOUNT, initial().revision, { kind: 'challenge' }, NOW)
      ._unsafeUnwrap();
    const other = repo.getOrCreate(OTHER_ACCOUNT, NOW)._unsafeUnwrap();
    expect(repo.reserveSend(OTHER_ACCOUNT, other.revision, CONTEXT, NOW).isOk()).toBe(true);
    expect(repo.findByAccount(ACCOUNT)._unsafeUnwrap()).toEqual(blocked);
  });

  it('atomically commits checkpoint, destination owner and reservation through the shared Result transaction', () => {
    const state = initial();
    const leases = new SignalDestinationLeaseRepository(db);
    const result = runResultTransaction(
      (fn) => repo.transaction(fn),
      () => {
        db.prepare(
          "UPDATE queue_items SET payload = json_set(payload, '$.checkpoint', 'in_flight') WHERE id = ?",
        ).run(CONTEXT.queueItemId);
        return leases
          .acquire(ACCOUNT, `signal:v1:${ACCOUNT}:self`, CONTEXT, NOW)
          .andThen(() => repo.reserveSend(ACCOUNT, state.revision, CONTEXT, NOW));
      },
    );
    expect(result.isOk()).toBe(true);
    expect(new QueueRepository(db).findById(CONTEXT.queueItemId)._unsafeUnwrap()?.payload).toBe(
      '{"existing":true,"checkpoint":"in_flight"}',
    );
    expect(leases.find(ACCOUNT, `signal:v1:${ACCOUNT}:self`)._unsafeUnwrap()?.deliveryId).toBe(
      CONTEXT.deliveryId,
    );
  });

  it('rolls back checkpoint and lease acquisition on an account CAS failure', () => {
    const state = initial();
    const leases = new SignalDestinationLeaseRepository(db);
    const result = runResultTransaction(
      (fn) => repo.transaction(fn),
      () => {
        db.prepare('UPDATE queue_items SET payload = \'{"checkpoint":true}\' WHERE id = ?').run(
          CONTEXT.queueItemId,
        );
        return leases
          .acquire(ACCOUNT, `signal:v1:${ACCOUNT}:self`, CONTEXT, NOW)
          .andThen(() => repo.reserveSend(ACCOUNT, state.revision + 1, CONTEXT, NOW));
      },
    );
    expect(result._unsafeUnwrapErr().reason).toBe('CONFLICT');
    expect(new QueueRepository(db).findById(CONTEXT.queueItemId)._unsafeUnwrap()?.payload).toBe(
      '{"existing":true}',
    );
    expect(leases.find(ACCOUNT, `signal:v1:${ACCOUNT}:self`)._unsafeUnwrap()).toBeNull();
    expect(repo.findByAccount(ACCOUNT)._unsafeUnwrap()).toEqual(state);
  });

  it('rolls back classified reservation and pause changes on a later checkpoint failure', () => {
    const state = repo.reserveSend(ACCOUNT, initial().revision, CONTEXT, NOW)._unsafeUnwrap();
    const failure = new SignalStateError('CONFLICT');
    const result = runResultTransaction(
      (fn) => repo.transaction(fn),
      () =>
        repo
          .recordPause(ACCOUNT, state.revision, { kind: 'recovery' }, NOW + 1)
          .andThen((paused) =>
            repo.clearReservation(ACCOUNT, paused.revision, state.reservation!, NOW + 1),
          )
          .andThen(() => err(failure)),
    );
    expect(result._unsafeUnwrapErr()).toBe(failure);
    expect(repo.findByAccount(ACCOUNT)._unsafeUnwrap()).toEqual(state);
  });

  it('returns sanitized DB failure and rolls back both writes if the final revision update fails', () => {
    const state = initial();
    db.exec(`CREATE TRIGGER fail_signal_revision BEFORE UPDATE OF revision ON signal_account_state
      BEGIN SELECT RAISE(ABORT, 'secret text and private identifier'); END`);
    const failure = repo.reserveSend(ACCOUNT, state.revision, CONTEXT, NOW)._unsafeUnwrapErr();
    expect(failure).toBeInstanceOf(SignalStateError);
    expect(failure.reason).toBe('DATABASE');
    expect(failure.message).not.toMatch(/secret|private|queue-a/);
    expect(failure.cause).toBeUndefined();
    expect(repo.findByAccount(ACCOUNT)._unsafeUnwrap()).toEqual(state);
  });

  it('retains potentially written reservation on purge but never reserves a missing queue row', () => {
    const state = repo.reserveSend(ACCOUNT, initial().revision, CONTEXT, NOW)._unsafeUnwrap();
    db.prepare('DELETE FROM queue_items WHERE id = ?').run(CONTEXT.queueItemId);
    expect(repo.findReserved()._unsafeUnwrap()).toEqual([state]);
    const classified = runResultTransaction(
      (fn) => repo.transaction(fn),
      () =>
        repo
          .recordPause(ACCOUNT, state.revision, { kind: 'recovery' }, NOW)
          .andThen((paused) =>
            repo.clearReservation(ACCOUNT, paused.revision, state.reservation!, NOW),
          ),
    )._unsafeUnwrap();
    expect(classified.reservation).toBeNull();
    expect(
      repo.reserveSend(ACCOUNT, classified.revision, CONTEXT, NOW + 60_000)._unsafeUnwrapErr()
        .reason,
    ).toBe('NOT_FOUND');
    expect(new QueueRepository(db).findById(CONTEXT.queueItemId)._unsafeUnwrap()).toBeNull();
  });

  it('refuses invalid timestamps, overflowing deadlines, empty identities and missing accounts without writes', () => {
    const state = initial();
    for (const time of [-1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(repo.startDeviceCheck(ACCOUNT, state.revision, time)._unsafeUnwrapErr().reason).toBe(
        'INVALID_INPUT',
      );
    }
    expect(
      repo
        .recordPause(ACCOUNT, state.revision, { kind: 'rate_limit', notBefore: Infinity }, NOW)
        ._unsafeUnwrapErr().reason,
    ).toBe('INVALID_INPUT');
    expect(
      repo
        .recordPause(ACCOUNT, state.revision, { kind: 'recovery' }, Number.MAX_SAFE_INTEGER)
        ._unsafeUnwrapErr().reason,
    ).toBe('INVALID_INPUT');
    expect(
      repo
        .reserveSend(ACCOUNT, state.revision, { ...CONTEXT, deliveryId: '' }, NOW)
        ._unsafeUnwrapErr().reason,
    ).toBe('INVALID_INPUT');
    expect(repo.reserveSend(OTHER_ACCOUNT, 0, CONTEXT, NOW)._unsafeUnwrapErr().reason).toBe(
      'NOT_FOUND',
    );
    expect(repo.findByAccount(ACCOUNT)._unsafeUnwrap()).toEqual(state);
  });

  it('rejects budget starts whose next-attempt timestamp would overflow a safe integer', () => {
    const state = initial();
    expect(
      repo.startDeviceCheck(ACCOUNT, state.revision, Number.MAX_SAFE_INTEGER)._unsafeUnwrapErr()
        .reason,
    ).toBe('INVALID_INPUT');
    expect(
      repo.reserveSend(ACCOUNT, state.revision, CONTEXT, Number.MAX_SAFE_INTEGER)._unsafeUnwrapErr()
        .reason,
    ).toBe('INVALID_INPUT');
    expect(repo.findByAccount(ACCOUNT)._unsafeUnwrap()).toEqual(state);
  });

  it('reserves a privileged challenge-resume check without clearing restrictions and shares the ordinary check budget', () => {
    const checked = repo.startDeviceCheck(ACCOUNT, initial().revision, NOW)._unsafeUnwrap();
    const challenge = repo
      .recordPause(ACCOUNT, checked.revision, { kind: 'challenge' }, NOW)
      ._unsafeUnwrap();
    expect(
      repo
        .startChallengeResumeDeviceCheck(ACCOUNT, challenge.revision, NOW + 59_999)
        ._unsafeUnwrapErr(),
    ).toMatchObject({ reason: 'BUDGET', nextAttemptAt: NOW + 60_000 });
    const resumeCheck = repo
      .startChallengeResumeDeviceCheck(ACCOUNT, challenge.revision, NOW + 60_000)
      ._unsafeUnwrap();
    expect(resumeCheck).toMatchObject({
      pauseKind: 'challenge',
      lastDeviceCheckStart: NOW + 60_000,
    });
    expect(
      repo
        .startChallengeResumeDeviceCheck(ACCOUNT, challenge.revision, NOW + 60_000)
        ._unsafeUnwrapErr().reason,
    ).toBe('CONFLICT');
    expect(
      repo
        .startChallengeResumeDeviceCheck(ACCOUNT, resumeCheck.revision, NOW + 60_001)
        ._unsafeUnwrapErr().reason,
    ).toBe('BUDGET');
    expect(
      repo.startDeviceCheck(ACCOUNT, resumeCheck.revision, NOW + 120_000)._unsafeUnwrapErr().reason,
    ).toBe('PAUSED');
    expect(
      repo.reserveSend(ACCOUNT, resumeCheck.revision, CONTEXT, NOW + 120_000)._unsafeUnwrapErr()
        .reason,
    ).toBe('PAUSED');
    const newChallenge = repo
      .recordPause(ACCOUNT, resumeCheck.revision, { kind: 'challenge' }, NOW + 60_001)
      ._unsafeUnwrap();
    expect(
      repo.clearChallenge(ACCOUNT, resumeCheck.revision, NOW + 60_002)._unsafeUnwrapErr().reason,
    ).toBe('CONFLICT');
    expect(repo.findByAccount(ACCOUNT)._unsafeUnwrap()).toEqual(newChallenge);
    const freshCheck = repo
      .startChallengeResumeDeviceCheck(ACCOUNT, newChallenge.revision, NOW + 120_000)
      ._unsafeUnwrap();
    expect(
      repo.clearChallenge(ACCOUNT, freshCheck.revision, NOW + 120_001)._unsafeUnwrap().pauseKind,
    ).toBe('none');
  });

  it.each(['rate_limit', 'recovery'] as const)(
    'privileged resume checks still honor and preserve %s deadlines',
    (kind) => {
      const challenge = repo
        .recordPause(ACCOUNT, initial().revision, { kind: 'challenge' }, NOW)
        ._unsafeUnwrap();
      const paused = repo
        .recordPause(
          ACCOUNT,
          challenge.revision,
          kind === 'rate_limit' ? { kind, notBefore: NOW + 2_000_000 } : { kind },
          NOW,
        )
        ._unsafeUnwrap();
      expect(
        repo
          .startChallengeResumeDeviceCheck(ACCOUNT, paused.revision, paused.notBefore - 1)
          ._unsafeUnwrapErr(),
      ).toMatchObject({ reason: 'PAUSED', nextAttemptAt: paused.notBefore });
      const checked = repo
        .startChallengeResumeDeviceCheck(ACCOUNT, paused.revision, paused.notBefore)
        ._unsafeUnwrap();
      expect(checked).toMatchObject({
        pauseKind: 'challenge',
        notBefore: paused.notBefore,
        rateLimitNotBefore: paused.rateLimitNotBefore,
        recoveryNotBefore: paused.recoveryNotBefore,
        lastDeviceCheckStart: paused.notBefore,
      });
    },
  );

  it('does not admit a privileged resume check unless a challenge is present', () => {
    const state = initial();
    expect(
      repo.startChallengeResumeDeviceCheck(ACCOUNT, state.revision, NOW)._unsafeUnwrapErr().reason,
    ).toBe('CONFLICT');
    expect(repo.findByAccount(ACCOUNT)._unsafeUnwrap()).toEqual(state);
  });

  it('supports enclosing rollback even after a successful device-check start', () => {
    const state = initial();
    const result = runResultTransaction(
      (fn) => repo.transaction(fn),
      () => repo.startDeviceCheck(ACCOUNT, state.revision, NOW).andThen(() => err('rollback')),
    );
    expect(result._unsafeUnwrapErr()).toBe('rollback');
    expect(repo.findByAccount(ACCOUNT)._unsafeUnwrap()).toEqual(state);
    expect(
      repo
        .startDeviceCheck(ACCOUNT, state.revision, NOW)
        .andThen(() => ok(undefined))
        .isOk(),
    ).toBe(true);
  });
});
