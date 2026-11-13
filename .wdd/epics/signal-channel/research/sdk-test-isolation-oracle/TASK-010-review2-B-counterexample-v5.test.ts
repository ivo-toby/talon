import { expect, it } from 'vitest';
import { appendFileSync, readFileSync } from 'node:fs';
import { query as importedQuery } from '@anthropic-ai/claude-agent-sdk';
import { query, selectSyntheticQueryFactory, clearSyntheticQueryFactory } from './TASK-010-review2-B-counterexample-v5-sdk.fixture.mjs';
import { ClaudeCodeProvider } from '/home/ivo/workspace/talon.feat-signal/.worktrees/SCOPE-signal-channel/TASK-010/src/providers/claude-code-provider.ts';
import type { AgentRunInput, AgentStreamEvent } from '/home/ivo/workspace/talon.feat-signal/.worktrees/SCOPE-signal-channel/TASK-010/src/providers/provider.ts';
const trace = '/home/ivo/workspace/talon.feat-signal/.wdd/dispatch/pi-validation/TASK-010-review2-B-counterexample-v5-trace.jsonl';
const record = (event: unknown): void => appendFileSync(trace, JSON.stringify({ process: process.pid, ...event as object }) + '\n');
const input: AgentRunInput = { threadId: 'fixture', prompt: 'synthetic command', systemPrompt: 'synthetic', mcpServers: {}, cwd: '/tmp', model: 'fixture', maxTurns: 25, timeoutMs: 600000 };

it('isolates shared versus fresh iterable ownership through the actual SDK adapter with actual drains', async () => {
  expect(importedQuery).toBe(query);
  const before = readFileSync(trace, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  expect(before.some(event => event.stage === 'deny-original-guards-installed')).toBe(true);
  expect(before.some(event => event.stage === 'fenced-sdk-resolution')).toBe(true);
  expect(before.some(event => event.stage === 'inert-sdk-module-evaluated')).toBe(true);
  expect(before.some(event => event.stage.includes('refused') || event.stage.includes('denied'))).toBe(false);
  const provider = new ClaudeCodeProvider({ enabled: true, command: 'NEVER_INVOKED', contextWindowTokens: 1024 });
  for (const arm of ['shared', 'fresh'] as const) {
    record({ arm, stage: 'arm-start' });
    const natives: AsyncGenerator[] = [];
    const nativeIds = new WeakMap<object, number>();
    const nativeReturns: Promise<unknown>[] = [];
    const returned: AsyncGenerator[] = [];
    function rawFactory(): AsyncGenerator {
      const nativeId = natives.length + 1;
      const raw = (async function* () {
        record({ arm, stage: 'native-before-yield', nativeId });
        yield { type: 'result', subtype: 'success', result: 'original final', session_id: 'original-session', usage: { input_tokens: 123, output_tokens: 45 }, is_error: false };
        record({ arm, stage: 'native-resumed-after-yield', nativeId });
      })();
      natives.push(raw);
      nativeIds.set(raw, nativeId);
      const originalReturn = raw.return.bind(raw);
      raw.return = (...args) => {
        record({ arm, stage: 'native-return-call', nativeId });
        const actual = originalReturn(...args);
        nativeReturns.push(actual);
        actual.then(value => record({ arm, stage: 'native-return-settled', nativeId, value }), error => record({ arm, stage: 'native-return-rejected', nativeId, error: String(error) }));
        return actual;
      };
      return raw;
    }
    const shared = arm === 'shared' ? rawFactory() : undefined;
    selectSyntheticQueryFactory(arm, () => {
      const raw = shared ?? rawFactory();
      returned.push(raw);
      record({ arm, stage: 'supplier-returned-original-iterable', queryCall: returned.length, nativeId: nativeIds.get(raw) });
      return raw;
    });
    const strategy = provider.createExecutionStrategy();
    const iterators = [strategy.run(input)[Symbol.asyncIterator](), strategy.run(input)[Symbol.asyncIterator]()];
    const pending: Promise<IteratorResult<AgentStreamEvent>>[] = [];
    const results: Array<Array<IteratorResult<AgentStreamEvent>>> = [[], []];
    function next(consumer: number): Promise<IteratorResult<AgentStreamEvent>> {
      record({ arm, stage: 'adapter-next-call', consumer });
      const actual = iterators[consumer].next();
      pending.push(actual);
      actual.then(value => record({ arm, stage: 'adapter-next-settled', consumer, value }), error => record({ arm, stage: 'adapter-next-rejected', consumer, error: String(error) }));
      return actual;
    }
    const first = [next(0), next(1)];
    try {
      await Promise.all(iterators.map(async (_iterator, consumer) => {
        let current = await first[consumer];
        results[consumer].push(current);
        while (!current.done) {
          current = await next(consumer);
          results[consumer].push(current);
        }
      }));
      expect(returned).toHaveLength(2);
      expect(returned[0] === returned[1]).toBe(arm === 'shared');
      const emitted = results.map(values => values.flatMap(value => value.done ? [] : [value.value]));
      expect(emitted.map(values => values.length).sort()).toEqual(arm === 'shared' ? [0, 1] : [1, 1]);
      for (const events of emitted) for (const event of events) expect(event).toMatchObject({ type: 'result', result: { output: 'original final', sessionId: 'original-session', usage: { inputTokens: 123, outputTokens: 45 }, isError: false } });
      record({ arm, stage: 'actual-result-summary', nativeIds: returned.map(raw => nativeIds.get(raw)), results });
    } finally {
      record({ arm, stage: 'drain-pending-next', count: pending.length });
      await Promise.allSettled(pending);
      await Promise.all(iterators.map(async (iterator, consumer) => {
        record({ arm, stage: 'adapter-return-call', consumer });
        await iterator.return?.(undefined);
        record({ arm, stage: 'adapter-return-settled', consumer });
      }));
      await Promise.all(natives.map(raw => raw.return(undefined)));
      await Promise.all(nativeReturns);
      record({ arm, stage: 'actual-drain-completed', adapters: iterators.length, nativeIterables: natives.length, awaitedNativeReturnPromises: nativeReturns.length });
      clearSyntheticQueryFactory();
    }
  }
  const all = readFileSync(trace, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  expect(all.filter(event => event.stage === 'synthetic-query-entry')).toHaveLength(4);
  expect(all.filter(event => event.stage === 'actual-drain-completed')).toHaveLength(2);
  expect(all.some(event => event.stage.includes('refused') || event.stage.includes('denied'))).toBe(false);
});
