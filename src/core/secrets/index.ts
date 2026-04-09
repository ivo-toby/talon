/**
 * Secret store interface and error types.
 *
 * The secret store resolves named secrets for injection into sandboxed
 * skill script executions. v1 supports process.env and an operator-managed
 * secrets.env file.
 */

import type { Result } from 'neverthrow';

export interface SecretResolveContext {
  personaId?: string;
  skillName?: string;
}

export interface SecretStore {
  resolve(
    names: readonly string[],
    context: SecretResolveContext,
  ): Result<Record<string, string>, SecretError>;
}

export class SecretError extends Error {
  constructor(public readonly missing: string[]) {
    super(`Missing secrets: ${missing.join(', ')}`);
    this.name = 'SecretError';
  }
}
