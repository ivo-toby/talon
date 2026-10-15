import { afterEach, describe, expect, it, vi } from 'vitest';
import { SignalDiagnostics } from '../../../../../src/channels/connectors/signal/signal-diagnostics.js';

afterEach(() => vi.useRealTimers());
describe('Signal metadata-free diagnostics', () => {
  it('aggregates fixed ignored reason counts once per minute, not per event', async () => {
    vi.useFakeTimers();
    const sink = { debug: vi.fn(), warn: vi.fn() };
    const diagnostics = new SignalDiagnostics('synthetic-channel', sink);
    for (let i = 0; i < 100; i++) diagnostics.count('RECEIVE_EXCEPTION');
    diagnostics.count('UNKNOWN_DEVICE');
    expect(sink.debug).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sink.debug.mock.calls).toEqual([
      [
        { channelName: 'synthetic-channel', counts: { RECEIVE_EXCEPTION: 100, UNKNOWN_DEVICE: 1 } },
        'Signal ignored input counts',
      ],
    ]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sink.debug).toHaveBeenCalledTimes(1);
    diagnostics.count('CONTROL');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sink.debug).toHaveBeenCalledTimes(2);
    diagnostics.stop();
  });

  it('warns once per bounded-buffer episode with only safe counts and fixed recovery instruction', () => {
    vi.useFakeTimers();
    const sink = { debug: vi.fn(), warn: vi.fn() };
    const diagnostics = new SignalDiagnostics('synthetic-channel', sink);
    diagnostics.episode('PROOF_EXPIRED');
    diagnostics.episode('PROOF_EXPIRED');
    expect(sink.warn).toHaveBeenCalledTimes(1);
    expect(sink.warn.mock.calls[0]).toEqual([
      { channelName: 'synthetic-channel', counts: { PROOF_EXPIRED: 1 } },
      'Signal input loss before acceptance; resend expired commands after recovery',
    ]);
    diagnostics.recovered('PROOF_EXPIRED');
    diagnostics.episode('PROOF_EXPIRED');
    expect(sink.warn).toHaveBeenCalledTimes(2);
    diagnostics.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stop cancels aggregate emission and no raw error/envelope API exists', async () => {
    vi.useFakeTimers();
    const sink = { debug: vi.fn(), warn: vi.fn() };
    const diagnostics = new SignalDiagnostics('synthetic-channel', sink);
    diagnostics.count('INVALID_EVENT');
    diagnostics.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sink.debug).not.toHaveBeenCalled();
    diagnostics.count('INVALID_EVENT');
    expect(vi.getTimerCount()).toBe(0);
  });
});
