import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ConfiguredSipAuthorizationResolver,
  SIP_ASSERTION_ALGORITHM,
  SIP_ASSERTION_VERSION,
  encodeSipAssertion,
} from '../../../../../src/voice/transports/sip/sip-authorization.js';

const NOW = 1_000;

function fixture() {
  const keys = generateKeyPairSync('ed25519');
  const publicKey = keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url');
  const resolver = new ConfiguredSipAuthorizationResolver({
    issuer: 'operator-issuer',
    audience: 'talon-incoming',
    publicKeys: { primary: publicKey },
    endpointMappings: { 'endpoint-1': { ownerId: 'owner-1', personaId: 'persona-1' } },
  });
  return { privateKey: keys.privateKey, publicKey, resolver };
}

function proof(
  privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'],
  overrides: Partial<{
    issuer: string;
    keyId: string;
    audience: string;
    subject: string;
    nonce: string;
    callBinding: string;
    issuedAt: number;
    expiresAt: number;
  }> = {},
): string {
  const claims = {
    issuer: 'operator-issuer',
    keyId: 'primary',
    audience: 'talon-incoming',
    subject: 'endpoint-1',
    nonce: 'nonce-0123456789ab',
    callBinding: 'pbx-call-1',
    issuedAt: NOW - 5,
    expiresAt: NOW + 55,
    ...overrides,
  };
  const encoded = Buffer.from(
    JSON.stringify({ version: 1, algorithm: SIP_ASSERTION_ALGORITHM, ...claims }),
    'utf8',
  ).toString('base64url');
  const signed = Buffer.from(`${SIP_ASSERTION_VERSION}.${encoded}`, 'utf8');
  return encodeSipAssertion(claims, sign(null, signed, privateKey));
}

describe('ConfiguredSipAuthorizationResolver', () => {
  it('verifies the fixed Ed25519 envelope and maps only the authenticated endpoint', () => {
    const { privateKey, resolver } = fixture();
    const result = resolver.resolve({
      proof: proof(privateKey),
      providerSessionId: 'provider-session-1',
      nowSeconds: NOW,
    });

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toMatchObject({
      issuer: 'operator-issuer',
      subject: 'endpoint-1',
      principal: { ownerId: 'owner-1', personaId: 'persona-1' },
    });
    expect(result._unsafeUnwrap().proofHash).toHaveLength(64);
  });

  it('denies missing configuration, unknown subjects, and caller-proof mutations', () => {
    const keys = generateKeyPairSync('ed25519');
    const encoded = Buffer.from(
      JSON.stringify({
        version: 1,
        algorithm: SIP_ASSERTION_ALGORITHM,
        issuer: 'operator-issuer',
        keyId: 'primary',
        audience: 'talon-incoming',
        subject: 'unknown-endpoint',
        nonce: 'nonce-0123456789ab',
        callBinding: 'pbx-call-1',
        issuedAt: NOW - 5,
        expiresAt: NOW + 55,
      }),
      'utf8',
    ).toString('base64url');
    const validShape = `${SIP_ASSERTION_VERSION}.${encoded}.${sign(
      null,
      Buffer.from(`${SIP_ASSERTION_VERSION}.${encoded}`),
      keys.privateKey,
    ).toString('base64url')}`;
    const unknown = new ConfiguredSipAuthorizationResolver({
      issuer: 'operator-issuer',
      audience: 'talon-incoming',
      publicKeys: {
        primary: keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'),
      },
      endpointMappings: {},
    });
    expect(
      unknown.resolve({ proof: validShape, providerSessionId: 's', nowSeconds: NOW }).isErr(),
    ).toBe(true);
    expect(
      new ConfiguredSipAuthorizationResolver().resolve({
        proof: validShape,
        providerSessionId: 's',
        nowSeconds: NOW,
      }).isErr(),
    ).toBe(true);
  });

  it('rejects invalid signature, lifetime, time, key rotation, and revoked key claims', () => {
    const { privateKey, publicKey, resolver } = fixture();
    const valid = proof(privateKey);
    const parts = valid.split('.');
    const forged = `${parts[0]}.${parts[1]}.${Buffer.from('forged').toString('base64url')}`;
    expect(resolver.resolve({ proof: forged, providerSessionId: 's', nowSeconds: NOW }).isErr()).toBe(true);
    expect(
      resolver.resolve({
        proof: proof(privateKey, { expiresAt: NOW + 61 }),
        providerSessionId: 's',
        nowSeconds: NOW,
      }).isErr(),
    ).toBe(true);
    expect(
      resolver.resolve({
        proof: proof(privateKey, { issuedAt: NOW + 1 }),
        providerSessionId: 's',
        nowSeconds: NOW,
      }).isErr(),
    ).toBe(true);
    const revoked = new ConfiguredSipAuthorizationResolver({
      issuer: 'operator-issuer',
      audience: 'talon-incoming',
      publicKeys: { primary: publicKey },
      revokedKeyIds: ['primary'],
    });
    expect(revoked.resolve({ proof: valid, providerSessionId: 's', nowSeconds: NOW }).isErr()).toBe(true);
  });

  it('rejects short nonces, unsupported algorithms, and oversized proofs', () => {
    const { privateKey, resolver } = fixture();
    expect(
      resolver.resolve({
        proof: proof(privateKey, { nonce: 'short' }),
        providerSessionId: 's',
        nowSeconds: NOW,
      }).isErr(),
    ).toBe(true);
    const supportedProof = proof(privateKey);
    const supportedParts = supportedProof.split('.');
    const unsupportedClaims = JSON.parse(
      Buffer.from(supportedParts[1]!, 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
    unsupportedClaims.algorithm = 'RS256';
    const unsupportedPayload = Buffer.from(JSON.stringify(unsupportedClaims), 'utf8').toString('base64url');
    const unsupported = `${SIP_ASSERTION_VERSION}.${unsupportedPayload}.${sign(
      null,
      Buffer.from(`${SIP_ASSERTION_VERSION}.${unsupportedPayload}`),
      privateKey,
    ).toString('base64url')}`;
    expect(
      resolver.resolve({ proof: unsupported, providerSessionId: 's', nowSeconds: NOW }).isErr(),
    ).toBe(true);
    expect(
      resolver.resolve({
        proof: `${proof(privateKey)}${'x'.repeat(2_000)}`,
        providerSessionId: 's',
        nowSeconds: NOW,
      }).isErr(),
    ).toBe(true);
  });
});
