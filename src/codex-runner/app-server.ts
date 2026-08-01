import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export interface CodexAppServerInvocation {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  uid?: number;
  gid?: number;
}

export interface CodexAppServerProcess {
  readonly stdin: NodeJS.WritableStream;
  readonly stdout: NodeJS.ReadableStream;
  readonly stderr?: NodeJS.ReadableStream;
  readonly pid?: number;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: 'error' | 'exit', listener: (...args: unknown[]) => void): this;
}

export type CodexAppServerSpawner = (
  invocation: CodexAppServerInvocation,
) => CodexAppServerProcess;

export interface CodexAppServerTurnInput {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  outputSchema?: unknown;
  abortSignal?: AbortSignal;
  uid?: number;
  gid?: number;
}

export interface CodexAppServerTurnResult {
  text: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
  };
}

export class CodexSandboxPolicyViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodexSandboxPolicyViolationError';
  }
}

interface JsonRpcMessage {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string };
}

interface ThreadStartResult {
  thread?: { id?: string };
  approvalPolicy?: unknown;
  sandbox?: { type?: unknown; networkAccess?: unknown };
}

interface TurnStartResult {
  turn?: { id?: string };
  /**
   * Some App Server protocol revisions return the newly-created turn as a
   * complete object, while others return its identifier directly. Accept both
   * documented response shapes so the runner fails closed only when neither
   * yields an identifier.
   */
  turnId?: string;
}

interface TurnCompletedParams {
  threadId?: string;
  turn?: { status?: string; error?: { message?: string } | null };
}

interface ThreadItemParams {
  item?: { type?: string; text?: string };
}

interface TokenUsageParams {
  tokenUsage?: {
    last?: {
      inputTokens?: number;
      outputTokens?: number;
    };
  };
}

const FORBIDDEN_ITEM_TYPES = new Set([
  'commandExecution',
  'fileChange',
  'mcpToolCall',
  'dynamicToolCall',
  'collabAgentToolCall',
  'collabToolCall',
  'subAgentActivity',
  'webSearch',
  'imageView',
  'imageGeneration',
  'sleep',
]);

export function spawnCodexAppServer(input: CodexAppServerInvocation): CodexAppServerProcess {
  const options = {
    // A per-turn process group lets teardown reap any CLI child process the
    // app server starts, instead of leaving it alive after an abort.
    detached: process.platform !== 'win32',
    cwd: input.cwd,
    env: input.env,
    stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'],
    ...(input.uid === undefined ? {} : { uid: input.uid }),
    ...(input.gid === undefined ? {} : { gid: input.gid }),
  };
  return spawn(input.command, ['app-server'], options);
}

/**
 * Runs one App Server turn in a new ephemeral thread. A fresh CODEX_HOME is
 * supplied by the caller, so no user config, sessions, skills, or MCP servers
 * are inherited from the runner image.
 */
export async function runCodexAppServerTurn(
  input: CodexAppServerTurnInput,
  spawner: CodexAppServerSpawner = spawnCodexAppServer,
): Promise<CodexAppServerTurnResult> {
  const rpc = new AppServerRpc(
    spawner({
      command: input.command,
      cwd: input.cwd,
      env: input.env,
      ...(input.uid === undefined ? {} : { uid: input.uid }),
      ...(input.gid === undefined ? {} : { gid: input.gid }),
    }),
  );
  let threadId: string | undefined;
  let turnId: string | undefined;
  let sawForbiddenActivity: string | undefined;
  let latestAgentMessage = '';
  let latestUsage: CodexAppServerTurnResult['usage'];
  let resolveTurn: (() => void) | undefined;
  let rejectTurn: ((error: Error) => void) | undefined;
  const turnFinished = new Promise<void>((resolve, reject) => {
    resolveTurn = resolve;
    rejectTurn = reject;
  });
  // Cancellation can happen during startup, before this promise is awaited.
  // Keep a rejection handler attached in that path while still awaiting the
  // original promise below once a turn has actually started.
  void turnFinished.catch(() => undefined);

  const interrupt = (): void => {
    if (threadId === undefined || turnId === undefined) return;
    void rpc.request('turn/interrupt', { threadId, turnId }).catch(() => undefined);
  };

  const abort = (): void => {
    interrupt();
    rejectTurn?.(new Error('Codex sandbox runner request was cancelled'));
    // An abort can arrive during initialization or thread startup, before
    // turnFinished is awaited. Closing the RPC rejects that in-flight request
    // and reaps the App Server rather than leaving the single-flight runner
    // stuck until its container is restarted.
    rpc.dispose('Codex sandbox runner request was cancelled');
  };

  if (input.abortSignal?.aborted) abort();
  input.abortSignal?.addEventListener('abort', abort, { once: true });

  rpc.onNotification((message) => {
    if (message.method === 'item/started' || message.method === 'item/completed') {
      const item = (message.params as ThreadItemParams | undefined)?.item;
      if (item?.type !== undefined && FORBIDDEN_ITEM_TYPES.has(item.type)) {
        sawForbiddenActivity ??= item.type;
        interrupt();
      }
      if (item?.type === 'agentMessage' && typeof item.text === 'string') {
        latestAgentMessage = item.text;
      }
      return;
    }

    if (message.method === 'item/agentMessage/delta') {
      const params = message.params as { delta?: unknown } | undefined;
      if (typeof params?.delta === 'string') latestAgentMessage += params.delta;
      return;
    }

    if (message.method === 'thread/tokenUsage/updated') {
      const params = message.params as TokenUsageParams | undefined;
      latestUsage = {
        inputTokens: params?.tokenUsage?.last?.inputTokens,
        outputTokens: params?.tokenUsage?.last?.outputTokens,
      };
      return;
    }

    if (message.method === 'turn/completed') {
      const params = message.params as TurnCompletedParams | undefined;
      if (sawForbiddenActivity !== undefined) {
        rejectTurn?.(
          new CodexSandboxPolicyViolationError(
            `Codex sandbox runner rejected a forbidden built-in tool activity: ${sawForbiddenActivity}`,
          ),
        );
        return;
      }
      if (params?.turn?.status === 'completed') {
        resolveTurn?.();
      } else {
        rejectTurn?.(
          new Error(
            params?.turn?.error?.message ??
              `Codex App Server turn ended with status "${params?.turn?.status ?? 'unknown'}"`,
          ),
        );
      }
    }
  });

  try {
    await rpc.request('initialize', {
      clientInfo: {
        name: 'talon-codex-sandbox-runner',
        title: 'Talon Codex sandbox runner',
        version: '1.0.0',
      },
      capabilities: null,
    });
    rpc.notify('initialized', {});

    const auth = (await rpc.request('getAuthStatus', {
      includeToken: false,
      refreshToken: false,
    })) as { authMethod?: unknown };
    if (auth.authMethod !== 'chatgpt') {
      throw new Error(
        'Codex sandbox runner requires ChatGPT authentication; API-key and gateway authentication are rejected.',
      );
    }

    const thread = await startReadOnlyThread(rpc, input);
    threadId = thread.thread?.id;
    if (threadId === undefined) throw new Error('Codex App Server did not return a thread id');
    if (thread.approvalPolicy !== 'never') {
      throw new Error('Codex App Server did not apply the runner never-approve policy');
    }
    if (thread.sandbox?.type !== 'readOnly' || thread.sandbox.networkAccess !== false) {
      throw new Error('Codex App Server did not apply the runner read-only, no-network tool sandbox');
    }

    const turn = (await rpc.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: input.userPrompt, text_elements: [] }],
      ...(input.outputSchema === undefined ? {} : { outputSchema: input.outputSchema }),
    })) as TurnStartResult;
    turnId = turn.turn?.id ?? turn.turnId;
    if (turnId === undefined) throw new Error('Codex App Server did not return a turn id');

    await turnFinished;
    if (sawForbiddenActivity !== undefined) {
      throw new CodexSandboxPolicyViolationError(
        `Codex sandbox runner rejected a forbidden built-in tool activity: ${sawForbiddenActivity}`,
      );
    }
    if (!latestAgentMessage.trim()) {
      throw new Error('Codex App Server returned an empty final message');
    }

    return {
      text: latestAgentMessage,
      ...(latestUsage === undefined ? {} : { usage: latestUsage }),
    };
  } finally {
    input.abortSignal?.removeEventListener('abort', abort);
    if (threadId !== undefined) {
      await rpc.request('thread/delete', { threadId }).catch(() => undefined);
    }
    rpc.dispose();
  }
}

/**
 * App Server has used both kebab- and camel-cased read-only sandbox enum
 * values across protocol revisions. Prefer the locally supported legacy value
 * and retry only a clearly rejected enum value; a failure to create the thread
 * does not create a usable turn or widen the requested policy.
 */
async function startReadOnlyThread(
  rpc: AppServerRpc,
  input: CodexAppServerTurnInput,
): Promise<ThreadStartResult> {
  const params = {
    model: input.model,
    cwd: input.cwd,
    approvalPolicy: 'never',
    developerInstructions: buildDeveloperInstructions(input.systemPrompt),
    config: { web_search: 'disabled' },
    ephemeral: true,
  };

  try {
    return (await rpc.request('thread/start', { ...params, sandbox: 'read-only' })) as ThreadStartResult;
  } catch (error) {
    if (!isUnsupportedReadOnlySandboxValue(error)) throw error;
    return (await rpc.request('thread/start', { ...params, sandbox: 'readOnly' })) as ThreadStartResult;
  }
}

function isUnsupportedReadOnlySandboxValue(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    /sandbox/iu.test(message) &&
    /(read-only|readOnly)/u.test(message) &&
    /(invalid|unknown|unsupported|expected)/iu.test(message)
  );
}

class AppServerRpc {
  private readonly pending = new Map<
    number,
    { resolve: (result: unknown) => void; reject: (error: Error) => void }
  >();
  private readonly notificationListeners = new Set<(message: JsonRpcMessage) => void>();
  private requestId = 1;
  private disposed = false;

  constructor(private readonly process: CodexAppServerProcess) {
    const lines = createInterface({ input: process.stdout });
    lines.on('line', (line) => this.handleLine(line));
    // Stderr is intentionally not forwarded: it can contain prompt-derived
    // diagnostics. It must still be drained, otherwise a verbose App Server
    // can block after filling the OS pipe buffer.
    process.stderr?.resume();
    process.once('error', (cause) => this.failAll(`Codex App Server process error: ${String(cause)}`));
    process.once('exit', () => this.failAll('Codex App Server exited before the turn completed'));
  }

  onNotification(listener: (message: JsonRpcMessage) => void): void {
    this.notificationListeners.add(listener);
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.disposed) return Promise.reject(new Error('Codex App Server RPC is closed'));
    const id = this.requestId++;
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ method, id, params });
    });
  }

  notify(method: string, params: unknown): void {
    if (!this.disposed) this.send({ method, params });
  }

  dispose(message = 'Codex App Server RPC was closed'): void {
    if (this.disposed) return;
    this.disposed = true;
    this.failAll(message);
    terminateProcessGroup(this.process, 'SIGTERM');
    const forceKill = setTimeout(() => terminateProcessGroup(this.process, 'SIGKILL'), 2_000);
    forceKill.unref();
  }

  private handleLine(line: string): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      return;
    }

    if (typeof message.id === 'number' && message.method !== undefined) {
      // The runner has no interactive permission channel. Under the required
      // never-approve policy these are unexpected, so fail closed rather than
      // granting an incomplete protocol-specific approval response.
      this.send({
        id: message.id,
        error: { code: -32001, message: 'Talon Codex sandbox runner denies server requests' },
      });
      return;
    }

    if (typeof message.id === 'number') {
      const pending = this.pending.get(message.id);
      if (pending === undefined) return;
      this.pending.delete(message.id);
      if (message.error !== undefined) {
        pending.reject(new Error(message.error.message ?? 'Codex App Server returned an error'));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.method !== undefined) {
      for (const listener of this.notificationListeners) listener(message);
    }
  }

  private send(message: JsonRpcMessage): void {
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private failAll(message: string): void {
    for (const pending of this.pending.values()) pending.reject(new Error(message));
    this.pending.clear();
  }
}

function terminateProcessGroup(
  processHandle: CodexAppServerProcess,
  signal: NodeJS.Signals,
): boolean {
  if (processHandle.pid !== undefined && process.platform !== 'win32') {
    try {
      process.kill(-processHandle.pid, signal);
      return true;
    } catch {
      // It may already have exited. The unit-test fake is also not a real
      // process-group leader, so fall through to its leader method.
    }
  }

  return processHandle.kill(signal);
}

function buildDeveloperInstructions(systemPrompt: string): string {
  return [
    'This is a bounded, text-only sub-agent generation.',
    'Do not use shell, filesystem, browser, web-search, MCP, dynamic, or collaboration tools.',
    'Return the requested answer directly.',
    '',
    systemPrompt,
  ].join('\n');
}
