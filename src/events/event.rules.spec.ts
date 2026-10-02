import { describe, expect, it } from '@jest/globals';
import { getEventState, normalizeEventDefinition } from './event.rules';

const HOST_ID = '11111111-1111-4111-8111-111111111111';
const ROOM_ID = '22222222-2222-4222-8222-222222222222';

describe('Event scheduling rules', () => {
  it('keeps canonical instants with the original IANA timezone and bounded recurrence', () => {
    const event = normalizeEventDefinition({
      hostUserId: HOST_ID,
      title: 'English Coffee Talk',
      languageCode: 'en',
      level: 'B1',
      topic: 'Small talk',
      startAt: at('2026-10-10T02:00:00.000Z'),
      endAt: at('2026-10-10T03:00:00.000Z'),
      timezone: 'Asia/Ho_Chi_Minh',
      capacity: 20,
      visibility: 'PUBLIC',
      venueType: 'SPEAKING_ROOM',
      speakingRoomId: ROOM_ID,
      recurrence: {
        frequency: 'WEEKLY',
        interval: 1,
        count: 4,
        until: null,
        byWeekday: ['MO'],
      },
      createdAt: at('2026-10-01T00:00:00.000Z'),
    });

    expect(event.startAt.toISOString()).toBe('2026-10-10T02:00:00.000Z');
    expect(event.timezone).toBe('Asia/Ho_Chi_Minh');
    expect(event.recurrence).toMatchObject({
      frequency: 'WEEKLY',
      count: 4,
      byWeekday: ['MO'],
    });
  });

  it('rejects invalid timezone, reversed time and unbounded recurrence', () => {
    expect(() =>
      normalizeEventDefinition(baseInput({ timezone: 'Mars/Olympus' })),
    ).toThrow();
    expect(() =>
      normalizeEventDefinition(
        baseInput({ endAt: at('2026-10-09T02:00:00.000Z') }),
      ),
    ).toThrow();
    expect(() =>
      normalizeEventDefinition(
        baseInput({
          recurrence: {
            frequency: 'DAILY',
            interval: 1,
            count: null,
            until: null,
            byWeekday: [],
          },
        }),
      ),
    ).toThrow();
  });

  it('derives cancellation and time-window state from server facts', () => {
    const event = normalizeEventDefinition(baseInput());
    expect(
      getEventState(
        { ...event, status: 'SCHEDULED' },
        at('2026-10-09T01:00:00.000Z'),
      ),
    ).toBe('UPCOMING');
    expect(
      getEventState(
        { ...event, status: 'SCHEDULED' },
        at('2026-10-10T02:30:00.000Z'),
      ),
    ).toBe('LIVE');
    expect(
      getEventState(
        { ...event, status: 'SCHEDULED' },
        at('2026-10-10T04:00:00.000Z'),
      ),
    ).toBe('ENDED');
    expect(
      getEventState(
        { ...event, status: 'CANCELLED' },
        at('2026-10-10T02:30:00.000Z'),
      ),
    ).toBe('CANCELLED');
  });
});

function baseInput(
  overrides: Partial<Parameters<typeof normalizeEventDefinition>[0]> = {},
) {
  return {
    hostUserId: HOST_ID,
    title: 'English Coffee Talk',
    languageCode: 'en',
    level: 'B1',
    topic: 'Small talk',
    startAt: at('2026-10-10T02:00:00.000Z'),
    endAt: at('2026-10-10T03:00:00.000Z'),
    timezone: 'Asia/Ho_Chi_Minh',
    capacity: 20,
    visibility: 'PUBLIC' as const,
    venueType: 'SPEAKING_ROOM' as const,
    speakingRoomId: ROOM_ID,
    recurrence: null,
    createdAt: at('2026-10-01T00:00:00.000Z'),
    ...overrides,
  };
}

function at(value: string): Date {
  return new Date(value);
}
