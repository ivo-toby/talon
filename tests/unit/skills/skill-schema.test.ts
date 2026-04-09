import { describe, it, expect } from 'vitest';
import {
  SkillManifestSchema,
  SkillMdFrontmatterSchema,
} from '@talon/skills/skill-schema';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MINIMAL_SANDBOX = {};

function parseManifest(input: Record<string, unknown>) {
  return SkillManifestSchema.safeParse(input);
}

function parseFrontmatter(input: Record<string, unknown>) {
  return SkillMdFrontmatterSchema.safeParse(input);
}

// ---------------------------------------------------------------------------
// SkillMdFrontmatterSchema — sandbox integration
// ---------------------------------------------------------------------------

describe('SkillMdFrontmatterSchema', () => {
  const base = {
    name: 'contentful',
    description: 'Contentful CMS skill',
  };

  it('accepts frontmatter without a sandbox block (unchanged behavior)', () => {
    const result = parseFrontmatter(base);
    expect(result.success).toBe(true);
  });

  it('accepts frontmatter with sandbox and matching requiredCapabilities', () => {
    const result = parseFrontmatter({
      ...base,
      sandbox: MINIMAL_SANDBOX,
      requiredCapabilities: ['skill.exec:contentful'],
    });
    expect(result.success).toBe(true);
  });

  it('rejects frontmatter with sandbox but no requiredCapabilities', () => {
    const result = parseFrontmatter({
      ...base,
      sandbox: MINIMAL_SANDBOX,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message);
      expect(messages).toContainEqual(
        expect.stringContaining("skill.exec:contentful"),
      );
    }
  });

  it('rejects frontmatter with sandbox and mismatched requiredCapabilities', () => {
    const result = parseFrontmatter({
      ...base,
      sandbox: MINIMAL_SANDBOX,
      requiredCapabilities: ['skill.exec:wrong-name'],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message);
      expect(messages).toContainEqual(
        expect.stringContaining("skill.exec:contentful"),
      );
    }
  });

  it('accepts frontmatter with sandbox and extra capabilities beyond the required one', () => {
    const result = parseFrontmatter({
      ...base,
      sandbox: MINIMAL_SANDBOX,
      requiredCapabilities: ['skill.exec:contentful', 'network.http'],
    });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SkillManifestSchema — sandbox integration
// ---------------------------------------------------------------------------

describe('SkillManifestSchema', () => {
  const base = {
    name: 'contentful',
    version: '1.0.0',
    description: 'Contentful CMS skill',
  };

  it('accepts manifest without a sandbox block (unchanged behavior)', () => {
    const result = parseManifest(base);
    expect(result.success).toBe(true);
  });

  it('accepts manifest with sandbox and matching requiredCapabilities', () => {
    const result = parseManifest({
      ...base,
      sandbox: MINIMAL_SANDBOX,
      requiredCapabilities: ['skill.exec:contentful'],
    });
    expect(result.success).toBe(true);
  });

  it('rejects manifest with sandbox but no requiredCapabilities', () => {
    const result = parseManifest({
      ...base,
      sandbox: MINIMAL_SANDBOX,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message);
      expect(messages).toContainEqual(
        expect.stringContaining("skill.exec:contentful"),
      );
    }
  });

  it('rejects manifest with sandbox and mismatched requiredCapabilities', () => {
    const result = parseManifest({
      ...base,
      sandbox: MINIMAL_SANDBOX,
      requiredCapabilities: ['skill.exec:wrong-name'],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message);
      expect(messages).toContainEqual(
        expect.stringContaining("skill.exec:contentful"),
      );
    }
  });

  it('accepts manifest with sandbox and extra capabilities beyond the required one', () => {
    const result = parseManifest({
      ...base,
      sandbox: MINIMAL_SANDBOX,
      requiredCapabilities: ['skill.exec:contentful', 'network.http'],
    });
    expect(result.success).toBe(true);
  });

  it('validates the sandbox block itself (e.g. invalid workdir)', () => {
    const result = parseManifest({
      ...base,
      sandbox: { workdir: 'invalid-value' },
      requiredCapabilities: ['skill.exec:contentful'],
    });
    expect(result.success).toBe(false);
  });
});
