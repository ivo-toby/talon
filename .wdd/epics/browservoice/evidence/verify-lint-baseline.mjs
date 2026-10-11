#!/usr/bin/env node

/**
 * Reproduce the pre-voice lint baseline and prove that voice changes do not
 * add diagnostics. The archived checkout uses this checkout's installed
 * dependencies; no network install or temporary repository is required.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  compareTouchedFileDiagnostics,
  parseUnifiedDiff,
} from './lint-baseline-comparison.mjs';

const BASELINE_COMMIT = 'abab3f2a4694992e857a178f9209d4ae871db2c2';
const EXPECTED_ERRORS = 75;
const EXPECTED_WARNINGS = 21;
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDirectory, '../../../..');
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function fail(message) {
  console.error(`verify-lint-baseline: ${message}`);
  process.exitCode = 1;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
  if (result.error) throw result.error;
  return result;
}

function relativePath(root, filePath) {
  const candidate = relative(root, filePath).split(sep).join('/');
  if (!candidate.startsWith('../')) return candidate;
  const parts = filePath.split(/[\\/]/);
  const sourceIndex = parts.lastIndexOf('src');
  return sourceIndex >= 0 ? parts.slice(sourceIndex).join('/') : candidate;
}

function canonicalDiagnostics(root, raw) {
  return raw
    .map((entry) => ({
      ...entry,
      filePath: relativePath(root, entry.filePath),
    }))
    .sort((left, right) => left.filePath.localeCompare(right.filePath));
}

function parseLintOutput(root, result) {
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(
      `lint command exited ${String(result.status)}: ${(result.stderr ?? '').trim()}`,
    );
  }
  try {
    return canonicalDiagnostics(root, JSON.parse(result.stdout));
  } catch (cause) {
    throw new Error(
      `lint command did not produce JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

function lint(root) {
  const env = {
    ...process.env,
    PATH: `${dirname(process.execPath)}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`,
  };
  const result = spawnSync(npmCommand, ['run', 'lint', '--', '--format', 'json'], {
    cwd: root,
    env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return parseLintOutput(root, result);
}

function totals(entries) {
  return entries.reduce(
    (summary, entry) => ({
      errors: summary.errors + entry.errorCount,
      warnings: summary.warnings + entry.warningCount,
    }),
    { errors: 0, warnings: 0 },
  );
}

function archiveBaseline(directory) {
  const archive = run('git', ['archive', BASELINE_COMMIT], { encoding: null });
  if (archive.status !== 0) {
    throw new Error(`git archive failed: ${(archive.stderr ?? '').toString().trim()}`);
  }
  const extracted = spawnSync('tar', ['-xf', '-', '-C', directory], {
    input: archive.stdout,
    encoding: null,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (extracted.status !== 0) {
    throw new Error(`tar extraction failed: ${(extracted.stderr ?? '').toString().trim()}`);
  }
}

function changedSourceFiles() {
  const result = run('git', ['diff', '--name-only', BASELINE_COMMIT, '--', 'src']);
  if (result.status !== 0) throw new Error(`git diff failed: ${result.stderr.trim()}`);
  return new Set(
    result.stdout
      .split('\n')
      .map((file) => file.trim())
      .filter((file) => file.endsWith('.ts')),
  );
}

function changedSourceDiff() {
  const result = run('git', ['diff', '--no-ext-diff', '--unified=0', BASELINE_COMMIT, '--', 'src']);
  if (result.status !== 0) throw new Error(`git diff failed: ${result.stderr.trim()}`);
  return parseUnifiedDiff(result.stdout);
}

function byPath(entries) {
  return new Map(entries.map((entry) => [entry.filePath, entry]));
}

function sourceEntry(root, filePath, entry) {
  if (typeof entry.source === 'string') return entry;
  const rootPath = resolve(root);
  const sourcePath = resolve(rootPath, filePath);
  if (!sourcePath.startsWith(`${rootPath}${sep}`)) {
    throw new Error(`lint entry path escapes checkout: ${filePath}`);
  }
  return { ...entry, source: readFileSync(sourcePath, 'utf8') };
}

const temporaryDirectory = mkdtempSync(join('/tmp', 'talon-lint-baseline-'));
try {
  archiveBaseline(temporaryDirectory);
  symlinkSync(join(repoRoot, 'node_modules'), join(temporaryDirectory, 'node_modules'), 'junction');

  const baseline = lint(temporaryDirectory);
  const current = lint(repoRoot);
  const baselineTotals = totals(baseline);
  const currentTotals = totals(current);

  if (baselineTotals.errors !== EXPECTED_ERRORS || baselineTotals.warnings !== EXPECTED_WARNINGS) {
    throw new Error(
      `baseline counts changed: expected ${EXPECTED_ERRORS} errors/${EXPECTED_WARNINGS} warnings, ` +
        `got ${baselineTotals.errors} errors/${baselineTotals.warnings} warnings`,
    );
  }
  if (
    currentTotals.errors !== baselineTotals.errors ||
    currentTotals.warnings !== baselineTotals.warnings
  ) {
    throw new Error(
      `current counts differ: baseline ${baselineTotals.errors}/${baselineTotals.warnings}, ` +
        `current ${currentTotals.errors}/${currentTotals.warnings}`,
    );
  }

  const changed = changedSourceFiles();
  const changedDiff = changedSourceDiff();
  const baselineByPath = byPath(baseline);
  const currentByPath = byPath(current);
  for (const file of changed) {
    const entry = currentByPath.get(file);
    if (!entry) throw new Error(`changed source file was not linted: ${file}`);
    const baselineEntry = baselineByPath.get(file);
    if (!baselineEntry) {
      compareTouchedFileDiagnostics({ filePath: file, baseline: null, current: entry, hunks: [] });
      continue;
    }
    const diff = changedDiff.get(file);
    if (!diff) throw new Error(`changed source file has no diff metadata: ${file}`);
    compareTouchedFileDiagnostics({
      filePath: file,
      baseline: sourceEntry(temporaryDirectory, file, baselineEntry),
      current: sourceEntry(repoRoot, file, entry),
      hunks: diff.hunks,
    });
  }

  const paths = new Set([...baselineByPath.keys(), ...currentByPath.keys()]);
  for (const file of paths) {
    if (changed.has(file)) continue;
    const before = baselineByPath.get(file);
    const after = currentByPath.get(file);
    if (!before || !after || JSON.stringify(before) !== JSON.stringify(after)) {
      throw new Error(`unchanged source diagnostics differ: ${file}`);
    }
  }

  console.log(
    `verify-lint-baseline: PASS (${currentTotals.errors} errors, ${currentTotals.warnings} warnings; ` +
      `unchanged baseline diagnostics preserved and ${changed.size} changed source files clean)`,
  );
} catch (cause) {
  fail(cause instanceof Error ? cause.message : String(cause));
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
