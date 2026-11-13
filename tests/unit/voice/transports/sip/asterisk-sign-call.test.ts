import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { ConfiguredSipAuthorizationResolver } from '../../../../../src/voice/transports/sip/sip-authorization.js';
import {
  createAssertion,
  parseAgiEnvironment,
} from '../../../../../scripts/voice/asterisk-sign-call.mjs';

const signerPath = join(import.meta.dirname, '../../../../../scripts/voice/asterisk-sign-call.mjs');

describe('Asterisk SIP signer reference', () => {
  it('uses native Ed25519 and interoperates with the Talon resolver', () => {
    const keys = generateKeyPairSync('ed25519');
    const publicKey = keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url');
    const assertion = createAssertion({
      privateKey: keys.privateKey,
      issuer: 'operator-issuer',
      keyId: 'primary',
      audience: 'talon-incoming',
      subject: 'endpoint-1',
      callBinding: 'asterisk-call-1',
      issuedAt: 1_000,
      lifetimeSeconds: 60,
      nonce: 'nonce-0123456789ab',
    });
    const resolver = new ConfiguredSipAuthorizationResolver({
      issuer: 'operator-issuer',
      audience: 'talon-incoming',
      publicKeys: { primary: publicKey },
      endpointMappings: { 'endpoint-1': { ownerId: 'owner-1', personaId: 'persona-1' } },
    });
    const verified = resolver.resolve({
      proof: assertion,
      providerSessionId: 'provider-session-1',
      nowSeconds: 1_001,
    });
    expect(verified.isOk()).toBe(true);
    expect(verified._unsafeUnwrap().principal).toEqual({ ownerId: 'owner-1', personaId: 'persona-1' });
  });

  it('rejects malformed, duplicated, newline, and oversized AGI fields', () => {
    expect(parseAgiEnvironment('agi_channel: PJSIP/1\nagi_type: SIP\n\n')).toMatchObject({
      agi_channel: 'PJSIP/1',
      agi_type: 'SIP',
    });
    expect(() => parseAgiEnvironment('agi_channel: one\nagi_channel: two\n\n')).toThrow();
    expect(() => parseAgiEnvironment('agi_channel: one\nBAD\n\n')).toThrow();
    expect(() => parseAgiEnvironment(`agi_channel: ${'x'.repeat(1_025)}\n\n`)).toThrow();
    expect(() => parseAgiEnvironment('agi_channel: one\r\nagi_type: two\n\n')).not.toThrow();
  });

  it('performs the AGI exchange without shell arguments or logging the assertion', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'talon-sip-signer-'));
    const keyPath = join(directory, 'ed25519-private.pem');
    const keys = generateKeyPairSync('ed25519');
    writeFileSync(keyPath, keys.privateKey.export({ format: 'pem', type: 'pkcs8' }));
    try {
      const child = spawn(process.execPath, [signerPath], {
        env: {
          ...process.env,
          TALON_SIP_PRIVATE_KEY_FILE: keyPath,
          TALON_SIP_ISSUER: 'operator-issuer',
          TALON_SIP_KEY_ID: 'primary',
          TALON_SIP_AUDIENCE: 'talon-incoming',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
      child.stdin.end(
        'agi_channel: PJSIP/1\nagi_type: SIP\n\n' +
          '200 result=1 (endpoint-1)\n200 result=1 (asterisk-call-1)\n200 result=1\n',
      );
      const exitCode = await new Promise<number>((resolve) => child.once('exit', (code) => resolve(code ?? 1)));
      const output = Buffer.concat(stdout).toString('utf8');
      expect(exitCode).toBe(0);
      expect(output).toContain('GET VARIABLE TALON_SIP_ENDPOINT_SUBJECT\n');
      expect(output).toContain('GET VARIABLE TALON_SIP_CALL_BINDING\n');
      expect(output).toMatch(/SET VARIABLE TALON_VOICE_ASSERTION talon-sip-v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\n/u);
      expect(Buffer.concat(stderr).toString('utf8')).toBe('');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('documents caller-only assertion inheritance into the b() pre-dial handler', () => {
    const dialplan = readFileSync(
      join(import.meta.dirname, '../../../../../examples/voice/asterisk/extensions.conf.example'),
      'utf8',
    );
    expect(dialplan).toContain('Set(_TALON_VOICE_ASSERTION=${TALON_VOICE_ASSERTION})');
    expect(dialplan).toContain('Dial(PJSIP/talon-live,,b(talon-outgoing-assertion^s^1))');
    expect(dialplan).toContain('Set(PJSIP_HEADER(remove,X-Talon-Voice-Assertion)=)');
    expect(dialplan).toContain('Set(PJSIP_HEADER(add,X-Talon-Voice-Assertion)=${TALON_VOICE_ASSERTION})');
    expect(dialplan.match(/PJSIP_HEADER\(add,X-Talon-Voice-Assertion\)/gu)).toHaveLength(1);
    expect(dialplan).not.toContain('Set(__TALON_VOICE_ASSERTION=');
  });
});
