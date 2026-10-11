/**
 * Conservative comparison of ESLint diagnostics for files changed from a
 * known baseline. Diagnostics are compared after mapping only source lines
 * that git proves unchanged. This module has no filesystem or process I/O so
 * its mapping and rejection rules can be tested independently.
 */

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

export class DiagnosticComparisonError extends Error {
  constructor(message, code = 'invalid') {
    super(message);
    this.name = 'DiagnosticComparisonError';
    this.code = code;
  }
}

function fail(message, code = 'invalid') {
  throw new DiagnosticComparisonError(message, code);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sourceLines(source) {
  if (typeof source !== 'string') fail('lint entry source is unavailable');
  if (source.length === 0) return [];

  const lines = [];
  let start = 0;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === '\n') {
      const end = index > start && source[index - 1] === '\r' ? index - 1 : index;
      lines.push({ start, end, separatorEnd: index + 1, text: source.slice(start, end) });
      start = index + 1;
    } else if (character === '\r' && source[index + 1] !== '\n') {
      lines.push({ start, end: index, separatorEnd: index + 1, text: source.slice(start, index) });
      start = index + 1;
    }
  }
  if (start < source.length) {
    lines.push({ start, end: source.length, separatorEnd: source.length, text: source.slice(start) });
  }
  return lines;
}

function parseCount(value, fallback = 1) {
  return value === undefined ? fallback : Number(value);
}

/** Parse `git diff --unified=0` output into per-file hunk metadata. */
export function parseUnifiedDiff(diffText) {
  if (typeof diffText !== 'string') fail('git diff output is not text');

  const files = new Map();
  let current = null;
  for (const line of diffText.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const header = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      if (!header) fail(`cannot parse git diff file header: ${line}`);
      current = { oldPath: header[1], newPath: header[2], hunks: [] };
      files.set(current.newPath, current);
      continue;
    }
    if (!line.startsWith('@@')) continue;
    if (!current) fail('git diff hunk has no file header');
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: |$)/.exec(line);
    if (!hunk) fail(`cannot parse git diff hunk header: ${line}`);
    current.hunks.push({
      oldStart: Number(hunk[1]),
      oldCount: parseCount(hunk[2]),
      newStart: Number(hunk[3]),
      newCount: parseCount(hunk[4]),
    });
  }
  return files;
}

function hunkEnd(start, count) {
  return count === 0 ? start : start + count - 1;
}

function validateHunks(hunks, oldLineCount, newLineCount) {
  if (!Array.isArray(hunks)) fail('git diff hunk list is unavailable');
  let previousOldEnd = -1;
  let previousNewEnd = -1;
  for (const hunk of hunks) {
    if (
      !isRecord(hunk) ||
      !Number.isInteger(hunk.oldStart) ||
      !Number.isInteger(hunk.oldCount) ||
      !Number.isInteger(hunk.newStart) ||
      !Number.isInteger(hunk.newCount) ||
      hunk.oldCount < 0 ||
      hunk.newCount < 0
    ) {
      fail('git diff contains an invalid hunk');
    }

    if (hunk.oldCount === 0) {
      if (hunk.oldStart < 0 || hunk.oldStart > oldLineCount) fail('git diff old insertion anchor is invalid');
    } else if (hunk.oldStart < 1 || hunk.oldStart + hunk.oldCount - 1 > oldLineCount) {
      fail('git diff old hunk range is invalid');
    }
    if (hunk.newCount === 0) {
      if (hunk.newStart < 0 || hunk.newStart > newLineCount) fail('git diff new deletion anchor is invalid');
    } else if (hunk.newStart < 1 || hunk.newStart + hunk.newCount - 1 > newLineCount) {
      fail('git diff new hunk range is invalid');
    }

    const oldEnd = hunkEnd(hunk.oldStart, hunk.oldCount);
    const newEnd = hunkEnd(hunk.newStart, hunk.newCount);
    if (hunk.oldStart <= previousOldEnd || hunk.newStart <= previousNewEnd) {
      fail('git diff hunk ranges overlap or are ambiguous');
    }
    previousOldEnd = oldEnd;
    previousNewEnd = newEnd;
  }
}

function lineInHunk(line, start, count) {
  return count > 0 && line >= start && line <= start + count - 1;
}

function mapOldLine(oldLine, hunks) {
  let delta = 0;
  for (const hunk of hunks) {
    if (hunk.oldCount > 0 && lineInHunk(oldLine, hunk.oldStart, hunk.oldCount)) {
      return undefined;
    }
    if (hunk.oldCount === 0 ? oldLine > hunk.oldStart : oldLine > hunk.oldStart + hunk.oldCount - 1) {
      delta += hunk.newCount - hunk.oldCount;
    }
  }
  return oldLine + delta;
}

function mapNewLine(newLine, hunks) {
  let delta = 0;
  for (const hunk of hunks) {
    if (hunk.newCount > 0 && lineInHunk(newLine, hunk.newStart, hunk.newCount)) {
      return undefined;
    }
    if (hunk.newCount === 0 ? newLine >= hunk.newStart : newLine > hunk.newStart + hunk.newCount - 1) {
      delta += hunk.oldCount - hunk.newCount;
    }
  }
  return newLine + delta;
}

/**
 * Build a bijection for unchanged lines. Every mapped pair is also checked
 * against the actual source text so malformed or ambiguous diff metadata
 * fails closed.
 */
export function buildLineMapping(oldSource, newSource, hunks) {
  const oldLines = sourceLines(oldSource);
  const newLines = sourceLines(newSource);
  validateHunks(hunks, oldLines.length, newLines.length);

  const oldToNew = Array(oldLines.length + 1).fill(undefined);
  const newToOld = Array(newLines.length + 1).fill(undefined);
  for (let oldLine = 1; oldLine <= oldLines.length; oldLine += 1) {
    const newLine = mapOldLine(oldLine, hunks);
    if (newLine === undefined) continue;
    if (!Number.isInteger(newLine) || newLine < 1 || newLine > newLines.length) {
      fail(`unchanged baseline line ${oldLine} has no valid current mapping`);
    }
    if (mapNewLine(newLine, hunks) !== oldLine) {
      fail(`line mapping is not one-to-one at baseline line ${oldLine}`);
    }
    if (oldLines[oldLine - 1].text !== newLines[newLine - 1].text) {
      fail(`unchanged line mapping is ambiguous at baseline line ${oldLine}`);
    }
    oldToNew[oldLine] = newLine;
  }
  for (let newLine = 1; newLine <= newLines.length; newLine += 1) {
    const oldLine = mapNewLine(newLine, hunks);
    if (oldLine === undefined) continue;
    if (!Number.isInteger(oldLine) || oldLine < 1 || oldLine > oldLines.length) {
      fail(`unchanged current line ${newLine} has no valid baseline mapping`);
    }
    if (oldToNew[oldLine] !== newLine) {
      fail(`line mapping is not one-to-one at current line ${newLine}`);
    }
    newToOld[newLine] = oldLine;
  }

  return { oldLines, newLines, oldToNew, newToOld };
}

function sourcePosition(lines, offset) {
  if (!Number.isInteger(offset) || offset < 0) fail('diagnostic range offset is invalid');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (offset >= line.start && offset <= line.end) {
      return { line: index + 1, column: offset - line.start + 1 };
    }
    if (offset > line.end && offset < line.separatorEnd) {
      fail('diagnostic range falls inside a line separator');
    }
    if (offset === line.separatorEnd && index + 1 < lines.length) {
      return { line: index + 2, column: 1 };
    }
  }
  if (lines.length > 0 && offset === lines.at(-1).separatorEnd) {
    return { line: lines.length, column: lines.at(-1).text.length + 1 };
  }
  fail('diagnostic range offset is outside source');
}

function mapUnchangedLine(mapping, side, line) {
  const sourceMap = side === 'baseline' ? mapping.oldToNew : mapping.newToOld;
  if (!Number.isInteger(line) || line < 1 || line >= sourceMap.length) {
    fail(`diagnostic line ${String(line)} is outside source`);
  }
  const mapped = sourceMap[line];
  if (mapped === undefined) {
    fail(`diagnostic touches changed source line ${line}`, 'changed-range');
  }
  return side === 'baseline' ? line : mapped;
}

function validateColumn(lines, line, column, label) {
  if (!Number.isInteger(column) || column < 1) fail(`${label} column is invalid`);
  const sourceLine = lines[line - 1];
  if (!sourceLine || column > sourceLine.text.length + 1) {
    fail(`${label} column is outside source`);
  }
}

function normalizePrimary(message, mapping, side, sourceInfo) {
  if (!Number.isInteger(message.line) || !Number.isInteger(message.column)) {
    fail('diagnostic primary position is malformed');
  }
  if (message.line < 1 || message.column < 1) fail('diagnostic primary position is invalid');

  const hasEndLine = hasOwn(message, 'endLine');
  const hasEndColumn = hasOwn(message, 'endColumn');
  if (hasEndLine !== hasEndColumn) fail('diagnostic end position is incomplete');
  if (hasEndLine && (!Number.isInteger(message.endLine) || !Number.isInteger(message.endColumn))) {
    fail('diagnostic end position is malformed');
  }

  const endLine = hasEndLine ? message.endLine : message.line;
  const endColumn = hasEndLine ? message.endColumn : message.column;
  if (endLine < message.line || endColumn < 1) fail('diagnostic end position is invalid');
  validateColumn(sourceInfo.lines, message.line, message.column, 'diagnostic start');
  validateColumn(sourceInfo.lines, endLine, endColumn, 'diagnostic end');
  for (let line = message.line; line <= endLine; line += 1) {
    mapUnchangedLine(mapping, side, line);
  }
  const mappedLine = mapUnchangedLine(mapping, side, message.line);
  const mappedEndLine = mapUnchangedLine(mapping, side, endLine);
  if (endLine === message.line && endColumn < message.column) {
    fail('diagnostic end column precedes its start');
  }

  const normalized = { line: mappedLine, column: message.column };
  if (hasEndLine) {
    normalized.endLine = mappedEndLine;
    normalized.endColumn = endColumn;
  }
  return normalized;
}

function normalizeRange(range, sourceInfo, mapping, side) {
  if (!Array.isArray(range) || range.length !== 2 || !range.every(Number.isInteger)) {
    fail('diagnostic auxiliary range is malformed');
  }
  const [start, end] = range;
  if (start < 0 || end < start || end > sourceInfo.source.length) {
    fail('diagnostic auxiliary range is outside source');
  }
  const startPosition = sourcePosition(sourceInfo.lines, start);
  const endPosition = sourcePosition(sourceInfo.lines, end);
  const firstLine = Math.min(startPosition.line, endPosition.line);
  const lastLine = Math.max(startPosition.line, endPosition.line);
  for (let line = firstLine; line <= lastLine; line += 1) {
    mapUnchangedLine(mapping, side, line);
  }
  return [
    mapUnchangedLine(mapping, side, startPosition.line),
    startPosition.column,
    mapUnchangedLine(mapping, side, endPosition.line),
    endPosition.column,
  ];
}

function normalizeFix(fix, context) {
  if (!isRecord(fix)) fail('diagnostic fix is malformed');
  const normalized = {};
  for (const key of Object.keys(fix).sort()) {
    normalized[key] = key === 'range'
      ? normalizeRange(fix[key], context.sourceInfo, context.mapping, context.side)
      : fix[key];
  }
  return normalized;
}

function normalizeNested(value, context) {
  if (!isRecord(value)) fail('diagnostic suggestion is malformed');
  const normalized = {};
  for (const key of Object.keys(value).sort()) {
    if (key === 'fix') {
      normalized[key] = normalizeFix(value[key], context);
    } else if (key === 'range') {
      normalized[key] = normalizeRange(value[key], context.sourceInfo, context.mapping, context.side);
    } else if (key === 'line' || key === 'endLine') {
      normalized[key] = mapUnchangedLine(context.mapping, context.side, value[key]);
    } else {
      normalized[key] = value[key];
    }
  }
  return normalized;
}

function normalizeDiagnostic(message, context) {
  if (!isRecord(message)) fail('lint diagnostic is malformed');
  const normalized = {};
  for (const key of Object.keys(message).sort()) {
    if (key === 'line' || key === 'column' || key === 'endLine' || key === 'endColumn') continue;
    if (key === 'fix') {
      normalized[key] = normalizeFix(message[key], context);
    } else if (key === 'suggestions') {
      if (!Array.isArray(message[key])) fail('diagnostic suggestions are malformed');
      normalized[key] = message[key].map((suggestion) => normalizeNested(suggestion, context));
    } else if (key === 'range') {
      normalized[key] = normalizeRange(message[key], context.sourceInfo, context.mapping, context.side);
    } else {
      normalized[key] = message[key];
    }
  }
  return {
    ...normalized,
    ...normalizePrimary(message, context.mapping, context.side, context.sourceInfo),
  };
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (isRecord(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

function diagnosticKey(value) {
  return JSON.stringify(stableValue(value));
}

function validateEntry(entry, label) {
  if (!isRecord(entry)) fail(`${label} lint entry is malformed`);
  if (!Array.isArray(entry.messages)) fail(`${label} lint messages are malformed`);
  let errorCount = 0;
  let warningCount = 0;
  for (const message of entry.messages) {
    if (!isRecord(message) || !Number.isInteger(message.severity) || ![1, 2].includes(message.severity)) {
      fail(`${label} lint diagnostic severity is malformed`);
    }
    if (message.severity === 2) errorCount += 1;
    if (message.severity === 1) warningCount += 1;
  }
  for (const field of ['errorCount', 'warningCount', 'fatalErrorCount']) {
    if (!Number.isInteger(entry[field]) || entry[field] < 0) {
      fail(`${label} lint ${field} is malformed`);
    }
  }
  if (entry.errorCount !== errorCount || entry.warningCount !== warningCount) {
    fail(`${label} lint counts do not match diagnostics`);
  }
  if (entry.fatalErrorCount > 0) fail(`${label} lint parse failure`);
}

/**
 * Compare one touched file's active diagnostics. Baseline diagnostics located
 * on changed source ranges are intentionally omitted: they belong to code
 * the patch is allowed to repair. Every current diagnostic must instead map
 * to one unchanged baseline diagnostic, with all semantic and auxiliary
 * fields preserved.
 */
export function compareTouchedFileDiagnostics({ filePath, baseline, current, hunks }) {
  validateEntry(current, 'current');
  if (!baseline) {
    if (current.messages.length > 0) fail(`new source file has diagnostics: ${filePath}`);
    return { matched: 0, ignoredChangedBaseline: 0 };
  }
  validateEntry(baseline, 'baseline');

  if (baseline.messages.length === 0 && current.messages.length === 0) {
    return { matched: 0, ignoredChangedBaseline: 0 };
  }
  if (typeof baseline.source !== 'string' || typeof current.source !== 'string') {
    fail(`source text is unavailable for touched file: ${filePath}`);
  }

  const mapping = buildLineMapping(baseline.source, current.source, hunks);
  const baselineContext = {
    mapping,
    side: 'baseline',
    sourceInfo: { source: baseline.source, lines: mapping.oldLines },
  };
  const currentContext = {
    mapping,
    side: 'current',
    sourceInfo: { source: current.source, lines: mapping.newLines },
  };
  const expected = new Map();
  let ignoredChangedBaseline = 0;
  for (const message of baseline.messages) {
    try {
      const normalized = normalizeDiagnostic(message, baselineContext);
      const key = diagnosticKey(normalized);
      expected.set(key, (expected.get(key) ?? 0) + 1);
    } catch (error) {
      if (error instanceof DiagnosticComparisonError && error.code === 'changed-range') {
        ignoredChangedBaseline += 1;
        continue;
      }
      throw error;
    }
  }

  let matched = 0;
  for (const message of current.messages) {
    const normalized = normalizeDiagnostic(message, currentContext);
    const key = diagnosticKey(normalized);
    const count = expected.get(key) ?? 0;
    if (count === 0) {
      fail(`new or changed diagnostic in touched file: ${filePath}`);
    }
    expected.set(key, count - 1);
    matched += 1;
  }

  for (const count of expected.values()) {
    if (count > 0) fail(`baseline diagnostic missing from touched file: ${filePath}`);
  }
  return { matched, ignoredChangedBaseline };
}
