import { describe, expect, it } from 'vitest';
import { scriptRunAccess } from '@talon/scripts/run-policy.js';

const caps = (allow: string[], requireApproval: string[] = []) => ({ allow, requireApproval });

describe('scriptRunAccess', () => {
  it('denies without a matching label', () => {
    expect(scriptRunAccess(caps([]), 'mail-intake')).toBe('denied');
    expect(scriptRunAccess(caps(['script.manage:own']), 'mail-intake')).toBe('denied');
    expect(scriptRunAccess(caps(['script.running:*']), 'mail-intake')).toBe('denied');
    expect(scriptRunAccess(caps(['script.run:mail-intake']), 'heartbeat')).toBe('denied');
    expect(scriptRunAccess(caps(['script.run:Mail-Intake']), 'mail-intake')).toBe('denied');
  });

  it('allows wildcard, unscoped and named labels', () => {
    expect(scriptRunAccess(caps(['script.run:*']), 'mail-intake')).toBe('allowed');
    expect(scriptRunAccess(caps(['script.run']), 'mail-intake')).toBe('allowed');
    expect(scriptRunAccess(caps(['script.run:mail-intake']), 'mail-intake')).toBe('allowed');
    expect(scriptRunAccess(caps(['script.run: mail-intake ']), 'mail-intake')).toBe('allowed');
  });

  it('lets requireApproval win over allow', () => {
    expect(scriptRunAccess(caps([], ['script.run:*']), 'mail-intake')).toBe('approval');
    expect(scriptRunAccess(caps(['script.run:*'], ['script.run:mail-intake']), 'mail-intake')).toBe(
      'approval',
    );
    expect(scriptRunAccess(caps(['script.run:*'], ['script.run:mail-intake']), 'heartbeat')).toBe(
      'allowed',
    );
  });
});
