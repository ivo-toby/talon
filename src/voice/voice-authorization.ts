/**
 * Transport-neutral exact voice grant boundary.
 *
 * Transports may authenticate differently, but the session service always
 * receives the same stable owner and grant revision. A missing or mismatched
 * grant is an error; callers must never fall back to a newer grant for the
 * same owner.
 */

import { PolicyError } from '../core/errors/index.js';
import { err, ok } from '../core/types/result.js';
import type { VoiceOwnerContext, VoiceResult } from './voice-types.js';

export interface VoiceGrant {
  readonly owner: VoiceOwnerContext;
  readonly grantRevision: number;
  readonly transport?: string;
  readonly expiresAt?: number;
}

export interface VoiceAuthorization {
  /** Resolve exactly the requested owner/revision, if it is still active. */
  resolve(owner: VoiceOwnerContext): VoiceResult<VoiceGrant | undefined>;
  /** Revoke only the requested grant; this must not mint a replacement. */
  revoke(owner: VoiceOwnerContext): VoiceResult<void>;
}

export interface VoiceAuthorizationSource {
  resolve(owner: VoiceOwnerContext): VoiceResult<VoiceGrant | VoiceOwnerContext | undefined>;
  revoke?(owner: VoiceOwnerContext): VoiceResult<void>;
}

/** Adapt an existing exact owner resolver without exposing cookies or tokens. */
export function createVoiceAuthorization(source: VoiceAuthorizationSource): VoiceAuthorization {
  return {
    resolve(owner): VoiceResult<VoiceGrant | undefined> {
      const result = source.resolve(owner);
      if (result.isErr()) return err(result.error);
      if (result.value === undefined) return ok(undefined);
      const grant = isVoiceGrant(result.value)
        ? result.value
        : { owner: result.value, grantRevision: result.value.loginRevision };
      if (!sameOwnerGrant(grant, owner)) return ok(undefined);
      return ok(grant);
    },
    revoke(owner): VoiceResult<void> {
      if (!source.revoke) return err(new PolicyError('Voice grant revocation is unavailable'));
      const resolved = this.resolve(owner);
      if (resolved.isErr()) return err(resolved.error);
      if (!resolved.value) return err(new PolicyError('Voice grant is missing or revoked'));
      return source.revoke(resolved.value.owner);
    },
  };
}

/** Require an active grant with the exact owner and revision requested. */
export function resolveExactVoiceGrant(
  authorization: VoiceAuthorization | undefined,
  owner: VoiceOwnerContext,
): VoiceResult<VoiceGrant> {
  if (!authorization) return err(new PolicyError('Voice authorization is unavailable'));
  const resolved = authorization.resolve(owner);
  if (resolved.isErr()) return err(resolved.error);
  if (!resolved.value || !sameOwnerGrant(resolved.value, owner)) {
    return err(new PolicyError('Voice grant is missing or revoked'));
  }
  return ok(resolved.value);
}

/** Revoke only the exact grant represented by the owner context. */
export function revokeExactVoiceGrant(
  authorization: VoiceAuthorization | undefined,
  owner: VoiceOwnerContext,
): VoiceResult<void> {
  if (!authorization) return err(new PolicyError('Voice authorization is unavailable'));
  const grant = resolveExactVoiceGrant(authorization, owner);
  if (grant.isErr()) return err(grant.error);
  return authorization.revoke(grant.value.owner);
}

function isVoiceGrant(value: VoiceGrant | VoiceOwnerContext): value is VoiceGrant {
  return 'grantRevision' in value;
}

function sameOwnerGrant(grant: VoiceGrant, owner: VoiceOwnerContext): boolean {
  return (
    grant.owner.ownerId === owner.ownerId &&
    grant.owner.loginRevision === owner.loginRevision &&
    grant.grantRevision === owner.loginRevision
  );
}
