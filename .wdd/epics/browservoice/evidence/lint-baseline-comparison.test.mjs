import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildLineMapping,
  compareTouchedFileDiagnostics,
  DiagnosticComparisonError,
  parseUnifiedDiff,
} from './lint-baseline-comparison.mjs';

function diagnostic(line, overrides = {}) {
  return {
    ruleId: 'demo/rule',
    severity: 2,
    message: 'demo diagnostic',
    line,
    column: 1,
    nodeType: 'Identifier',
    messageId: 'demo',
    endLine: line,
    endColumn: 2,
    ...overrides,
  };
}

function entry(source, messages = [], overrides = {}) {
  return {
    filePath: '/tmp/src/example.ts',
    messages,
    errorCount: messages.filter((message) => message.severity === 2).length,
    warningCount: messages.filter((message) => message.severity === 1).length,
    fatalErrorCount: 0,
    source,
    ...overrides,
  };
}

function compare(beforeSource, afterSource, beforeMessages, afterMessages, hunks = []) {
  return compareTouchedFileDiagnostics({
    filePath: 'src/example.ts',
    baseline: entry(beforeSource, beforeMessages),
    current: entry(afterSource, afterMessages),
    hunks,
  });
}

function assertRejected(action, text) {
  assert.throws(action, (error) => {
    assert.ok(error instanceof DiagnosticComparisonError);
    assert.match(error.message, text);
    return true;
  });
}

test('maps an unchanged diagnostic across an insertion and a deletion', () => {
  const before = 'one\ntwo\nthree';
  const afterInsertion = 'inserted\none\ntwo\nthree';
  const insertion = [{ oldStart: 0, oldCount: 0, newStart: 1, newCount: 1 }];
  assert.deepEqual(
    compare(before, afterInsertion, [diagnostic(3)], [diagnostic(4)], insertion),
    { matched: 1, ignoredChangedBaseline: 0 },
  );

  const beforeDeletion = 'removed\none\ntwo\nthree';
  const afterDeletion = 'one\ntwo\nthree';
  const deletion = [{ oldStart: 1, oldCount: 1, newStart: 0, newCount: 0 }];
  assert.deepEqual(
    compare(beforeDeletion, afterDeletion, [diagnostic(4)], [diagnostic(3)], deletion),
    { matched: 1, ignoredChangedBaseline: 0 },
  );
});

test('rejects a current diagnostic whose primary range touches changed code', () => {
  const source = 'one\ntwo\nthree';
  const replacement = [{ oldStart: 2, oldCount: 1, newStart: 2, newCount: 1 }];
  assertRejected(
    () => compare(source, source, [diagnostic(2)], [diagnostic(2)], replacement),
    /changed source line/,
  );
  assertRejected(
    () => compare(source, source, [diagnostic(1)], [diagnostic(1, { endLine: 3, endColumn: 2 })], replacement),
    /changed source line/,
  );
});

test('rejects changed rule, severity, message, node, or column even with equal totals', () => {
  const source = 'one\ntwo\nthree';
  const changes = [
    ['ruleId', 'other/rule'],
    ['severity', 1],
    ['message', 'different diagnostic'],
    ['nodeType', 'CallExpression'],
    ['column', 2],
  ];
  for (const [field, value] of changes) {
    assertRejected(
      () => compare(source, source, [diagnostic(2)], [diagnostic(2, { [field]: value })]),
      /new or changed diagnostic/,
    );
  }
});

test('rejects missing, new, and swapped diagnostics one-to-one', () => {
  const source = 'one\ntwo\nthree';
  const first = diagnostic(1, { message: 'first' });
  const second = diagnostic(2, { message: 'second' });
  assertRejected(() => compare(source, source, [first], []), /baseline diagnostic missing/);
  assertRejected(() => compare(source, source, [], [first]), /new or changed diagnostic/);
  assertRejected(
    () => compare(source, source, [first, second], [
      diagnostic(1, { message: 'second' }),
      diagnostic(2, { message: 'first' }),
    ]),
    /new or changed diagnostic/,
  );
});

test('rejects an auxiliary fix or suggestion range that touches changed code', () => {
  const before = 'one\nbad\nthree';
  const after = 'one\nchanged\nthree';
  const changed = [{ oldStart: 2, oldCount: 1, newStart: 2, newCount: 1 }];
  const withSuggestion = diagnostic(1, {
    suggestions: [{
      messageId: 'replace',
      desc: 'replace changed text',
      fix: { range: [4, 7], text: 'good' },
    }],
  });
  const currentSuggestion = diagnostic(1, {
    suggestions: [{
      messageId: 'replace',
      desc: 'replace changed text',
      fix: { range: [4, 11], text: 'good' },
    }],
  });
  assertRejected(
    () => compare(before, after, [withSuggestion], [currentSuggestion], changed),
    /changed source line/,
  );
});

test('maps unchanged fix and suggestion ranges after a line insertion', () => {
  const before = 'one\nbad\nthree';
  const after = 'inserted\none\nbad\nthree';
  const insertion = [{ oldStart: 0, oldCount: 0, newStart: 1, newCount: 1 }];
  const beforeStart = before.indexOf('bad');
  const afterStart = after.indexOf('bad');
  const beforeMessage = diagnostic(2, {
    fix: { range: [beforeStart, beforeStart + 3], text: 'good' },
    suggestions: [{
      messageId: 'replace',
      desc: 'replace text',
      fix: { range: [beforeStart, beforeStart + 3], text: 'good' },
    }],
  });
  const afterMessage = diagnostic(3, {
    fix: { range: [afterStart, afterStart + 3], text: 'good' },
    suggestions: [{
      messageId: 'replace',
      desc: 'replace text',
      fix: { range: [afterStart, afterStart + 3], text: 'good' },
    }],
  });
  assert.deepEqual(compare(before, after, [beforeMessage], [afterMessage], insertion), {
    matched: 1,
    ignoredChangedBaseline: 0,
  });
});

test('rejects malformed or unmappable diagnostic positions and source mappings', () => {
  const source = 'one\ntwo';
  assertRejected(
    () => compare(source, source, [diagnostic(3)], [diagnostic(3)]),
    /outside source/,
  );
  assertRejected(
    () => compare('one\ntwo', 'one\nchanged', [diagnostic(2)], [diagnostic(2)], []),
    /ambiguous/,
  );
  assertRejected(
    () => compare(source, source, [diagnostic(1)], [diagnostic(1)], [
      { oldStart: 1, oldCount: 3, newStart: 1, newCount: 1 },
    ]),
    /hunk range is invalid/,
  );
  assertRejected(
    () => parseUnifiedDiff('@@ malformed @@'),
    /no file header/,
  );
});

test('requires new source files to be clean and rejects lint parse failures', () => {
  const clean = entry('new source');
  assert.deepEqual(
    compareTouchedFileDiagnostics({
      filePath: 'src/new.ts',
      baseline: null,
      current: clean,
      hunks: [],
    }),
    { matched: 0, ignoredChangedBaseline: 0 },
  );
  assertRejected(
    () => compareTouchedFileDiagnostics({
      filePath: 'src/new.ts',
      baseline: null,
      current: entry('new source', [diagnostic(1)]),
      hunks: [],
    }),
    /new source file has diagnostics/,
  );
  assertRejected(
    () => compareTouchedFileDiagnostics({
      filePath: 'src/example.ts',
      baseline: entry('one', [], { fatalErrorCount: 1 }),
      current: entry('one'),
      hunks: [],
    }),
    /parse failure/,
  );
});

test('parses unified-zero diff hunks with stable file paths', () => {
  const diff = [
    'diff --git a/src/example.ts b/src/example.ts',
    'index 1111111..2222222 100644',
    '@@ -2,0 +3,1 @@ export const example = true;',
    '+inserted',
  ].join('\n');
  assert.deepEqual([...parseUnifiedDiff(diff)], [[
    'src/example.ts',
    {
      oldPath: 'src/example.ts',
      newPath: 'src/example.ts',
      hunks: [{ oldStart: 2, oldCount: 0, newStart: 3, newCount: 1 }],
    },
  ]]);
});

test('line mapping fails closed when a mapped source line is not identical', () => {
  assertRejected(
    () => buildLineMapping('one\ntwo', 'one\nchanged', []),
    /ambiguous/,
  );
});
