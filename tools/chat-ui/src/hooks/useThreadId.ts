import { useState, useCallback } from 'react';

function generateId(): string {
  return crypto.randomUUID();
}

export interface UseThreadIdResult {
  threadId: string;
  resetThread: () => void;
}

export function useThreadId(storageKey: string): UseThreadIdResult {
  const [threadId, setThreadId] = useState<string>(() => {
    const stored = localStorage.getItem(storageKey);
    if (stored) return stored;
    const id = generateId();
    localStorage.setItem(storageKey, id);
    return id;
  });

  const resetThread = useCallback(() => {
    const id = generateId();
    localStorage.setItem(storageKey, id);
    setThreadId(id);
  }, [storageKey]);

  return { threadId, resetThread };
}
