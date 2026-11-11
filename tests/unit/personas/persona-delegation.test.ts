import { describe, expect, it } from 'vitest';
import {
  allowedDelegationTargets,
  canDelegateTo,
  describeDelegationTargets,
  filterDelegationTargets,
  unknownDelegationTargets,
} from '../../../src/personas/persona-delegation.js';
import { validateCapabilityLabels } from '../../../src/personas/capability-merger.js';
import type { ResolvedCapabilities } from '../../../src/personas/persona-types.js';

const caps = (allow: string[], requireApproval: string[] = []): ResolvedCapabilities => ({ allow, requireApproval });

describe('allowedDelegationTargets', () => {
  it('returns all for persona.send:*', () => {
    expect(allowedDelegationTargets(caps(['persona.send:*']))).toBe('all');
  });

  it('treats an unscoped persona.send as all (same as every other unscoped tool label)', () => {
    expect(allowedDelegationTargets(caps(['persona.send']))).toBe('all');
    expect(allowedDelegationTargets(caps(['persona.send:']))).toBe('all');
  });

  it('collects scoped names from several labels, across allow and requireApproval', () => {
    const allowed = allowedDelegationTargets(caps(['persona.send:a', 'persona.send:b'], ['persona.send:c-d']));
    expect(allowed).toEqual(new Set(['a', 'b', 'c-d']));
  });

  it('lets a wildcard win over scoped labels', () => {
    expect(allowedDelegationTargets(caps(['persona.send:a', 'persona.send:*']))).toBe('all');
  });

  it('is an empty set without any persona.send label (fail closed)', () => {
    expect(allowedDelegationTargets(caps([]))).toEqual(new Set());
    expect(allowedDelegationTargets(caps(['channel.send:*', 'persona.sendx:a', 'xpersona.send:a']))).toEqual(new Set());
  });
});

describe('canDelegateTo', () => {
  it('matches exact names only', () => {
    const c = caps(['persona.send:researcher']);
    expect(canDelegateTo(c, 'researcher')).toBe(true);
    expect(canDelegateTo(c, 'Researcher')).toBe(false);
    expect(canDelegateTo(c, 'researcher2')).toBe(false);
    expect(canDelegateTo(c, '*')).toBe(false);
  });

  it('allows anything for *', () => {
    expect(canDelegateTo(caps(['persona.send:*']), 'whoever')).toBe(true);
  });

  it('denies everything with no label', () => {
    expect(canDelegateTo(caps([]), 'x')).toBe(false);
  });
});

describe('filterDelegationTargets / describeDelegationTargets', () => {
  it('filters names and keeps order', () => {
    expect(filterDelegationTargets(caps(['persona.send:c', 'persona.send:a']), ['a', 'b', 'c'])).toEqual(['a', 'c']);
    expect(filterDelegationTargets(caps(['persona.send:*']), ['a', 'b'])).toEqual(['a', 'b']);
  });

  it('describes targets sorted, any persona, or none', () => {
    expect(describeDelegationTargets('all')).toBe('any persona');
    expect(describeDelegationTargets(new Set(['b', 'a']))).toBe('a, b');
    expect(describeDelegationTargets(new Set())).toBe('none');
  });
});

describe('unknownDelegationTargets', () => {
  it('reports scoped names that are not configured personas, even next to a wildcard', () => {
    const known = new Set(['a', 'b']);
    expect(unknownDelegationTargets(caps(['persona.send:a', 'persona.send:zzz', 'persona.send:*']), known)).toEqual(['zzz']);
    expect(unknownDelegationTargets(caps(['persona.send:*', 'persona.send']), known)).toEqual([]);
  });
});

describe('validateCapabilityLabels with persona names', () => {
  it('accepts persona names with hyphens and dots as fully valid scopes', () => {
    const { valid, warnings } = validateCapabilityLabels(caps(['persona.send:code-reviewer', 'persona.send:v1.2']));
    expect(valid).toBe(true);
    expect(warnings).toEqual([]);
  });
});
