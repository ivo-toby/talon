import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { err } from 'neverthrow';
import {
  ChannelRepository,
  QueueRepository,
  SignalAccountStateRepository,
  SignalDestinationLeaseRepository,
  ThreadRepository,
} from '../../../../../src/core/database/repositories/index.js';
import { runMigrations } from '../../../../../src/core/database/migrations/runner.js';
import { createDatabase } from '../../../../../src/core/database/connection.js';
import { runResultTransaction } from '../../../../../src/core/database/transaction.js';
import type {
  SignalDeliveryPurpose,
  TrustedDeliveryContext,
} from '../../../../../src/channels/channel-types.js';

const ACCOUNT = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const OTHER_ACCOUNT = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const SELF = `signal:v1:${ACCOUNT}:self`;
const GROUP = `signal:v1:${ACCOUNT}:group:Z3JvdXA`;
const DM = `signal:v1:${ACCOUNT}:dm:cccccccc-cccc-cccc-cccc-cccccccccccc`;
const OTHER_GROUP = `signal:v1:${ACCOUNT}:group:b3RoZXI`;
const NOW = 1_000_000;
const CONTEXT: TrustedDeliveryContext = {
  queueItemId: 'queue-a',
  deliveryId: 'delivery-a',
  purpose: 'reply',
};
const COMPETITOR: TrustedDeliveryContext = {
  queueItemId: 'queue-b',
  deliveryId: 'delivery-b',
  purpose: 'explicit',
};
const migrations = join(import.meta.dirname, '../../../../../src/core/database/migrations');

describe('SignalDestinationLeaseRepository', () => {
  let db: Database.Database;
  let repo: SignalDestinationLeaseRepository;
  let accounts: SignalAccountStateRepository;
  let directory: string;
  let filename: string;

  function open(): void {
    db = createDatabase(filename)._unsafeUnwrap();
    expect(runMigrations(db, migrations).isOk()).toBe(true);
    repo = new SignalDestinationLeaseRepository(db);
    accounts = new SignalAccountStateRepository(db);
  }

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'talon-signal-lease-'));
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
    for (const suffix of ['a', 'b']) {
      new ThreadRepository(db)
        .insert({
          id: `thread-${suffix}`,
          channel_id: 'channel',
          external_id: `fixture-${suffix}`,
          metadata: '{}',
        })
        ._unsafeUnwrap();
      new QueueRepository(db)
        .enqueue({
          id: `queue-${suffix}`,
          thread_id: `thread-${suffix}`,
          message_id: null,
          type: 'message',
          payload: '{"existing":true}',
          max_attempts: 3,
        })
        ._unsafeUnwrap();
    }
    accounts.getOrCreate(ACCOUNT, NOW)._unsafeUnwrap();
  });

  afterEach(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('migrates queue-owned destination leases with cascade cancellation', () => {
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'signal_destination_leases'",
        )
        .get(),
    ).toBeDefined();
    expect(db.prepare('PRAGMA foreign_key_list(signal_destination_leases)').all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: 'queue_items',
          from: 'queue_item_id',
          on_delete: 'CASCADE',
        }),
      ]),
    );
  });

  it('serializes complete logical messages to one canonical destination, not one thread or purpose', () => {
    const owner = repo.acquire(ACCOUNT, GROUP, CONTEXT, NOW)._unsafeUnwrap();
    expect(repo.acquire(ACCOUNT, GROUP, COMPETITOR, NOW + 1)._unsafeUnwrapErr().reason).toBe(
      'BUSY',
    );
    expect(
      repo
        .acquire(ACCOUNT, GROUP, { ...COMPETITOR, purpose: 'background' }, NOW + 1)
        ._unsafeUnwrapErr().reason,
    ).toBe('BUSY');
    expect(
      repo.acquire(ACCOUNT, GROUP, { ...CONTEXT, purpose: 'progress' }, NOW + 1)._unsafeUnwrapErr()
        .reason,
    ).toBe('BUSY');
    expect(
      repo
        .acquire(ACCOUNT, GROUP, { ...CONTEXT, queueItemId: COMPETITOR.queueItemId }, NOW + 1)
        ._unsafeUnwrapErr().reason,
    ).toBe('BUSY');
    expect(repo.validateOwner(owner)._unsafeUnwrap()).toEqual(owner);
    expect(repo.acquire(ACCOUNT, OTHER_GROUP, COMPETITOR, NOW + 1).isOk()).toBe(true);
    expect(
      repo
        .acquire(OTHER_ACCOUNT, `signal:v1:${OTHER_ACCOUNT}:group:Z3JvdXA`, COMPETITOR, NOW + 1)
        .isOk(),
    ).toBe(true);
  });

  it('refuses a competing SQLite connection while another owner holds the destination', () => {
    const owner = repo.acquire(ACCOUNT, GROUP, CONTEXT, NOW)._unsafeUnwrap();
    const competingDb = createDatabase(filename)._unsafeUnwrap();
    try {
      const competitor = new SignalDestinationLeaseRepository(competingDb);
      expect(competitor.acquire(ACCOUNT, GROUP, COMPETITOR, NOW)._unsafeUnwrapErr().reason).toBe(
        'BUSY',
      );
      expect(competitor.find(ACCOUNT, GROUP)._unsafeUnwrap()).toEqual(owner);
      repo.release(owner)._unsafeUnwrap();
      expect(competitor.acquire(ACCOUNT, GROUP, COMPETITOR, NOW).isOk()).toBe(true);
    } finally {
      competingDb.close();
    }
  });

  it.each(['reply', 'background'] as const)(
    'retains saved %s ownership unchanged across defer and restart',
    (purpose) => {
      const context = { ...CONTEXT, purpose };
      const lease = repo.acquire(ACCOUNT, GROUP, context, NOW)._unsafeUnwrap();
      expect(repo.acquire(ACCOUNT, GROUP, context, NOW - 1)._unsafeUnwrap()).toEqual(lease);
      db.close();
      open();
      expect(repo.acquire(ACCOUNT, GROUP, context, NOW + 60_000)._unsafeUnwrap()).toEqual(lease);
      expect(repo.acquire(ACCOUNT, GROUP, COMPETITOR, NOW + 60_000)._unsafeUnwrapErr().reason).toBe(
        'BUSY',
      );
      expect(repo.validateOwner(lease)._unsafeUnwrap()).toEqual(lease);
    },
  );

  it.each(['explicit', 'progress'] as const)(
    'supports %s release on success and transient NOT_SENT so a new delivery can proceed',
    (purpose) => {
      for (const outcome of ['success', 'NOT_SENT']) {
        const invocation = repo
          .acquire(ACCOUNT, SELF, { ...CONTEXT, purpose, deliveryId: outcome }, NOW)
          ._unsafeUnwrap();
        expect(repo.release(invocation).isOk()).toBe(true);
        const next = repo.acquire(ACCOUNT, SELF, COMPETITOR, NOW)._unsafeUnwrap();
        expect(repo.release(next).isOk()).toBe(true);
      }
    },
  );

  it('uses owner CAS for validation/release, including a generation to prevent stale-release ABA', () => {
    const lease = repo.acquire(ACCOUNT, SELF, CONTEXT, NOW)._unsafeUnwrap();
    for (const wrong of [
      { ...lease, queueItemId: 'queue-b' },
      { ...lease, deliveryId: 'other' },
      { ...lease, kind: 'explicit' as const },
      { ...lease, leaseId: 'other-generation' },
    ]) {
      expect(repo.validateOwner(wrong)._unsafeUnwrapErr().reason).toBe('CONFLICT');
      expect(repo.release(wrong)._unsafeUnwrapErr().reason).toBe('CONFLICT');
    }
    repo.release(lease)._unsafeUnwrap();
    const replacement = repo.acquire(ACCOUNT, SELF, CONTEXT, NOW)._unsafeUnwrap();
    expect(replacement.leaseId).not.toBe(lease.leaseId);
    expect(repo.release(lease)._unsafeUnwrapErr().reason).toBe('CONFLICT');
    expect(repo.validateOwner(replacement)._unsafeUnwrap()).toEqual(replacement);
  });

  it('cascades queue deletion to its leases only, while preserving the active account reservation', () => {
    const lease = repo.acquire(ACCOUNT, GROUP, CONTEXT, NOW)._unsafeUnwrap();
    const other = repo.acquire(ACCOUNT, OTHER_GROUP, COMPETITOR, NOW)._unsafeUnwrap();
    const state = accounts.findByAccount(ACCOUNT)._unsafeUnwrap()!;
    const reserved = accounts.reserveSend(ACCOUNT, state.revision, CONTEXT, NOW)._unsafeUnwrap();
    db.prepare('DELETE FROM queue_items WHERE id = ?').run(CONTEXT.queueItemId);
    expect(repo.find(ACCOUNT, GROUP)._unsafeUnwrap()).toBeNull();
    expect(repo.release(lease)._unsafeUnwrapErr().reason).toBe('CONFLICT');
    expect(repo.validateOwner(other)._unsafeUnwrap()).toEqual(other);
    expect(accounts.findByAccount(ACCOUNT)._unsafeUnwrap()).toEqual(reserved);
    expect(repo.acquire(ACCOUNT, GROUP, CONTEXT, NOW)._unsafeUnwrapErr().reason).toBe('NOT_FOUND');
  });

  it('rejects missing trusted queue rows and malformed/stale-account external destinations', () => {
    for (const destination of [
      'group name',
      `signal:v1:${OTHER_ACCOUNT}:self`,
      `signal:v1:${ACCOUNT.toUpperCase()}:self`,
      `${GROUP}=`,
      `${SELF}:extra`,
    ]) {
      expect(repo.acquire(ACCOUNT, destination, CONTEXT, NOW)._unsafeUnwrapErr().reason).toBe(
        'INVALID_INPUT',
      );
    }
    expect(repo.acquire('account display name', SELF, CONTEXT, NOW)._unsafeUnwrapErr().reason).toBe(
      'INVALID_INPUT',
    );
    expect(
      repo.acquire(ACCOUNT, SELF, { ...CONTEXT, queueItemId: 'missing' }, NOW)._unsafeUnwrapErr()
        .reason,
    ).toBe('NOT_FOUND');
    expect(
      repo.acquire(ACCOUNT, SELF, { ...CONTEXT, deliveryId: '' }, NOW)._unsafeUnwrapErr().reason,
    ).toBe('INVALID_INPUT');
    expect(repo.acquire(ACCOUNT, SELF, CONTEXT, Infinity)._unsafeUnwrapErr().reason).toBe(
      'INVALID_INPUT',
    );
    expect(repo.acquire(ACCOUNT.toUpperCase(), SELF, CONTEXT, NOW).isOk()).toBe(true);
  });

  function acquireRecoveryFixtures(): void {
    for (const [destination, purpose] of [
      [SELF, 'explicit'],
      [DM, 'progress'],
      [GROUP, 'reply'],
      [OTHER_GROUP, 'background'],
    ] satisfies readonly (readonly [string, SignalDeliveryPurpose])[]) {
      repo.acquire(ACCOUNT, destination, { ...CONTEXT, purpose }, NOW)._unsafeUnwrap();
    }
  }

  it('recovers orphan explicit/progress leases after a crash BEFORE reservation creation, retaining saved owners', () => {
    acquireRecoveryFixtures();
    db.close();
    open();
    const state = accounts.findByAccount(ACCOUNT)._unsafeUnwrap()!;
    expect(state.reservation).toBeNull();
    expect(repo.releaseOrphanInvocations(ACCOUNT, state.revision)._unsafeUnwrap()).toBe(2);
    expect(repo.find(ACCOUNT, SELF)._unsafeUnwrap()).toBeNull();
    expect(repo.find(ACCOUNT, DM)._unsafeUnwrap()).toBeNull();
    expect(repo.find(ACCOUNT, GROUP)._unsafeUnwrap()?.kind).toBe('reply');
    expect(repo.find(ACCOUNT, OTHER_GROUP)._unsafeUnwrap()?.kind).toBe('background');
    expect(new QueueRepository(db).findById(CONTEXT.queueItemId)._unsafeUnwrap()?.payload).toBe(
      '{"existing":true}',
    );
  });

  it('requires reservation classification first and rejects cleanup with a stale account revision', () => {
    acquireRecoveryFixtures();
    const state = accounts.findByAccount(ACCOUNT)._unsafeUnwrap()!;
    const reserved = accounts
      .reserveSend(ACCOUNT, state.revision, { ...CONTEXT, purpose: 'explicit' }, NOW)
      ._unsafeUnwrap();
    expect(
      repo.releaseOrphanInvocations(ACCOUNT, reserved.revision)._unsafeUnwrapErr().reason,
    ).toBe('BUSY');
    expect(repo.find(ACCOUNT, SELF)._unsafeUnwrap()).not.toBeNull();
    const classified = runResultTransaction(
      (fn) => accounts.transaction(fn),
      () =>
        accounts
          .recordPause(ACCOUNT, reserved.revision, { kind: 'recovery' }, NOW + 1)
          .andThen((paused) =>
            accounts.clearReservation(ACCOUNT, paused.revision, reserved.reservation!, NOW + 1),
          ),
    )._unsafeUnwrap();
    expect(
      repo.releaseOrphanInvocations(ACCOUNT, reserved.revision)._unsafeUnwrapErr().reason,
    ).toBe('CONFLICT');
    expect(repo.releaseOrphanInvocations(ACCOUNT, classified.revision)._unsafeUnwrap()).toBe(2);
    expect(accounts.findByAccount(ACCOUNT)._unsafeUnwrap()).toEqual(classified);
    expect(repo.releaseOrphanInvocations(ACCOUNT, classified.revision)._unsafeUnwrap()).toBe(0);
  });

  it('does not recover another account, and does not rewrite a completed queue item during cleanup', () => {
    const state = accounts.findByAccount(ACCOUNT)._unsafeUnwrap()!;
    repo.acquire(ACCOUNT, SELF, { ...CONTEXT, purpose: 'explicit' }, NOW)._unsafeUnwrap();
    const other = repo
      .acquire(OTHER_ACCOUNT, `signal:v1:${OTHER_ACCOUNT}:self`, COMPETITOR, NOW)
      ._unsafeUnwrap();
    new QueueRepository(db).complete(CONTEXT.queueItemId)._unsafeUnwrap();
    const queueBefore = new QueueRepository(db).findById(CONTEXT.queueItemId)._unsafeUnwrap();
    expect(repo.releaseOrphanInvocations(ACCOUNT, state.revision)._unsafeUnwrap()).toBe(1);
    expect(new QueueRepository(db).findById(CONTEXT.queueItemId)._unsafeUnwrap()).toEqual(
      queueBefore,
    );
    expect(repo.validateOwner(other)._unsafeUnwrap()).toEqual(other);
  });

  it('rolls back lease acquire, release, orphan cleanup and cascade deletion with an outer Result Err', () => {
    const owner = repo.acquire(ACCOUNT, GROUP, CONTEXT, NOW)._unsafeUnwrap();
    const invocation = repo.acquire(ACCOUNT, SELF, COMPETITOR, NOW)._unsafeUnwrap();
    const result = runResultTransaction(
      (fn) => repo.transaction(fn),
      () =>
        repo
          .release(owner)
          .andThen(() => repo.acquire(ACCOUNT, GROUP, COMPETITOR, NOW))
          .andThen(() => repo.releaseOrphanInvocations(ACCOUNT, 0))
          .andThen(() => {
            db.prepare('DELETE FROM queue_items WHERE id = ?').run(COMPETITOR.queueItemId);
            return err('rollback');
          }),
    );
    expect(result._unsafeUnwrapErr()).toBe('rollback');
    expect(repo.validateOwner(owner)._unsafeUnwrap()).toEqual(owner);
    expect(repo.validateOwner(invocation)._unsafeUnwrap()).toEqual(invocation);
    expect(new QueueRepository(db).findById(COMPETITOR.queueItemId)._unsafeUnwrap()).not.toBeNull();
  });

  it('sanitizes SQLite failures without retaining raw causes', () => {
    db.exec(`CREATE TRIGGER fail_signal_lease BEFORE INSERT ON signal_destination_leases
      BEGIN SELECT RAISE(ABORT, 'private target and secret payload'); END`);
    const failure = repo.acquire(ACCOUNT, SELF, CONTEXT, NOW)._unsafeUnwrapErr();
    expect(failure.reason).toBe('DATABASE');
    expect(failure.message).not.toMatch(/private|secret|target|payload/);
    expect(failure.cause).toBeUndefined();
    expect(repo.find(ACCOUNT, SELF)._unsafeUnwrap()).toBeNull();
  });
});
