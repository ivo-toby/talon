/**
 * Database layer public API.
 *
 * Opens the SQLite database via better-sqlite3, applies pending migrations,
 * and exports all repositories and connection utilities.
 */

export { createDatabase } from './connection.js';
export { runResultTransaction } from './transaction.js';
export { runMigrations } from './migrations/index.js';
export * from './repositories/index.js';
