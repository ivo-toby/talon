/**
 * Unit tests for the unhandled-rejection shield.
 *
 * The shield is a small singleton registry of "this rejection is expected and
 * non-fatal" matchers. Connectors register matchers when they start and
 * deregister on stop. The signal handler consults the shield before crashing
 * the daemon on `unhandledRejection`.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerSafeRejectionMatcher,
  classifyRejection,
  __resetMatchersForTesting,
} from '../../../src/daemon/unhandled-rejection-shield.js';

describe('unhandled-rejection-shield', () => {
  beforeEach(() => {
    __resetMatchersForTesting();
  });

  it('classifies all rejections as fatal when no matchers are registered', () => {
    const result = classifyRejection(new Error('boom'));
    expect(result.fatal).toBe(true);
    expect(result.matchedBy).toBeUndefined();
  });

  it('classifies a rejection as non-fatal when a matcher returns true', () => {
    registerSafeRejectionMatcher({
      name: 'always-match',
      matches: () => true,
    });

    const result = classifyRejection(new Error('whatever'));
    expect(result.fatal).toBe(false);
    expect(result.matchedBy).toBe('always-match');
  });

  it('still classifies as fatal when no registered matcher matches', () => {
    registerSafeRejectionMatcher({
      name: 'matches-foo',
      matches: (reason) => reason instanceof Error && reason.message === 'foo',
    });

    const result = classifyRejection(new Error('bar'));
    expect(result.fatal).toBe(true);
  });

  it('returns the first matching matcher when multiple match', () => {
    registerSafeRejectionMatcher({ name: 'first', matches: () => true });
    registerSafeRejectionMatcher({ name: 'second', matches: () => true });

    const result = classifyRejection(new Error('x'));
    expect(result.matchedBy).toBe('first');
  });

  it('deregister removes the matcher', () => {
    const deregister = registerSafeRejectionMatcher({
      name: 'temp',
      matches: () => true,
    });

    expect(classifyRejection('x').fatal).toBe(false);
    deregister();
    expect(classifyRejection('x').fatal).toBe(true);
  });

  it('deregister is idempotent', () => {
    const deregister = registerSafeRejectionMatcher({
      name: 'temp',
      matches: () => true,
    });
    deregister();
    expect(() => deregister()).not.toThrow();
    expect(classifyRejection('x').fatal).toBe(true);
  });

  it('a throwing matcher is treated as non-matching and does not break classification', () => {
    registerSafeRejectionMatcher({
      name: 'broken',
      matches: () => {
        throw new Error('matcher exploded');
      },
    });
    registerSafeRejectionMatcher({
      name: 'always',
      matches: () => true,
    });

    const result = classifyRejection('x');
    expect(result.fatal).toBe(false);
    expect(result.matchedBy).toBe('always');
  });

  it('handles non-Error rejection reasons (string, object, undefined)', () => {
    registerSafeRejectionMatcher({
      name: 'string-foo',
      matches: (reason) => reason === 'foo',
    });

    expect(classifyRejection('foo').fatal).toBe(false);
    expect(classifyRejection('bar').fatal).toBe(true);
    expect(classifyRejection(undefined).fatal).toBe(true);
    expect(classifyRejection({}).fatal).toBe(true);
  });
});
