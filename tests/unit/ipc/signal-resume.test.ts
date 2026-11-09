/**
 * Privileged Signal resume and status over the real daemon IPC file transport.
 *
 * The server is the real DaemonIpcServer polling real files; the command handler is the
 * production handleSignalResumeCommand. Connectors are real SignalConnector instances.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { err, ok } from 'neverthrow';

import { DaemonIpcServer, handleSignalResumeCommand, projectSignalStatus } from '../../../src/ipc/daemon-ipc-server.js';
import type { SignalChannelLookup } from '../../../src/ipc/daemon-ipc-server.js';
import type { DaemonCommand, DaemonResponse } from '../../../src/ipc/daemon-ipc.js';
import { parseSignalResumeResponse, parseSignalStatusData } from '../../../src/ipc/daemon-ipc.js';
import { SignalConnector } from '../../../src/channels/connectors/signal/signal-connector.js';
import { SignalConfigSchema } from '../../../src/channels/connectors/signal/signal-config.js';
import { SignalDeviceRegistry } from '../../../src/channels/connectors/signal/signal-device-registry.js';
import { SignalVerificationError } from '../../../src/channels/connectors/signal/signal-account-verifier.js';

const accountUuid = 'aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb';
const socketPath = '/run/talon-signal/private/bridge.sock';
const phone = '+12025550123';

function connectorFor(name: string): SignalConnector {
  const config = SignalConfigSchema.parse({
    accountMode: 'dedicated',
    socketPath,
    account: phone,
    accountUuid,
    deviceId: 1,
  });
  const registry = SignalDeviceRegistry.create(1, [config])._unsafeUnwrap();
  return new SignalConnector(config, name, pino({ level: 'silent' }), {
    accounts: {} as never,
    leases: {} as never,
    queue: {} as never,
    registry,
  });
}

function lookupOf(connectors: SignalConnector[]): SignalChannelLookup {
  return {
    get: (name: string) => connectors.find((connector) => connector.name === name),
    listAll: () => [...connectors],
  };
}

async function readResponse(outputDir: string): Promise<unknown> {
  const entries = (await fs.readdir(outputDir)).filter((entry) => entry.endsWith('.json')).sort();
  expect(entries).toHaveLength(1);
  return JSON.parse(await fs.readFile(path.join(outputDir, entries[0]!), 'utf8')) as unknown;
}

describe('Signal IPC resume and status', () => {
  let tmpDir: string;
  let inputDir: string;
  let outputDir: string;
  let errorsDir: string;
  let connector: SignalConnector;
  let handled: DaemonCommand[];
  let server: DaemonIpcServer;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'signal-resume-ipc-'));
    inputDir = path.join(tmpDir, 'input');
    outputDir = path.join(tmpDir, 'output');
    errorsDir = path.join(tmpDir, 'errors');
    connector = connectorFor('signal-main');
    handled = [];
    const lookup = lookupOf([connector]);
    server = new DaemonIpcServer({
      inputDir,
      outputDir,
      errorsDir,
      logger: pino({ level: 'silent' }),
      commandHandler: async (command) => {
        handled.push(command);
        if (command.command === 'signal-resume') return handleSignalResumeCommand(lookup, command);
        return { id: randomUUID(), commandId: command.id, success: true };
      },
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function sendResume(payload: Record<string, unknown>): Promise<unknown> {
    const command = { id: randomUUID(), command: 'signal-resume', payload };
    await fs.mkdir(inputDir, { recursive: true });
    await fs.writeFile(path.join(inputDir, `${command.id}.json`), JSON.stringify(command), 'utf8');
    await server.pollOnce();
    return readResponse(outputDir);
  }

  it('reports an unknown channel as NOT_FOUND without touching any connector', async () => {
    const sendSpy = vi.spyOn(connector, 'send');
    const raw = await sendResume({ channel: 'no-such-channel', externalChallengeResolved: true });

    const parsed = parseSignalResumeResponse(raw, (raw as { commandId: string }).commandId);
    expect(parsed._unsafeUnwrap()).toEqual({ outcome: 'unavailable', reason: 'NOT_FOUND' });
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('preserves a refused verification as blocked with its own reason and never sends', async () => {
    vi.spyOn(connector, 'resumeChallenge').mockResolvedValue(
      err(new SignalVerificationError('VERIFICATION_PENDING')),
    );
    const sendSpy = vi.spyOn(connector, 'send');
    const raw = await sendResume({ channel: 'signal-main', externalChallengeResolved: true });

    const data = parseSignalResumeResponse(raw, (raw as { commandId: string }).commandId)._unsafeUnwrap();
    expect(data).toEqual({ outcome: 'blocked', reason: 'VERIFICATION_PENDING' });
    expect((raw as DaemonResponse).success).toBe(false);
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('keeps a rate/recovery pause visible instead of reporting verified', async () => {
    vi.spyOn(connector, 'resumeChallenge').mockResolvedValue(
      ok({ state: 'pending', reason: 'PAUSED', checking: false }),
    );
    const raw = await sendResume({ channel: 'signal-main', externalChallengeResolved: true });

    expect(parseSignalResumeResponse(raw, (raw as { commandId: string }).commandId)._unsafeUnwrap())
      .toEqual({ outcome: 'blocked', reason: 'PAUSED' });
  });

  it('reports verified only for an Ok, verified, unpaused result', async () => {
    vi.spyOn(connector, 'resumeChallenge').mockResolvedValue(
      ok({ state: 'verified', checking: false }),
    );
    const raw = await sendResume({ channel: 'signal-main', externalChallengeResolved: true });

    expect(parseSignalResumeResponse(raw, (raw as { commandId: string }).commandId)._unsafeUnwrap())
      .toEqual({ outcome: 'verified' });
    expect((raw as DaemonResponse).success).toBe(true);
  });

  it('refuses a real stopped connector without sending or changing its state', async () => {
    const sendSpy = vi.spyOn(connector, 'send');
    const raw = await sendResume({ channel: 'signal-main', externalChallengeResolved: true });

    expect(parseSignalResumeResponse(raw, (raw as { commandId: string }).commandId)._unsafeUnwrap())
      .toEqual({ outcome: 'unavailable', reason: 'DISCONNECTED' });
    expect(sendSpy).not.toHaveBeenCalled();
    expect(connector.status().state).toBe('stopped');
  });

  it('rejects a resume request with extra fields before the handler runs', async () => {
    const command = {
      id: randomUUID(),
      command: 'signal-resume',
      payload: { channel: 'signal-main', externalChallengeResolved: true, extra: 'x' },
    };
    await fs.mkdir(inputDir, { recursive: true });
    await fs.writeFile(path.join(inputDir, `${command.id}.json`), JSON.stringify(command), 'utf8');
    await server.pollOnce();

    expect(handled).toHaveLength(0);
    const errors = await fs.readdir(errorsDir);
    expect(errors.some((entry) => entry.endsWith('.error.json'))).toBe(true);
    await expect(fs.readdir(outputDir)).rejects.toThrow();
  });

  const noSaved = { summarizeSavedSignalDeliveries: () => ok({ pending: 0, terminal: 0, reasons: [] }) };

  it('projects a status DTO with no account, socket, phone or identity leakage', () => {
    const status = projectSignalStatus(lookupOf([connector]), noSaved, true);
    expect(status).toBeDefined();
    const serialized = JSON.stringify(status);

    expect(parseSignalStatusData({ channels: status!.channels }).isOk()).toBe(true);
    expect(status!.channels![0]).toEqual(expect.objectContaining({ channel: 'signal-main', state: 'stopped' }));
    for (const forbidden of [accountUuid, socketPath, phone, 'bridge.sock']) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('maps the repository saved summary and omits it when the summary is unavailable', () => {
    const withSaved = projectSignalStatus(
      lookupOf([connector]),
      {
        summarizeSavedSignalDeliveries: () =>
          ok({ pending: 3, terminal: 2, reasons: [{ reason: 'UNKNOWN_ACCEPTANCE', count: 2 }] }),
      },
      true,
    );
    expect(withSaved!.saved).toEqual({
      pending: 3,
      terminal: 2,
      reasons: [{ reason: 'UNKNOWN_ACCEPTANCE', count: 2 }],
    });
    expect(withSaved!.channels).toHaveLength(1);

    const unavailable = projectSignalStatus(
      lookupOf([connector]),
      { summarizeSavedSignalDeliveries: () => err(new Error('invalid reserved state')) },
      true,
    );
    expect(unavailable).not.toHaveProperty('saved');
    expect(unavailable!.channels).toHaveLength(1);
  });

  it('is absent when Signal is not configured and nothing is saved, but still shows stranded saved work', () => {
    expect(projectSignalStatus(lookupOf([]), noSaved, false)).toBeUndefined();
    expect(
      projectSignalStatus(
        lookupOf([]),
        { summarizeSavedSignalDeliveries: () => ok({ pending: 1, terminal: 0, reasons: [] }) },
        false,
      ),
    ).toEqual({ saved: { pending: 1, terminal: 0, reasons: [] } });
  });
});
