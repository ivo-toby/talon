import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import {
  CodexSandboxPolicyViolationError,
  runCodexAppServerTurn,
  type CodexAppServerProcess,
} from '../../../src/codex-runner/app-server.js';

interface ClientMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
}

class FakeAppServerProcess extends EventEmitter implements CodexAppServerProcess {
  readonly stdout = new PassThrough();
  readonly stdin: Writable;
  readonly received: ClientMessage[] = [];
  readonly kill = vi.fn(() => true);

  constructor(public onMessage: (message: ClientMessage) => void) {
    super();
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        const message = JSON.parse(chunk.toString()) as ClientMessage;
        this.received.push(message);
        this.onMessage(message);
        callback();
      },
    });
  }

  reply(id: number | undefined, result: unknown): void {
    this.stdout.write(`${JSON.stringify({ id, result })}\n`);
  }

  notify(method: string, params: unknown): void {
    this.stdout.write(`${JSON.stringify({ method, params })}\n`);
  }
}

function installHappyPath(process: FakeAppServerProcess): void {
  process.onMessage = (message) => {
    switch (message.method) {
      case 'initialize':
        process.reply(message.id, {});
        return;
      case 'getAuthStatus':
        process.reply(message.id, { authMethod: 'chatgpt' });
        return;
      case 'thread/start':
        process.reply(message.id, {
          thread: { id: 'thread-1' },
          approvalPolicy: 'never',
          sandbox: { type: 'readOnly', networkAccess: false },
        });
        return;
      case 'turn/start':
        process.reply(message.id, { turn: { id: 'turn-1' } });
        queueMicrotask(() => {
          process.notify('item/completed', {
            threadId: 'thread-1',
            turnId: 'turn-1',
            item: { type: 'agentMessage', text: 'contained answer' },
          });
          process.notify('turn/completed', {
            threadId: 'thread-1',
            turn: { status: 'completed', error: null },
          });
        });
        return;
      case 'thread/delete':
        process.reply(message.id, {});
        return;
      default:
        return;
    }
  };
}

describe('runCodexAppServerTurn', () => {
  it('uses the trusted developer-instruction channel and a read-only ephemeral turn', async () => {
    const process = new FakeAppServerProcess(() => undefined);
    installHappyPath(process);

    const result = await runCodexAppServerTurn(
      {
        command: 'codex',
        cwd: '/tmp/contained-workspace',
        env: { PATH: '/usr/bin' },
        model: 'gpt-5.6-terra',
        systemPrompt: 'Trusted system instruction',
        userPrompt: 'Untrusted bounded task',
        outputSchema: { type: 'object' },
      },
      () => process,
    );

    expect(result.text).toBe('contained answer');
    const threadStart = process.received.find((message) => message.method === 'thread/start');
    expect(threadStart?.params).toMatchObject({
      cwd: '/tmp/contained-workspace',
      approvalPolicy: 'never',
      sandbox: 'read-only',
      developerInstructions:
        'This is a bounded, text-only sub-agent generation.\n' +
        'Do not use shell, filesystem, browser, web-search, MCP, dynamic, or collaboration tools.\n' +
        'Return the requested answer directly.\n\nTrusted system instruction',
      ephemeral: true,
      config: { web_search: 'disabled' },
    });
    const turnStart = process.received.find((message) => message.method === 'turn/start');
    expect(turnStart?.params).toMatchObject({
      input: [{ type: 'text', text: 'Untrusted bounded task', text_elements: [] }],
      outputSchema: { type: 'object' },
    });
    expect(process.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('fails closed when Codex emits built-in command activity', async () => {
    const process = new FakeAppServerProcess((message) => {
      if (message.method === 'initialize') process.reply(message.id, {});
      if (message.method === 'getAuthStatus') process.reply(message.id, { authMethod: 'chatgpt' });
      if (message.method === 'thread/start') {
        process.reply(message.id, {
          thread: { id: 'thread-1' },
          approvalPolicy: 'never',
          sandbox: { type: 'readOnly', networkAccess: false },
        });
      }
      if (message.method === 'turn/start') {
        process.reply(message.id, { turn: { id: 'turn-1' } });
        queueMicrotask(() => {
          process.notify('item/started', {
            threadId: 'thread-1',
            turnId: 'turn-1',
            item: { type: 'commandExecution', command: 'cat /etc/hosts' },
          });
          process.notify('turn/completed', {
            threadId: 'thread-1',
            turn: { status: 'interrupted', error: null },
          });
        });
      }
      if (message.method === 'turn/interrupt' || message.method === 'thread/delete') {
        process.reply(message.id, {});
      }
    });

    await expect(
      runCodexAppServerTurn(
        {
          command: 'codex',
          cwd: '/tmp/contained-workspace',
          env: { PATH: '/usr/bin' },
          model: 'gpt-5.6-terra',
          systemPrompt: 'Trusted',
          userPrompt: 'Task',
        },
        () => process,
      ),
    ).rejects.toBeInstanceOf(CodexSandboxPolicyViolationError);
  });

  it('fails closed when Codex emits a collaboration tool activity', async () => {
    const process = new FakeAppServerProcess((message) => {
      if (message.method === 'initialize') process.reply(message.id, {});
      if (message.method === 'getAuthStatus') process.reply(message.id, { authMethod: 'chatgpt' });
      if (message.method === 'thread/start') {
        process.reply(message.id, {
          thread: { id: 'thread-1' },
          approvalPolicy: 'never',
          sandbox: { type: 'readOnly', networkAccess: false },
        });
      }
      if (message.method === 'turn/start') {
        process.reply(message.id, { turn: { id: 'turn-1' } });
        queueMicrotask(() => {
          process.notify('item/started', {
            threadId: 'thread-1',
            turnId: 'turn-1',
            item: { type: 'collabToolCall' },
          });
          process.notify('turn/completed', {
            threadId: 'thread-1',
            turn: { status: 'interrupted', error: null },
          });
        });
      }
      if (message.method === 'turn/interrupt' || message.method === 'thread/delete') {
        process.reply(message.id, {});
      }
    });

    await expect(
      runCodexAppServerTurn(
        {
          command: 'codex',
          cwd: '/tmp/contained-workspace',
          env: { PATH: '/usr/bin' },
          model: 'gpt-5.6-terra',
          systemPrompt: 'Trusted',
          userPrompt: 'Task',
        },
        () => process,
      ),
    ).rejects.toBeInstanceOf(CodexSandboxPolicyViolationError);
  });

  it('retries the thread start with the newer camel-cased sandbox enum only after rejection', async () => {
    const process = new FakeAppServerProcess((message) => {
      if (message.method === 'initialize') process.reply(message.id, {});
      if (message.method === 'getAuthStatus') process.reply(message.id, { authMethod: 'chatgpt' });
      if (message.method === 'thread/start' && message.params?.sandbox === 'read-only') {
        process.stdout.write(
          `${JSON.stringify({
            id: message.id,
            error: { code: -32602, message: 'sandbox has unknown variant read-only' },
          })}\n`,
        );
      }
      if (message.method === 'thread/start' && message.params?.sandbox === 'readOnly') {
        process.reply(message.id, {
          thread: { id: 'thread-1' },
          approvalPolicy: 'never',
          sandbox: { type: 'readOnly', networkAccess: false },
        });
      }
      if (message.method === 'turn/start') {
        process.reply(message.id, { turn: { id: 'turn-1' } });
        queueMicrotask(() => {
          process.notify('item/completed', {
            threadId: 'thread-1',
            turnId: 'turn-1',
            item: { type: 'agentMessage', text: 'compatible sandbox answer' },
          });
          process.notify('turn/completed', {
            threadId: 'thread-1',
            turn: { status: 'completed', error: null },
          });
        });
      }
      if (message.method === 'thread/delete') process.reply(message.id, {});
    });

    await expect(
      runCodexAppServerTurn(
        {
          command: 'codex',
          cwd: '/tmp/contained-workspace',
          env: { PATH: '/usr/bin' },
          model: 'gpt-5.6-terra',
          systemPrompt: 'Trusted',
          userPrompt: 'Task',
        },
        () => process,
      ),
    ).resolves.toMatchObject({ text: 'compatible sandbox answer' });

    expect(
      process.received.filter((message) => message.method === 'thread/start').map((message) => message.params?.sandbox),
    ).toEqual(['read-only', 'readOnly']);
  });

  it('accepts the top-level turn id returned by compatible App Server revisions', async () => {
    const process = new FakeAppServerProcess((message) => {
      if (message.method === 'initialize') process.reply(message.id, {});
      if (message.method === 'getAuthStatus') process.reply(message.id, { authMethod: 'chatgpt' });
      if (message.method === 'thread/start') {
        process.reply(message.id, {
          thread: { id: 'thread-1' },
          approvalPolicy: 'never',
          sandbox: { type: 'readOnly', networkAccess: false },
        });
      }
      if (message.method === 'turn/start') {
        process.reply(message.id, { turnId: 'turn-1' });
        queueMicrotask(() => {
          process.notify('item/completed', {
            threadId: 'thread-1',
            turnId: 'turn-1',
            item: { type: 'agentMessage', text: 'compatible answer' },
          });
          process.notify('turn/completed', {
            threadId: 'thread-1',
            turn: { status: 'completed', error: null },
          });
        });
      }
      if (message.method === 'thread/delete') process.reply(message.id, {});
    });

    await expect(
      runCodexAppServerTurn(
        {
          command: 'codex',
          cwd: '/tmp/contained-workspace',
          env: { PATH: '/usr/bin' },
          model: 'gpt-5.6-terra',
          systemPrompt: 'Trusted',
          userPrompt: 'Task',
        },
        () => process,
      ),
    ).resolves.toMatchObject({ text: 'compatible answer' });
  });

  it('rejects an App Server that does not confirm the no-network tool sandbox', async () => {
    const process = new FakeAppServerProcess((message) => {
      if (message.method === 'initialize') process.reply(message.id, {});
      if (message.method === 'getAuthStatus') process.reply(message.id, { authMethod: 'chatgpt' });
      if (message.method === 'thread/start') {
        process.reply(message.id, {
          thread: { id: 'thread-1' },
          approvalPolicy: 'never',
          sandbox: { type: 'readOnly', networkAccess: true },
        });
      }
      if (message.method === 'thread/delete') process.reply(message.id, {});
    });

    await expect(
      runCodexAppServerTurn(
        {
          command: 'codex',
          cwd: '/tmp/contained-workspace',
          env: { PATH: '/usr/bin' },
          model: 'gpt-5.6-terra',
          systemPrompt: 'Trusted',
          userPrompt: 'Task',
        },
        () => process,
      ),
    ).rejects.toThrow('read-only, no-network tool sandbox');
  });

  it('tears down a startup that is cancelled before a turn exists', async () => {
    const process = new FakeAppServerProcess(() => {
      // Deliberately leave initialize pending to model a hung App Server.
    });
    const abortController = new AbortController();
    const turn = runCodexAppServerTurn(
      {
        command: 'codex',
        cwd: '/tmp/contained-workspace',
        env: { PATH: '/usr/bin' },
        model: 'gpt-5.6-terra',
        systemPrompt: 'Trusted',
        userPrompt: 'Task',
        abortSignal: abortController.signal,
      },
      () => process,
    );

    abortController.abort();

    await expect(turn).rejects.toThrow('request was cancelled');
    expect(process.kill).toHaveBeenCalledWith('SIGTERM');
  });
});
