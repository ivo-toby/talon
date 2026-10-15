import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { createServer, type Server } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { validateSignalSocket } from '../../../../../src/channels/connectors/signal/signal-socket-trust.js';

// Real fixture sockets only, never an operator path. /tmp is intentionally not trusted.
describe('signal-socket-trust', () => {
  let directory: string;
  let socketPath: string;
  const servers: Server[] = [];

  async function listen(path = socketPath): Promise<void> {
    const server = createServer();
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(path, resolve);
    });
    fs.chmodSync(path, 0o600);
  }

  beforeEach(() => {
    directory = fs.mkdtempSync(join(homedir(), '.sig-trust-'));
    fs.chmodSync(directory, 0o700);
    socketPath = join(directory, 'rpc.sock');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const server of servers.splice(0)) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('accepts a private HOME socket and freezes its full ancestor identity snapshot', async () => {
    await listen();
    const snapshot = validateSignalSocket(socketPath)._unsafeUnwrap();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(snapshot.entries.at(-1)?.path).toBe(socketPath);
    expect(snapshot.entries[0]?.path).toBe('/');
    expect(validateSignalSocket(socketPath, snapshot).isOk()).toBe(true);
  });

  it('distinguishes absent socket under trusted parent from unsafe ancestry', () => {
    expect(validateSignalSocket(socketPath)._unsafeUnwrapErr().reason).toBe('DISCONNECTED');
    expect(validateSignalSocket('/tmp/absent-signal/rpc.sock')._unsafeUnwrapErr().reason).toBe(
      'UNTRUSTED_SOCKET',
    );
    fs.chmodSync(directory, 0o755);
    expect(validateSignalSocket(socketPath)._unsafeUnwrapErr().reason).toBe('UNTRUSTED_SOCKET');
  });

  it.each([0o666, 0o660, 0o640, 0o700])(
    'rejects socket mode %s without repairing it',
    async (mode) => {
      await listen();
      fs.chmodSync(socketPath, mode);
      expect(validateSignalSocket(socketPath)._unsafeUnwrapErr().reason).toBe('UNTRUSTED_SOCKET');
      expect(fs.lstatSync(socketPath).mode & 0o777).toBe(mode);
    },
  );

  it('rejects writable ancestors even with a private immediate parent', async () => {
    const inner = join(directory, 'private');
    fs.mkdirSync(inner, { mode: 0o700 });
    socketPath = join(inner, 'rpc.sock');
    await listen();
    fs.chmodSync(directory, 0o1777);
    expect(validateSignalSocket(socketPath)._unsafeUnwrapErr().reason).toBe('UNTRUSTED_SOCKET');
  });

  it('rejects symlink sockets, ancestors, and traversal spellings', async () => {
    await listen();
    const alias = join(directory, 'alias');
    fs.symlinkSync(socketPath, alias);
    expect(validateSignalSocket(alias).isErr()).toBe(true);
    fs.symlinkSync(directory, join(directory, 'linked'));
    expect(validateSignalSocket(join(directory, 'linked', 'rpc.sock')).isErr()).toBe(true);
    expect(validateSignalSocket(`${directory}/linked/../rpc.sock`).isErr()).toBe(true);
    expect(validateSignalSocket('relative.sock').isErr()).toBe(true);
  });

  it('rejects a regular file without removing or modifying it', () => {
    fs.writeFileSync(socketPath, 'fixture', { mode: 0o600 });
    expect(validateSignalSocket(socketPath).isErr()).toBe(true);
    expect(fs.readFileSync(socketPath, 'utf8')).toBe('fixture');
  });

  it('rejects substituted socket and ancestor inodes between checks', async () => {
    await listen();
    const snapshot = validateSignalSocket(socketPath)._unsafeUnwrap();
    fs.renameSync(socketPath, join(directory, 'old.sock'));
    await listen();
    expect(validateSignalSocket(socketPath, snapshot).isErr()).toBe(true);
    const second = validateSignalSocket(socketPath)._unsafeUnwrap();
    const moved = `${directory}-moved`;
    fs.renameSync(directory, moved);
    fs.mkdirSync(directory, { mode: 0o700 });
    try {
      fs.renameSync(join(moved, 'rpc.sock'), socketPath);
      expect(validateSignalSocket(socketPath, second).isErr()).toBe(true);
    } finally {
      fs.rmSync(moved, { recursive: true, force: true });
    }
  });

  it.each(['socket', 'parent', 'ancestor'])(
    'rejects foreign %s owner using the actual effective UID, with safe errors',
    async (target) => {
      await listen();
      const original = fs.lstatSync;
      const foreignPath = target === 'socket' ? socketPath : target === 'parent' ? directory : '/';
      vi.spyOn(fs, 'lstatSync').mockImplementation((path, options) => {
        const stats = original(path, options);
        if (String(path) === foreignPath)
          Object.defineProperty(stats, 'uid', { value: BigInt(process.geteuid!() + 1) });
        return stats;
      });
      const error = validateSignalSocket(socketPath)._unsafeUnwrapErr();
      expect(error.reason).toBe('UNTRUSTED_SOCKET');
      expect(error.message).not.toContain(directory);
      expect(error.cause).toBeUndefined();
    },
  );
});
