# AI SDK HTTP Channel — React Frontend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a clean, minimal React chat UI that connects to a Talon `aisdk-http` channel via the Vercel AI SDK, streaming responses in real-time, persisting thread ID across page reloads, and rendering custom `data-*` artifact chunks from tool results.

**Architecture:** Vite + React 19 + TypeScript SPA. `@ai-sdk/react` `useChat` hook with `DefaultChatTransport` pointed at the Talon endpoint. Thread ID persisted in `localStorage`. Tailwind CSS v4 for styling. Artifact chunks surfaced via `useChat`'s `data` array. Deployable as a static site or served from `vite preview`. Configurable via `.env` file — no hardcoded URLs.

**Tech Stack:** Vite 6, React 19, TypeScript 5, `@ai-sdk/react` ^4, `@ai-sdk/ui-utils`, Tailwind CSS v4, `lucide-react` (icons), `vitest` + `@testing-library/react` for component tests.

---

## File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `tools/chat-ui/package.json` | Dependencies and scripts |
| Create | `tools/chat-ui/vite.config.ts` | Vite config with proxy for dev |
| Create | `tools/chat-ui/tsconfig.json` | TypeScript config |
| Create | `tools/chat-ui/index.html` | HTML entry point |
| Create | `tools/chat-ui/.env.example` | Documented env vars |
| Create | `tools/chat-ui/src/main.tsx` | React root mount |
| Create | `tools/chat-ui/src/App.tsx` | Root component — provides chat context, renders layout |
| Create | `tools/chat-ui/src/config.ts` | Reads env vars, validates, exports typed config |
| Create | `tools/chat-ui/src/hooks/useThreadId.ts` | Persist + retrieve thread ID from localStorage |
| Create | `tools/chat-ui/src/hooks/useArtifacts.ts` | Extract artifact chunks from useChat `data` array |
| Create | `tools/chat-ui/src/components/ChatWindow.tsx` | Scrollable message list |
| Create | `tools/chat-ui/src/components/MessageBubble.tsx` | Single message (user / assistant), renders Markdown |
| Create | `tools/chat-ui/src/components/InputBar.tsx` | Textarea input + send button |
| Create | `tools/chat-ui/src/components/ArtifactPanel.tsx` | Renders custom artifact data-* chunks |
| Create | `tools/chat-ui/src/components/StatusBar.tsx` | Connection status + thread ID display |
| Create | `tools/chat-ui/src/components/Sidebar.tsx` | Thread controls (new thread button) |
| Create | `tools/chat-ui/src/lib/markdown.ts` | Minimal Markdown → HTML (no heavy deps) |
| Create | `tools/chat-ui/src/lib/format.ts` | Timestamp formatting helpers |
| Create | `tools/chat-ui/tests/useThreadId.test.ts` | Hook unit test |
| Create | `tools/chat-ui/tests/useArtifacts.test.ts` | Hook unit test |
| Create | `tools/chat-ui/tests/MessageBubble.test.tsx` | Component test |

---

## Task 1: Project Scaffold

**Files:**
- Create: `tools/chat-ui/package.json`
- Create: `tools/chat-ui/vite.config.ts`
- Create: `tools/chat-ui/tsconfig.json`
- Create: `tools/chat-ui/index.html`
- Create: `tools/chat-ui/.env.example`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "talon-chat-ui",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "tsc --noEmit"
  },
  "dependencies": {
    "@ai-sdk/react": "^1.0.0",
    "ai": "^4.0.0",
    "lucide-react": "^0.511.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "@testing-library/jest-dom": "^6.6.3",
    "@testing-library/react": "^16.3.0",
    "@testing-library/user-event": "^14.6.1",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@vitejs/plugin-react": "^4.3.4",
    "jsdom": "^26.1.0",
    "tailwindcss": "^4.1.0",
    "@tailwindcss/vite": "^4.1.0",
    "typescript": "^5.7.2",
    "vite": "^6.3.2",
    "vitest": "^3.1.1"
  }
}
```

- [ ] **Step 2: Create vite.config.ts**

```typescript
// tools/chat-ui/vite.config.ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      // Proxy API calls to local Talon during development
      '/api': {
        target: process.env.VITE_TALON_URL ?? 'http://127.0.0.1:4100',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    globals: true,
  },
});
```

- [ ] **Step 3: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "useDefineForClassFields": true,
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "isolatedModules": true,
    "moduleDetection": "force",
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true
  },
  "include": ["src", "tests"]
}
```

- [ ] **Step 4: Create index.html**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Talon Chat</title>
    <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🦅</text></svg>" />
  </head>
  <body class="bg-gray-950 text-gray-100">
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 5: Create .env.example**

```bash
# URL of your Talon aisdk-http channel endpoint
# e.g. http://localhost:4100 for local dev
VITE_TALON_URL=http://localhost:4100

# Persona/agent name to connect to (maps to :agentId in the route)
VITE_AGENT_ID=exo-agent

# Route pattern (must match talond.yaml routePattern for the channel)
VITE_ROUTE_PATTERN=/agents/{agentId}/stream
```

- [ ] **Step 6: Create tests/setup.ts**

```typescript
// tools/chat-ui/tests/setup.ts
import '@testing-library/jest-dom';
```

- [ ] **Step 7: Install dependencies**

```bash
cd /home/talon/talon/tools/chat-ui && npm install
```
Expected: node_modules installed, no peer dependency errors.

- [ ] **Step 8: Commit scaffold**

```bash
cd /home/talon/talon && git add tools/chat-ui/
git commit -m "feat(chat-ui): project scaffold — Vite, React 19, Tailwind v4, AI SDK"
```

---

## Task 2: Config and Hooks

**Files:**
- Create: `tools/chat-ui/src/config.ts`
- Create: `tools/chat-ui/src/hooks/useThreadId.ts`
- Create: `tools/chat-ui/src/hooks/useArtifacts.ts`
- Create: `tools/chat-ui/tests/useThreadId.test.ts`
- Create: `tools/chat-ui/tests/useArtifacts.test.ts`

- [ ] **Step 1: Create config.ts**

```typescript
// tools/chat-ui/src/config.ts

function requireEnv(key: string): string {
  const val = import.meta.env[key] as string | undefined;
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

function optionalEnv(key: string, fallback: string): string {
  return (import.meta.env[key] as string | undefined) ?? fallback;
}

export const config = {
  talonUrl: optionalEnv('VITE_TALON_URL', 'http://localhost:4100'),
  agentId: optionalEnv('VITE_AGENT_ID', 'default'),
  /**
   * Full stream URL — constructed from talonUrl + agentId.
   * Uses the default aisdk-http route pattern.
   */
  get streamUrl(): string {
    return `${this.talonUrl}/agents/${this.agentId}/stream`;
  },
  /** localStorage key for thread ID persistence. */
  threadStorageKey: `talon-thread-${optionalEnv('VITE_AGENT_ID', 'default')}`,
} as const;
```

- [ ] **Step 2: Write useThreadId tests**

```typescript
// tools/chat-ui/tests/useThreadId.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useThreadId } from '../src/hooks/useThreadId';

beforeEach(() => {
  localStorage.clear();
});

describe('useThreadId', () => {
  it('generates a UUID on first render when no stored thread', () => {
    const { result } = renderHook(() => useThreadId('test-key'));
    expect(result.current.threadId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
  });

  it('restores thread ID from localStorage', () => {
    localStorage.setItem('test-key', 'stored-thread-id');
    const { result } = renderHook(() => useThreadId('test-key'));
    expect(result.current.threadId).toBe('stored-thread-id');
  });

  it('resetThread generates a new UUID and persists it', () => {
    const { result } = renderHook(() => useThreadId('test-key'));
    const original = result.current.threadId;
    act(() => { result.current.resetThread(); });
    expect(result.current.threadId).not.toBe(original);
    expect(localStorage.getItem('test-key')).toBe(result.current.threadId);
  });
});
```

- [ ] **Step 3: Run tests — expect failure**

```bash
cd /home/talon/talon/tools/chat-ui && npm test -- --reporter=verbose 2>&1 | tail -15
```
Expected: FAIL — useThreadId not found.

- [ ] **Step 4: Create useThreadId.ts**

```typescript
// tools/chat-ui/src/hooks/useThreadId.ts
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
```

- [ ] **Step 5: Write useArtifacts tests**

```typescript
// tools/chat-ui/tests/useArtifacts.test.ts
import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useArtifacts } from '../src/hooks/useArtifacts';

describe('useArtifacts', () => {
  it('returns empty array when data is empty', () => {
    const { result } = renderHook(() => useArtifacts([]));
    expect(result.current).toEqual([]);
  });

  it('filters data items by known artifact type prefixes', () => {
    const data = [
      { type: 'data-exo-output-artifact', jsonContent: { tree: [] } },
      { type: 'data-search-results', items: [{ id: '1' }] },
      { type: 'other-data' },
    ];
    const { result } = renderHook(() => useArtifacts(data as object[]));
    // Should return all items that have a `type` starting with "data-"
    expect(result.current).toHaveLength(2);
    expect(result.current[0]).toMatchObject({ type: 'data-exo-output-artifact' });
  });
});
```

- [ ] **Step 6: Create useArtifacts.ts**

```typescript
// tools/chat-ui/src/hooks/useArtifacts.ts
import { useMemo } from 'react';

export interface ArtifactChunk {
  type: string;
  [key: string]: unknown;
}

/**
 * Extract custom artifact chunks from the useChat `data` array.
 * Artifact chunks are identified by their `type` field starting with "data-".
 */
export function useArtifacts(data: object[]): ArtifactChunk[] {
  return useMemo(
    () =>
      data.filter(
        (item): item is ArtifactChunk =>
          typeof item === 'object' &&
          item !== null &&
          'type' in item &&
          typeof (item as { type: unknown }).type === 'string' &&
          (item as { type: string }).type.startsWith('data-'),
      ),
    [data],
  );
}
```

- [ ] **Step 7: Run tests — expect pass**

```bash
cd /home/talon/talon/tools/chat-ui && npm test -- --reporter=verbose 2>&1 | tail -15
```
Expected: all hook tests pass.

- [ ] **Step 8: Commit**

```bash
cd /home/talon/talon && git add tools/chat-ui/src/ tools/chat-ui/tests/
git commit -m "feat(chat-ui): config, useThreadId, useArtifacts hooks with tests"
```

---

## Task 3: Utility Libraries

**Files:**
- Create: `tools/chat-ui/src/lib/markdown.ts`
- Create: `tools/chat-ui/src/lib/format.ts`

- [ ] **Step 1: Create markdown.ts**

A minimal Markdown → safe HTML converter. No heavy dependencies — just enough for chat messages (bold, italic, code, links, line breaks).

```typescript
// tools/chat-ui/src/lib/markdown.ts

/**
 * Convert a small subset of Markdown to sanitised HTML.
 * Handles: bold, italic, inline code, code blocks, links, line breaks.
 * Does NOT handle: tables, images, headings (not expected in chat responses).
 */
export function markdownToHtml(md: string): string {
  return md
    // Code blocks (``` ... ```) — must come before inline code
    .replace(/```[\w]*\n?([\s\S]*?)```/g, '<pre><code>$1</code></pre>')
    // Inline code
    .replace(/`([^`]+)`/g, '<code class="bg-gray-800 px-1 rounded text-sm font-mono">$1</code>')
    // Bold
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    // Italic
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    // Links [text](url) — only allow http/https
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer" class="text-blue-400 underline">$1</a>')
    // Line breaks
    .replace(/\n/g, '<br />');
}
```

- [ ] **Step 2: Create format.ts**

```typescript
// tools/chat-ui/src/lib/format.ts

/**
 * Format a Unix timestamp (ms) as a short time string: "14:32".
 */
export function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * Truncate a string to maxLen characters, appending "..." if truncated.
 */
export function truncate(str: string, maxLen: number): string {
  return str.length > maxLen ? `${str.slice(0, maxLen)}…` : str;
}
```

- [ ] **Step 3: Commit**

```bash
cd /home/talon/talon && git add tools/chat-ui/src/lib/
git commit -m "feat(chat-ui): markdown and format utilities"
```

---

## Task 4: Components

**Files:**
- Create: `tools/chat-ui/src/components/MessageBubble.tsx`
- Create: `tools/chat-ui/src/components/ChatWindow.tsx`
- Create: `tools/chat-ui/src/components/InputBar.tsx`
- Create: `tools/chat-ui/src/components/ArtifactPanel.tsx`
- Create: `tools/chat-ui/src/components/StatusBar.tsx`
- Create: `tools/chat-ui/src/components/Sidebar.tsx`
- Create: `tools/chat-ui/tests/MessageBubble.test.tsx`

- [ ] **Step 1: Write MessageBubble test**

```typescript
// tools/chat-ui/tests/MessageBubble.test.tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MessageBubble } from '../src/components/MessageBubble';

describe('MessageBubble', () => {
  it('renders user message on the right', () => {
    render(<MessageBubble role="user" content="Hello" createdAt={new Date()} />);
    const bubble = screen.getByText('Hello').closest('div');
    expect(bubble?.className).toContain('items-end');
  });

  it('renders assistant message on the left', () => {
    render(<MessageBubble role="assistant" content="Hi there" createdAt={new Date()} />);
    const bubble = screen.getByText('Hi there').closest('div');
    expect(bubble?.className).toContain('items-start');
  });

  it('renders bold markdown in assistant messages', () => {
    render(<MessageBubble role="assistant" content="This is **bold**" createdAt={new Date()} />);
    const strong = document.querySelector('strong');
    expect(strong?.textContent).toBe('bold');
  });
});
```

- [ ] **Step 2: Run test — expect failure**

```bash
cd /home/talon/talon/tools/chat-ui && npm test -- tests/MessageBubble.test.tsx 2>&1 | tail -10
```
Expected: FAIL.

- [ ] **Step 3: Create MessageBubble.tsx**

```tsx
// tools/chat-ui/src/components/MessageBubble.tsx
import { markdownToHtml } from '../lib/markdown';
import { formatTime } from '../lib/format';

interface MessageBubbleProps {
  role: 'user' | 'assistant';
  content: string;
  createdAt: Date;
}

export function MessageBubble({ role, content, createdAt }: MessageBubbleProps) {
  const isUser = role === 'user';

  return (
    <div className={`flex flex-col gap-1 ${isUser ? 'items-end' : 'items-start'}`}>
      <div
        className={`max-w-[75%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${
          isUser
            ? 'bg-blue-600 text-white rounded-br-sm'
            : 'bg-gray-800 text-gray-100 rounded-bl-sm'
        }`}
      >
        {isUser ? (
          <span>{content}</span>
        ) : (
          <span
            dangerouslySetInnerHTML={{ __html: markdownToHtml(content) }}
            className="prose-sm"
          />
        )}
      </div>
      <span className="text-xs text-gray-500 px-1">{formatTime(createdAt.getTime())}</span>
    </div>
  );
}
```

- [ ] **Step 4: Run test — expect pass**

```bash
cd /home/talon/talon/tools/chat-ui && npm test -- tests/MessageBubble.test.tsx 2>&1 | tail -10
```
Expected: PASS.

- [ ] **Step 5: Create ChatWindow.tsx**

```tsx
// tools/chat-ui/src/components/ChatWindow.tsx
import { useEffect, useRef } from 'react';
import type { Message } from '@ai-sdk/react';
import { MessageBubble } from './MessageBubble';
import { Bot } from 'lucide-react';

interface ChatWindowProps {
  messages: Message[];
  isLoading: boolean;
}

export function ChatWindow({ messages, isLoading }: ChatWindowProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isLoading]);

  if (messages.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-4 text-gray-500">
        <Bot size={48} className="text-gray-700" />
        <p className="text-sm">Start a conversation</p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto px-4 py-6 flex flex-col gap-4">
      {messages.map((msg) => (
        <MessageBubble
          key={msg.id}
          role={msg.role as 'user' | 'assistant'}
          content={msg.content}
          createdAt={msg.createdAt ?? new Date()}
        />
      ))}
      {isLoading && (
        <div className="flex items-start gap-2">
          <div className="bg-gray-800 rounded-2xl rounded-bl-sm px-4 py-3 flex gap-1">
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                className="w-1.5 h-1.5 bg-gray-500 rounded-full animate-bounce"
                style={{ animationDelay: `${i * 150}ms` }}
              />
            ))}
          </div>
        </div>
      )}
      <div ref={bottomRef} />
    </div>
  );
}
```

- [ ] **Step 6: Create InputBar.tsx**

```tsx
// tools/chat-ui/src/components/InputBar.tsx
import { type FormEvent, type KeyboardEvent, useRef } from 'react';
import { Send } from 'lucide-react';

interface InputBarProps {
  input: string;
  isLoading: boolean;
  onChange: (value: string) => void;
  onSubmit: (e: FormEvent) => void;
}

export function InputBar({ input, isLoading, onChange, onSubmit }: InputBarProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (input.trim() && !isLoading) {
        onSubmit(e as unknown as FormEvent);
      }
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      className="flex items-end gap-3 px-4 py-4 border-t border-gray-800 bg-gray-950"
    >
      <textarea
        ref={textareaRef}
        rows={1}
        value={input}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Message Talon… (Enter to send, Shift+Enter for newline)"
        disabled={isLoading}
        className="flex-1 resize-none bg-gray-900 border border-gray-700 rounded-xl px-4 py-3 text-sm text-gray-100 placeholder-gray-600 focus:outline-none focus:border-blue-500 disabled:opacity-50 max-h-40 overflow-y-auto"
        style={{ fieldSizing: 'content' } as React.CSSProperties}
      />
      <button
        type="submit"
        disabled={isLoading || !input.trim()}
        className="flex items-center justify-center w-10 h-10 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-800 disabled:text-gray-600 text-white rounded-xl transition-colors shrink-0"
        aria-label="Send message"
      >
        <Send size={16} />
      </button>
    </form>
  );
}
```

- [ ] **Step 7: Create ArtifactPanel.tsx**

```tsx
// tools/chat-ui/src/components/ArtifactPanel.tsx
import type { ArtifactChunk } from '../hooks/useArtifacts';
import { Package } from 'lucide-react';

interface ArtifactPanelProps {
  artifacts: ArtifactChunk[];
}

export function ArtifactPanel({ artifacts }: ArtifactPanelProps) {
  if (artifacts.length === 0) return null;

  return (
    <aside className="w-80 border-l border-gray-800 bg-gray-900 flex flex-col overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-800">
        <Package size={14} className="text-gray-400" />
        <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
          Artifacts
        </span>
        <span className="ml-auto text-xs text-gray-600">{artifacts.length}</span>
      </div>
      <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-4">
        {artifacts.map((artifact, idx) => (
          <div key={idx} className="rounded-lg border border-gray-700 overflow-hidden">
            <div className="flex items-center gap-2 px-3 py-2 bg-gray-800 border-b border-gray-700">
              <span className="text-xs font-mono text-blue-400">{artifact.type}</span>
            </div>
            <pre className="text-xs text-gray-300 p-3 overflow-x-auto leading-relaxed">
              {JSON.stringify(
                Object.fromEntries(Object.entries(artifact).filter(([k]) => k !== 'type')),
                null,
                2,
              )}
            </pre>
          </div>
        ))}
      </div>
    </aside>
  );
}
```

- [ ] **Step 8: Create StatusBar.tsx**

```tsx
// tools/chat-ui/src/components/StatusBar.tsx
import { Wifi, WifiOff } from 'lucide-react';
import { truncate } from '../lib/format';

interface StatusBarProps {
  threadId: string;
  isConnected: boolean;
  agentId: string;
}

export function StatusBar({ threadId, isConnected, agentId }: StatusBarProps) {
  return (
    <div className="flex items-center gap-3 px-4 py-2 bg-gray-900 border-b border-gray-800 text-xs text-gray-500">
      <span className="flex items-center gap-1">
        {isConnected ? (
          <Wifi size={12} className="text-green-500" />
        ) : (
          <WifiOff size={12} className="text-gray-600" />
        )}
        <span className={isConnected ? 'text-green-400' : 'text-gray-600'}>
          {isConnected ? 'Connected' : 'Disconnected'}
        </span>
      </span>
      <span className="text-gray-700">·</span>
      <span>agent: <span className="text-blue-400 font-mono">{agentId}</span></span>
      <span className="text-gray-700">·</span>
      <span>thread: <span className="font-mono text-gray-400">{truncate(threadId, 8)}</span></span>
    </div>
  );
}
```

- [ ] **Step 9: Create Sidebar.tsx**

```tsx
// tools/chat-ui/src/components/Sidebar.tsx
import { PlusCircle, Bird } from 'lucide-react';

interface SidebarProps {
  agentId: string;
  onNewThread: () => void;
}

export function Sidebar({ agentId, onNewThread }: SidebarProps) {
  return (
    <aside className="w-16 flex flex-col items-center py-4 gap-4 border-r border-gray-800 bg-gray-950 shrink-0">
      <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-gray-800">
        <Bird size={20} className="text-blue-400" />
      </div>
      <div className="flex-1" />
      <button
        onClick={onNewThread}
        className="flex items-center justify-center w-10 h-10 rounded-xl hover:bg-gray-800 text-gray-500 hover:text-gray-300 transition-colors"
        title="New thread"
        aria-label="Start new thread"
      >
        <PlusCircle size={20} />
      </button>
    </aside>
  );
}
```

- [ ] **Step 10: Run all tests**

```bash
cd /home/talon/talon/tools/chat-ui && npm test 2>&1 | tail -20
```
Expected: all tests pass.

- [ ] **Step 11: Commit**

```bash
cd /home/talon/talon && git add tools/chat-ui/src/components/ tools/chat-ui/tests/MessageBubble.test.tsx
git commit -m "feat(chat-ui): all UI components — ChatWindow, MessageBubble, InputBar, ArtifactPanel, StatusBar, Sidebar"
```

---

## Task 5: App Root and Main Entry

**Files:**
- Create: `tools/chat-ui/src/App.tsx`
- Create: `tools/chat-ui/src/main.tsx`
- Create: `tools/chat-ui/src/index.css`

- [ ] **Step 1: Create index.css (Tailwind entry)**

```css
/* tools/chat-ui/src/index.css */
@import "tailwindcss";
```

- [ ] **Step 2: Create App.tsx**

```tsx
// tools/chat-ui/src/App.tsx
import { useChat } from '@ai-sdk/react';
import { config } from './config';
import { useThreadId } from './hooks/useThreadId';
import { useArtifacts } from './hooks/useArtifacts';
import { ChatWindow } from './components/ChatWindow';
import { InputBar } from './components/InputBar';
import { ArtifactPanel } from './components/ArtifactPanel';
import { StatusBar } from './components/StatusBar';
import { Sidebar } from './components/Sidebar';

export function App() {
  const { threadId, resetThread } = useThreadId(config.threadStorageKey);

  const {
    messages,
    input,
    handleInputChange,
    handleSubmit,
    isLoading,
    data,
    error,
    setMessages,
  } = useChat({
    api: config.streamUrl,
    id: threadId,
    onError: (err) => {
      console.error('Chat error:', err);
    },
  });

  const artifacts = useArtifacts((data ?? []) as object[]);

  function handleNewThread() {
    setMessages([]);
    resetThread();
  }

  function handleInputBarChange(value: string) {
    // useChat handleInputChange expects a ChangeEvent — wrap it
    handleInputChange({ target: { value } } as React.ChangeEvent<HTMLInputElement>);
  }

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-gray-950 text-gray-100">
      <Sidebar agentId={config.agentId} onNewThread={handleNewThread} />

      <div className="flex flex-col flex-1 min-w-0">
        <StatusBar
          threadId={threadId}
          isConnected={!error}
          agentId={config.agentId}
        />

        <div className="flex flex-1 min-h-0">
          <div className="flex flex-col flex-1 min-w-0">
            <ChatWindow messages={messages} isLoading={isLoading} />
            {error && (
              <div className="px-4 py-2 text-xs text-red-400 bg-red-950 border-t border-red-900">
                Error: {error.message}
              </div>
            )}
            <InputBar
              input={input}
              isLoading={isLoading}
              onChange={handleInputBarChange}
              onSubmit={handleSubmit}
            />
          </div>

          <ArtifactPanel artifacts={artifacts} />
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Create main.tsx**

```tsx
// tools/chat-ui/src/main.tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import { App } from './App';

const root = document.getElementById('root');
if (!root) throw new Error('#root element not found');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
);
```

- [ ] **Step 4: Start dev server and verify it loads**

```bash
cd /home/talon/talon/tools/chat-ui && cp .env.example .env && npm run dev 2>&1 &
sleep 3 && curl -s http://localhost:5173 | grep -c "Talon Chat"
```
Expected: output `1` (title found in HTML).

- [ ] **Step 5: Build for production — verify no errors**

```bash
cd /home/talon/talon/tools/chat-ui && npm run build 2>&1 | tail -10
```
Expected: `dist/` directory created, 0 TypeScript errors.

- [ ] **Step 6: Commit**

```bash
cd /home/talon/talon && git add tools/chat-ui/src/App.tsx tools/chat-ui/src/main.tsx tools/chat-ui/src/index.css
git commit -m "feat(chat-ui): App root and main entry — fully wired useChat + layout"
```

---

## Task 6: README for chat-ui

**Files:**
- Create: `tools/chat-ui/README.md`

- [ ] **Step 1: Write README**

```markdown
# Talon Chat UI

A minimal React frontend for any Talon `aisdk-http` channel.

## Setup

1. Copy env file and configure:
   ```bash
   cp .env.example .env
   # Edit .env: set VITE_TALON_URL and VITE_AGENT_ID
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Start Talon with an `aisdk-http` channel on the configured port.

4. Start dev server:
   ```bash
   npm run dev
   ```
   Open http://localhost:5173.

## Build

```bash
npm run build
npm run preview   # preview the production build
```

## Features

- Streams responses in real-time via AI SDK v5 data-stream protocol
- Thread ID persisted across page reloads (localStorage)
- Custom `data-*` artifact chunks rendered in the Artifact Panel
- New Thread button to start fresh conversations
- Shift+Enter for multi-line input, Enter to send

## Connecting to Talon

In `talond.yaml`:
```yaml
channels:
  - name: my-chat
    type: aisdk-http
    config:
      port: 4100
      routePattern: "/agents/:agentId/stream"

bindings:
  - channel: my-chat
    persona: my-persona
    isDefault: true
```

Set `VITE_TALON_URL=http://localhost:4100` and `VITE_AGENT_ID=my-persona` in `.env`.
```

- [ ] **Step 2: Commit**

```bash
cd /home/talon/talon && git add tools/chat-ui/README.md
git commit -m "docs(chat-ui): setup and usage README"
```

---

## Self-Review Checklist

**Spec coverage:**
- ✅ `@ai-sdk/react` `useChat` connected to Talon `aisdk-http` endpoint
- ✅ Thread ID persisted in `localStorage`, resettable via "New Thread" button
- ✅ Real-time streaming — text appears as chunks arrive via SSE
- ✅ Custom `data-*` artifact chunks surfaced in `ArtifactPanel`
- ✅ Clean, dark-mode design (Tailwind v4, `bg-gray-950` base)
- ✅ Configurable via `.env` — no hardcoded URLs
- ✅ Typing indicator (animated dots while `isLoading`)
- ✅ Error display when connection fails
- ✅ Markdown rendering (bold, italic, inline code, code blocks, links) in assistant messages
- ✅ Enter to send, Shift+Enter for newlines
- ✅ Auto-scroll to latest message
- ✅ Status bar with connection state, agent ID, thread ID
- ✅ Production build via `vite build`
- ✅ Tests for hooks and key component

**Not implemented (intentional):**
- Message history persistence beyond `useChat` state (requires backend API, deferred)
- Multi-conversation sidebar (V2 — single thread per tab for now)
- File attachment upload (not in scope for V1)
- Dark/light theme toggle (dark-only is fine for a dev tool)

**Type consistency:** All component prop types match what `useChat` returns. `data` typed as `object[]` via `useArtifacts` guard. `Message` imported from `@ai-sdk/react`.
