import { randomUUID } from 'node:crypto';
import { MessageCursorCodec } from './message-cursor';

describe('Private direct message cursors', () => {
  const secret = 'synthetic-messaging-cursor-key-not-runtime';
  const actor = randomUUID();
  const conversation = randomUUID();
  const codec = new MessageCursorCodec(secret);

  it('roundtrips exact bigint boundaries across replicas without exposing scope identifiers', () => {
    const cursor = codec.history(actor, conversation, '9007199254740993');
    expect(new MessageCursorCodec(secret).readHistory(cursor, actor, conversation)).toBe('9007199254740993');
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    expect(raw).not.toContain(actor);
    expect(raw).not.toContain(conversation);
    expect(raw).not.toContain('9007199254740993');
  });

  it('rejects another actor, conversation, rotation, tampering or malformed cursor', () => {
    const cursor = codec.history(actor, conversation, '10');
    for (const read of [
      () => codec.readHistory(cursor, randomUUID(), conversation),
      () => codec.readHistory(cursor, actor, randomUUID()),
      () => new MessageCursorCodec('rotated-synthetic-secret').readHistory(cursor, actor, conversation),
      () => codec.readHistory(cursor.slice(0, -3), actor, conversation),
      () => codec.readHistory('invalid!', actor, conversation),
    ]) expect(read).toThrow(expect.objectContaining({ code: 'MESSAGE_INVALID_CURSOR' }));
  });

  it('binds deterministic list position to actor and rejects history/list cursor substitution', () => {
    const position = { id: conversation, updatedAt: '2026-10-10T01:02:03.004Z' };
    const cursor = codec.list(actor, position);
    expect(codec.readList(cursor, actor)).toEqual(position);
    expect(() => codec.readList(cursor, randomUUID())).toThrow();
    expect(() => codec.readHistory(cursor, actor, conversation)).toThrow();
    expect(() => codec.readList(codec.history(actor, conversation, '1'), actor)).toThrow();
  });

  it('preserves PostgreSQL microseconds and rejects impossible calendar positions', () => {
    const position = { id: conversation, updatedAt: '2026-10-10T01:02:03.004987Z' };
    expect(codec.readList(codec.list(actor, position), actor)).toEqual(position);
    for (const updatedAt of ['2026-02-30T01:02:03.004987Z', '2026-10-10T01:02:03.004987+00:00',
      '2026-10-10T01:02:03.00498Z', '2026-10-10T01:02:03.0049879Z']) {
      expect(() => codec.readList(codec.list(actor, { id: conversation, updatedAt }), actor))
        .toThrow(expect.objectContaining({ code: 'MESSAGE_INVALID_CURSOR' }));
    }
  });
});
