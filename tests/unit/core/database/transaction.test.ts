import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { err, ok, type Result } from 'neverthrow';
import { runResultTransaction } from '../../../../src/core/database/transaction.js';
import { DbError } from '../../../../src/core/errors/index.js';

// Repository contract inventory: BaseRepository.transaction (base-repository.ts:78-82)
// calls db.transaction(callback)(); returning Err normally commits in SQLite.
// Design snapshot: "Atomic ingress and replay actor (F16)" requires Err rollback.
describe('runResultTransaction with real SQLite', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec('CREATE TABLE writes (value INTEGER)');
  });

  afterEach(() => {
    db.close();
  });

  function transaction<T>(callback: () => T): T {
    return db.transaction(callback)();
  }

  it('commits Ok and returns the original Result', () => {
    const expected = ok('accepted');
    const result = runResultTransaction(transaction, () => {
      db.exec('INSERT INTO writes VALUES (1)');
      return expected;
    });
    expect(result).toBe(expected);
    expect(db.prepare('SELECT * FROM writes').all()).toEqual([{ value: 1 }]);
    expect(db.inTransaction).toBe(false);
  });

  it('rolls back Err without leaking a sentinel or changing typed error identity', () => {
    const error = new DbError('fixture failure');
    const expected = err(error);
    const result = runResultTransaction(transaction, () => {
      db.exec('INSERT INTO writes VALUES (1)');
      return expected;
    });
    expect(result).toBe(expected);
    expect(result._unsafeUnwrapErr()).toBe(error);
    expect(db.prepare('SELECT * FROM writes').all()).toEqual([]);
    expect(db.inTransaction).toBe(false);
  });

  it('rolls back unexpected exceptions and propagates the same exception', () => {
    const error = new Error('fixture exception');
    expect(() =>
      runResultTransaction(transaction, () => {
        db.exec('INSERT INTO writes VALUES (1)');
        throw error;
      }),
    ).toThrow(error);
    expect(db.prepare('SELECT * FROM writes').all()).toEqual([]);
    expect(db.inTransaction).toBe(false);
  });

  it('rolls back a failed nested savepoint without rolling back an outer success', () => {
    const error = new DbError('inner failure');
    const result = runResultTransaction(transaction, () => {
      db.exec('INSERT INTO writes VALUES (1)');
      const inner = runResultTransaction(transaction, () => {
        db.exec('INSERT INTO writes VALUES (2)');
        return err(error);
      });
      expect(inner._unsafeUnwrapErr()).toBe(error);
      return ok('outer');
    });
    expect(result._unsafeUnwrap()).toBe('outer');
    expect(db.prepare('SELECT * FROM writes').all()).toEqual([{ value: 1 }]);
  });

  it('rolls back an inner success if the enclosing Result fails', () => {
    const result = runResultTransaction(transaction, () => {
      runResultTransaction(transaction, () => {
        db.exec('INSERT INTO writes VALUES (1)');
        return ok('inner');
      });
      return err('outer failure');
    });
    expect(result._unsafeUnwrapErr()).toBe('outer failure');
    expect(db.prepare('SELECT * FROM writes').all()).toEqual([]);
  });

  it('rejects async callbacks before invoking them', () => {
    async function invalidCallback(): Promise<Result<void, DbError>> {
      db.exec('INSERT INTO writes VALUES (1)');
      await Promise.resolve();
      db.exec('INSERT INTO writes VALUES (2)');
      return ok(undefined);
    }
    // @ts-expect-error Async callbacks are not the synchronous Result contract.
    expect(() => runResultTransaction(transaction, invalidCallback)).toThrow('synchronous Result');
    expect(db.prepare('SELECT * FROM writes').all()).toEqual([]);
  });

  it('rejects a non-async function returning a Promise and rolls back its synchronous writes', () => {
    function invalidCallback(): Promise<Result<void, DbError>> {
      db.exec('INSERT INTO writes VALUES (1)');
      return Promise.resolve(ok(undefined));
    }
    // @ts-expect-error Promise results cannot commit through this API.
    expect(() => runResultTransaction(transaction, invalidCallback)).toThrow('synchronous Result');
    expect(db.prepare('SELECT * FROM writes').all()).toEqual([]);
    expect(db.inTransaction).toBe(false);
  });
});
