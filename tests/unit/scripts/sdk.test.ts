import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installScriptSdk } from '../../../src/scripts/sdk-install.js';

type Msg = Record<string, unknown>;

class Run {
  readonly child: ChildProcessWithoutNullStreams;
  readonly lines: Msg[] = [];
  stdout = '';
  stderr = '';
  exitCode: Promise<number | null>;
  private waiters: Array<() => void> = [];

  constructor(root: string, script: string) {
    this.child = spawn(process.execPath, [join(root, 'node_modules/talon/run.js'), script], {
      cwd: root,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let buf = '';
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (c: string) => (this.stderr += c));
    this.child.stdout.on('data', (c: string) => {
      this.stdout += c;
      buf += c;
      let i = buf.indexOf('\n');
      while (i !== -1) {
        this.lines.push(JSON.parse(buf.slice(0, i)) as Msg);
        buf = buf.slice(i + 1);
        i = buf.indexOf('\n');
      }
      this.waiters.splice(0).forEach((w) => w());
    });
    this.exitCode = new Promise((resolve) => this.child.on('close', (code) => resolve(code)));
  }

  send(message: Msg): void {
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }

  async waitFor(count: number): Promise<void> {
    while (this.lines.length < count) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }
}

describe('talon script SDK', () => {
  let root: string;
  let runs: Run[];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'talon-sdk-'));
    runs = [];
    expect(installScriptSdk(root).isOk()).toBe(true);
  });

  afterEach(() => {
    for (const run of runs) run.child.kill('SIGKILL');
    rmSync(root, { recursive: true, force: true });
  });

  function start(source: string, input: unknown = null): Run {
    mkdirSync(join(root, 'demo'), { recursive: true });
    writeFileSync(join(root, 'demo/script.ts'), source);
    const run = new Run(root, 'demo/script.ts');
    runs.push(run);
    run.send({ t: 'start', mode: 'live', input });
    return run;
  }

  it('sends done with the returned value', async () => {
    const run = start(
      'export default async function (input: unknown) { return { got: input }; }',
      5,
    );
    await run.waitFor(1);
    expect(run.lines[0]).toEqual({ t: 'done', ok: true, result: { got: 5 } });
    expect(await run.exitCode).toBe(0);
  }, 20_000);

  it('sends a call and resolves with the result value', async () => {
    const run = start(
      `import { tools } from 'talon';
       export default async function () { return await tools.mail.list({ a: 1 }); }`,
    );
    await run.waitFor(1);
    expect(run.lines[0]).toEqual({ t: 'call', id: 1, name: 'mail.list', input: { a: 1 } });
    run.send({ t: 'result', id: 1, ok: true, value: ['x'] });
    await run.waitFor(2);
    expect(run.lines[1]).toEqual({ t: 'done', ok: true, result: ['x'] });
    expect(await run.exitCode).toBe(0);
  }, 20_000);

  it('supports dashes and underscores in names', async () => {
    const run = start(
      `import { tools } from 'talon';
       export default async function () { return await tools['zerolib-email'].list_emails_metadata(); }`,
    );
    await run.waitFor(1);
    expect(run.lines[0]).toMatchObject({ name: 'zerolib-email.list_emails_metadata' });
  }, 20_000);

  it('rejects with TalonToolError and the code on a failed result', async () => {
    const run = start(
      `import { tools, TalonToolError } from 'talon';
       export default async function () {
         try { await tools.mail.send({}); } catch (e) {
           return { isErr: e instanceof TalonToolError, code: (e as TalonToolError).code, message: (e as Error).message };
         }
       }`,
    );
    await run.waitFor(1);
    run.send({ t: 'result', id: 1, ok: false, code: 'NOT_IN_MANIFEST', message: 'nope' });
    await run.waitFor(2);
    expect(run.lines[1]).toEqual({
      t: 'done',
      ok: true,
      result: { isErr: true, code: 'NOT_IN_MANIFEST', message: 'nope' },
    });
  }, 20_000);

  it('gives concurrent calls distinct ids and the right results', async () => {
    const run = start(
      `import { tools } from 'talon';
       export default async function () {
         return await Promise.all([tools.a.one(), tools.b.two()]);
       }`,
    );
    await run.waitFor(2);
    const [first, second] = run.lines;
    expect(first?.id).toBe(1);
    expect(second?.id).toBe(2);
    run.send({ t: 'result', id: 2, ok: true, value: 'B' });
    run.send({ t: 'result', id: 1, ok: true, value: 'A' });
    await run.waitFor(3);
    expect(run.lines[2]).toEqual({ t: 'done', ok: true, result: ['A', 'B'] });
  }, 20_000);

  it('keeps console output off standard output', async () => {
    const run = start(
      `export default async function () {
         console.log('x'); console.info('y'); console.warn('z'); console.error('w');
         return 1;
       }`,
    );
    await run.waitFor(1);
    await run.exitCode;
    expect(run.stdout).toBe('{"t":"done","ok":true,"result":1}\n');
    expect(run.stderr).toContain('x');
    expect(run.stderr).toContain('w');
  }, 20_000);

  it('sends done with ok false when the script throws', async () => {
    const run = start('export default async function () { throw new Error("boom"); }');
    await run.waitFor(1);
    expect(run.lines[0]).toEqual({ t: 'done', ok: false, message: 'boom' });
    expect(await run.exitCode).toBe(0);
  }, 20_000);

  it('uses a fixed text for a thrown non-error value', async () => {
    const run = start('export default async function () { throw "secret"; }');
    await run.waitFor(1);
    expect(run.lines[0]).toEqual({
      t: 'done',
      ok: false,
      message: 'script threw a non-error value',
    });
  }, 20_000);

  it('truncates long error messages', async () => {
    const run = start('export default async function () { throw new Error("a".repeat(5000)); }');
    await run.waitFor(1);
    expect((run.lines[0]?.message as string).length).toBe(2000);
  }, 20_000);

  it('sends done with ok false when there is no default export function', async () => {
    const run = start('export const x = 1;');
    await run.waitFor(1);
    expect(run.lines[0]).toMatchObject({ t: 'done', ok: false });
    expect(await run.exitCode).toBe(0);
  }, 20_000);

  it('turns an unhandled rejection into one failed done', async () => {
    const run = start(
      `export default async function () {
         Promise.reject(new Error('late'));
         await new Promise((r) => setTimeout(r, 50));
         return 1;
       }`,
    );
    await run.waitFor(1);
    expect(await run.exitCode).toBe(0);
    expect(run.lines).toEqual([{ t: 'done', ok: false, message: 'late' }]);
  }, 20_000);

  it('fails done for a result that is not JSON-serializable', async () => {
    const run = start('export default async function () { return { n: 1n }; }');
    await run.waitFor(1);
    expect(run.lines[0]).toMatchObject({ t: 'done', ok: false });
  }, 20_000);

  it('sends null for an undefined result', async () => {
    const run = start('export default async function () {}');
    await run.waitFor(1);
    expect(run.lines[0]).toEqual({ t: 'done', ok: true, result: null });
  }, 20_000);

  it('does not hang when tools is awaited', async () => {
    const run = start(
      `import { tools } from 'talon';
       export default async function () { const t = await tools; return typeof t; }`,
    );
    await run.waitFor(1);
    expect(run.lines[0]).toEqual({ t: 'done', ok: true, result: 'object' });
  }, 20_000);

  it('exits with code 1 when standard input closes during the run', async () => {
    const run = start(
      `import { tools } from 'talon';
       export default async function () { return await tools.a.b(); }`,
    );
    await run.waitFor(1);
    run.child.stdin.end();
    expect(await run.exitCode).toBe(1);
  }, 20_000);

  it('ignores garbage lines and results for unknown ids', async () => {
    const run = start(
      `import { tools } from 'talon';
       export default async function () { return await tools.a.b(); }`,
    );
    await run.waitFor(1);
    run.child.stdin.write('not json\n');
    run.send({ t: 'result', id: 99, ok: true, value: 'no' });
    run.send({ t: 'result', id: 1, ok: true, value: 'yes' });
    await run.waitFor(2);
    expect(run.lines[1]).toEqual({ t: 'done', ok: true, result: 'yes' });
  }, 20_000);

  it('runs a script with TypeScript type annotations', async () => {
    const run = start(
      `interface Out { n: number }
       export default async function (input: unknown): Promise<Out> { const n: number = 2; return { n }; }`,
    );
    await run.waitFor(1);
    expect(run.lines[0]).toEqual({ t: 'done', ok: true, result: { n: 2 } });
  }, 20_000);

  describe('installScriptSdk', () => {
    it('replaces an existing copy and sets readable modes', () => {
      const stale = join(root, 'node_modules/talon/stale.js');
      writeFileSync(stale, 'old');
      expect(installScriptSdk(root).isOk()).toBe(true);
      expect(existsSync(stale)).toBe(false);
      for (const f of ['index.js', 'run.js', 'index.d.ts', 'package.json']) {
        expect(statSync(join(root, 'node_modules/talon', f)).mode & 0o777).toBe(0o644);
      }
      expect(statSync(join(root, 'node_modules/talon')).mode & 0o777).toBe(0o755);
    });

    it('rejects a relative or missing root', () => {
      const relative = installScriptSdk('relative/path');
      expect(relative._unsafeUnwrapErr().scriptCode).toBe('INVALID_ARGUMENT');
      const missing = installScriptSdk(join(root, 'nope'));
      expect(missing._unsafeUnwrapErr().scriptCode).toBe('INVALID_ARGUMENT');
    });

    it('returns SANDBOX with a fixed message when the file system fails', () => {
      // node_modules exists as a file, so creating node_modules/talon fails
      const bad = mkdtempSync(join(tmpdir(), 'talon-sdk-bad-'));
      try {
        writeFileSync(join(bad, 'node_modules'), 'file');
        const e = installScriptSdk(bad)._unsafeUnwrapErr();
        expect(e.scriptCode).toBe('SANDBOX');
        expect(e.cause).toBeInstanceOf(Error);
        expect(e.message).not.toContain(bad);
      } finally {
        rmSync(bad, { recursive: true, force: true });
      }
    });
  });
});
