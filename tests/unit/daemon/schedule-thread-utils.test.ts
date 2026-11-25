import { describe, it, expect } from 'vitest';
import {
  readScheduleOriginExternalId,
  resolveThreadRecipient,
} from '../../../src/daemon/schedule-thread-utils.js';

const scheduleMetadata = (originExternalId: unknown): string =>
  JSON.stringify({ kind: 'schedule', originExternalId });

describe('readScheduleOriginExternalId', () => {
  it('returns the origin of a schedule thread', () => {
    expect(readScheduleOriginExternalId(scheduleMetadata('74575531'))).toBe('74575531');
  });

  it.each([null, undefined, '', '{}', 'not json', JSON.stringify({ originExternalId: '1' })])(
    'returns null for %j',
    (metadata) => {
      expect(readScheduleOriginExternalId(metadata)).toBeNull();
    },
  );
});

describe('resolveThreadRecipient', () => {
  it('uses a live conversation thread as its own recipient', () => {
    expect(resolveThreadRecipient({ external_id: '74575531', metadata: '{}' })).toBe('74575531');
    expect(resolveThreadRecipient({ external_id: '-1004452318413:42', metadata: null })).toBe(
      '-1004452318413:42',
    );
  });

  it('uses the origin chat of a schedule thread, including the topic', () => {
    expect(
      resolveThreadRecipient({
        external_id: 'schedule:assistant:TalonMain:-1004452318413:42',
        metadata: scheduleMetadata('-1004452318413:42'),
      }),
    ).toBe('-1004452318413:42');
  });

  it('has no recipient for a schedule thread without an origin', () => {
    // The thread from the reported log line: created without an origin chat.
    expect(
      resolveThreadRecipient({ external_id: 'schedule:assistant:TalonMain', metadata: '{}' }),
    ).toBeNull();
    expect(
      resolveThreadRecipient({ external_id: 'schedule:assistant:TalonMain', metadata: undefined }),
    ).toBeNull();
  });

  it('has no recipient when the recorded origin is itself synthetic', () => {
    expect(
      resolveThreadRecipient({
        external_id: 'schedule:assistant:TalonMain:schedule:assistant:TalonMain',
        metadata: scheduleMetadata('schedule:assistant:TalonMain'),
      }),
    ).toBeNull();
  });
});
