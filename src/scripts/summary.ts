import { isDeepStrictEqual } from 'node:util';
import { err, ok, type Result } from 'neverthrow';
import { ScriptError, type CallRecord, type ScriptRunReport, type ToolClass } from './types.js';

const MAX_TOTAL = 3500;
const NAME_MAX = 60;
const DESCRIPTION_MAX = 500;
const TOOL_MAX = 100;
const INPUT_MAX = 600;
const READ_TOOL_MAX = 60;
const READ_TOOLS_SHOWN = 8;
const WRITE_TOOLS_SHOWN = 12;
const CHANNELS_SHOWN = 8;
const RECIPIENT_MAX = 80;
const SHORT_STRING = 80;
const CHANNEL_SEND = 'talon.channel_send';
const JUDGE = 'model.judge';

/*
 * Worst case of the head (everything before the writes), in characters:
 *   title      8 + 60 + 3 + 9 + 19            =   99
 *   About      7 + 500                        =  507
 *   May write  16 + 12 * (60 + 2) + 16        =  ~776
 *   Model      22                             =   22
 *   Channels   10 + 8 * (60 + 2) + 16        =  ~522
 *   Input line                                =   51
 *   Dry run line                              =   21
 *   Read line  6 + 8 * (60 + 2 + 3 + 2) + 23  =  ~570
 *   Model requests / Failed / Unexpected      =  ~65
 *   Would write (n):                          =   20
 *   closing                                   =   40
 *   newlines                                  =  ~16
 * about 2,700, so the head always fits and the writes get the rest. Writes that
 * do not fit make the summary an error: a write is never hidden.
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isShortScalar(value: unknown): boolean {
  return (
    value === null ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    (typeof value === 'string' && value.length < SHORT_STRING)
  );
}

/** JSON of an object with the short scalar values first, so a long value cannot push them out. */
function orderedJson(input: unknown): string {
  if (!isRecord(input)) return inputJson(input);
  try {
    const entries = Object.entries(input);
    const ordered = [
      ...entries.filter(([, value]) => isShortScalar(value)),
      ...entries.filter(([, value]) => !isShortScalar(value)),
    ];
    const parts: string[] = [];
    for (const [key, value] of ordered) {
      const text = JSON.stringify(value);
      if (text !== undefined) parts.push(`${JSON.stringify(key)}:${text}`);
    }
    return `{${parts.join(',')}}`;
  } catch {
    return '[unserializable]';
  }
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : inputJson(value);
}

function writeLine(call: CallRecord): string {
  const name = clean(call.name, TOOL_MAX);
  if (call.name === CHANNEL_SEND && isRecord(call.input)) {
    const { channelId, externalChatId, content } = call.input;
    const channel = clean(asText(channelId), RECIPIENT_MAX);
    const chat =
      externalChatId === undefined || externalChatId === null
        ? '(thread chat)'
        : clean(asText(externalChatId), RECIPIENT_MAX);
    return `${name} to ${channel}/${chat}: ${clean(asText(content), INPUT_MAX)}`;
  }
  return `${name} ${clean(orderedJson(call.input), INPUT_MAX)}`;
}

function listed(names: string[], max: number, shown: number): string {
  const head = names.slice(0, shown).map((name) => clean(name, max));
  if (names.length > shown) head.push(`and ${names.length - shown} more`);
  return head.join(', ');
}

function sameJson(a: unknown, b: unknown): boolean {
  try {
    const text = (value: unknown): unknown => {
      const json = JSON.stringify(value);
      return json === undefined ? undefined : JSON.parse(json);
    };
    return isDeepStrictEqual(text(a), text(b));
  } catch {
    return false;
  }
}

function ttlText(minutes: number): string {
  return minutes < 120 ? `${minutes} minutes` : `${Math.floor(minutes / 60)} hours`;
}

export interface ApprovalSummaryInput {
  name: string;
  version: number;
  description: string;
  /** The authored manifest fields that the user approves. */
  manifest: {
    tools: string[];
    channels: string[];
    dryRunInput: unknown;
    liveInput?: unknown;
  };
  /** The class of a manifest tool, from the provider. `undefined` counts as `write`. */
  toolClass(name: string): ToolClass | undefined;
  report: ScriptRunReport;
  code: string;
  ttlMinutes: number;
}

/** `err` when not every write of the dry run fits in the message. */
export function buildApprovalSummary(input: ApprovalSummaryInput): Result<string, ScriptError> {
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
      writes.push(writeLine(call));
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

  const { manifest } = input;
  const writeTools = manifest.tools.filter((tool) => {
    const toolClass = input.toolClass(tool);
    return toolClass === undefined || toolClass === 'write';
  });
  const head = [
    `Script "${clean(input.name, NAME_MAX)}" v${input.version} asks for approval.`,
    `About: ${clean(input.description, DESCRIPTION_MAX)}`,
    writeTools.length === 0
      ? 'May write with: nothing'
      : `May write with: ${listed(writeTools, READ_TOOL_MAX, WRITE_TOOLS_SHOWN)}`,
  ];
  if (manifest.tools.includes(JUDGE)) {
    head.push('May use the model: yes');
  }
  if (manifest.channels.length > 0) {
    head.push(`Channels: ${listed(manifest.channels, NAME_MAX, CHANNELS_SHOWN)}`);
  }
  if (manifest.liveInput !== undefined && !sameJson(manifest.liveInput, manifest.dryRunInput)) {
    head.push('The scheduled input differs from the dry-run input.');
  }
  head.push(
    '',
    'Dry run on real data:',
    shownReads.length === 0 ? 'Read: none' : `Read: ${shownReads.join(', ')}`,
    `Model requests: ${models}`,
  );
  if (failed > 0) {
    head.push(`Failed calls: ${failed}`);
  }
  if (unexpected > 0) {
    head.push(`Unexpected calls: ${unexpected}`);
  }
  const closing = ['', 'The script did not change anything yet.'];

  const lines = [...head];
  if (writes.length === 0) {
    lines.push('Would write: nothing');
  } else {
    lines.push(`Would write (${writes.length}):`);
    writes.forEach((write, i) => lines.push(`${i + 1}. ${write}`));
  }
  // Final guard: no body line can look like a command line.
  const body = [...lines, ...closing]
    .map((line) => (line.trimStart().startsWith('/') ? `· ${line}` : line))
    .join('\n');
  if (body.length > MAX_TOTAL - tail.length - 1) {
    return err(new ScriptError('RESULT_TOO_LARGE', 'the dry-run writes do not fit in one message'));
  }
  return ok(`${body}\n${tail}`);
}
