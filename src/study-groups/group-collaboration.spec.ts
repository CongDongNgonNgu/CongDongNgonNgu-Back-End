import { describe, expect, it } from '@jest/globals';
import { GroupSyncCursor } from './group-sync-cursor';
import {
  normalizeGroupText,
  normalizeGroupSync,
} from './group-collaboration.validation';
const id = '00000000-0000-4000-8000-000000000001',
  other = '00000000-0000-4000-8000-000000000002';
describe('group collaboration boundaries', () => {
  it('allows canonical reference-only notes and 2000 Unicode code points', () => {
    expect(
      normalizeGroupText({
        contextType: 'COMMUNITY_POST',
        contextId: id,
        clientMessageId: id,
      }),
    ).toMatchObject({
      body: '',
      context: { type: 'COMMUNITY_POST', id },
      clientMessageId: id,
    });
    expect(
      normalizeGroupText({ body: '\u{1f600}'.repeat(2000) }).body,
    ).toHaveLength(4000);
    expect(() =>
      normalizeGroupText({ body: '\u{1f600}'.repeat(2001) }),
    ).toThrow();
    expect(() =>
      normalizeGroupText({ contextType: 'COMMUNITY_POST' }),
    ).toThrow();
  });
  it('rejects recognized native invite-token URLs while preserving ordinary long text',()=>{
    expect(()=>normalizeGroupText({body:'https://example.invalid/study-groups/invitations?token='+ 'a'.repeat(43)})).toThrow();
    expect(normalizeGroupText({body:'a'.repeat(43)}).body).toHaveLength(43);
  });
  it('caps catch-up and rendered IDs and rejects duplicates/foreign syntax', () => {
    expect(normalizeGroupSync({})).toEqual({ limit: 20, renderedIds: [] });
    expect(() => normalizeGroupSync({ limit: 21 })).toThrow();
    expect(() => normalizeGroupSync({ renderedIds: [id, id] })).toThrow();
  });
  it('authenticates group, actor and membership generation scope including bigint positions', () => {
    const codec = new GroupSyncCursor(
      'synthetic-group-sync-secret-at-least-32',
    );
    const token = codec.encode(id, other, id, '9007199254740993', 20);
    expect(codec.decode(token, id, other, id, 20)).toBe('9007199254740993');
    expect(() => codec.decode(token, id, id, id, 20)).toThrow();
    expect(() => codec.decode(token, id, other, other, 20)).toThrow();
    expect(() => codec.decode(token, id, other, id, 10)).toThrow();
    expect(() => codec.decode(token + '=', id, other, id, 20)).toThrow();
  });
});
