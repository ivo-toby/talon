/**
 * Unit tests for capability-merger utilities.
 *
 * Tests cover:
 *   - mergeCapabilities: persona-only, with skill capabilities, intersection,
 *     requireApproval override, empty inputs, duplicates, edge cases
 *   - validateCapabilityLabels: valid labels, missing scope warnings,
 *     malformed labels, empty inputs, mixed allow/requireApproval lists
 */

import { describe, it, expect } from 'vitest';
import { mergeCapabilities, validateCapabilityLabels } from '../../../src/personas/capability-merger.js';
import type { CapabilitiesConfig } from '../../../src/personas/persona-types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function caps(allow: string[], requireApproval: string[] = []): CapabilitiesConfig {
  return { allow, requireApproval };
}

// ---------------------------------------------------------------------------
// mergeCapabilities — persona only (no skills)
// ---------------------------------------------------------------------------

describe('mergeCapabilities — persona only', () => {
  it('returns persona allow list when no skills provided', () => {
    const result = mergeCapabilities(caps(['fs.read:workspace', 'net.http:egress']));
    expect(result.allow).toContain('fs.read:workspace');
    expect(result.allow).toContain('net.http:egress');
    expect(result.requireApproval).toHaveLength(0);
  });

  it('returns empty allow when persona allow is empty', () => {
    const result = mergeCapabilities(caps([]));
    expect(result.allow).toHaveLength(0);
    expect(result.requireApproval).toHaveLength(0);
  });

  it('requireApproval labels from persona appear in requireApproval', () => {
    const result = mergeCapabilities(caps(['fs.read:workspace'], ['net.http:egress']));
    expect(result.requireApproval).toContain('net.http:egress');
  });

  it('requireApproval overrides allow — label in both ends up only in requireApproval', () => {
    const result = mergeCapabilities(caps(['fs.read:workspace', 'net.http:egress'], ['net.http:egress']));
    expect(result.allow).not.toContain('net.http:egress');
    expect(result.requireApproval).toContain('net.http:egress');
  });

  it('returns empty when both lists are empty', () => {
    const result = mergeCapabilities(caps([], []));
    expect(result.allow).toHaveLength(0);
    expect(result.requireApproval).toHaveLength(0);
  });

  it('empty skills array behaves the same as undefined', () => {
    const withUndefined = mergeCapabilities(caps(['fs.read:workspace']));
    const withEmpty = mergeCapabilities(caps(['fs.read:workspace']), []);
    expect(withEmpty.allow).toEqual(withUndefined.allow);
    expect(withEmpty.requireApproval).toEqual(withUndefined.requireApproval);
  });
});

// ---------------------------------------------------------------------------
// mergeCapabilities — with skill capabilities
// ---------------------------------------------------------------------------

describe('mergeCapabilities — with skills', () => {
  it('intersects skill allow with persona allow', () => {
    const result = mergeCapabilities(
      caps(['fs.read:workspace', 'net.http:egress']),
      [caps(['fs.read:workspace', 'channel.send:telegram'])],
    );
    // fs.read:workspace is in both — granted
    expect(result.allow).toContain('fs.read:workspace');
    // channel.send:telegram is not in persona allow — excluded
    expect(result.allow).not.toContain('channel.send:telegram');
    // net.http:egress is in persona but not requested by skill — excluded (intersection)
    expect(result.allow).not.toContain('net.http:egress');
  });

  it('merges requireApproval from persona and skill', () => {
    const result = mergeCapabilities(
      caps(['fs.read:workspace'], ['net.http:egress']),
      [caps(['fs.read:workspace'], ['memory.write:thread'])],
    );
    expect(result.requireApproval).toContain('net.http:egress');
    expect(result.requireApproval).toContain('memory.write:thread');
  });

  it('requireApproval from skill overrides allow from persona', () => {
    const result = mergeCapabilities(
      caps(['fs.read:workspace', 'net.http:egress']),
      [caps(['net.http:egress'], ['net.http:egress'])],
    );
    // net.http:egress requested by skill but also in skill requireApproval
    expect(result.allow).not.toContain('net.http:egress');
    expect(result.requireApproval).toContain('net.http:egress');
  });

  it('no intersection — all skill-requested labels blocked by persona', () => {
    const result = mergeCapabilities(
      caps(['fs.read:workspace']),
      [caps(['net.http:egress', 'channel.send:telegram'])],
    );
    expect(result.allow).toHaveLength(0);
  });

  it('full intersection — all skill labels permitted by persona', () => {
    const result = mergeCapabilities(
      caps(['fs.read:workspace', 'net.http:egress']),
      [caps(['fs.read:workspace', 'net.http:egress'])],
    );
    expect(result.allow).toContain('fs.read:workspace');
    expect(result.allow).toContain('net.http:egress');
  });

  it('multiple skills — union of their requested labels is intersected with persona', () => {
    const result = mergeCapabilities(
      caps(['fs.read:workspace', 'net.http:egress', 'memory.write:thread']),
      [
        caps(['fs.read:workspace']),
        caps(['net.http:egress']),
      ],
    );
    expect(result.allow).toContain('fs.read:workspace');
    expect(result.allow).toContain('net.http:egress');
    expect(result.allow).not.toContain('memory.write:thread');
  });

  it('deduplicates labels when multiple skills request the same capability', () => {
    const result = mergeCapabilities(
      caps(['fs.read:workspace']),
      [
        caps(['fs.read:workspace']),
        caps(['fs.read:workspace']),
      ],
    );
    const count = result.allow.filter((l) => l === 'fs.read:workspace').length;
    expect(count).toBe(1);
  });

  it('skill with empty capabilities does not contribute any labels', () => {
    const result = mergeCapabilities(
      caps(['fs.read:workspace']),
      [caps([])],
    );
    // Skill requests nothing, so intersection is empty.
    expect(result.allow).toHaveLength(0);
  });

  it('persona with no allow blocks all skill requests', () => {
    const result = mergeCapabilities(
      caps([]),
      [caps(['fs.read:workspace'])],
    );
    expect(result.allow).toHaveLength(0);
  });

  it('skill requireApproval deduplicates with persona requireApproval', () => {
    const result = mergeCapabilities(
      caps([], ['net.http:egress']),
      [caps([], ['net.http:egress'])],
    );
    const count = result.requireApproval.filter((l) => l === 'net.http:egress').length;
    expect(count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// validateCapabilityLabels — valid labels
// ---------------------------------------------------------------------------

describe('validateCapabilityLabels — valid labels', () => {
  it('returns valid=true and no warnings for well-formed allow labels', () => {
    const { valid, warnings } = validateCapabilityLabels({
      allow: ['fs.read:workspace', 'net.http:egress', 'channel.send:telegram'],
      requireApproval: [],
    });
    expect(valid).toBe(true);
    expect(warnings).toHaveLength(0);
  });

  it('returns valid=true and no warnings for well-formed requireApproval labels', () => {
    const { valid, warnings } = validateCapabilityLabels({
      allow: [],
      requireApproval: ['memory.write:thread'],
    });
    expect(valid).toBe(true);
    expect(warnings).toHaveLength(0);
  });

  it('returns valid=true for empty capability lists', () => {
    const { valid, warnings } = validateCapabilityLabels({ allow: [], requireApproval: [] });
    expect(valid).toBe(true);
    expect(warnings).toHaveLength(0);
  });

  it('accepts labels with wildcard scope', () => {
    const { valid, warnings } = validateCapabilityLabels({
      allow: ['fs.read:*', 'memory.access:*', 'subagent.invoke:*'],
      requireApproval: [],
    });
    expect(valid).toBe(true);
    expect(warnings).toHaveLength(0);
  });

  it('accepts labels with underscores in each segment', () => {
    const { valid, warnings } = validateCapabilityLabels({
      allow: ['my_domain.some_action:my_scope'],
      requireApproval: [],
    });
    expect(valid).toBe(true);
    expect(warnings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// validateCapabilityLabels — labels missing scope (warn, not fail)
// ---------------------------------------------------------------------------

describe('validateCapabilityLabels — missing scope segment', () => {
  it('emits a warning for a label without scope but does not fail', () => {
    const { valid, warnings } = validateCapabilityLabels({
      allow: ['fs.read'],
      requireApproval: [],
    });
    // Missing scope produces a warning but valid stays true.
    expect(valid).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/fs\.read/);
    expect(warnings[0]).toMatch(/missing scope/i);
  });

  it('emits a warning for each missing-scope label across both lists', () => {
    const { valid, warnings } = validateCapabilityLabels({
      allow: ['fs.read'],
      requireApproval: ['net.http'],
    });
    expect(valid).toBe(true);
    expect(warnings).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// validateCapabilityLabels — malformed labels (valid=false)
// ---------------------------------------------------------------------------

describe('validateCapabilityLabels — malformed labels', () => {
  it('returns valid=false for a completely malformed label in allow', () => {
    const { valid, warnings } = validateCapabilityLabels({
      allow: ['not-valid!!'],
      requireApproval: [],
    });
    expect(valid).toBe(false);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toMatch(/malformed/i);
  });

  it('returns valid=false for an empty string label', () => {
    const { valid, warnings } = validateCapabilityLabels({
      allow: [''],
      requireApproval: [],
    });
    expect(valid).toBe(false);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('returns valid=false for a label with no separators', () => {
    const { valid } = validateCapabilityLabels({
      allow: ['fsread'],
      requireApproval: [],
    });
    expect(valid).toBe(false);
  });

  it('returns valid=false for a malformed label in requireApproval', () => {
    const { valid, warnings } = validateCapabilityLabels({
      allow: [],
      requireApproval: ['bad-label'],
    });
    expect(valid).toBe(false);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('sets valid=false even when mix of good and bad labels', () => {
    const { valid } = validateCapabilityLabels({
      allow: ['fs.read:workspace', 'INVALID!!!'],
      requireApproval: [],
    });
    expect(valid).toBe(false);
  });

  it('collects warnings for every malformed label', () => {
    const { warnings } = validateCapabilityLabels({
      allow: ['bad1', 'bad2'],
      requireApproval: ['bad3'],
    });
    expect(warnings).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// validateCapabilityLabels — hyphenated scope segments
// ---------------------------------------------------------------------------

describe('validateCapabilityLabels — hyphenated scope segments', () => {
  it('accepts hyphenated scope (skill.exec:git-flow)', () => {
    const { valid, warnings } = validateCapabilityLabels({
      allow: ['skill.exec:git-flow', 'skill.exec:my-cool-skill'],
      requireApproval: [],
    });
    expect(valid).toBe(true);
    expect(warnings).toHaveLength(0);
  });

  it('still accepts wildcard scope (skill.exec:*)', () => {
    const { valid, warnings } = validateCapabilityLabels({
      allow: ['skill.exec:*'],
      requireApproval: [],
    });
    expect(valid).toBe(true);
    expect(warnings).toHaveLength(0);
  });

  it('rejects scope with spaces (skill.exec:git flow)', () => {
    const { valid, warnings } = validateCapabilityLabels({
      allow: ['skill.exec:git flow'],
      requireApproval: [],
    });
    expect(valid).toBe(false);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toMatch(/malformed/i);
  });

  it('rejects empty scope (skill.exec:)', () => {
    const { valid, warnings } = validateCapabilityLabels({
      allow: ['skill.exec:'],
      requireApproval: [],
    });
    expect(valid).toBe(false);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('rejects scope with slash (skill.exec:git/flow)', () => {
    const { valid, warnings } = validateCapabilityLabels({
      allow: ['skill.exec:git/flow'],
      requireApproval: [],
    });
    expect(valid).toBe(false);
    expect(warnings.length).toBeGreaterThan(0);
  });
});
