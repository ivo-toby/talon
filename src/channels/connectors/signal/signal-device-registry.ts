import { ChannelError } from '../../../core/errors/error-types.js';
import { err, ok, type Result } from '../../../core/types/result.js';
import type { SignalConfig } from './signal-config.js';
import { normalizeSignalUuid } from './signal-identities.js';
import type {
  SignalAccountProofRegistry,
  SignalAccountProofSnapshot,
  SignalDeviceProof,
} from './signal-types.js';

export class SignalDeviceError extends ChannelError {
  constructor(
    readonly reason: 'DUPLICATE_ACCOUNT' | 'DEVICE_METADATA_INVALID' | 'STALE_GENERATION',
  ) {
    super(`Signal device verification rejected: ${reason}`);
  }
}

/** v0.14.9 ListDevicesCommand.java:58-67: JSON has no current-device marker. */
export function verifySignalDevices(
  config: SignalConfig,
  input: unknown,
  generation: number,
  now: number,
): Result<SignalAccountProofSnapshot, SignalDeviceError> {
  const invalid = (): Result<never, SignalDeviceError> =>
    err(new SignalDeviceError('DEVICE_METADATA_INVALID'));
  if (!Array.isArray(input) || input.length === 0) return invalid();
  const devices: SignalDeviceProof[] = [];
  const entries: readonly unknown[] = input;
  for (const value of entries) {
    if (
      typeof value !== 'object' ||
      value === null ||
      !('id' in value) ||
      !positiveInteger(value.id) ||
      !('createdTimestamp' in value) ||
      !nonnegativeInteger(value.createdTimestamp) ||
      !('lastSeenTimestamp' in value) ||
      !nonnegativeInteger(value.lastSeenTimestamp) ||
      !('name' in value) ||
      (value.name !== null && typeof value.name !== 'string') ||
      devices.some((device) => device.deviceId === value.id)
    )
      return invalid();
    devices.push(Object.freeze({ deviceId: value.id, createdTimestamp: value.createdTimestamp }));
  }
  const bridge = devices.find((device) => device.deviceId === config.deviceId);
  if (
    !bridge ||
    (config.deviceCreatedTimestamp !== undefined &&
      bridge.createdTimestamp !== config.deviceCreatedTimestamp)
  )
    return invalid();
  if (
    config.accountMode === 'personal' &&
    (bridge.deviceId === 1 ||
      bridge.createdTimestamp === 0 ||
      devices.some(
        (device) =>
          device.deviceId !== 1 &&
          device.deviceId !== bridge.deviceId &&
          (device.createdTimestamp === 0 || device.createdTimestamp >= bridge.createdTimestamp),
      ))
  )
    return invalid();
  return ok(
    Object.freeze({
      accountUuid: config.accountUuid,
      accountMode: config.accountMode,
      bridgeDeviceId: config.deviceId,
      generation,
      status: 'verified',
      verifiedAt: now,
      expiresAt: now + 300_000,
      humanDevices: Object.freeze(devices.filter((device) => device.deviceId !== bridge.deviceId)),
    }),
  );
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function nonnegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** One generation-wide owner per ACI. Publication replaces, never mutates, a proof. */
export class SignalDeviceRegistry {
  private refreshRequests: ReadonlyMap<string, number> = new Map();

  private constructor(
    readonly generation: number,
    private proofs: SignalAccountProofRegistry,
  ) {}

  static create(
    generation: number,
    configs: readonly SignalConfig[],
  ): Result<SignalDeviceRegistry, SignalDeviceError> {
    const accounts = configs.map((config) => config.accountUuid);
    if (new Set(accounts).size !== accounts.length)
      return err(new SignalDeviceError('DUPLICATE_ACCOUNT'));
    const proofs = Object.freeze(
      configs.map(
        (config): SignalAccountProofSnapshot =>
          Object.freeze({
            accountUuid: config.accountUuid,
            accountMode: config.accountMode,
            bridgeDeviceId: config.deviceId,
            generation,
            status: 'unverified',
          }),
      ),
    );
    return ok(new SignalDeviceRegistry(generation, proofs));
  }

  snapshot(): SignalAccountProofRegistry {
    return this.proofs;
  }

  /** Coalesce advisory requests across receivers. The injected owner still enforces the
   * persisted start budget, in-flight checks and server pauses; this never grants proof. */
  requestRefresh(accountUuid: string, now: number, request: (accountUuid: string) => void): void {
    const owner = this.proofs.find((proof) => proof.accountUuid === accountUuid);
    if (!owner || owner.accountMode !== 'personal') return;
    const last = this.refreshRequests.get(accountUuid);
    if (last !== undefined && now - last < 60_000) return;
    this.refreshRequests = new Map([...this.refreshRequests, [accountUuid, now]]);
    request(accountUuid);
  }

  publish(proof: SignalAccountProofSnapshot): Result<void, SignalDeviceError> {
    const current = this.proofs.find((entry) => entry.accountUuid === proof.accountUuid);
    if (proof.generation !== this.generation || !current)
      return err(new SignalDeviceError('STALE_GENERATION'));
    if (
      current.accountMode !== proof.accountMode ||
      current.bridgeDeviceId !== proof.bridgeDeviceId ||
      normalizeSignalUuid(proof.accountUuid).isErr()
    )
      return err(new SignalDeviceError('DEVICE_METADATA_INVALID'));
    const frozen: SignalAccountProofSnapshot =
      proof.status === 'verified'
        ? Object.freeze({
            ...proof,
            humanDevices: Object.freeze(
              proof.humanDevices.map((device) => Object.freeze({ ...device })),
            ),
          })
        : Object.freeze({ ...proof });
    this.proofs = Object.freeze(
      this.proofs.map((entry) => (entry.accountUuid === proof.accountUuid ? frozen : entry)),
    );
    return ok(undefined);
  }

  invalidate(accountUuid: string): void {
    this.proofs = Object.freeze(
      this.proofs.map(
        (proof): SignalAccountProofSnapshot =>
          proof.accountUuid === accountUuid
            ? Object.freeze({
                accountUuid: proof.accountUuid,
                accountMode: proof.accountMode,
                bridgeDeviceId: proof.bridgeDeviceId,
                generation: this.generation,
                status: 'unverified',
              })
            : proof,
      ),
    );
  }
}
