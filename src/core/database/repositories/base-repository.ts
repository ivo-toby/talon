/**
 * Abstract base class for all data repositories.
 *
 * Provides the shared database reference and a convenience helper for
 * generating Unix epoch millisecond timestamps.
 */

import type Database from 'better-sqlite3';

/** Base class shared by all Talon repositories. */
export abstract class BaseRepository {
  /**
   * Process-wide last emitted timestamp. Ensures strict monotonicity across
   * all repositories so that two rows written within the same wall-clock
   * millisecond still get distinct, strictly-increasing `created_at` values.
   *
   * Why: consumers like `MessageRepository.findLatestByThreadSince` and the
   * context-rotation boundary use `created_at > boundary` filters. If two
   * writes share a timestamp, the later one would be incorrectly excluded
   * from the post-rotation window. Monotonic issuance removes the tie.
   *
   * Drift vs. wall clock is bounded by the number of rows written within a
   * single ms — in practice a handful of microseconds under burst load.
   */
  private static lastMonotonicTs = 0;

  constructor(protected readonly db: Database.Database) {}

  /** Returns the current time as Unix epoch milliseconds, strictly monotonic. */
  protected now(): number {
    const wall = Date.now();
    const next = wall > BaseRepository.lastMonotonicTs
      ? wall
      : BaseRepository.lastMonotonicTs + 1;
    BaseRepository.lastMonotonicTs = next;
    return next;
  }

  /**
   * Seed the in-memory monotonic counter from the max `created_at` across
   * the tables whose timestamps gate durable correctness checks (messages,
   * memory_items). Call once at bootstrap.
   *
   * Why: monotonic issuance is otherwise only safe within a single process
   * lifetime. If process A persisted drift-inflated timestamps (or the
   * system wall clock rewound) and process B started with an uninitialized
   * counter, a new row could receive `created_at <= rotatedThroughTs` from
   * a prior rotation and be incorrectly filtered out of post-rotation
   * windows. Seeding from DB max guarantees monotonicity across restarts.
   */
  public static seedMonotonicClockFromDb(db: Database.Database): void {
    try {
      // Coalesce each inner MAX to 0 first so an empty table doesn't poison
      // the outer MAX (SQLite's scalar MAX returns NULL when any arg is NULL).
      const row = db
        .prepare(
          `SELECT MAX(
             COALESCE((SELECT MAX(created_at) FROM messages), 0),
             COALESCE((SELECT MAX(created_at) FROM memory_items), 0)
           ) AS max_ts`,
        )
        .get() as { max_ts: number | null } | undefined;
      const seed = row?.max_ts ?? 0;
      if (seed > BaseRepository.lastMonotonicTs) {
        BaseRepository.lastMonotonicTs = seed;
      }
    } catch {
      // Tables may not exist yet (fresh DB pre-migration). Safe to skip —
      // the counter stays at 0 and wall clock dominates on first write.
    }
  }

  /** Reset the monotonic counter. Test-only. */
  public static __resetMonotonicClockForTests(): void {
    BaseRepository.lastMonotonicTs = 0;
  }

  /** Wraps a synchronous function in a SQLite transaction. Throws on error (rolls back). */
  public transaction<T>(fn: () => T): T {
    const tx = this.db.transaction(fn);
    return tx();
  }
}
