import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';

import {
  BEHAVIOR_REVIEW_OUTPUT_CONTRACT,
  BehaviorReviewOutputSchema,
} from '../../../src/lifecycle/behavior/review-contracts.js';
import {
  LIFECYCLE_EVENT_INPUT_CONTRACT,
  LIFECYCLE_SIGNAL_ENVELOPES_OUTPUT_CONTRACT,
} from '../../../src/lifecycle/contracts/index.js';
import { SubAgentManifestSchema } from '../../../src/subagents/subagent-schema.js';

describe('behavior review default subagents', () => {
  it.each([
    ['behavior-daily-reviewer', 'daily'],
    ['behavior-weekly-reviewer', 'weekly'],
  ] as const)(
    'ships %s with review lifecycle contracts and no filesystem authority',
    (name, cadence) => {
      const root = join(process.cwd(), 'src/subagents/default', name);
      const parsed = SubAgentManifestSchema.parse(
        yaml.load(readFileSync(join(root, 'subagent.yaml'), 'utf8')),
      );
      const prompt = readFileSync(join(root, 'prompts/01-system.md'), 'utf8');

      expect(parsed.name).toBe(name);
      expect(parsed.model.name).toBe('gpt-5.5');
      expect(parsed.model.name).not.toContain('5.6');
      expect(parsed.requiredCapabilities).toEqual([]);
      expect(parsed.rootPaths).toEqual([]);
      expect(parsed.lifecycleCapabilities).toEqual([
        {
          mode: 'event',
          inputContract: LIFECYCLE_EVENT_INPUT_CONTRACT,
          outputContract: LIFECYCLE_SIGNAL_ENVELOPES_OUTPUT_CONTRACT,
        },
      ]);
      expect(prompt).toContain(`cadence: ${cadence}`);
      expect(prompt).toContain('Do not activate prompts');
    },
  );

  it('accepts notes-only reviewer JSON and rejects direct activation output', () => {
    expect(
      BehaviorReviewOutputSchema.safeParse({
        contract: BEHAVIOR_REVIEW_OUTPUT_CONTRACT,
        decision: 'propose',
        rationale: 'Two independent sources support this change.',
        notes: ['Keep this proposal for operator review.'],
        conflicts: [],
      }).success,
    ).toBe(true);

    expect(
      BehaviorReviewOutputSchema.safeParse({
        contract: BEHAVIOR_REVIEW_OUTPUT_CONTRACT,
        decision: 'activate',
        rationale: 'Apply it now.',
        notes: [],
        conflicts: [],
      }).success,
    ).toBe(false);
  });
});
