/**
 * Unit tests for SessionTracker.
 *
 * Tests cover all CRUD operations on the in-memory session map:
 *  - getSessionId (hit / miss / expired)
 *  - setSessionId (insert / overwrite)
 *  - clearSession (existing / non-existent)
 *  - clearAll
 *  - size
 *  - hasSession (including expiry)
 *  - evictStale (TTL-based eviction)
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { SessionTracker } from '../../../src/sandbox/session-tracker.js';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

describe('SessionTracker', () => {
  let tracker: SessionTracker;

  beforeEach(() => {
    tracker = new SessionTracker();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // getSessionId
  // -------------------------------------------------------------------------

  describe('getSessionId()', () => {
    it('returns undefined for a thread with no session', () => {
      expect(tracker.getSessionId('thread-1')).toBeUndefined();
    });

    it('returns the session ID after it has been set', () => {
      tracker.setSessionId('thread-1', 'ses-abc');
      expect(tracker.getSessionId('thread-1')).toBe('ses-abc');
    });

    it('returns the updated session ID after it is overwritten', () => {
      tracker.setSessionId('thread-1', 'ses-old');
      tracker.setSessionId('thread-1', 'ses-new');
      expect(tracker.getSessionId('thread-1')).toBe('ses-new');
    });

    it('returns undefined after the session has been cleared', () => {
      tracker.setSessionId('thread-1', 'ses-abc');
      tracker.clearSession('thread-1');
      expect(tracker.getSessionId('thread-1')).toBeUndefined();
    });

    it('returns undefined for a different thread', () => {
      tracker.setSessionId('thread-1', 'ses-abc');
      expect(tracker.getSessionId('thread-2')).toBeUndefined();
    });

    it('scopes sessions by provider when a provider name is supplied', () => {
      tracker.setSessionId('thread-1', 'claude-session', 'claude-code');
      tracker.setSessionId('thread-1', 'codex-session', 'codex-cli');

      expect(tracker.getSessionId('thread-1', 'claude-code')).toBe('claude-session');
      expect(tracker.getSessionId('thread-1', 'codex-cli')).toBe('codex-session');
      expect(tracker.getSessionId('thread-1')).toBeUndefined();
    });

    it('scopes sessions by model when a model name is supplied', () => {
      tracker.setSessionId('thread-1', 'qwen-small-session', 'ollama-mac', 'Qwen3.5-9B-OptiQ-4bit');
      tracker.setSessionId('thread-1', 'qwen-large-session', 'ollama-mac', 'Qwen3-30B-A3B-Instruct-2507-4bit');

      expect(tracker.getSessionId('thread-1', 'ollama-mac', 'Qwen3.5-9B-OptiQ-4bit')).toBe('qwen-small-session');
      expect(tracker.getSessionId('thread-1', 'ollama-mac', 'Qwen3-30B-A3B-Instruct-2507-4bit')).toBe('qwen-large-session');
      expect(tracker.getSessionId('thread-1', 'ollama-mac', 'gemma-4-12B-it-4bit')).toBeUndefined();
      expect(tracker.getSessionId('thread-1', 'ollama-mac')).toBeUndefined();
    });

    it('returns undefined for an expired session', () => {
      tracker.setSessionId('thread-1', 'ses-abc');
      // Advance past the default 24h TTL.
      vi.advanceTimersByTime(25 * 60 * 60 * 1000);
      expect(tracker.getSessionId('thread-1')).toBeUndefined();
    });

    it('refreshes lastUsedAt on read, keeping the session alive', () => {
      tracker.setSessionId('thread-1', 'ses-abc');
      // Advance 23 hours — still within TTL.
      vi.advanceTimersByTime(23 * 60 * 60 * 1000);
      expect(tracker.getSessionId('thread-1')).toBe('ses-abc');
      // Advance another 23 hours — session was touched, so still alive.
      vi.advanceTimersByTime(23 * 60 * 60 * 1000);
      expect(tracker.getSessionId('thread-1')).toBe('ses-abc');
    });
  });

  // -------------------------------------------------------------------------
  // setSessionId
  // -------------------------------------------------------------------------

  describe('setSessionId()', () => {
    it('stores the session ID for a new thread', () => {
      tracker.setSessionId('thread-new', 'ses-xyz');
      expect(tracker.getSessionId('thread-new')).toBe('ses-xyz');
    });

    it('overwrites the previous session ID for the same thread', () => {
      tracker.setSessionId('thread-1', 'ses-v1');
      tracker.setSessionId('thread-1', 'ses-v2');
      expect(tracker.getSessionId('thread-1')).toBe('ses-v2');
    });

    it('supports multiple threads independently', () => {
      tracker.setSessionId('t-1', 'ses-t1');
      tracker.setSessionId('t-2', 'ses-t2');
      tracker.setSessionId('t-3', 'ses-t3');
      expect(tracker.getSessionId('t-1')).toBe('ses-t1');
      expect(tracker.getSessionId('t-2')).toBe('ses-t2');
      expect(tracker.getSessionId('t-3')).toBe('ses-t3');
    });

    it('stores separate sessions per provider on the same thread', () => {
      tracker.setSessionId('thread-1', 'claude-session', 'claude-code');
      tracker.setSessionId('thread-1', 'codex-session', 'codex-cli');

      expect(tracker.getSessionId('thread-1', 'claude-code')).toBe('claude-session');
      expect(tracker.getSessionId('thread-1', 'codex-cli')).toBe('codex-session');
    });

    it('stores separate sessions per provider model on the same thread', () => {
      tracker.setSessionId('thread-1', 'small-session', 'ollama-mac', 'small-model');
      tracker.setSessionId('thread-1', 'large-session', 'ollama-mac', 'large-model');

      expect(tracker.getSessionId('thread-1', 'ollama-mac', 'small-model')).toBe('small-session');
      expect(tracker.getSessionId('thread-1', 'ollama-mac', 'large-model')).toBe('large-session');
    });
  });

  // -------------------------------------------------------------------------
  // clearSession
  // -------------------------------------------------------------------------

  describe('clearSession()', () => {
    it('removes the session ID for the specified thread', () => {
      tracker.setSessionId('thread-1', 'ses-abc');
      tracker.clearSession('thread-1');
      expect(tracker.getSessionId('thread-1')).toBeUndefined();
    });

    it('does not affect other threads', () => {
      tracker.setSessionId('thread-1', 'ses-abc');
      tracker.setSessionId('thread-2', 'ses-def');
      tracker.clearSession('thread-1');
      expect(tracker.getSessionId('thread-2')).toBe('ses-def');
    });

    it('is a no-op for a thread with no session', () => {
      // Should not throw.
      expect(() => tracker.clearSession('nonexistent-thread')).not.toThrow();
    });

    it('reduces size by 1 when clearing an existing session', () => {
      tracker.setSessionId('thread-1', 'ses-1');
      tracker.setSessionId('thread-2', 'ses-2');
      tracker.clearSession('thread-1');
      expect(tracker.size()).toBe(1);
    });

    it('clears all model sessions for a provider when only provider is supplied', () => {
      tracker.setSessionId('thread-1', 'small-session', 'ollama-mac', 'small-model');
      tracker.setSessionId('thread-1', 'large-session', 'ollama-mac', 'large-model');
      tracker.setSessionId('thread-1', 'codex-session', 'codex-cli', 'gpt-5.4');

      tracker.clearSession('thread-1', 'ollama-mac');

      expect(tracker.getSessionId('thread-1', 'ollama-mac', 'small-model')).toBeUndefined();
      expect(tracker.getSessionId('thread-1', 'ollama-mac', 'large-model')).toBeUndefined();
      expect(tracker.getSessionId('thread-1', 'codex-cli', 'gpt-5.4')).toBe('codex-session');
    });

    it('clears one model session when provider and model are supplied', () => {
      tracker.setSessionId('thread-1', 'small-session', 'ollama-mac', 'small-model');
      tracker.setSessionId('thread-1', 'large-session', 'ollama-mac', 'large-model');

      tracker.clearSession('thread-1', 'ollama-mac', 'small-model');

      expect(tracker.getSessionId('thread-1', 'ollama-mac', 'small-model')).toBeUndefined();
      expect(tracker.getSessionId('thread-1', 'ollama-mac', 'large-model')).toBe('large-session');
    });
  });

  // -------------------------------------------------------------------------
  // clearAll
  // -------------------------------------------------------------------------

  describe('clearAll()', () => {
    it('removes all stored sessions', () => {
      tracker.setSessionId('t-1', 'ses-1');
      tracker.setSessionId('t-2', 'ses-2');
      tracker.setSessionId('t-3', 'ses-3');
      tracker.clearAll();
      expect(tracker.getSessionId('t-1')).toBeUndefined();
      expect(tracker.getSessionId('t-2')).toBeUndefined();
      expect(tracker.getSessionId('t-3')).toBeUndefined();
    });

    it('reduces size to 0', () => {
      tracker.setSessionId('t-1', 'ses-1');
      tracker.setSessionId('t-2', 'ses-2');
      tracker.clearAll();
      expect(tracker.size()).toBe(0);
    });

    it('is a no-op on an empty tracker', () => {
      expect(() => tracker.clearAll()).not.toThrow();
      expect(tracker.size()).toBe(0);
    });

    it('allows new sessions to be added after clearAll', () => {
      tracker.setSessionId('t-1', 'ses-old');
      tracker.clearAll();
      tracker.setSessionId('t-1', 'ses-new');
      expect(tracker.getSessionId('t-1')).toBe('ses-new');
    });
  });

  // -------------------------------------------------------------------------
  // size
  // -------------------------------------------------------------------------

  describe('size()', () => {
    it('returns 0 for a new tracker', () => {
      expect(tracker.size()).toBe(0);
    });

    it('increases by 1 for each unique thread', () => {
      tracker.setSessionId('t-1', 'ses-1');
      expect(tracker.size()).toBe(1);
      tracker.setSessionId('t-2', 'ses-2');
      expect(tracker.size()).toBe(2);
    });

    it('does not increase when overwriting an existing thread', () => {
      tracker.setSessionId('t-1', 'ses-v1');
      tracker.setSessionId('t-1', 'ses-v2');
      expect(tracker.size()).toBe(1);
    });

    it('excludes expired entries from count', () => {
      tracker.setSessionId('t-1', 'ses-1');
      tracker.setSessionId('t-2', 'ses-2');
      vi.advanceTimersByTime(25 * 60 * 60 * 1000);
      tracker.setSessionId('t-3', 'ses-3');
      // t-1 and t-2 are expired, only t-3 is live.
      expect(tracker.size()).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // hasSession
  // -------------------------------------------------------------------------

  describe('hasSession()', () => {
    it('returns false for an unknown thread', () => {
      expect(tracker.hasSession('unknown')).toBe(false);
    });

    it('returns true after a session is set', () => {
      tracker.setSessionId('thread-1', 'ses-abc');
      expect(tracker.hasSession('thread-1')).toBe(true);
    });

    it('returns false after the session is cleared', () => {
      tracker.setSessionId('thread-1', 'ses-abc');
      tracker.clearSession('thread-1');
      expect(tracker.hasSession('thread-1')).toBe(false);
    });

    it('returns false for all threads after clearAll', () => {
      tracker.setSessionId('t-1', 'ses-1');
      tracker.setSessionId('t-2', 'ses-2');
      tracker.clearAll();
      expect(tracker.hasSession('t-1')).toBe(false);
      expect(tracker.hasSession('t-2')).toBe(false);
    });

    it('returns false for an expired session', () => {
      tracker.setSessionId('thread-1', 'ses-abc');
      vi.advanceTimersByTime(25 * 60 * 60 * 1000);
      expect(tracker.hasSession('thread-1')).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // evictStale
  // -------------------------------------------------------------------------

  describe('evictStale()', () => {
    it('returns 0 when no entries are stale', () => {
      tracker.setSessionId('t-1', 'ses-1');
      tracker.setSessionId('t-2', 'ses-2');
      expect(tracker.evictStale()).toBe(0);
      expect(tracker.size()).toBe(2);
    });

    it('evicts entries older than TTL', () => {
      tracker.setSessionId('t-1', 'ses-1');
      tracker.setSessionId('t-2', 'ses-2');
      vi.advanceTimersByTime(25 * 60 * 60 * 1000);
      expect(tracker.evictStale()).toBe(2);
      expect(tracker.size()).toBe(0);
    });

    it('only evicts stale entries, keeps fresh ones', () => {
      tracker.setSessionId('t-old', 'ses-old');
      vi.advanceTimersByTime(23 * 60 * 60 * 1000);
      tracker.setSessionId('t-new', 'ses-new');
      vi.advanceTimersByTime(2 * 60 * 60 * 1000); // t-old is now 25h, t-new is 2h
      expect(tracker.evictStale()).toBe(1);
      expect(tracker.hasSession('t-old')).toBe(false);
      expect(tracker.hasSession('t-new')).toBe(true);
    });

    it('returns 0 on an empty tracker', () => {
      expect(tracker.evictStale()).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Custom TTL
  // -------------------------------------------------------------------------

  describe('custom TTL', () => {
    it('respects a shorter TTL', () => {
      const shortTracker = new SessionTracker(5000); // 5 seconds
      shortTracker.setSessionId('t-1', 'ses-1');
      vi.advanceTimersByTime(6000);
      expect(shortTracker.getSessionId('t-1')).toBeUndefined();
    });

    it('keeps entries alive within custom TTL', () => {
      const shortTracker = new SessionTracker(5000);
      shortTracker.setSessionId('t-1', 'ses-1');
      vi.advanceTimersByTime(4000);
      expect(shortTracker.getSessionId('t-1')).toBe('ses-1');
    });
  });
});
