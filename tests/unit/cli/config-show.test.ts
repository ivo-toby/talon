import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { configShow } from '../../../src/cli/commands/config-show.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'talon-config-show-test-'));
});

afterEach(async () => {
  delete process.env.TEST_CONFIG_SHOW_SIP_SECRET;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function writeYaml(content: string): string {
  const p = join(tmpDir, 'talond.yaml');
  writeFileSync(p, content);
  return p;
}

describe('configShow()', () => {
  it('returns YAML output', async () => {
    const p = writeYaml('logLevel: info\nchannels: []\n');
    const output = await configShow({ configPath: p });

    expect(output).toContain('logLevel');
    expect(output).toContain('info');
  });

  it('substitutes env vars', async () => {
    process.env.TEST_CONFIG_SHOW_VAR = 'my-secret-token';
    const p = writeYaml('token: ${TEST_CONFIG_SHOW_VAR}\n');
    const output = await configShow({ configPath: p, showSecrets: true });

    expect(output).toContain('my-secret-token');
    delete process.env.TEST_CONFIG_SHOW_VAR;
  });

  it('masks secret values by default', async () => {
    const p = writeYaml('channels:\n  - name: tg\n    type: telegram\n    config:\n      token: super-secret\n');
    const output = await configShow({ configPath: p });

    expect(output).toContain('MASKED');
    expect(output).not.toContain('super-secret');
  });

  it('shows secrets when --show-secrets is used', async () => {
    const p = writeYaml('channels:\n  - name: tg\n    type: telegram\n    config:\n      token: super-secret\n');
    const output = await configShow({ configPath: p, showSecrets: true });

    expect(output).toContain('super-secret');
    expect(output).not.toContain('MASKED');
  });

  it('masks nested secret keys', async () => {
    const p = writeYaml('channels:\n  - config:\n      botToken: secret1\n      appToken: secret2\n');
    const output = await configShow({ configPath: p });

    expect(output).not.toContain('secret1');
    expect(output).not.toContain('secret2');
  });

  it('masks extended secret keys (signingSecret, clientSecret, privateKey)', async () => {
    const p = writeYaml('oauth:\n  clientSecret: abc123\n  signingSecret: xyz789\n  privateKey: my-key\n');
    const output = await configShow({ configPath: p });

    expect(output).not.toContain('abc123');
    expect(output).not.toContain('xyz789');
    expect(output).not.toContain('my-key');
    expect(output).toContain('MASKED');
  });

  it('masks the SIP webhook secret while preserving SIP references and public metadata', async () => {
    const p = writeYaml(`
voice:
  sip:
    standardWebhookSecret: synthetic-sip-webhook-secret
    standardWebhookSecretRef: openai-webhook
    issuer: operator-issuer
    audience: talon-incoming
    publicKeys:
      primary: synthetic-public-key
    revokedIssuers:
      - revoked-issuer
    revokedKeyIds:
      - revoked-key
`);
    const output = await configShow({ configPath: p });

    expect(output).toContain('MASKED');
    expect(output).not.toContain('synthetic-sip-webhook-secret');
    expect(output).toContain('standardWebhookSecretRef');
    expect(output).toContain('openai-webhook');
    expect(output).toContain('operator-issuer');
    expect(output).toContain('talon-incoming');
    expect(output).toContain('synthetic-public-key');
    expect(output).toContain('revoked-issuer');
    expect(output).toContain('revoked-key');
  });

  it('masks env-substituted SIP secrets in nested array objects', async () => {
    process.env.TEST_CONFIG_SHOW_SIP_SECRET = 'env-sip-webhook-secret';
    const p = writeYaml(`
voice:
  sip:
    standardWebhookSecret: \${TEST_CONFIG_SHOW_SIP_SECRET}
channels:
  - name: nested-secret
    config:
      standardWebhookSecret: nested-array-sip-secret
`);
    const output = await configShow({ configPath: p });

    expect(output).not.toContain('env-sip-webhook-secret');
    expect(output).not.toContain('nested-array-sip-secret');
    expect(output.match(/MASKED/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('shows the SIP webhook secret when --show-secrets is used', async () => {
    const p = writeYaml(`
voice:
  sip:
    standardWebhookSecret: synthetic-sip-webhook-secret
`);
    const output = await configShow({ configPath: p, showSecrets: true });

    expect(output).toContain('synthetic-sip-webhook-secret');
    expect(output).not.toContain('MASKED');
  });

  it('throws for non-existent config', async () => {
    await expect(configShow({ configPath: join(tmpDir, 'nope.yaml') }))
      .rejects.toThrow(/not found/);
  });
});
