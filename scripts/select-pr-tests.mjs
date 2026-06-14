#!/usr/bin/env node
import { existsSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (!arg.startsWith('--')) continue;
  const key = arg.slice(2);
  const value = process.argv[i + 1]?.startsWith('--') ? '' : (process.argv[++i] ?? '');
  args.set(key, value);
}

const base = args.get('base') || '';
const head = args.get('head') || 'HEAD';
const commandFile = args.get('command-file') || '';
const githubOutput = args.get('github-output') || process.env.GITHUB_OUTPUT || '';

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function resolveBase(input) {
  if (input && input !== '0000000000000000000000000000000000000000') {
    return input;
  }
  try {
    return git(['merge-base', 'origin/main', head]);
  } catch {
    return 'HEAD~1';
  }
}

function diffFiles() {
  const resolvedBase = resolveBase(base);
  const output = git(['diff', '--name-only', `${resolvedBase}...${head}`]);
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function addIfExists(targets, path) {
  if (existsSync(path)) targets.add(path);
}

function addAreaTargets(targets, area) {
  addIfExists(targets, `tests/unit/${area}`);
}

function selectTargets(files) {
  const targets = new Set();
  let runtimeRelevant = false;
  let docsOnly = true;

  for (const file of files) {
    if (file.startsWith('tests/')) {
      runtimeRelevant = true;
      docsOnly = false;
      if (/\.(test|spec)\.ts$/.test(file)) {
        addIfExists(targets, file);
      } else {
        const parts = file.split('/');
        if (parts[1] === 'unit' && parts[2]) {
          addIfExists(targets, `tests/unit/${parts[2]}`);
        } else if (parts[1] === 'integration' && parts[2]) {
          addIfExists(targets, `tests/integration/${parts[2]}`);
        } else {
          addIfExists(targets, 'tests/integration');
        }
      }
      continue;
    }

    if (file.startsWith('src/')) {
      runtimeRelevant = true;
      docsOnly = false;
      const parts = file.split('/');
      const area = parts[1];

      if (area === 'channels') {
        addAreaTargets(targets, 'channels');
        addIfExists(targets, 'tests/integration/channel-registry.test.ts');
      } else if (area === 'core') {
        const coreArea = parts[2];
        if (coreArea) addAreaTargets(targets, `core/${coreArea}`);
        addAreaTargets(targets, 'core');
      } else {
        addAreaTargets(targets, area);
      }

      if (['daemon', 'pipeline', 'queue', 'channels'].includes(area)) {
        addIfExists(targets, 'tests/integration/e2e/message-flow.test.ts');
      }
      if (area === 'queue' || file.startsWith('src/core/database/')) {
        addIfExists(targets, 'tests/integration/queue-durability.test.ts');
      }
      if (area === 'skills' || area === 'mcp' || area === 'personas') {
        addIfExists(targets, 'tests/integration/lazy-skill-loading.test.ts');
      }
      if (area === 'subagents') {
        addIfExists(targets, 'tests/integration/subagent-pipeline.test.ts');
      }
      continue;
    }

    if (file.startsWith('config/') || file === 'talond.yaml.example') {
      runtimeRelevant = true;
      docsOnly = false;
      addIfExists(targets, 'tests/unit/core/config');
      continue;
    }

    if (
      file.startsWith('deploy/') ||
      file.startsWith('starter/') ||
      file.startsWith('starter-stack/')
    ) {
      runtimeRelevant = true;
      docsOnly = false;
      addIfExists(targets, 'tests/unit/deploy');
      continue;
    }

    if (
      [
        'package.json',
        'package-lock.json',
        'tsconfig.json',
        'tsconfig.build.json',
        'vitest.config.ts',
        'eslint.config.js',
      ].includes(file)
    ) {
      runtimeRelevant = true;
      docsOnly = false;
      addIfExists(targets, 'tests/unit/core');
      addIfExists(targets, 'tests/unit/daemon');
      continue;
    }

    if (file === 'scripts/select-pr-tests.mjs') {
      runtimeRelevant = true;
      docsOnly = false;
      addIfExists(targets, 'tests/unit/core/types');
      addIfExists(targets, 'tests/unit/core/errors');
      continue;
    }

    if (!file.endsWith('.md') && !file.startsWith('.github/') && !file.startsWith('.agents/')) {
      docsOnly = false;
    }
  }

  if (!runtimeRelevant && docsOnly) {
    return {
      targets: [],
      reason: 'Only documentation, workflow, or skill files changed; skipping Vitest.',
    };
  }

  if (targets.size === 0) {
    return {
      targets: ['tests/unit/core/types', 'tests/unit/core/errors'],
      reason:
        'Runtime-relevant files changed but no focused test mapping matched; running lightweight core smoke tests.',
    };
  }

  return {
    targets: [...targets].sort(),
    reason: `Selected ${targets.size} focused test target(s) from ${files.length} changed file(s).`,
  };
}

function appendGithubOutput(values) {
  if (!githubOutput) return;
  const body = Object.entries(values)
    .map(([key, value]) => `${key}=${String(value).replace(/\n/g, ' ')}`)
    .join('\n');
  writeFileSync(githubOutput, `${body}\n`, { flag: 'a' });
}

const files = diffFiles();
const { targets, reason } = selectTargets(files);
const shouldRun = targets.length > 0;
const command = shouldRun
  ? `npx vitest run ${targets.map((target) => JSON.stringify(target)).join(' ')}`
  : '';

if (commandFile) {
  const script = shouldRun
    ? `#!/usr/bin/env bash\nset -euo pipefail\n${command}\n`
    : '#!/usr/bin/env bash\nset -euo pipefail\necho "No Vitest targets selected."\n';
  writeFileSync(commandFile, script, { mode: 0o755 });
}

appendGithubOutput({
  should_run: shouldRun ? 'true' : 'false',
  reason,
  targets: shouldRun ? targets.join(' ') : '',
});

console.log(reason);
if (files.length > 0) {
  console.log('Changed files:');
  for (const file of files) console.log(`- ${file}`);
}
if (shouldRun) {
  console.log(`Command: ${command}`);
}
