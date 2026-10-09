import { describe, expect, it } from 'vitest';
import { TalondConfigSchema } from '../src/core/config/config-schema.js';

describe('attachment origin configuration', () => {
  it('defaults to deny-all', () => {
    const config = TalondConfigSchema.parse({});
    expect(config.attachments).toEqual({ allowedOrigins: [], privateOrigins: [] });
  });

  it('allows explicitly named private origins', () => {
    const origin = 'http://192.168.1.161:3300';
    const config = TalondConfigSchema.parse({
      attachments: { allowedOrigins: [origin], privateOrigins: [origin] },
    });
    expect(config.attachments.privateOrigins).toEqual([origin]);
  });

  it.each([
    'ftp://files.example.com',
    'https://user:password@files.example.com',
    'https://files.example.com/path',
    'https://files.example.com?secret=yes',
    'https://files.example.com/#fragment',
  ])('rejects an invalid origin: %s', (origin) => {
    expect(TalondConfigSchema.safeParse({
      attachments: { allowedOrigins: [origin] },
    }).success).toBe(false);
  });

  it('rejects private exceptions missing from the general allowlist', () => {
    expect(TalondConfigSchema.safeParse({
      attachments: { privateOrigins: ['http://192.168.1.161:3300'] },
    }).success).toBe(false);
  });
});
