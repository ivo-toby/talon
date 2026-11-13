/**
 * Server-side verification of the short-lived assertion produced by the
 * configured PBX endpoint. OpenAI webhook authentication is deliberately not
 * part of this module: a valid provider delivery identifies the provider,
 * while this assertion identifies the caller principal.
 */

import {
  createHash,
  createPublicKey,
  timingSafeEqual,
  verify,
  type KeyObject,
} from 'node:crypto';
import { err, ok } from '../../../core/types/result.js';
import { PolicyError } from '../../../core/errors/index.js';
import type { VoiceResult } from '../../voice-types.js';

export const SIP_ASSERTION_VERSION = 'talon-sip-v1';
export const SIP_ASSERTION_ALGORITHM = 'Ed25519';
export const SIP_MAX_ASSERTION_BYTES = 2_048;
export const SIP_MAX_IDENTIFIER_BYTES = 256;
export const SIP_MAX_ASSERTION_LIFETIME_SECONDS = 60;
export const SIP_MIN_ASSERTION_NONCE_BYTES = 16;

export interface SipEndpointPrincipal {
  readonly ownerId: string;
  readonly personaId: string;
}

export interface SipAuthorizationClaims {
  readonly version: 1;
  readonly algorithm: typeof SIP_ASSERTION_ALGORITHM;
  readonly issuer: string;
  readonly keyId: string;
  readonly audience: string;
  readonly subject: string;
  readonly nonce: string;
  readonly callBinding: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

/** A verified assertion before it is atomically bound to a provider session. */
export interface SipVerifiedAuthorization extends SipAuthorizationClaims {
  readonly proofHash: string;
  readonly principal: SipEndpointPrincipal;
}

export interface SipAuthorizationResolveInput {
  readonly proof: string;
  readonly providerSessionId: string;
  readonly nowSeconds: number;
}

export interface SipAuthorizationResolver {
  resolve(input: SipAuthorizationResolveInput): VoiceResult<SipVerifiedAuthorization>;
}

export interface SipAuthorizationResolverConfig {
  readonly issuer?: string;
  readonly audience?: string;
  readonly publicKeys?: Readonly<Record<string, string>>;
  readonly endpointMappings?: Readonly<Record<string, SipEndpointPrincipal>>;
  readonly revokedIssuers?: readonly string[];
  readonly revokedKeyIds?: readonly string[];
  readonly maxAssertionLifetimeSeconds?: number;
}

/**
 * Ed25519 resolver for operator-configured issuers and authenticated PBX
 * endpoint subjects. Missing configuration is intentionally a deny-all
 * resolver rather than a reason to infer identity from SIP headers.
 */
export class ConfiguredSipAuthorizationResolver implements SipAuthorizationResolver {
  private readonly issuer: string | undefined;
  private readonly audience: string | undefined;
  private readonly keys: ReadonlyMap<string, KeyObject>;
  private readonly endpointMappings: Readonly<Record<string, SipEndpointPrincipal>>;
  private readonly revokedIssuers: ReadonlySet<string>;
  private readonly revokedKeyIds: ReadonlySet<string>;
  private readonly maxLifetimeSeconds: number;

  constructor(config: SipAuthorizationResolverConfig = {}) {
    this.issuer = boundedConfigText(config.issuer);
    this.audience = boundedConfigText(config.audience);
    this.keys = createPublicKeyMap(config.publicKeys ?? {});
    this.endpointMappings = config.endpointMappings ?? {};
    this.revokedIssuers = new Set(config.revokedIssuers ?? []);
    this.revokedKeyIds = new Set(config.revokedKeyIds ?? []);
    this.maxLifetimeSeconds = boundedLifetime(config.maxAssertionLifetimeSeconds);
  }

  resolve(input: SipAuthorizationResolveInput): VoiceResult<SipVerifiedAuthorization> {
    if (!isBoundedText(input.proof, SIP_MAX_ASSERTION_BYTES)) {
      return err(new PolicyError('SIP authority assertion is missing or oversized'));
    }
    if (!isBoundedText(input.providerSessionId, 256)) {
      return err(new PolicyError('SIP provider session identifier is invalid'));
    }
    if (!Number.isSafeInteger(input.nowSeconds)) {
      return err(new PolicyError('SIP authority verification time is invalid'));
    }
    const parsed = parseAssertion(input.proof);
    if (parsed.isErr()) return err(parsed.error);
    const { claims, signedBytes, signature } = parsed.value;
    if (!this.issuer || !this.audience) {
      return err(new PolicyError('SIP authority issuer is not configured'));
    }
    if (claims.issuer !== this.issuer || this.revokedIssuers.has(claims.issuer)) {
      return err(new PolicyError('SIP authority issuer is not trusted'));
    }
    if (claims.audience !== this.audience) {
      return err(new PolicyError('SIP authority audience is not trusted'));
    }
    if (this.revokedKeyIds.has(claims.keyId)) {
      return err(new PolicyError('SIP authority key is revoked'));
    }
    const key = this.keys.get(claims.keyId);
    if (!key) return err(new PolicyError('SIP authority key is unknown'));
    if (!verify(null, signedBytes, key, signature)) {
      return err(new PolicyError('SIP authority signature is invalid'));
    }
    const claimError = validateClaims(claims, input.nowSeconds, this.maxLifetimeSeconds);
    if (claimError) return err(claimError);
    const principal = this.endpointMappings[claims.subject];
    if (!principal || !isPrincipal(principal)) {
      return err(new PolicyError('SIP endpoint subject is not mapped'));
    }
    return ok({
      ...claims,
      proofHash: hashSipProof(input.proof),
      principal,
    });
  }
}

/** Construct the exact assertion bytes used by the reference PBX signer. */
export function encodeSipAssertion(
  claims: Omit<SipAuthorizationClaims, 'version' | 'algorithm'>,
  signature: Uint8Array,
): string {
  const payload: SipAuthorizationClaims = {
    version: 1,
    algorithm: SIP_ASSERTION_ALGORITHM,
    ...claims,
  };
  const payloadBytes = Buffer.from(JSON.stringify(payload), 'utf8');
  const payloadText = payloadBytes.toString('base64url');
  return `${SIP_ASSERTION_VERSION}.${payloadText}.${Buffer.from(signature).toString('base64url')}`;
}

/** Return the one-way binding retained in SQLite instead of the reusable proof. */
export function hashSipProof(proof: string): string {
  return createHash('sha256').update(proof, 'utf8').digest('hex');
}

function parseAssertion(
  proof: string,
): VoiceResult<{ claims: SipAuthorizationClaims; signedBytes: Buffer; signature: Buffer }> {
  const parts = proof.split('.');
  if (parts.length !== 3 || parts[0] !== SIP_ASSERTION_VERSION) {
    return err(new PolicyError('SIP authority assertion format is invalid'));
  }
  const payloadText = parts[1];
  const signatureText = parts[2];
  if (!payloadText || !signatureText) {
    return err(new PolicyError('SIP authority assertion is incomplete'));
  }
  let payloadBytes: Buffer;
  let signature: Buffer;
  try {
    payloadBytes = Buffer.from(payloadText, 'base64url');
    signature = Buffer.from(signatureText, 'base64url');
    if (payloadBytes.length === 0 || signature.length !== 64) throw new Error('invalid encoding');
  } catch {
    return err(new PolicyError('SIP authority assertion encoding is invalid'));
  }
  let raw: unknown;
  try {
    raw = JSON.parse(payloadBytes.toString('utf8'));
  } catch {
    return err(new PolicyError('SIP authority assertion claims are invalid'));
  }
  if (!isClaims(raw)) return err(new PolicyError('SIP authority assertion claims are invalid'));
  return ok({
    claims: raw,
    signedBytes: Buffer.from(`${SIP_ASSERTION_VERSION}.${payloadText}`, 'utf8'),
    signature,
  });
}

function isClaims(value: unknown): value is SipAuthorizationClaims {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate).sort();
  const expected = [
    'algorithm',
    'audience',
    'callBinding',
    'expiresAt',
    'issuedAt',
    'issuer',
    'keyId',
    'nonce',
    'subject',
    'version',
  ].sort();
  return (
    keys.length === expected.length &&
    keys.every((key, index) => key === expected[index]) &&
    candidate.version === 1 &&
    candidate.algorithm === SIP_ASSERTION_ALGORITHM &&
    isBoundedText(candidate.issuer, 256) &&
    isBoundedText(candidate.keyId, 256) &&
    isBoundedText(candidate.audience, 256) &&
    isBoundedText(candidate.subject, 256) &&
    isBoundedText(candidate.nonce, 256) &&
    isBoundedText(candidate.callBinding, 256) &&
    Number.isSafeInteger(candidate.issuedAt) &&
    Number.isSafeInteger(candidate.expiresAt)
  );
}

function validateClaims(
  claims: SipAuthorizationClaims,
  nowSeconds: number,
  maxLifetimeSeconds: number,
): PolicyError | undefined {
  if (Buffer.byteLength(claims.nonce, 'utf8') < SIP_MIN_ASSERTION_NONCE_BYTES) {
    return new PolicyError('SIP authority nonce is too short');
  }
  if (claims.callBinding.length === 0) {
    return new PolicyError('SIP authority call binding is missing');
  }
  if (claims.issuedAt > nowSeconds || claims.expiresAt <= nowSeconds) {
    return new PolicyError('SIP authority assertion is expired or from the future');
  }
  if (claims.expiresAt <= claims.issuedAt) {
    return new PolicyError('SIP authority assertion lifetime is invalid');
  }
  if (claims.expiresAt - claims.issuedAt > maxLifetimeSeconds) {
    return new PolicyError('SIP authority assertion lifetime is too long');
  }
  return undefined;
}

function createPublicKeyMap(input: Readonly<Record<string, string>>): ReadonlyMap<string, KeyObject> {
  const output = new Map<string, KeyObject>();
  for (const [keyId, encoded] of Object.entries(input)) {
    if (!isBoundedText(keyId, 256) || !encoded || Buffer.byteLength(encoded, 'utf8') > 16_384) continue;
    try {
      output.set(keyId, parsePublicKey(encoded));
    } catch {
      // Invalid operator configuration remains deny-by-default.
    }
  }
  return output;
}

function parsePublicKey(encoded: string): KeyObject {
  if (encoded.includes('BEGIN PUBLIC KEY')) return createPublicKey(encoded);
  const bytes = Buffer.from(encoded, 'base64url');
  return createPublicKey({ key: bytes, format: 'der', type: 'spki' });
}

function isPrincipal(value: SipEndpointPrincipal): boolean {
  return (
    isBoundedText(value.ownerId, 256) &&
    isBoundedText(value.personaId, 256)
  );
}

function boundedConfigText(value: string | undefined): string | undefined {
  return value !== undefined && isBoundedText(value, 256) ? value : undefined;
}

function boundedLifetime(value: number | undefined): number {
  if (value === undefined) return SIP_MAX_ASSERTION_LIFETIME_SECONDS;
  return Number.isSafeInteger(value) && value > 0 && value <= SIP_MAX_ASSERTION_LIFETIME_SECONDS
    ? value
    : SIP_MAX_ASSERTION_LIFETIME_SECONDS;
}

function isBoundedText(value: unknown, maxBytes: number): value is string {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= maxBytes;
}

/** Constant-time comparison helper for proof bindings in tests/adapters. */
export function equalSipProofHash(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'utf8');
  const rightBytes = Buffer.from(right, 'utf8');
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}
