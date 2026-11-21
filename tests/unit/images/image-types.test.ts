/**
 * Contract tests for the shared Image vocabulary and the `ImageAccess` port.
 *
 * Expectations here are literal on purpose: the closed state and reason lists
 * are written out in full rather than derived from the exported constants, so
 * adding, renaming, or reordering a value in `src/images/image-types.ts` fails
 * these tests instead of being silently mirrored.
 *
 * Several assertions are compile-time (type-level). `npm run build` excludes
 * tests and Vitest strips types without checking them, so this suite enforces
 * them itself: the 'compile-time pins are enforced' block at the bottom runs
 * exactly the documented typecheck command and fails when it reports anything:
 *   node node_modules/typescript/bin/tsc --noEmit --strict --target ES2022 \
 *     --module Node16 --moduleResolution Node16 --skipLibCheck \
 *     --esModuleInterop tests/unit/images/image-types.test.ts
 *
 * That enforcement is proven red/green by temporary source mutations:
 * a field added to a single descriptor arm, and a corrupted approved-field
 * list, each make the suite fail; both were reverted.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ok, err, type Result } from '../../../src/core/types/result.js';
import {
  IMAGE_STATES,
  IMAGE_REJECTION_REASONS,
  IMAGE_UNAVAILABILITY_REASONS,
  type ImageState,
  type ImageRejectionReason,
  type ImageUnavailabilityReason,
  type ImageDimensions,
  type ImageGpsMetadata,
  type ImageGpsAltitudeRef,
  type ImageExifMetadata,
  type ImageDescriptor,
  type ImageAvailability,
  type ImageInspectionBytes,
  type ImageAccessError,
  type ImageAccessRequest,
  type ImageAccess,
} from '../../../src/images/image-types.js';
import type {
  Attachment,
  InboundAttachment,
  InboundAttachmentRejection,
  InboundEvent,
} from '../../../src/channels/channel-types.js';

// ---------------------------------------------------------------------------
// Compile-time helpers
// ---------------------------------------------------------------------------

/** Exact type equality (not mutual assignability). */
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/** Fails to compile unless the argument type is exactly `true`. */
type Assert<T extends true> = T;

/** Anything that can hold pixel bytes. */
type ByteLike = Buffer | Uint8Array | ArrayBuffer | DataView;

/** Repository root, resolved from this file at tests/unit/images/<name>.ts. */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** The documented typecheck of this file, kept argument-for-argument. */
const TYPECHECK_ARGV = [
  'node_modules/typescript/bin/tsc',
  '--noEmit',
  '--strict',
  '--target',
  'ES2022',
  '--module',
  'Node16',
  '--moduleResolution',
  'Node16',
  '--skipLibCheck',
  '--esModuleInterop',
  'tests/unit/images/image-types.test.ts',
] as const;

/** True when any field of a DTO (recursively) is byte-bearing. */
type ContainsBytes<T> = [T] extends [never]
  ? false
  : T extends ByteLike
    ? true
    : T extends (...args: never[]) => unknown
      ? false
      : T extends object
        ? true extends { [K in keyof T]-?: ContainsBytes<T[K]> }[keyof T]
          ? true
          : false
        : false;

type DescriptorCarriesNoBytes = ContainsBytes<ImageDescriptor> extends false ? true : false;
type ExifCarriesNoBytes = ContainsBytes<ImageExifMetadata> extends false ? true : false;
type AvailabilityCarriesNoBytes = ContainsBytes<ImageAvailability> extends false ? true : false;
type AccessErrorCarriesNoBytes = ContainsBytes<ImageAccessError> extends false ? true : false;
type InboundRejectionCarriesNoBytes =
  ContainsBytes<InboundAttachmentRejection> extends false ? true : false;

/**
 * Union of the key sets of every union arm. Unlike `keyof T`, which resolves to
 * the INTERSECTION of the arms' keys and therefore hides a field that exists on
 * only one arm, this distributes: a field added to a single arm appears.
 */
type AnyArmKey<T> = T extends unknown ? keyof T : never;

/** True only when every arm's key set is exactly `Approved` (no extra, no gap). */
type EveryArmKeysEqual<T, Approved extends PropertyKey> = (
  T extends unknown ? Equals<keyof T, Approved> : never
) extends true
  ? true
  : false;

/**
 * Exact field-set pins. Because these DTOs are closed object types, a new
 * field — including one that could hold a local path, staging reference, or
 * credential — fails to compile until this list is deliberately widened.
 *
 * `keyof` over a union is the INTERSECTION of the arm keys, so
 * `DescriptorFieldsPin` alone would miss a field that exists on only one arm.
 * `DescriptorAnyArmFieldsPin` (distributive union of keys) and
 * `DescriptorPerArmFieldsPin` (every arm's key set must match exactly) close
 * that hole, and the same distributive/arm pins guard availability and errors.
 */
type DimensionsFieldsPin = Assert<Equals<keyof ImageDimensions, 'width' | 'height'>>;
type GpsFieldsPin = Assert<
  Equals<keyof ImageGpsMetadata, 'latitude' | 'longitude' | 'altitude' | 'altitudeRef'>
>;
type ExifFieldsPin = Assert<
  Equals<
    keyof ImageExifMetadata,
    'gps' | 'capturedAt' | 'capturedAtOffset' | 'cameraMake' | 'cameraModel' | 'orientation'
  >
>;
/** Every approved descriptor field name, spelled out once. */
type ApprovedDescriptorFields =
  | 'imageId'
  | 'threadId'
  | 'messageId'
  | 'ordinal'
  | 'receivedAt'
  | 'expiresAt'
  | 'filename'
  | 'mimeType'
  | 'dimensions'
  | 'exif'
  | 'state'
  | 'rejectionReason'
  | 'unavailabilityReason';

/** Shared/base fields present on all arms (catches additions to the base). */
type DescriptorFieldsPin = Assert<Equals<keyof ImageDescriptor, ApprovedDescriptorFields>>;
/** Union across arms (catches additions to any single arm, and removals). */
type DescriptorAnyArmFieldsPin = Assert<
  Equals<AnyArmKey<ImageDescriptor>, ApprovedDescriptorFields>
>;
/** Per-arm: no arm may carry a field outside the approved set. */
type DescriptorPerArmFieldsPin = Assert<
  EveryArmKeysEqual<ImageDescriptor, ApprovedDescriptorFields>
>;

/** Every approved availability field name across all four arms. */
type ApprovedAvailabilityFields =
  | 'state'
  | 'available'
  | 'expiresAt'
  | 'rejectionReason'
  | 'unavailabilityReason';

type AvailabilityFieldsPin = Assert<
  Equals<AnyArmKey<ImageAvailability>, ApprovedAvailabilityFields>
>;
type AvailableArmPin = Assert<
  Equals<
    Extract<ImageAvailability, { state: 'available' }>,
    { state: 'available'; available: true; expiresAt: number }
  >
>;
type ProcessingArmPin = Assert<
  Equals<
    Extract<ImageAvailability, { state: 'processing' }>,
    { state: 'processing'; available: false }
  >
>;
type RejectedArmPin = Assert<
  Equals<
    Extract<ImageAvailability, { state: 'rejected' }>,
    { state: 'rejected'; available: false; rejectionReason: ImageRejectionReason }
  >
>;
type UnavailableArmPin = Assert<
  Equals<
    Extract<ImageAvailability, { state: 'unavailable' }>,
    { state: 'unavailable'; available: false; unavailabilityReason: ImageUnavailabilityReason }
  >
>;

/** Every approved ImageAccessError field name across all five variants. */
type ApprovedAccessErrorFields = 'code' | 'message' | 'rejectionReason' | 'unavailabilityReason';

type AccessErrorFieldsPin = Assert<Equals<AnyArmKey<ImageAccessError>, ApprovedAccessErrorFields>>;
type NotFoundErrorArmPin = Assert<
  Equals<Extract<ImageAccessError, { code: 'not_found' }>, { code: 'not_found'; message?: string }>
>;
type ProcessingErrorArmPin = Assert<
  Equals<
    Extract<ImageAccessError, { code: 'processing' }>,
    { code: 'processing'; message?: string }
  >
>;
type RejectedErrorArmPin = Assert<
  Equals<
    Extract<ImageAccessError, { code: 'rejected' }>,
    { code: 'rejected'; rejectionReason: ImageRejectionReason }
  >
>;
type UnavailableErrorArmPin = Assert<
  Equals<
    Extract<ImageAccessError, { code: 'unavailable' }>,
    { code: 'unavailable'; unavailabilityReason: ImageUnavailabilityReason }
  >
>;
type StorageErrorArmPin = Assert<
  Equals<
    Extract<ImageAccessError, { code: 'storage_failed' }>,
    { code: 'storage_failed'; message: string }
  >
>;
type InboundRejectionFieldsPin = Assert<
  Equals<
    keyof InboundAttachmentRejection,
    'kind' | 'rejectionReason' | 'filename' | 'mimeType' | 'size' | 'sourcePosition'
  >
>;
/** Negative control: the byte detector does flag a byte-bearing DTO. */
type InspectionBytesAreDetected = ContainsBytes<ImageInspectionBytes> extends true ? true : false;

// ---------------------------------------------------------------------------
// Closed lists
// ---------------------------------------------------------------------------

describe('closed Image state and reason lists', () => {
  it('exports exactly the four approved states in order', () => {
    expect([...IMAGE_STATES]).toEqual(['processing', 'available', 'rejected', 'unavailable']);
    expect(IMAGE_STATES).toHaveLength(4);
  });

  it('exports exactly the eight approved rejection reasons in order', () => {
    expect([...IMAGE_REJECTION_REASONS]).toEqual([
      'unsupported_mime',
      'count_limit',
      'size_limit',
      'animated',
      'download_failed',
      'conversion_failed',
      'processing_interrupted',
      'processing_failed',
    ]);
    expect(IMAGE_REJECTION_REASONS).toHaveLength(8);
  });

  it('exports exactly the two approved unavailability reasons in order', () => {
    expect([...IMAGE_UNAVAILABILITY_REASONS]).toEqual(['expired', 'file_missing']);
    expect(IMAGE_UNAVAILABILITY_REASONS).toHaveLength(2);
  });

  it('keeps the three lists disjoint', () => {
    const states = new Set<string>(IMAGE_STATES);
    for (const reason of IMAGE_REJECTION_REASONS) {
      expect(states.has(reason)).toBe(false);
    }
    for (const reason of IMAGE_UNAVAILABILITY_REASONS) {
      expect(states.has(reason)).toBe(false);
    }
    expect(new Set<string>(IMAGE_REJECTION_REASONS).size).toBe(8);
    expect(new Set<string>(IMAGE_UNAVAILABILITY_REASONS).size).toBe(2);
  });

  it('freezes every exported list', () => {
    expect(Object.isFrozen(IMAGE_STATES)).toBe(true);
    expect(Object.isFrozen(IMAGE_REJECTION_REASONS)).toBe(true);
    expect(Object.isFrozen(IMAGE_UNAVAILABILITY_REASONS)).toBe(true);
  });

  it('types the unions exactly (compile-time pins)', () => {
    type StatePin = Assert<
      Equals<ImageState, 'processing' | 'available' | 'rejected' | 'unavailable'>
    >;
    type RejectionPin = Assert<
      Equals<
        ImageRejectionReason,
        | 'unsupported_mime'
        | 'count_limit'
        | 'size_limit'
        | 'animated'
        | 'download_failed'
        | 'conversion_failed'
        | 'processing_interrupted'
        | 'processing_failed'
      >
    >;
    type UnavailabilityPin = Assert<Equals<ImageUnavailabilityReason, 'expired' | 'file_missing'>>;
    type AltitudeRefPin = Assert<Equals<ImageGpsAltitudeRef, 'aboveSeaLevel' | 'belowSeaLevel'>>;

    const pins: [StatePin, RejectionPin, UnavailabilityPin, AltitudeRefPin] = [
      true,
      true,
      true,
      true,
    ];
    expect(pins).toEqual([true, true, true, true]);
  });

  it('rejects invented reasons and states at compile time', () => {
    // @ts-expect-error connector-specific rejection reasons are not permitted
    const connectorReason: ImageRejectionReason = 'telegram_timeout';
    // @ts-expect-error "expired" is an unavailability reason, not a state
    const expiredState: ImageState = 'expired';
    // @ts-expect-error "cancelled" is not an Image state
    const cancelledState: ImageState = 'cancelled';
    // @ts-expect-error a third unavailability reason does not exist
    const thirdReason: ImageUnavailabilityReason = 'quarantined';

    expect([connectorReason, expiredState, cancelledState, thirdReason]).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// Metadata DTOs and descriptors
// ---------------------------------------------------------------------------

const SAMPLE_EXIF: ImageExifMetadata = {
  gps: { latitude: 52.3702, longitude: 4.8952, altitude: -4.2, altitudeRef: 'belowSeaLevel' },
  capturedAt: '2026-03-01 09:15:23',
  capturedAtOffset: '+01:00',
  cameraMake: 'Canon',
  cameraModel: 'EOS R5',
  orientation: 6,
};

const SAMPLE_DIMENSIONS: ImageDimensions = { width: 4000, height: 3000 };

const DESCRIPTOR_BASE = {
  imageId: 'img_01',
  threadId: 'thr_01',
  messageId: 'msg_01',
  ordinal: 0,
  receivedAt: 1_770_000_000_000,
  expiresAt: 1_770_086_400_000,
  filename: 'IMG_0001.CR3.jpg',
  mimeType: 'image/jpeg',
  dimensions: SAMPLE_DIMENSIONS,
  exif: SAMPLE_EXIF,
} as const;

describe('Image descriptor DTOs', () => {
  it('describes an Available Image without a reason', () => {
    const available: ImageDescriptor = { ...DESCRIPTOR_BASE, state: 'available' };
    const processing: ImageDescriptor = { ...DESCRIPTOR_BASE, state: 'processing' };

    expect(available.state).toBe('available');
    expect(processing.state).toBe('processing');
    expect(available.receivedAt).toBe(1_770_000_000_000);
    expect(available.expiresAt).toBe(1_770_086_400_000);
    expect(available.ordinal).toBe(0);
    expect(available.exif?.gps).toEqual({
      latitude: 52.3702,
      longitude: 4.8952,
      altitude: -4.2,
      altitudeRef: 'belowSeaLevel',
    });
    // Capture time stays a plain string pair; no timezone is invented.
    expect(available.exif?.capturedAt).toBe('2026-03-01 09:15:23');
    expect(available.exif?.capturedAtOffset).toBe('+01:00');
    expect(available.exif?.orientation).toBe(6);
  });

  it('omits unknown metadata instead of inventing it', () => {
    const sparse: ImageDescriptor = {
      imageId: 'img_02',
      threadId: 'thr_01',
      messageId: 'msg_02',
      ordinal: 2,
      receivedAt: 1_770_000_000_000,
      expiresAt: 1_770_086_400_000,
      state: 'available',
    };

    expect(sparse.ordinal).toBe(2);
    expect(sparse.filename).toBeUndefined();
    expect(sparse.mimeType).toBeUndefined();
    expect(sparse.dimensions).toBeUndefined();
    expect(sparse.exif).toBeUndefined();
    expect(Object.keys(sparse.exif ?? {})).toEqual([]);
  });

  it('carries exactly one reason in each terminal state', () => {
    const rejected: ImageDescriptor = {
      ...DESCRIPTOR_BASE,
      state: 'rejected',
      rejectionReason: 'unsupported_mime',
    };
    const unavailable: ImageDescriptor = {
      ...DESCRIPTOR_BASE,
      state: 'unavailable',
      unavailabilityReason: 'expired',
    };

    expect(rejected.state).toBe('rejected');
    expect(rejected.rejectionReason).toBe('unsupported_mime');
    expect(rejected.unavailabilityReason).toBeUndefined();
    expect(unavailable.state).toBe('unavailable');
    expect(unavailable.unavailabilityReason).toBe('expired');
    expect(unavailable.rejectionReason).toBeUndefined();
  });

  it('forbids mismatched or missing reasons at compile time', () => {
    // Shapes are `as const` so the only remaining error is the intended one.
    const rejectedShape = { ...DESCRIPTOR_BASE, state: 'rejected' } as const;
    const unavailableShape = { ...DESCRIPTOR_BASE, state: 'unavailable' } as const;
    const availableWithReasonShape = {
      ...DESCRIPTOR_BASE,
      state: 'available',
      rejectionReason: 'size_limit',
    } as const;
    const bothReasonsShape = {
      ...DESCRIPTOR_BASE,
      state: 'unavailable',
      unavailabilityReason: 'file_missing',
      rejectionReason: 'animated',
    } as const;

    // @ts-expect-error a Rejected descriptor must carry a rejection reason
    const rejectedWithoutReason: ImageDescriptor = rejectedShape;
    // @ts-expect-error an Unavailable descriptor must carry an unavailability reason
    const unavailableWithoutReason: ImageDescriptor = unavailableShape;
    // @ts-expect-error an Available descriptor carries no reason
    const availableWithReason: ImageDescriptor = availableWithReasonShape;
    // @ts-expect-error rejection and unavailability reasons are mutually exclusive
    const bothReasons: ImageDescriptor = bothReasonsShape;

    const withPixels: ImageDescriptor = {
      ...DESCRIPTOR_BASE,
      state: 'available',
      // @ts-expect-error descriptors carry no pixel payload field
      bytes: Buffer.from(''),
    };
    const withPath: ImageDescriptor = {
      ...DESCRIPTOR_BASE,
      state: 'available',
      // @ts-expect-error descriptors carry no local path or staging reference
      path: '/data/threads/thr_01/attachments/images/img_01.jpg',
    };
    // @ts-expect-error a payload Attachment is not an Image descriptor
    const payloadAsDescriptor: ImageDescriptor = PAYLOAD_ATTACHMENT;

    expect([
      rejectedWithoutReason,
      unavailableWithoutReason,
      availableWithReason,
      bothReasons,
      withPixels,
      withPath,
      payloadAsDescriptor,
    ]).toHaveLength(7);
  });

  it('exposes no metadata field that could hold a path or credential', () => {
    const fieldPins: [
      DimensionsFieldsPin,
      GpsFieldsPin,
      ExifFieldsPin,
      DescriptorFieldsPin,
      DescriptorAnyArmFieldsPin,
      DescriptorPerArmFieldsPin,
      InboundRejectionFieldsPin,
    ] = [true, true, true, true, true, true, true];
    const descriptorKeys = Object.keys(DESCRIPTOR_BASE).sort();

    expect(descriptorKeys).toEqual([
      'dimensions',
      'exif',
      'expiresAt',
      'filename',
      'imageId',
      'messageId',
      'mimeType',
      'ordinal',
      'receivedAt',
      'threadId',
    ]);
    expect(Object.keys(SAMPLE_EXIF).sort()).toEqual([
      'cameraMake',
      'cameraModel',
      'capturedAt',
      'capturedAtOffset',
      'gps',
      'orientation',
    ]);
    expect(Object.keys(SAMPLE_DIMENSIONS).sort()).toEqual(['height', 'width']);
    expect(fieldPins).toEqual([true, true, true, true, true, true, true]);
  });

  it('pins each union arm of availability and access errors separately', () => {
    const armPins: [
      AvailabilityFieldsPin,
      AvailableArmPin,
      ProcessingArmPin,
      RejectedArmPin,
      UnavailableArmPin,
      AccessErrorFieldsPin,
      NotFoundErrorArmPin,
      ProcessingErrorArmPin,
      RejectedErrorArmPin,
      UnavailableErrorArmPin,
      StorageErrorArmPin,
    ] = [true, true, true, true, true, true, true, true, true, true, true];

    expect(armPins).toEqual([true, true, true, true, true, true, true, true, true, true, true]);
  });

  it('carries no bytes anywhere in the descriptor DTO types (compile-time)', () => {
    const noBytes: [
      DescriptorCarriesNoBytes,
      ExifCarriesNoBytes,
      AvailabilityCarriesNoBytes,
      AccessErrorCarriesNoBytes,
      InboundRejectionCarriesNoBytes,
    ] = [true, true, true, true, true];
    // The only byte-bearing shape in the vocabulary is the Inspection payload.
    const control: InspectionBytesAreDetected = true;

    expect(noBytes).toEqual([true, true, true, true, true]);
    expect(control).toBe(true);
  });

  it('carries no bytes in a fully populated descriptor (runtime walk)', () => {
    const seen: string[] = [];
    const walk = (value: unknown, path: string): void => {
      if (value === null || value === undefined) {
        return;
      }
      if (Buffer.isBuffer(value) || value instanceof ArrayBuffer || value instanceof Uint8Array) {
        seen.push(path);
        return;
      }
      if (Array.isArray(value)) {
        value.forEach((item, index) => walk(item, `${path}[${index}]`));
        return;
      }
      if (typeof value === 'object') {
        for (const [key, nested] of Object.entries(value)) {
          walk(nested, `${path}.${key}`);
        }
      }
    };

    const rejected: ImageDescriptor = {
      ...DESCRIPTOR_BASE,
      state: 'rejected',
      rejectionReason: 'animated',
    };
    walk(rejected, 'descriptor');

    expect(seen).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// ImageAccess port — deterministic fake
// ---------------------------------------------------------------------------

interface FakeStoredImage {
  descriptor: ImageDescriptor;
  /** Normalized file contents; absent models a missing file. */
  normalized: Buffer | undefined;
}

/**
 * Deterministic in-memory `ImageAccess` used as the consumer-side fixture for
 * the port. The real adapter is supplied by the storage task; this fake pins
 * the outcome shapes every consumer relies on.
 */
class FakeImageAccess implements ImageAccess {
  private readonly images = new Map<string, FakeStoredImage>();

  constructor(private readonly now: () => number) {}

  put(entry: FakeStoredImage): void {
    this.images.set(entry.descriptor.imageId, entry);
  }

  async resolveImage(
    request: ImageAccessRequest,
  ): Promise<Result<ImageDescriptor, ImageAccessError>> {
    const found = this.lookup(request);
    if (!found) {
      return err({ code: 'not_found' });
    }
    return ok(found.descriptor);
  }

  async getAvailability(
    request: ImageAccessRequest,
  ): Promise<Result<ImageAvailability, ImageAccessError>> {
    const found = this.lookup(request);
    if (!found) {
      return err({ code: 'not_found' });
    }

    const { descriptor, normalized } = found;
    if (descriptor.state === 'processing') {
      return ok({ state: 'processing', available: false });
    }
    if (descriptor.state === 'rejected') {
      return ok({
        state: 'rejected',
        available: false,
        rejectionReason: descriptor.rejectionReason,
      });
    }
    if (descriptor.state === 'unavailable') {
      return ok({
        state: 'unavailable',
        available: false,
        unavailabilityReason: descriptor.unavailabilityReason,
      });
    }

    if (descriptor.expiresAt <= this.now()) {
      return ok({ state: 'unavailable', available: false, unavailabilityReason: 'expired' });
    }
    if (normalized === undefined) {
      return ok({ state: 'unavailable', available: false, unavailabilityReason: 'file_missing' });
    }
    return ok({ state: 'available', available: true, expiresAt: descriptor.expiresAt });
  }

  async fetchInspectionBytes(
    request: ImageAccessRequest,
  ): Promise<Result<ImageInspectionBytes, ImageAccessError>> {
    const found = this.lookup(request);
    if (!found) {
      return err({ code: 'not_found' });
    }

    const { descriptor, normalized } = found;

    if (descriptor.state === 'processing') {
      return err({ code: 'processing' });
    }
    if (descriptor.state === 'rejected') {
      return err({ code: 'rejected', rejectionReason: descriptor.rejectionReason });
    }
    if (descriptor.state === 'unavailable') {
      return err({ code: 'unavailable', unavailabilityReason: descriptor.unavailabilityReason });
    }
    // Expiry takes precedence over a missing file.
    if (descriptor.expiresAt <= this.now()) {
      return err({ code: 'unavailable', unavailabilityReason: 'expired' });
    }
    if (normalized === undefined) {
      return err({ code: 'unavailable', unavailabilityReason: 'file_missing' });
    }

    return ok({
      imageId: descriptor.imageId,
      bytes: normalized,
      mimeType: 'image/jpeg',
      expiresAt: descriptor.expiresAt,
    });
  }

  private lookup(request: ImageAccessRequest): FakeStoredImage | undefined {
    const found = this.images.get(request.imageId);
    // Cross-thread IDs are indistinguishable from unknown ones.
    if (!found || found.descriptor.threadId !== request.threadId) {
      return undefined;
    }
    return found;
  }
}

const CLOCK = 1_770_043_200_000; // between receivedAt and expiresAt of DESCRIPTOR_BASE

function fakeWith(
  descriptor: ImageDescriptor,
  normalized: Buffer = Buffer.from('fake-jpeg-bytes'),
): FakeImageAccess {
  const access = new FakeImageAccess(() => CLOCK);
  access.put({ descriptor, normalized });
  return access;
}

/** An Available Image whose Normalized file is gone. */
function fakeWithMissingFile(descriptor: ImageDescriptor): FakeImageAccess {
  const access = new FakeImageAccess(() => CLOCK);
  access.put({ descriptor, normalized: undefined });
  return access;
}

function emptyAccess(): ImageAccess {
  return new FakeImageAccess(() => CLOCK);
}

describe('ImageAccess port', () => {
  it('resolves a current-thread descriptor', async () => {
    const access = fakeWith({ ...DESCRIPTOR_BASE, state: 'available' });

    const result = await access.resolveImage({ threadId: 'thr_01', imageId: 'img_01' });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toEqual({ ...DESCRIPTOR_BASE, state: 'available' });
    }
  });

  it('reports an unknown Image ID and a cross-thread Image ID identically', async () => {
    const access = fakeWith({ ...DESCRIPTOR_BASE, state: 'available' });

    const unknown = await access.resolveImage({ threadId: 'thr_01', imageId: 'img_other' });
    const crossThread = await access.resolveImage({ threadId: 'thr_02', imageId: 'img_01' });

    expect(unknown.isErr()).toBe(true);
    expect(crossThread.isErr()).toBe(true);
    if (unknown.isErr() && crossThread.isErr()) {
      expect(unknown.error).toEqual({ code: 'not_found' });
      expect(crossThread.error).toEqual(unknown.error);
    }
  });

  it('reports availability per state without treating terminal states as errors', async () => {
    const processing = await fakeWith({ ...DESCRIPTOR_BASE, state: 'processing' }).getAvailability({
      threadId: 'thr_01',
      imageId: 'img_01',
    });
    expect(processing.isOk()).toBe(true);
    if (processing.isOk()) {
      expect(processing.value).toEqual({ state: 'processing', available: false });
    }

    const rejected = await fakeWith({
      ...DESCRIPTOR_BASE,
      state: 'rejected',
      rejectionReason: 'count_limit',
    }).getAvailability({ threadId: 'thr_01', imageId: 'img_01' });
    expect(rejected.isOk()).toBe(true);
    if (rejected.isOk()) {
      expect(rejected.value).toEqual({
        state: 'rejected',
        available: false,
        rejectionReason: 'count_limit',
      });
    }

    const expired = await fakeWith({
      ...DESCRIPTOR_BASE,
      state: 'unavailable',
      unavailabilityReason: 'expired',
    }).getAvailability({ threadId: 'thr_01', imageId: 'img_01' });
    expect(expired.isOk()).toBe(true);
    if (expired.isOk()) {
      expect(expired.value).toEqual({
        state: 'unavailable',
        available: false,
        unavailabilityReason: 'expired',
      });
    }
  });

  it('applies expiry and missing-file rules to an Available Image', async () => {
    const live = fakeWith({ ...DESCRIPTOR_BASE, state: 'available' });
    const liveResult = await live.getAvailability({ threadId: 'thr_01', imageId: 'img_01' });
    expect(liveResult.isOk()).toBe(true);
    if (liveResult.isOk()) {
      expect(liveResult.value).toEqual({
        state: 'available',
        available: true,
        expiresAt: DESCRIPTOR_BASE.expiresAt,
      });
    }

    const missingFile = fakeWithMissingFile({ ...DESCRIPTOR_BASE, state: 'available' });
    const missingResult = await missingFile.getAvailability({
      threadId: 'thr_01',
      imageId: 'img_01',
    });
    expect(missingResult.isOk()).toBe(true);
    if (missingResult.isOk()) {
      expect(missingResult.value).toEqual({
        state: 'unavailable',
        available: false,
        unavailabilityReason: 'file_missing',
      });
    }

    const expiredRecord = fakeWith({
      ...DESCRIPTOR_BASE,
      state: 'available',
      expiresAt: CLOCK - 1,
    });
    const expiredResult = await expiredRecord.getAvailability({
      threadId: 'thr_01',
      imageId: 'img_01',
    });
    expect(expiredResult.isOk()).toBe(true);
    if (expiredResult.isOk()) {
      expect(expiredResult.value).toEqual({
        state: 'unavailable',
        available: false,
        unavailabilityReason: 'expired',
      });
    }
  });

  it('returns normalized bytes only for an inspectable Image', async () => {
    const access = fakeWith({ ...DESCRIPTOR_BASE, state: 'available' });

    const result = await access.fetchInspectionBytes({ threadId: 'thr_01', imageId: 'img_01' });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.mimeType).toBe('image/jpeg');
      expect(result.value.imageId).toBe('img_01');
      expect(result.value.expiresAt).toBe(DESCRIPTOR_BASE.expiresAt);
      expect(Buffer.isBuffer(result.value.bytes)).toBe(true);
      expect(result.value.bytes.toString()).toBe('fake-jpeg-bytes');
    }
  });

  it('refuses Inspection bytes with the matching closed reason', async () => {
    const processing = await fakeWith({
      ...DESCRIPTOR_BASE,
      state: 'processing',
    }).fetchInspectionBytes({ threadId: 'thr_01', imageId: 'img_01' });
    expect(processing.isErr()).toBe(true);
    if (processing.isErr()) {
      expect(processing.error).toEqual({ code: 'processing' });
    }

    const rejected = await fakeWith({
      ...DESCRIPTOR_BASE,
      state: 'rejected',
      rejectionReason: 'conversion_failed',
    }).fetchInspectionBytes({ threadId: 'thr_01', imageId: 'img_01' });
    expect(rejected.isErr()).toBe(true);
    if (rejected.isErr()) {
      expect(rejected.error).toEqual({ code: 'rejected', rejectionReason: 'conversion_failed' });
    }

    const fileMissing = await fakeWithMissingFile({
      ...DESCRIPTOR_BASE,
      state: 'available',
    }).fetchInspectionBytes({ threadId: 'thr_01', imageId: 'img_01' });
    expect(fileMissing.isErr()).toBe(true);
    if (fileMissing.isErr()) {
      expect(fileMissing.error).toEqual({
        code: 'unavailable',
        unavailabilityReason: 'file_missing',
      });
    }

    const expired = await fakeWithMissingFile({
      ...DESCRIPTOR_BASE,
      state: 'available',
      expiresAt: CLOCK - 1,
    }).fetchInspectionBytes({ threadId: 'thr_01', imageId: 'img_01' });
    expect(expired.isErr()).toBe(true);
    if (expired.isErr()) {
      expect(expired.error).toEqual({ code: 'unavailable', unavailabilityReason: 'expired' });
    }

    const unknown = await emptyAccess().fetchInspectionBytes({
      threadId: 'thr_01',
      imageId: 'img_missing',
    });
    expect(unknown.isErr()).toBe(true);
    if (unknown.isErr()) {
      expect(unknown.error).toEqual({ code: 'not_found' });
    }
  });

  it('accepts a bare object implementing the port (structural conformance)', async () => {
    const stub: ImageAccess = {
      async resolveImage(): Promise<Result<ImageDescriptor, ImageAccessError>> {
        return err({ code: 'storage_failed', message: 'not wired yet' });
      },
      async getAvailability(): Promise<Result<ImageAvailability, ImageAccessError>> {
        return err({ code: 'storage_failed', message: 'not wired yet' });
      },
      async fetchInspectionBytes(): Promise<Result<ImageInspectionBytes, ImageAccessError>> {
        return err({ code: 'storage_failed', message: 'not wired yet' });
      },
    };

    const result = await stub.resolveImage({ threadId: 'thr_01', imageId: 'img_01' });
    expect(result.isErr()).toBe(true);
    if (result.isErr() && result.error.code === 'storage_failed') {
      // Storage errors are operator-facing text, never pixels or paths.
      expect(result.error.message).toBe('not wired yet');
    } else {
      expect.unreachable('expected a storage_failed error');
    }
  });
});

// ---------------------------------------------------------------------------
// Inbound payload-or-rejection union
// ---------------------------------------------------------------------------

const PAYLOAD_ATTACHMENT: Attachment = {
  filename: 'photo.jpg',
  mimeType: 'image/jpeg',
  data: Buffer.from('bytes'),
  size: 5,
};

const REJECTION: InboundAttachmentRejection = {
  kind: 'rejected',
  rejectionReason: 'count_limit',
  filename: 'second-photo.jpg',
  mimeType: 'image/jpeg',
  size: 20_480,
  sourcePosition: 1,
};

/** Consumers narrow with a single `kind` check and keep payload access. */
function describeInbound(items: InboundAttachment[]): string[] {
  return items.map((item, index) => {
    if ('kind' in item) {
      return `${item.sourcePosition}:${item.rejectionReason}:${item.size ?? 'unknown'}`;
    }
    return `${index}:payload:${item.filename}:${item.size}`;
  });
}

describe('InboundEvent.attachments payload-or-rejection union', () => {
  it('still accepts plain Attachment payloads (backward compatible)', () => {
    const legacy: Attachment[] = [PAYLOAD_ATTACHMENT];
    const event: InboundEvent = {
      channelType: 'telegram',
      channelName: 'main',
      externalThreadId: 'chat-1',
      senderId: 'user-1',
      idempotencyKey: 'update-1',
      content: 'what is in this photo?',
      attachments: legacy,
      timestamp: 1_770_043_200_000,
    };

    expect(event.attachments).toHaveLength(1);
    expect(describeInbound(event.attachments ?? [])).toEqual(['0:payload:photo.jpg:5']);
  });

  it('accepts metadata-only rejections alongside payloads, in source order', () => {
    const event: InboundEvent = {
      channelType: 'email',
      channelName: 'inbox',
      externalThreadId: 'msg-id-1',
      senderId: 'sender@example.com',
      idempotencyKey: 'uidl-1',
      content: '',
      attachments: [
        PAYLOAD_ATTACHMENT,
        REJECTION,
        {
          kind: 'rejected',
          rejectionReason: 'download_failed',
          sourcePosition: 2,
        },
      ],
      timestamp: 1_770_043_200_000,
    };

    expect(describeInbound(event.attachments ?? [])).toEqual([
      '0:payload:photo.jpg:5',
      '1:count_limit:20480',
      '2:download_failed:unknown',
    ]);
  });

  it('carries no bytes, paths, or credentials in a rejection arm', () => {
    expect(Object.keys(REJECTION).sort()).toEqual([
      'filename',
      'kind',
      'mimeType',
      'rejectionReason',
      'size',
      'sourcePosition',
    ]);
    expect(Buffer.isBuffer(REJECTION.size)).toBe(false);
  });

  it('rejects invented reasons, missing order, and payload confusion at compile time', () => {
    const missingPositionShape = { kind: 'rejected', rejectionReason: 'size_limit' } as const;

    // @ts-expect-error source position is required to preserve source order
    const missingPosition: InboundAttachmentRejection = missingPositionShape;
    // @ts-expect-error channel-specific rejection reasons are not permitted
    const inventedReason: ImageRejectionReason = 'gmail_too_big';
    // @ts-expect-error a rejection outcome is not a payload Attachment (no data field)
    const rejectionAsPayload: Attachment = REJECTION;
    // @ts-expect-error a payload Attachment is not a rejection outcome
    const payloadAsRejection: InboundAttachmentRejection = PAYLOAD_ATTACHMENT;
    const withData: InboundAttachmentRejection = {
      kind: 'rejected',
      rejectionReason: 'animated',
      sourcePosition: 0,
      // @ts-expect-error a rejection outcome carries no payload data
      data: Buffer.from(''),
    };

    expect([
      missingPosition,
      inventedReason,
      rejectionAsPayload,
      payloadAsRejection,
      withData,
    ]).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// Enforcement of the compile-time pins
// ---------------------------------------------------------------------------

/**
 * `npm run build` excludes `tests/` and Vitest strips types without checking
 * them, so every `Assert<…>` and `@ts-expect-error` pin above would rot
 * silently on its own. This test runs the documented standalone typecheck of
 * this very file and fails the suite on any diagnostic.
 */
describe('compile-time pins are enforced', () => {
  it('typechecks this file with the documented tsc command', { timeout: 240_000 }, () => {
    const compiler = path.join(REPO_ROOT, 'node_modules/typescript/bin/tsc');
    expect(existsSync(compiler), `missing TypeScript compiler at ${compiler}`).toBe(true);

    let output = '';
    try {
      output = execFileSync(process.execPath, [...TYPECHECK_ARGV], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        timeout: 220_000,
        maxBuffer: 16 * 1024 * 1024,
      });
    } catch (failure) {
      const error = failure as {
        status?: number;
        stdout?: string;
        stderr?: string;
        message?: string;
      };
      const detail =
        [error.stdout, error.stderr].filter(Boolean).join('\n') ||
        error.message ||
        'unknown failure';
      expect.fail(`${TYPECHECK_ARGV.join(' ')} exited ${error.status ?? 'unknown'}:\n${detail}`);
    }

    // tsc is silent when every pin holds.
    expect(output).toBe('');
  });
});
