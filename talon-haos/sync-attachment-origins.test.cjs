'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { mkdtempSync, writeFileSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');

const helper = join(__dirname, 'sync-attachment-origins.cjs');
function run(origins, yaml = 'storage:\n  type: sqlite\n# keep this comment\n') {
  const dir = mkdtempSync(join(tmpdir(), 'ha-origins-'));
  const options = join(dir, 'options.json');
  const config = join(dir, 'talond.yaml');
  writeFileSync(options, JSON.stringify({ attachment_allowed_origins: origins }));
  writeFileSync(config, yaml);
  const execute = () => spawnSync(process.execPath, [helper, options, config], { encoding: 'utf8' });
  return { execute, config, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('default empty list does not modify user YAML', () => {
  const t = run([]);
  try {
    assert.equal(t.execute().status, 0);
    assert.equal(readFileSync(t.config, 'utf8'), 'storage:\n  type: sqlite\n# keep this comment\n');
  } finally { t.cleanup(); }
});

test('trusted origins persist in both allowlists without losing other settings', () => {
  const t = run(['http://127.0.0.1:8080']);
  try {
    assert.equal(t.execute().status, 0);
    const text = readFileSync(t.config, 'utf8');
    assert.match(text, /allowedOrigins:[\s\S]*127\.0\.0\.1:8080/);
    assert.match(text, /privateOrigins:[\s\S]*127\.0\.0\.1:8080/);
    assert.match(text, /# keep this comment/);
    assert.equal(t.execute().status, 0);
    assert.equal(readFileSync(t.config, 'utf8'), text);
  } finally { t.cleanup(); }
});

test('empty list removes only the managed block', () => {
  const t = run(['http://127.0.0.1:8080']);
  try {
    assert.equal(t.execute().status, 0);
    const optionsPath = join(t.config, '..', 'options.json');
    writeFileSync(optionsPath, JSON.stringify({ attachment_allowed_origins: [] }));
    assert.equal(t.execute().status, 0);
    const text = readFileSync(t.config, 'utf8');
    assert.doesNotMatch(text, /^attachments:/m);
    assert.match(text, /# keep this comment/);
  } finally { t.cleanup(); }
});

test('unmanaged attachments block is not overwritten', () => {
  const yaml = 'attachments:\n  allowedOrigins: []\n';
  const t = run(['https://files.example.com'], yaml);
  try {
    assert.notEqual(t.execute().status, 0);
    assert.equal(readFileSync(t.config, 'utf8'), yaml);
  } finally { t.cleanup(); }
});

test('invalid origins cannot widen network access', () => {
  for (const origin of ['https://x.test/path', 'https://user:pass@x.test', 'ftp://x.test', 'http://x.test,https://y.test']) {
    const t = run([origin]);
    try {
      assert.notEqual(t.execute().status, 0);
      assert.doesNotMatch(readFileSync(t.config, 'utf8'), /^attachments:/m);
    } finally { t.cleanup(); }
  }
});
