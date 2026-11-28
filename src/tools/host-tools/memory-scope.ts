/**
 * Which thread's memory a memory tool call works on.
 *
 * Every run works on its own thread by default, schedule runs included: a
 * schedule keeps its operational state (heartbeat bookkeeping, dedup lists,
 * last-run markers) on its own schedule thread. A schedule run reaches the
 * memory of the chat it serves only when the call asks for it with
 * `scope: 'conversation'`, and only when the daemon resolved that chat for the
 * run (`ToolExecutionContext.originThreadId`: same channel, routed to the same
 * persona). For a run on a conversation itself, `conversation` is its own
 * thread.
 */

import type { ToolExecutionContext } from './channel-send.js';

/** Memory scope a tool call may request. */
export type MemoryScope = 'thread' | 'conversation';

export type MemoryScopeResolution =
  { ok: true; threadId: string; scope: MemoryScope } | { ok: false; error: string };

/** Resolves `scope` (default `thread`) against the server-owned context. */
export function resolveMemoryScope(
  context: Pick<ToolExecutionContext, 'threadId' | 'originThreadId' | 'scheduleRun'>,
  scope: unknown,
): MemoryScopeResolution {
  if (scope === undefined || scope === null || scope === 'thread') {
    return { ok: true, threadId: context.threadId, scope: 'thread' };
  }
  if (scope !== 'conversation') {
    return {
      ok: false,
      error: `invalid scope ${JSON.stringify(scope)}. Must be "thread" or "conversation"`,
    };
  }
  if (context.originThreadId !== undefined) {
    return { ok: true, threadId: context.originThreadId, scope: 'conversation' };
  }
  if (context.scheduleRun === true) {
    return {
      ok: false,
      error:
        'scope "conversation" is unavailable: this schedule has no origin conversation routed to your persona ' +
        '(created from the CLI without --origin, or the chat is bound to another persona). ' +
        'Use the default scope, or set an origin with `talonctl set-schedule-origin`.',
    };
  }
  // A run on a conversation thread: the conversation is its own thread.
  return { ok: true, threadId: context.threadId, scope: 'conversation' };
}
