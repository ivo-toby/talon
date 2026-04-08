import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useThreadId } from '../src/hooks/useThreadId';

// Mock localStorage since jsdom doesn't provide it for opaque origins
const store: Record<string, string> = {};
const mockLocalStorage = {
  getItem: vi.fn((key: string) => store[key] ?? null),
  setItem: vi.fn((key: string, value: string) => { store[key] = value; }),
  removeItem: vi.fn((key: string) => { delete store[key]; }),
  clear: vi.fn(() => { for (const k in store) delete store[k]; }),
  get length() { return Object.keys(store).length; },
  key: vi.fn((_i: number) => null),
};

Object.defineProperty(globalThis, 'localStorage', { value: mockLocalStorage, writable: true });

beforeEach(() => {
  mockLocalStorage.clear();
  vi.clearAllMocks();
});

describe('useThreadId', () => {
  it('generates a UUID on first render when no stored thread', () => {
    const { result } = renderHook(() => useThreadId('test-key'));
    expect(result.current.threadId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
  });

  it('restores thread ID from localStorage', () => {
    store['test-key'] = 'stored-thread-id';
    const { result } = renderHook(() => useThreadId('test-key'));
    expect(result.current.threadId).toBe('stored-thread-id');
  });

  it('resetThread generates a new UUID and persists it', () => {
    const { result } = renderHook(() => useThreadId('test-key'));
    const original = result.current.threadId;
    act(() => { result.current.resetThread(); });
    expect(result.current.threadId).not.toBe(original);
    expect(store['test-key']).toBe(result.current.threadId);
  });
});
