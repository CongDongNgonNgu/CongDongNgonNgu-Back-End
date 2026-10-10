import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { MessageFailure } from './message-failure';
import { parseSequence } from './message-validation';

interface ListPosition { id: string; updatedAt: string }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class MessageCursorCodec {
  private readonly key: Buffer;
  constructor(secret: string) {
    this.key = createHmac('sha256', secret).update('direct-message-private-cursor-v1').digest();
  }

  history(actor: string, conversation: string, sequence: string): string {
    return this.encode({ kind: 'HISTORY', actor, conversation, sequence: parseSequence(sequence).toString() });
  }

  readHistory(cursor: string, actor: string, conversation: string): string {
    try {
      const value = this.decode(cursor);
      if (value.kind !== 'HISTORY' || value.actor !== actor || value.conversation !== conversation) throw invalid();
      return parseSequence(value.sequence).toString();
    } catch { throw invalid(); }
  }

  list(actor: string, position: ListPosition): string {
    return this.encode({ kind: 'LIST', actor, ...position });
  }

  readList(cursor: string, actor: string): ListPosition {
    try {
      const value = this.decode(cursor);
      if (value.kind !== 'LIST' || value.actor !== actor || typeof value.id !== 'string' || !UUID.test(value.id)
        || typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))
        || new Date(value.updatedAt).toISOString() !== value.updatedAt) throw invalid();
      return { id: value.id, updatedAt: value.updatedAt };
    } catch { throw invalid(); }
  }

  private encode(value: unknown): string {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce, { authTagLength: 16 });
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return Buffer.concat([Buffer.from([1]), nonce, cipher.getAuthTag(), ciphertext]).toString('base64url');
  }

  private decode(cursor: string): Record<string, unknown> {
    if (!/^[A-Za-z0-9_-]{1,512}$/.test(cursor)) throw invalid();
    const raw = Buffer.from(cursor, 'base64url');
    if (raw.length < 30 || raw[0] !== 1 || raw.toString('base64url') !== cursor) throw invalid();
    const decipher = createDecipheriv('aes-256-gcm', this.key, raw.subarray(1, 13), { authTagLength: 16 });
    decipher.setAuthTag(raw.subarray(13, 29));
    const value: unknown = JSON.parse(Buffer.concat([decipher.update(raw.subarray(29)), decipher.final()]).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
    return value as Record<string, unknown>;
  }
}

function invalid(): MessageFailure {
  return new MessageFailure('MESSAGE_INVALID_CURSOR', 400, 'Message cursor is invalid');
}
