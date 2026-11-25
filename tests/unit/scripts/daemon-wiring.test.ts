import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { err, ok } from 'neverthrow';
import pino from 'pino';
import { ScriptsConfigSchema } from '../../../src/core/config/config-schema.js';
import { PersonaRepository } from '../../../src/core/database/repositories/persona-repository.js';
import {
  buildScriptRuntime,
  createChannelSender,
  createChatResolver,
} from '../../../src/scripts/daemon-wiring.js';
import type { ScriptRuntimeDeps } from '../../../src/scripts/daemon-wiring.js';
import { createTestDb } from '../core/database/repositories/helpers.js';

const IMAGE = `node@sha256:${'a'.repeat(64)}`;
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('createChannelSender', () => {
  it('sends the body to the chat through the connector of the channel', async () => {
    const send = vi.fn(() => Promise.resolve(ok(undefined)));
    const sender = createChannelSender({ get: () => ({ send }) as never });
    expect((await sender('tg', 'chat-1', 'hello')).isOk()).toBe(true);
    expect(send).toHaveBeenCalledWith('chat-1', { body: 'hello' });
  });

  it('returns TOOL_FAILED for a channel with no connector', async () => {
    const sender = createChannelSender({ get: () => undefined });
    expect((await sender('tg', 'chat-1', 'hello'))._unsafeUnwrapErr().scriptCode).toBe(
      'TOOL_FAILED',
    );
  });

  it('returns TOOL_FAILED when the connector reports an error or throws', async () => {
    const failing = createChannelSender({
      get: () => ({ send: () => Promise.resolve(err(new Error('down'))) }) as never,
    });
    expect((await failing('tg', 'c', 'x'))._unsafeUnwrapErr().scriptCode).toBe('TOOL_FAILED');
    const throwing = createChannelSender({
      get: () => ({ send: () => Promise.reject(new Error('secret detail')) }) as never,
    });
    const error = (await throwing('tg', 'c', 'x'))._unsafeUnwrapErr();
    expect(error.scriptCode).toBe('TOOL_FAILED');
    expect(error.message).not.toContain('secret detail');
  });
});

describe('createChatResolver', () => {
  const threads: Record<
    string,
    { channel_id: string; external_id: string; metadata: string | null }
  > = {
    t1: { channel_id: 'c1', external_id: 'chat-1', metadata: null },
    sched: { channel_id: 'c1', external_id: 'schedule:abc', metadata: null },
    lost: { channel_id: 'gone', external_id: 'chat-2', metadata: null },
  };
  const resolve = createChatResolver(
    { findById: (id: string) => ok(threads[id] ?? null) } as never,
    { findById: (id: string) => ok(id === 'c1' ? { name: 'tg' } : null) } as never,
  );

  it('returns the channel name and recipient of a thread', () => {
    expect(resolve('t1')).toEqual({ channelName: 'tg', externalThreadId: 'chat-1' });
  });

  it('returns undefined for an unknown thread, a lost channel or a schedule thread', () => {
    expect(resolve('nope')).toBeUndefined();
    expect(resolve('lost')).toBeUndefined();
    expect(resolve('sched')).toBeUndefined();
  });

  it('returns undefined when a repository fails or throws', () => {
    const failing = createChatResolver(
      { findById: () => err(new Error('db')) } as never,
      { findById: () => ok(null) } as never,
    );
    expect(failing('t1')).toBeUndefined();
    const throwing = createChatResolver(
      {
        findById: () => {
          throw new Error('db');
        },
      } as never,
      { findById: () => ok(null) } as never,
    );
    expect(throwing('t1')).toBeUndefined();
  });
});

function deps(over: Partial<ScriptRuntimeDeps> = {}, withPersona = true): ScriptRuntimeDeps {
  const base = mkdtempSync(join(tmpdir(), 'wiring-'));
  roots.push(base);
  const db = createTestDb();
  const personaRepo = new PersonaRepository(db);
  if (withPersona) {
    personaRepo
      .insert({
        id: 'p1',
        name: 'p1',
        model: 'm',
        system_prompt_file: null,
        skills: '[]',
        capabilities: '{}',
        mounts: '[]',
        max_concurrent: null,
      })
      ._unsafeUnwrap();
  }
  return {
    config: ScriptsConfigSchema.parse({
      enabled: true,
      root: join(base, 'nested', 'scripts'),
      image: IMAGE,
    }),
    db,
    personaRepo,
    threadRepo: { findById: () => ok(null) } as never,
    channelRepo: { findById: () => ok(null) } as never,
    channelRegistry: { get: () => undefined },
    auditLogger: { logToolExecution: vi.fn(), logApprovalDecision: vi.fn() },
    provider: {} as never,
    logger: pino({ level: 'silent' }),
    ...over,
  };
}

describe('buildScriptRuntime', () => {
  it('creates the scripts root, installs the script module and returns a service', () => {
    const d = deps();
    const service = buildScriptRuntime(d)._unsafeUnwrap();
    expect(existsSync(join(d.config.root, 'node_modules', 'talon', 'index.js'))).toBe(true);
    expect(service.hasApproved('p1', 'nothing')).toBe(false);
    // no open approval anywhere: nothing is claimed
    expect(service.matchesInbound({ content: '/approve ABCDEFGH' } as never)).toBe(false);
  });

  it('fails when there is no persona to grant', () => {
    const result = buildScriptRuntime(deps({}, false));
    expect(result._unsafeUnwrapErr().scriptCode).toBe('INVALID_ARGUMENT');
  });

  it('fails when the image is not pinned by digest', () => {
    const d = deps();
    const result = buildScriptRuntime({ ...d, config: { ...d.config, image: 'node:24' } });
    expect(result._unsafeUnwrapErr().scriptCode).toBe('INVALID_ARGUMENT');
  });

  it('fails when the scripts root cannot be a directory', () => {
    const d = deps();
    const file = join(roots[roots.length - 1], 'a-file');
    writeFileSync(file, 'x');
    const result = buildScriptRuntime({ ...d, config: { ...d.config, root: join(file, 'sub') } });
    expect(result.isErr()).toBe(true);
  });
});
