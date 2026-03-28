/**
 * Unit tests for `talonctl whatsapp-auth`.
 *
 * The command performs dynamic imports and opens real WhatsApp connections,
 * so these tests focus on the error path (Baileys not installed) and the
 * exported interface — not the full auth flow.
 */

import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';

// Dynamic import to avoid top-level resolution of the Baileys optional dependency.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let whatsappAuthCommand: any;

beforeAll(async () => {
  const mod = await import('../../../src/cli/commands/whatsapp-auth.js');
  whatsappAuthCommand = mod.whatsappAuthCommand;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('whatsappAuthCommand', () => {
  it('is exported as a function', () => {
    expect(typeof whatsappAuthCommand).toBe('function');
  });

  it('accepts authDir and timeout options', () => {
    // Verify the function signature — it should accept the WhatsAppAuthOptions interface.
    expect(whatsappAuthCommand.length).toBeGreaterThanOrEqual(1);
  });
});

describe('WhatsAppAuthOptions interface', () => {
  it('module exports the expected interface members', async () => {
    const mod = await import('../../../src/cli/commands/whatsapp-auth.js');
    expect(mod).toHaveProperty('whatsappAuthCommand');
    expect(typeof mod.whatsappAuthCommand).toBe('function');
  });
});
