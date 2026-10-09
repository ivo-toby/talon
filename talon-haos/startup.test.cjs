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

test('daemon launcher execs via setpriv without runuser session timeout', () => {
  const script = fs.readFileSync(path.join(__dirname, 'run.sh'), 'utf8');
  assert.match(script, /^setsid setpriv --reuid=talond --regid=talond --init-groups -- node \/opt\/talond\/dist\/index\.js --config "\$CONFIG_FILE" &$/m);
  assert.doesNotMatch(script, /^setsid runuser .*node \/opt\/talond\/dist\/index\.js/m);
  assert.match(script, /kill -TERM "\-\$DAEMON_PID"/);
  assert.match(script, /wait "\$DAEMON_PID"/);
});
