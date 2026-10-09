'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Supervisor considers any nonempty Config.Healthcheck a readiness check;
// Docker's explicit NONE object therefore waits for a nonexistent health event.
// The image smoke test verifies actual metadata, including inherited settings.
for (const name of ['Dockerfile', 'Dockerfile.source']) {
  test(`${name} does not emit disabled-healthcheck metadata`, () => {
    const contents = fs.readFileSync(path.join(__dirname, name), 'utf8');
    assert.doesNotMatch(contents, /^\s*HEALTHCHECK\s+NONE\s*$/mi);
  });
}
