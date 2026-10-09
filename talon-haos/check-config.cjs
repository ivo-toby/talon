'use strict';
const fs = require('node:fs');
const yaml = require('/opt/talond/node_modules/js-yaml');
const [file, workspace, stateDir] = process.argv.slice(2);
try {
  const cfg = yaml.load(fs.readFileSync(file, 'utf8'));
  if (!cfg || typeof cfg !== 'object') throw new Error('Configuration must be a YAML object');
  const checks = [
    ['storage.path', cfg.storage?.path, stateDir],
    ['dataDir', cfg.dataDir, stateDir],
  ];
  for (const [label, value, parent] of checks) {
    if (typeof value !== 'string' || (value !== parent && !value.startsWith(parent + '/'))) {
      throw new Error(label + ' does not point inside the selected state directory: ' + String(value));
    }
  }
  const prompts = (cfg.personas || []).map(p => p.systemPromptFile).filter(Boolean);
  for (const value of prompts) {
    if (typeof value !== 'string' || !value.startsWith(workspace + '/')) {
      throw new Error('systemPromptFile points outside selected workspace: ' + String(value));
    }
  }
  process.stdout.write('[talon] Config paths verified; no migration performed.\n');
} catch (err) {
  console.error('[talon] Configuration needs repair before daemon startup: ' + err.message);
  console.error('[talon] Files were not moved or rewritten. Edit talond.yaml using recovery terminal.');
  process.exitCode = 1;
}
