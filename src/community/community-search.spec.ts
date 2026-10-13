import { describe, expect, it } from '@jest/globals';
import {
  normalizeCommunitySearch,
  escapeLikeLiteral,
} from './community-search';
import { CommunitySearchCursorCodec } from './community-search-cursor';
const id = '00000000-0000-4000-8000-000000000001';
describe('Community search contract', () => {
  it('normalizes Unicode literal query and scopes response state to questions', () => {
    expect(
      normalizeCommunitySearch({
        q: '  \uFF21_ %\\ ',
        topic: ' Grammar Tips ',
        responseState: 'ANSWERED',
      }),
    ).toEqual({
      q: 'A_ %\\',
      topic: 'grammar-tips',
      postType: 'QUESTION',
      responseState: 'ANSWERED',
      savedByMe: false,
      sort: 'NEWEST',
      limit: 20,
    });
    expect(escapeLikeLiteral('a%_\\b')).toBe('a\\%\\_\\\\b');
  });
  it.each([
    { postType: 'RESOURCE', responseState: 'ANSWERED' },
    { sort: 'ACTIVITY' },
    { savedByMe: '1' },
    { q: '\u{1f600}'.repeat(121) },
    { limit: 51 },
  ])('rejects unsupported or oversized input %p', (input) => {
    expect(() => normalizeCommunitySearch(input)).toThrow();
  });
  it('uses code points and treats empty q as omitted', () => {
    expect(
      normalizeCommunitySearch({ q: '\u{1f600}'.repeat(120) }).q,
    ).toHaveLength(240);
    expect(normalizeCommunitySearch({ q: '  ' })).not.toHaveProperty('q');
  });
  it('authenticates exact microsecond positions, query and saved actor scope', () => {
    const codec = new CommunitySearchCursorCodec(
      'synthetic-community-search-secret',
    );
    const scope = normalizeCommunitySearch({
      savedByMe: 'true',
      sort: 'USEFUL',
      limit: 2,
    });
    const position = {
      id,
      createdAt: '2026-10-13T01:02:03.123456Z',
      helpfulCount: 7,
    };
    const token = codec.encode(scope, id, position);
    expect(codec.decode(token, scope, id)).toEqual(position);
    expect(() =>
      codec.decode(token, scope, '00000000-0000-4000-8000-000000000002'),
    ).toThrow('Pagination cursor is invalid');
    expect(() => codec.decode(token, { ...scope, limit: 3 }, id)).toThrow(
      'Pagination cursor is invalid',
    );
    expect(() =>
      codec.decode(
        token.slice(0, -1) + (token.at(-1) === 'A' ? 'B' : 'A'),
        scope,
        id,
      ),
    ).toThrow('Pagination cursor is invalid');
    expect(() =>
      codec.decode(
        Buffer.from(
          JSON.stringify({ v: 1, id, createdAt: position.createdAt }),
        ).toString('base64url'),
        scope,
        id,
      ),
    ).toThrow('Pagination cursor is invalid');
  });
});
