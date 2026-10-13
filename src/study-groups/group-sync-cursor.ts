import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from 'node:crypto';
import { parseSequence } from '../messaging/message-validation';
import { StudyGroupFailure, uuid } from './study-group.validation';
function invalid(): never {
  throw new StudyGroupFailure(
    'GROUP_INVALID_CURSOR',
    400,
    'Group cursor is invalid',
  );
}
export class GroupSyncCursor {
  private readonly key: Buffer;
  constructor(secret: string) {
    if (secret.length < 32)
      throw new Error('Group sync cursor secret is required');
    this.key = createHmac('sha256', secret)
      .update('private-group-sync-cursor-v1')
      .digest();
  }
  encode(
    group: string,
    actor: string,
    generation: string,
    sequence: string,
    limit: number,
  ): string {
    [group, actor, generation].forEach(uuid);
    parseSequence(sequence);
    const nonce = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    const value = { v: 1, group, actor, generation, sequence, limit };
    const bytes = Buffer.concat([
      cipher.update(JSON.stringify(value), 'utf8'),
      cipher.final(),
    ]);
    return Buffer.concat([
      Buffer.from([1]),
      nonce,
      cipher.getAuthTag(),
      bytes,
    ]).toString('base64url');
  }
  decode(
    token: string,
    group: string,
    actor: string,
    generation: string,
    limit: number,
  ): string {
    try {
      if (!/^[A-Za-z0-9_-]{1,2048}$/.test(token)) return invalid();
      const bytes = Buffer.from(token, 'base64url');
      if (
        bytes.length < 30 ||
        bytes[0] !== 1 ||
        bytes.toString('base64url') !== token
      )
        return invalid();
      const decipher = createDecipheriv(
        'aes-256-gcm',
        this.key,
        bytes.subarray(1, 13),
      );
      decipher.setAuthTag(bytes.subarray(13, 29));
      const value = JSON.parse(
        Buffer.concat([
          decipher.update(bytes.subarray(29)),
          decipher.final(),
        ]).toString('utf8'),
      );
      if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        Object.keys(value).sort().join(',') !==
          'actor,generation,group,limit,sequence,v' ||
        value.v !== 1 ||
        value.group !== group ||
        value.actor !== actor ||
        value.generation !== generation ||
        value.limit !== limit
      )
        return invalid();
      return parseSequence(value.sequence).toString();
    } catch {
      return invalid();
    }
  }
}
