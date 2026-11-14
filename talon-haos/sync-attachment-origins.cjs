'use strict';

// Home Assistant counterpart of https://github.com/ivo-toby/talon/pull/289.
// PR #289 introduces talond.yaml's attachments.allowedOrigins/privateOrigins.
// Only this marked stanza is managed by HA; all other YAML stays untouched.
const fs = require('node:fs');

const [optionsPath, configPath] = process.argv.slice(2);
if (!optionsPath || !configPath) {
  console.error('Usage: node sync-attachment-origins.cjs OPTIONS CONFIG');
  process.exit(2);
}

const begin = '# BEGIN HOME ASSISTANT MANAGED ATTACHMENT ORIGINS (PR #289)';
const end = '# END HOME ASSISTANT MANAGED ATTACHMENT ORIGINS';
const options = JSON.parse(fs.readFileSync(optionsPath, 'utf8'));
const origins = options.attachment_allowed_origins ?? [];
if (!Array.isArray(origins) || origins.length > 10) {
  throw new Error('attachment_allowed_origins must be an array with at most 10 entries');
}
const allowed = [];
for (const entry of origins) {
  if (typeof entry !== 'string' || !entry || entry !== entry.trim() || /[\s,]/u.test(entry)) {
    throw new Error('Invalid attachment origin (whitespace and commas are not permitted)');
  }
  const url = new URL(entry);
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
      (entry !== url.origin && entry !== url.origin + '/')) {
    throw new Error('Attachment origins must be HTTP(S) origins without paths or credentials');
  }
  if (!allowed.includes(url.origin)) allowed.push(url.origin);
}

const original = fs.readFileSync(configPath, 'utf8');
const start = original.indexOf(begin);
const finish = original.indexOf(end);
if ((start >= 0) !== (finish >= 0) || (start >= 0 && finish <= start)) {
  throw new Error('Incomplete Home Assistant attachment origin block in talond.yaml');
}
const hasManaged = start >= 0;
let cleaned = original;
if (hasManaged) {
  const after = finish + end.length;
  cleaned = original.slice(0, start).replace(/\n?$/, '\n') +
    original.slice(after).replace(/^\n/, '');
}
// Do not overwrite a user's hand-managed attachment configuration.
if (allowed.length && /^attachments\s*:/m.test(cleaned)) {
  throw new Error('talond.yaml already defines attachments: edit it there, or remove that block to use the Home Assistant option');
}
if (!allowed.length && !hasManaged) process.exit(0);
if (allowed.length) {
  const quote = (value) => JSON.stringify(value);
  const entries = allowed.map((value) => '    - ' + quote(value)).join('\n');
  cleaned = cleaned.trimEnd() + '\n\n' + [
    begin,
    'attachments:',
    '  allowedOrigins:',
    entries,
    '  privateOrigins:',
    entries,
    end,
  ].join('\n') + '\n';
}
if (cleaned !== original) {
  const tempPath = configPath + '.ha-origins.tmp';
  fs.writeFileSync(tempPath, cleaned, { mode: 0o600 });
  fs.renameSync(tempPath, configPath);
}
