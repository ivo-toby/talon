/**
 * Environment-based secret store.
 *
 * Resolves secrets from process.env (daemon environment) first, then falls
 * back to a {dataDir}/secrets.env file parsed at construction time. The file
 * is read once and never re-read. Secret values are never logged.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { ok, err, type Result } from 'neverthrow';
import type pino from 'pino';
import { SecretError, type SecretResolveContext, type SecretStore } from './index.js';

export interface EnvSecretStoreOptions {
  dataDir: string;
  logger: pino.Logger;
}

/**
 * Parse a KEY=VALUE dotenv-style string into a Map.
 *
 * Handles:
 * - Lines starting with # (comments) are skipped
 * - Empty/whitespace-only lines are skipped
 * - KEY=VALUE pairs are stored
 * - KEY="VALUE" or KEY='VALUE' strips surrounding quotes
 * - No multiline support
 */
export function parseDotenv(content: string): Map<string, string> {
  const result = new Map<string, string>();

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();

    // Skip empty lines and comments
    if (line === '' || line.startsWith('#')) {
      continue;
    }

    const eqIndex = line.indexOf('=');
    if (eqIndex === -1) {
      continue;
    }

    let key = line.slice(0, eqIndex).trim();
    let value = line.slice(eqIndex + 1).trim();

    // Strip 'export ' prefix (e.g. export KEY=VALUE)
    if (key.startsWith('export ')) {
      key = key.slice(7).trim();
    }

    // Strip surrounding quotes (single or double)
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    } else {
      // Strip inline comments for unquoted values (e.g. VALUE # comment)
      const commentIndex = value.indexOf(' #');
      if (commentIndex !== -1) {
        value = value.slice(0, commentIndex).trimEnd();
      }
    }

    if (key !== '') {
      result.set(key, value);
    }
  }

  return result;
}

export class EnvSecretStore implements SecretStore {
  private readonly fileSecrets: Map<string, string>;

  constructor(options: EnvSecretStoreOptions) {
    const { dataDir, logger } = options;
    const secretsPath = path.join(dataDir, 'secrets.env');

    this.fileSecrets = new Map();

    let fd: number | undefined;
    try {
      // Open, fstat, and read from the same fd to avoid TOCTOU races
      fd = fs.openSync(secretsPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const stat = fs.fstatSync(fd);

      // Reject non-regular files
      if (!stat.isFile()) {
        logger.warn(
          { path: secretsPath },
          'secrets.env is not a regular file — ignored',
        );
        return;
      }

      // Check permissions: no group/other access allowed
      if ((stat.mode & 0o077) !== 0) {
        logger.warn(
          { path: secretsPath },
          'secrets.env has permissions looser than 0600 — file ignored',
        );
        return;
      }

      const content = fs.readFileSync(fd, 'utf-8');
      this.fileSecrets = parseDotenv(content);
      logger.info('Loaded %d secrets from secrets.env', this.fileSecrets.size);
    } catch (error: unknown) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        logger.debug('No secrets.env found at %s — skipping', secretsPath);
      } else {
        logger.warn(
          { err: error },
          'Failed to read secrets.env — proceeding without file secrets',
        );
      }
    } finally {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          // Best-effort close
        }
      }
    }
  }

  resolve(
    names: readonly string[],
    _context: SecretResolveContext,
  ): Result<Record<string, string>, SecretError> {
    if (names.length === 0) {
      return ok({});
    }

    const resolved: Record<string, string> = {};
    const missing: string[] = [];

    for (const name of names) {
      const envValue = process.env[name];
      if (envValue !== undefined) {
        resolved[name] = envValue;
        continue;
      }

      const fileValue = this.fileSecrets.get(name);
      if (fileValue !== undefined) {
        resolved[name] = fileValue;
        continue;
      }

      missing.push(name);
    }

    if (missing.length > 0) {
      return err(new SecretError(missing));
    }

    return ok(resolved);
  }
}
