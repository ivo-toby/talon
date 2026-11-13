import { appendFileSync } from 'node:fs';
const trace = '/home/ivo/workspace/talon.feat-signal/.wdd/dispatch/pi-validation/TASK-010-review2-B-counterexample-v5-trace.jsonl';
const record = event => appendFileSync(trace, JSON.stringify({ process: process.pid, ...event }) + '\n');
record({ stage: 'inert-sdk-module-evaluated', module: import.meta.url });
let selected;
export function selectSyntheticQueryFactory(arm, factory) {
  if (selected) throw new Error('Previous synthetic arm not cleared after actual drain');
  selected = { arm, factory, calls: 0 };
}
export function clearSyntheticQueryFactory() { selected = undefined; }
export function query(input) {
  if (!selected) throw new Error('Synthetic SDK query refused outside selected arm');
  const call = ++selected.calls;
  record({ stage: 'synthetic-query-entry', arm: selected.arm, call, threadId: input.prompt });
  const iterable = selected.factory();
  record({ stage: 'synthetic-query-return', arm: selected.arm, call });
  return iterable;
}
