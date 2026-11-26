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
/** More write tools or channels than this make the summary an error: none is hidden. */
const LISTED_MAX = 50;
const RECIPIENT_MAX = 80;
const SHORT_STRING = 80;
const STRING_MAX = 120;
const MAX_DEPTH = 32;
/** A run of whitespace, control and format characters in a string value of a write. */
const BLANK_RUN = new RegExp(
  // eslint-disable-next-line no-control-regex
  '[\\s\\p{Cf}\\u0000-\\u001F\\u007F-\\u009F]+',
  'gu',
);
const CHANNEL_SEND = 'talon.channel_send';
const JUDGE = 'model.judge';

/*
 * Nothing that the user approves is hidden or cut so that it changes meaning.
 * Every write tool and every channel is listed (at most 50 each), each recipient
 * of a channel send is shown in full, and each write is shown. If that does not
 * fit in one message, the summary is an error and the version cannot be put up
 * for approval.
 */

// Control characters, line and paragraph separators, bidirectional overrides and isolates.
const UNSAFE = new RegExp(
  // eslint-disable-next-line no-control-regex
  '[\\u0000-\\u001F\\u007F-\\u009F\\u2028\\u2029\\u202A-\\u202E\\u2066-\\u2069]',
  'g',
);

/** The one path for text that comes from the script or from data. */
export function clean(text: string, max: number): string {
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

/** One space for each run of whitespace, control and format characters, and no blank ends. */
function flatten(text: string): string {
  return text.replace(BLANK_RUN, ' ').trim();
}

function isScalar(value: unknown): boolean {
  return value === null || typeof value !== 'object';
}

function isShortScalar(value: unknown): boolean {
  return (
    value === null ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    (typeof value === 'string' && flatten(value).length < SHORT_STRING)
  );
}

/**
 * JSON with, at each level of an object, the short scalar values first, then the
 * other scalars, then the objects and arrays. Each string is cut at STRING_MAX, so
 * a long value cannot push a short one out of the line.
 */
function orderedJson(value: unknown, depth = 0): string | undefined {
  if (depth > MAX_DEPTH) throw new Error('too deep');
  if (typeof value === 'string') {
    // Padding cannot push the visible part of a value past the cut.
    const flat = flatten(value);
    return JSON.stringify(flat.length > STRING_MAX ? `${flat.slice(0, STRING_MAX - 1)}…` : flat);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => orderedJson(item, depth + 1) ?? 'null').join(',')}]`;
  }
  if (isRecord(value)) {
    const entries = Object.entries(value);
    const ordered = [
      ...entries.filter(([, item]) => isShortScalar(item)),
      ...entries.filter(([, item]) => isScalar(item) && !isShortScalar(item)),
      ...entries.filter(([, item]) => !isScalar(item)),
    ];
    const parts: string[] = [];
    for (const [key, item] of ordered) {
      const text = orderedJson(item, depth + 1);
      if (text !== undefined) parts.push(`${JSON.stringify(key)}:${text}`);
    }
    return `{${parts.join(',')}}`;
  }
  return JSON.stringify(value);
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : inputJson(value);
}

const FORMAT = /\p{Cf}/gu;
// Whitespace and control characters. A recipient that still holds one is refused.
const BLANK_OR_CONTROL = new RegExp(
  // eslint-disable-next-line no-control-regex
  '[\\s\\u0000-\\u001F\\u007F-\\u009F]',
  'u',
);

/**
 * A recipient part, in full, or undefined if it cannot be shown as it is sent.
 * The ends are trimmed (as the live handler does) and format characters are
 * removed. Nothing inside the value is removed: a space or control character
 * that remains makes it undefined.
 */
function recipient(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const text = String(value).replace(FORMAT, '').trim();
  if (BLANK_OR_CONTROL.test(text)) return undefined;
  return text.length > 0 && text.length <= RECIPIENT_MAX ? text : undefined;
}

/** The line of one write, or undefined if it cannot be shown without a cut that hides data. */
function writeLine(call: CallRecord): string | undefined {
  const name = clean(call.name, TOOL_MAX);
  if (call.name === CHANNEL_SEND && isRecord(call.input)) {
    const { channelId, externalChatId, content } = call.input;
    const channel = recipient(channelId);
    const chat =
      externalChatId === undefined || externalChatId === null
        ? '(thread chat)'
        : recipient(externalChatId);
    if (channel === undefined || chat === undefined) return undefined;
    return `${name} to ${channel}/${chat}: ${clean(asText(content), INPUT_MAX)}`;
  }
  let json: string | undefined;
  try {
    json = orderedJson(call.input) ?? 'null';
  } catch {
    return undefined;
  }
  const text = clean(json, Number.POSITIVE_INFINITY);
  return text.length > INPUT_MAX ? undefined : `${name} ${text}`;
}

/** The names, each in full, or undefined if a name is longer than `max` after cleaning. */
function listed(names: string[], max: number): string | undefined {
  const shown = names.map((name) => clean(name, Number.POSITIVE_INFINITY));
  return shown.some((name) => name.length > max) ? undefined : shown.join(', ');
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
    inputSchema?: Record<string, unknown>;
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
  let unshown = 0;
  for (const call of input.report.calls) {
    if (call.outcome === 'failed' || call.outcome === 'denied') {
      failed++;
    } else if (call.toolClass === 'model' && call.outcome === 'executed') {
      models++;
    } else if (call.toolClass === 'read' && call.outcome === 'executed') {
      const name = clean(call.name, READ_TOOL_MAX);
      reads.set(name, (reads.get(name) ?? 0) + 1);
    } else if (call.outcome === 'skipped-dry-run') {
      const line = writeLine(call);
      if (line === undefined) unshown++;
      else writes.push(line);
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
  if (unshown > 0) {
    return err(
      new ScriptError('RESULT_TOO_LARGE', 'a dry-run write cannot be shown in full in the message'),
    );
  }
  if (writeTools.length > LISTED_MAX || manifest.channels.length > LISTED_MAX) {
    return err(
      new ScriptError('RESULT_TOO_LARGE', 'the script lists too many write tools or channels'),
    );
  }
  const writeList = listed(writeTools, READ_TOOL_MAX);
  const channelList = listed(manifest.channels, NAME_MAX);
  if (writeList === undefined || channelList === undefined) {
    return err(
      new ScriptError('RESULT_TOO_LARGE', 'a write tool or channel name is too long to show'),
    );
  }
  let inputLine: string | undefined;
  if (manifest.inputSchema !== undefined) {
    const properties = manifest.inputSchema.properties;
    const names = isRecord(properties) ? Object.keys(properties) : [];
    const nameList = names.length === 0 ? 'yes' : listed(names, READ_TOOL_MAX);
    if (names.length > LISTED_MAX || nameList === undefined) {
      return err(
        new ScriptError('RESULT_TOO_LARGE', 'the input schema lists too many or too long names'),
      );
    }
    inputLine = `Accepts input: ${nameList}`;
  }
  const head = [
    `Script "${clean(input.name, NAME_MAX)}" v${input.version} asks for approval.`,
    `About: ${clean(input.description, DESCRIPTION_MAX)}`,
    writeTools.length === 0 ? 'May write with: nothing' : `May write with: ${writeList}`,
  ];
  if (manifest.tools.includes(JUDGE)) {
    head.push('May use the model: yes');
  }
  if (manifest.channels.length > 0) {
    head.push(`Channels: ${channelList}`);
  }
  if (inputLine !== undefined) {
    head.push(inputLine);
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
