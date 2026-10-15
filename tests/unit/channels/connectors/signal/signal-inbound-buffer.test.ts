import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InboundReceiptHandler } from '../../../../../src/channels/channel-types.js';
import type { Result } from '../../../../../src/core/types/result.js';
import { SignalConfigSchema } from '../../../../../src/channels/connectors/signal/signal-config.js';
import {
  SignalDeviceRegistry,
  verifySignalDevices,
} from '../../../../../src/channels/connectors/signal/signal-device-registry.js';
import { SignalInboundBuffer } from '../../../../../src/channels/connectors/signal/signal-inbound-buffer.js';
import { SignalDiagnostics } from '../../../../../src/channels/connectors/signal/signal-diagnostics.js';
import { ChannelError, PipelineError } from '../../../../../src/core/errors/error-types.js';
import { err, ok } from '../../../../../src/core/types/result.js';

// Supplemental pinned jsonrpc/SignalJsonRpcDispatcherHandler.java:164-199: manual subscription/result.
// Source-derived, NOT live evidence: pinned v0.14.9 JsonReceiveMessageHandler.java:23-35,
// JsonMessageEnvelope.java:15-31, JsonSyncMessage.java:20-35,
// JsonSyncDataMessage.java:14-30 (@JsonUnwrapped), JsonDataMessage.java:13-40.
const accountUuid = 'aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb';
const peerUuid = 'cccccccc-1111-2222-3333-dddddddddddd';
const devices = [
  { id: 1, name: null, createdTimestamp: 1, lastSeenTimestamp: 1_000 },
  { id: 2, name: null, createdTimestamp: 100, lastSeenTimestamp: 1_000 },
  { id: 3, name: null, createdTimestamp: 200, lastSeenTimestamp: 1_000 },
];
function receive(
  timestamp = 1_000,
  message = 'self command',
  account = accountUuid,
  sourceDevice: number | null = 2,
  data: Record<string, unknown> = {},
) {
  return {
    subscription: 7,
    result: {
      account,
      envelope: {
        sourceUuid: accountUuid,
        sourceDevice,
        timestamp: timestamp + 1,
        syncMessage: {
          sentMessage: {
            destinationUuid: accountUuid,
            timestamp,
            message,
            expiresInSeconds: 0,
            ...data,
          },
        },
      },
    },
  };
}
function setup() {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  let config = SignalConfigSchema.parse({
    accountMode: 'personal',
    socketPath: '/run/signal/bridge.sock',
    account: '+12025550123',
    accountUuid,
    deviceId: 3,
    deviceCreatedTimestamp: 200,
    allowedDmPeers: [peerUuid],
    allowedSenders: [peerUuid],
  });
  const registry = SignalDeviceRegistry.create(1, [config])._unsafeUnwrap();
  const renew = () =>
    registry
      .publish(verifySignalDevices(config, devices, 1, Date.now())._unsafeUnwrap())
      ._unsafeUnwrap();
  renew();
  let aliases = [accountUuid, '+12025550123'];
  const sink = { debug: vi.fn(), warn: vi.fn() };
  const diagnostics = new SignalDiagnostics('synthetic-channel', sink);
  const receipt = vi.fn<InboundReceiptHandler>(() => ok('accepted'));
  const refreshAliases = vi.fn<() => Promise<Result<void, ChannelError>>>(async () =>
    ok(undefined),
  );
  const refreshDevices = vi.fn();
  const reconnect = vi.fn();
  const buffer = new SignalInboundBuffer({
    devices: registry,
    context: () => ({
      config,
      channelName: 'synthetic-channel',
      generation: 1,
      connectionGeneration: 1,
      subscription: 7,
      aliases,
      registry: registry.snapshot(),
      now: Date.now(),
    }),
    receipt,
    refreshAliases,
    refreshDevices,
    reconnect,
    diagnostics,
    random: () => 0.5,
  });
  return {
    buffer,
    receipt,
    refreshAliases,
    refreshDevices,
    reconnect,
    registry,
    renew,
    sink,
    setAliases: (value: string[]) => {
      aliases = value;
    },
    setConfig: (value: Partial<typeof config>) => {
      config = { ...config, ...value };
    },
    stop: () => {
      buffer.stop();
      diagnostics.stop();
    },
  };
}
afterEach(() => vi.useRealTimers());

describe('Signal bounded admission actors', () => {
  it('R3-F1 holds three Note to Self commands through a six-minute verification outage, then admits once each', async () => {
    const h = setup();
    await vi.advanceTimersByTimeAsync(300_000);
    for (let i = 0; i < 3; i++)
      expect(h.buffer.receive(receive(1_000 + i, `command ${i}`), 1)._unsafeUnwrap()).toBe('held');
    expect(h.buffer.status().proof.held).toBe(3);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.receipt).not.toHaveBeenCalled();
    h.renew();
    h.buffer.revalidate();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.receipt.mock.calls.map(([event]) => event.content)).toEqual([
      'command 0',
      'command 1',
      'command 2',
    ]);
    h.buffer.revalidate();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.receipt).toHaveBeenCalledTimes(3);
    expect(h.buffer.status().proof.held).toBe(0);
    h.stop();
  });

  it('R2-F7 coalesces alias refresh on a healthy subscription, learns only the pinned ACI and retries held input once', async () => {
    const h = setup();
    h.refreshAliases.mockImplementation(async () => {
      h.setAliases([accountUuid, '+12025550456']);
      return ok(undefined);
    });
    h.buffer.receive(receive(1_000, 'new number', '+12025550456'), 1);
    h.buffer.receive(receive(1_001, 'other account', '+12025550789'), 1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.refreshAliases).toHaveBeenCalledTimes(1);
    expect(h.receipt).toHaveBeenCalledTimes(1);
    expect(h.receipt.mock.calls[0][0].content).toBe('new number');
    expect(h.buffer.status().alias.held).toBe(0);
    expect(h.reconnect).not.toHaveBeenCalled();
    expect(h.refreshDevices).not.toHaveBeenCalled();
    h.stop();
  });

  it('alias timeout grants no trust, retries at most every five seconds and expires after 30 seconds', async () => {
    const h = setup();
    h.refreshAliases.mockImplementation(async () => err(new ChannelError('unsafe raw response')));
    for (let i = 0; i < 10; i++) h.buffer.receive(receive(1_000 + i, 'private', '+12025550456'), 1);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(h.refreshAliases).toHaveBeenCalledTimes(1);
    expect(h.receipt).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(25_001);
    expect(h.refreshAliases.mock.calls.length).toBeLessThanOrEqual(6);
    expect(h.buffer.status().alias).toMatchObject({ held: 0, dropped: 10 });
    expect(h.sink.warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(h.sink.warn.mock.calls)).not.toMatch(/unsafe|private|1202555/);
    h.stop();
  });

  it('separate 64-entry alias/proof bounds drop newest, preserve retained entries, and never reconnect', async () => {
    const h = setup();
    h.refreshAliases.mockImplementation(async () => err(new ChannelError('failure')));
    for (let i = 0; i < 64; i++)
      h.buffer.receive(receive(1_000 + i, `alias ${i}`, '+12025550456'), 1);
    expect(
      h.buffer.receive(receive(2_000, 'newest', '+12025550456'), 1)._unsafeUnwrapErr().reason,
    ).toBe('ALIAS_OVERFLOW');
    expect(h.buffer.status().alias).toMatchObject({ held: 64, dropped: 1 });
    await vi.advanceTimersByTimeAsync(300_000);
    for (let i = 0; i < 64; i++) h.buffer.receive(receive(3_000 + i, `proof ${i}`), 1);
    expect(h.buffer.receive(receive(4_000, 'newest'), 1)._unsafeUnwrapErr().reason).toBe(
      'PROOF_OVERFLOW',
    );
    expect(h.buffer.status().proof).toMatchObject({ held: 64, dropped: 1 });
    h.renew();
    h.buffer.revalidate();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.receipt.mock.calls.map(([event]) => event.content)).toEqual(
      Array.from({ length: 64 }, (_, i) => `proof ${i}`),
    );
    expect(h.reconnect).not.toHaveBeenCalled();
    h.stop();
  });

  it('enforces independent UTF-8 encoded 1 MiB budgets rather than character counts', async () => {
    const h = setup();
    h.refreshAliases.mockImplementation(async () => err(new ChannelError('failure')));
    const large = '😀'.repeat(140_000); // 560,000 bytes; two exceed each independent budget.
    expect(h.buffer.receive(receive(1_000, large, '+12025550456'), 1)._unsafeUnwrap()).toBe('held');
    expect(
      h.buffer.receive(receive(1_001, large, '+12025550456'), 1)._unsafeUnwrapErr().reason,
    ).toBe('ALIAS_OVERFLOW');
    expect(h.buffer.status().alias.bytes).toBeLessThanOrEqual(1_048_576);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(h.buffer.receive(receive(2_000, large), 1)._unsafeUnwrap()).toBe('held');
    expect(h.buffer.receive(receive(2_001, large), 1)._unsafeUnwrapErr().reason).toBe(
      'PROOF_OVERFLOW',
    );
    h.stop();
  });

  it('never quarantines control/ephemeral/unknown-device/unauthorized input; unknown devices request coalesced refresh only', async () => {
    const h = setup();
    await vi.advanceTimersByTimeAsync(300_000);
    for (let i = 0; i < 20; i++) {
      h.buffer.receive(receive(1_000 + i, 'unknown', accountUuid, 99), 1);
      h.buffer.receive(receive(2_000 + i, 'missing', accountUuid, null), 1);
    }
    h.buffer.receive(receive(3_000, 'control', '+12025550456', 2, { reaction: {} }), 1);
    h.buffer.receive(receive(3_001, 'ephemeral', '+12025550456', 2, { expiresInSeconds: 20 }), 1);
    h.setConfig({ allowedDmPeers: [] });
    h.buffer.receive(
      receive(3_002, '!talon unselected', '+12025550456', 2, { destinationUuid: peerUuid }),
      1,
    );
    expect(h.buffer.status().alias.held + h.buffer.status().proof.held).toBe(0);
    expect(h.refreshDevices).toHaveBeenCalledTimes(1);
    expect(h.refreshAliases).not.toHaveBeenCalled();
    expect(h.receipt).not.toHaveBeenCalled();
    h.stop();
  });

  it('R3-F1 revalidates selection and renewed roster; ten-minute TTL and stop release no expired commands', async () => {
    const h = setup();
    h.setConfig({ allowedDmPeers: [peerUuid] });
    await vi.advanceTimersByTimeAsync(300_000);
    h.buffer.receive(
      receive(1_000, '!talon own dm', accountUuid, 2, { destinationUuid: peerUuid }),
      1,
    );
    h.setConfig({ allowedDmPeers: [] });
    h.renew();
    h.buffer.revalidate();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.receipt).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(300_000);
    h.buffer.receive(receive(2_000), 1);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(h.buffer.status().proof).toMatchObject({ held: 0, dropped: 2 });
    expect(h.sink.warn).toHaveBeenCalledTimes(1);
    h.buffer.receive(receive(3_000), 1);
    h.stop();
    h.renew();
    h.buffer.revalidate();
    await vi.advanceTimersByTimeAsync(1_000_000);
    expect(h.receipt).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('connector-driven receipt retry retains exact event/key, FIFO and successful duplicate/drop receipts', async () => {
    const h = setup();
    h.receipt.mockImplementationOnce(() => err(new PipelineError('do not log private failure')));
    h.receipt.mockImplementationOnce(() => ok('duplicate'));
    h.receipt.mockImplementationOnce(() => ok('dropped'));
    h.buffer.receive(receive(1_000, 'first'), 1);
    h.buffer.receive(receive(1_001, 'second'), 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.receipt).toHaveBeenCalledTimes(1);
    const first = h.receipt.mock.calls[0][0];
    await vi.advanceTimersByTimeAsync(250);
    expect(h.receipt).toHaveBeenCalledTimes(3);
    expect(h.receipt.mock.calls[1][0]).toBe(first);
    expect(h.receipt.mock.calls[2][0].content).toBe('second');
    expect(h.buffer.status().receipt.held).toBe(0);
    h.stop();
  });

  it('uses 250 ms exponential receipt backoff and config refresh cannot create a hot retry loop', async () => {
    const h = setup();
    h.receipt.mockImplementation(() => err(new PipelineError('transient')));
    h.buffer.receive(receive(), 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.receipt).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 10; i++) {
      h.buffer.revalidate();
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(h.receipt).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(250);
    expect(h.receipt).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(499);
    expect(h.receipt).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.receipt).toHaveBeenCalledTimes(3);
    h.stop();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(h.receipt).toHaveBeenCalledTimes(3);
  });

  it('receipt overflow reconnects without evicting retained FIFO, retries across reconnect and expires at five minutes', async () => {
    const h = setup();
    h.receipt.mockImplementation(() => err(new PipelineError('transient')));
    for (let i = 0; i < 64; i++) h.buffer.receive(receive(1_000 + i, `fifo ${i}`), 1);
    expect(h.buffer.receive(receive(2_000, 'overflow'), 1)._unsafeUnwrapErr().reason).toBe(
      'RECEIPT_OVERFLOW',
    );
    expect(h.reconnect).toHaveBeenCalledTimes(1);
    expect(h.buffer.status().receipt).toMatchObject({ held: 64, dropped: 1 });
    h.registry.invalidate(accountUuid);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.receipt).not.toHaveBeenCalled();
    h.renew();
    h.buffer.revalidate();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.receipt.mock.calls[0][0].content).toBe('fifo 0');
    await vi.advanceTimersByTimeAsync(300_000);
    expect(h.buffer.status().receipt).toMatchObject({ held: 0, dropped: 65 });
    expect(h.receipt.mock.calls.length).toBeLessThan(50);
    expect(new Set(h.receipt.mock.calls.map(([event]) => event.content))).toEqual(
      new Set(['fifo 0']),
    );
    expect(JSON.stringify(h.sink.warn.mock.calls)).not.toContain('fifo');
    h.stop();
  });

  it('renewed human roster can revoke a quarantined command, without speculative device trust', async () => {
    const h = setup();
    await vi.advanceTimersByTimeAsync(300_000);
    h.buffer.receive(receive(), 1);
    const current = h.registry.snapshot()[0];
    if (current.status !== 'verified') throw new Error('test requires verified initial roster');
    h.registry
      .publish({
        ...current,
        verifiedAt: Date.now(),
        expiresAt: Date.now() + 300_000,
        humanDevices: current.humanDevices.filter((device) => device.deviceId !== 2),
      })
      ._unsafeUnwrap();
    h.buffer.revalidate();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.buffer.status().proof).toMatchObject({ held: 0, dropped: 1 });
    expect(h.receipt).not.toHaveBeenCalled();
    h.stop();
  });

  it('receipt retries preserve original confirmed account ownership after a phone alias changes', async () => {
    const h = setup();
    h.receipt.mockImplementationOnce(() => err(new PipelineError('transient')));
    h.buffer.receive(receive(1_000, 'accepted alias', '+12025550123'), 1);
    await vi.advanceTimersByTimeAsync(0);
    const event = h.receipt.mock.calls[0][0];
    h.setAliases([accountUuid, '+12025550456']);
    await vi.advanceTimersByTimeAsync(250);
    expect(h.receipt).toHaveBeenCalledTimes(2);
    expect(h.receipt.mock.calls[1][0]).toBe(event);
    expect(h.buffer.status().receipt.held).toBe(0);
    h.stop();
  });

  it('enforces receipt deadlines while a handler is pending and never invokes handlers concurrently', async () => {
    const h = setup();
    let finish: (() => void) | undefined;
    h.receipt.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve(err(new PipelineError('late')));
        }),
    );
    h.buffer.receive(receive(1_000, 'first'), 1);
    h.buffer.receive(receive(1_001, 'second'), 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.receipt).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(h.buffer.status().receipt).toMatchObject({ held: 0, dropped: 2 });
    finish?.();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.receipt).toHaveBeenCalledTimes(1);
    h.stop();
  });

  it('receipt byte overflow preserves existing events and stop cancels late async completion', async () => {
    const h = setup();
    let finish: (() => void) | undefined;
    h.receipt.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve(ok('accepted'));
        }),
    );
    const large = '😀'.repeat(90_000);
    h.buffer.receive(receive(1_000, large), 1);
    // Receipt retains both candidate and immutable prepared event: combined encoded budget.
    expect(h.buffer.receive(receive(1_001, large), 1).isErr()).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.receipt).toHaveBeenCalledTimes(1);
    h.stop();
    finish?.();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(h.receipt).toHaveBeenCalledTimes(1);
    expect(h.buffer.status().receipt.held).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
