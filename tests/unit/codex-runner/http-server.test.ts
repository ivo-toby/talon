import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexRunnerService } from '../../../src/codex-runner/runner-service.js';
import { createCodexRunnerHttpServer } from '../../../src/codex-runner/http-server.js';

const TOKEN = 't'.repeat(32);

describe('Codex runner HTTP server', () => {
  let authDir: string;
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    authDir = await mkdtemp(join(tmpdir(), 'talon-codex-runner-test-'));
    await writeFile(join(authDir, 'auth.json'), '{}');
    const service = new CodexRunnerService({ authDir });
    server = createCodexRunnerHttpServer(TOKEN, service, {
      generate: vi.fn().mockResolvedValue({ ok: true, text: 'runner result' }),
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await rm(authDir, { recursive: true, force: true });
  });

  it('exposes an unauthenticated health endpoint only', async () => {
    const response = await fetch(`${baseUrl}/healthz`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it('rejects generation requests without the Talon runner token', async () => {
    const response = await fetch(`${baseUrl}/v1/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.6-terra', systemPrompt: 'x', userPrompt: 'y' }),
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('accepts only the narrow generation request with a valid token', async () => {
    const response = await fetch(`${baseUrl}/v1/generate`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.6-terra',
        systemPrompt: 'Trusted system instruction',
        userPrompt: 'Bounded task',
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, text: 'runner result' });
  });

  it('reserves the single-flight runner while an earlier request body is still streaming', async () => {
    let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const first = fetch(`${baseUrl}/v1/generate`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: new ReadableStream({
        start(controller) {
          bodyController = controller;
          controller.enqueue(new TextEncoder().encode('{'));
        },
      }),
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });

    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    const second = await fetch(`${baseUrl}/v1/generate`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.6-terra', systemPrompt: 'x', userPrompt: 'y' }),
    });

    expect(second.status).toBe(429);
    bodyController?.error(new Error('close test stream'));
    await expect(first).rejects.toThrow();
  });
});
