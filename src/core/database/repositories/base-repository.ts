/**
 * Abstract base class for all data repositories.
 *
 * Provides the shared database reference and a convenience helper for
 * generating Unix epoch millisecond timestamps.
 */

import type Database from 'better-sqlite3';

/** Base class shared by all Talon repositories. */
export abstract class BaseRepository {
  constructor(protected readonly db: Database.Database) {}

  /** Returns the current time as Unix epoch milliseconds. */
  protected now(): number {
    return Date.now();
  }

  /** Wraps a synchronous function in a SQLite transaction. Throws on error (rolls back). */
  public transaction<T>(fn: () => T): T {
    const tx = this.db.transaction(fn);
    return tx();
  }
}
