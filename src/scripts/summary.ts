import type { ScriptRunReport } from './types.js';

const MAX_TOTAL = 3500;
const NAME_MAX = 60;
const DESCRIPTION_MAX = 500;
const TOOL_MAX = 100;
const INPUT_MAX = 600;
const READ_TOOL_MAX = 60;
const READ_TOOLS_SHOWN = 8;

/*
 * Worst case of the head (everything before the writes), in characters:
 *   title      8 + 60 + 3 + 9 + 19            =   99
 *   About      7 + 500                        =  507
 *   Dry run line                              =   21
 *   Read line  6 + 8 * (60 + 2 + 3 + 2) + 23  =  ~570
 *   Model requests / Failed / Unexpected      =  ~65
 *   Would write (n):                          =   20
 *   closing                                   =   40
 *   newlines                                  =  ~12
 * about 1,350, below 1,500, so the head always fits and writes are the only part that shrinks.
 */

// Control characters, line and paragraph separators, bidirectional overrides and isolates.
const UNSAFE = new RegExp(
  // eslint-disable-next-line no-control-regex
  '[\\u0000-\\u001F\\u007F-\\u009F\\u2028\\u2029\\u202A-\\u202E\\u2066-\\u2069]',
  'g',
);

/** The one path for text that comes from the script or from data. */
function clean(text: string, max: number): string {
  const flat = text.replace(UNSAFE, ' ');
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function inputJson(input: unknown): string {
  try {
    return JSON.stringify(input) ?? 'null';
  } catch {
    return '[unserializable]';
  }
}

function ttlText(minutes: number): string {
  return minutes < 120 ? `${minutes} minutes` : `${Math.floor(minutes / 60)} hours`;
}

export function buildApprovalSummary(input: {
  name: string;
  version: number;
  description: string;
  report: ScriptRunReport;
  code: string;
  ttlMinutes: number;
}): string {
  const tail = [
    `/approve ${input.code}`,
    `/reject ${input.code}`,
    `Valid for ${ttlText(input.ttlMinutes)}.`,
  ].join('\n');

  const reads = new Map<string, number>();
  let models = 0;
  let failed = 0;
  let unexpected = 0;
  const writes: string[] = [];
  for (const call of input.report.calls) {
    if (call.outcome === 'failed' || call.outcome === 'denied') {
      failed++;
    } else if (call.toolClass === 'model' && call.outcome === 'executed') {
      models++;
    } else if (call.toolClass === 'read' && call.outcome === 'executed') {
      const name = clean(call.name, READ_TOOL_MAX);
      reads.set(name, (reads.get(name) ?? 0) + 1);
    } else if (call.outcome === 'skipped-dry-run') {
      writes.push(`${clean(call.name, TOOL_MAX)} ${clean(inputJson(call.input), INPUT_MAX)}`);
    } else if (call.toolClass === 'write') {
      unexpected++;
    }
  }

  const byCount = [...reads].sort(
    (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
  );
  const shownReads = byCount.slice(0, READ_TOOLS_SHOWN).map(([name, count]) => `${name} ×${count}`);
  if (byCount.length > READ_TOOLS_SHOWN) {
    shownReads.push(`and ${byCount.length - READ_TOOLS_SHOWN} more tools`);
  }

  const head = [
    `Script "${clean(input.name, NAME_MAX)}" v${input.version} asks for approval.`,
    `About: ${clean(input.description, DESCRIPTION_MAX)}`,
    '',
    'Dry run on real data:',
    shownReads.length === 0 ? 'Read: none' : `Read: ${shownReads.join(', ')}`,
    `Model requests: ${models}`,
  ];
  if (failed > 0) {
    head.push(`Failed calls: ${failed}`);
  }
  if (unexpected > 0) {
    head.push(`Unexpected calls: ${unexpected}`);
  }
  const closing = ['', 'The script did not change anything yet.'];

  const room = MAX_TOTAL - tail.length - 1;
  const assemble = (shown: number): string => {
    const lines = [...head];
    if (writes.length === 0) {
      lines.push('Would write: nothing');
    } else {
      lines.push(`Would write (${writes.length}):`);
      writes.slice(0, shown).forEach((write, i) => lines.push(`${i + 1}. ${write}`));
      if (shown < writes.length) {
        lines.push(`(and ${writes.length - shown} more writes not shown)`);
      }
    }
    // Final guard: no body line can look like a command line.
    return [...lines, ...closing]
      .map((line) => (line.trimStart().startsWith('/') ? `· ${line}` : line))
      .join('\n');
  };
  let shown = writes.length;
  let body = assemble(shown);
  while (body.length > room && shown > 0) {
    shown--;
    body = assemble(shown);
  }
  return `${body}\n${tail}`;
}
