import {
  decodeLibrarySearchCursor,
  encodeLibrarySearchCursor,
  libraryCursorMicrosFromDate,
} from './library.pagination';

const filters = {
  q: null,
  languageCode: null,
  resourceType: null,
  topic: null,
  cefrLevel: null,
} as const;

describe('library pagination cursors', () => {
  it('round-trips exact PostgreSQL microsecond boundaries without Number conversion', () => {
    const cursor = {
      updatedAtMicros: '1789948800000123',
      id: '00000000-0000-4000-8000-000000000001',
    };

    const encoded = encodeLibrarySearchCursor(cursor, filters);
    const decodedPayload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as {
      v: number;
      updatedAtMicros: string;
    };

    expect(decodedPayload).toMatchObject({
      v: 2,
      updatedAtMicros: cursor.updatedAtMicros,
    });
    expect(decodeLibrarySearchCursor(encoded, filters)).toEqual(cursor);
  });

  it('converts Date boundaries only at millisecond-backed adapter edges', () => {
    expect(libraryCursorMicrosFromDate(new Date('2026-09-21T00:00:00.000Z')))
      .toBe('1789948800000000');
  });

  it.each([
    {
      v: 1,
      updatedAt: '2026-09-21T00:00:00.123Z',
      id: '00000000-0000-4000-8000-000000000001',
    },
    {
      v: 2,
      updatedAtMicros: '1789948800000.123',
      id: '00000000-0000-4000-8000-000000000001',
    },
    {
      v: 2,
      updatedAtMicros: '01789948800000123',
      id: '00000000-0000-4000-8000-000000000001',
    },
  ])('rejects malformed or legacy cursor payloads safely', (payload) => {
    const encoded = Buffer.from(JSON.stringify({
      ...payload,
      filters: 'not-the-current-filter-fingerprint',
    })).toString('base64url');

    expect(() => decodeLibrarySearchCursor(encoded, filters))
      .toThrow('LIBRARY_INVALID_CURSOR');
  });
});
