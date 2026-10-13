import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from 'node:crypto';
import { communityFailure } from './community.errors';
import type {
  CommunitySearchFilters,
  CommunitySearchPosition,
} from './community-search';
const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
function invalid(): never {
  return communityFailure(
    'COMMUNITY_INVALID_CURSOR',
    'Pagination cursor is invalid',
  );
}
function scope(filters: CommunitySearchFilters, actor: string | null): string {
  const normalized = {
    q: filters.q ?? null,
    languageCode: filters.languageCode ?? null,
    postType: filters.postType ?? null,
    topic: filters.topic ?? null,
    responseState: filters.responseState ?? null,
    savedByMe: filters.savedByMe,
    sort: filters.sort,
    limit: filters.limit,
    actor: filters.savedByMe ? actor : null,
  };
  return createHmac('sha256', 'community-search-scope-v1')
    .update(JSON.stringify(normalized))
    .digest('hex');
}
function validPosition(value: unknown): value is CommunitySearchPosition {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const p = value as CommunitySearchPosition;
  if (
    Object.keys(p).sort().join(',') !== 'createdAt,helpfulCount,id' ||
    typeof p.id !== 'string' ||
    !UUID.test(p.id) ||
    typeof p.createdAt !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(p.createdAt) ||
    !Number.isSafeInteger(p.helpfulCount) ||
    p.helpfulCount < 0
  )
    return false;
  const millis = p.createdAt.slice(0, 23) + 'Z';
  return (
    Number.isFinite(Date.parse(millis)) &&
    new Date(millis).toISOString() === millis
  );
}
export class CommunitySearchCursorCodec {
  private readonly key: Buffer;
  constructor(secret: string) {
    this.key = createHmac('sha256', secret)
      .update('community-public-search-cursor-v1')
      .digest();
  }
  encode(
    filters: CommunitySearchFilters,
    actor: string | null,
    position: CommunitySearchPosition,
  ): string {
    if (!validPosition(position)) return invalid();
    const nonce = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    const value = { v: 1, scope: scope(filters, actor), position };
    const encrypted = Buffer.concat([
      cipher.update(JSON.stringify(value), 'utf8'),
      cipher.final(),
    ]);
    return Buffer.concat([
      Buffer.from([1]),
      nonce,
      cipher.getAuthTag(),
      encrypted,
    ]).toString('base64url');
  }
  decode(
    token: string,
    filters: CommunitySearchFilters,
    actor: string | null,
  ): CommunitySearchPosition {
    try {
      if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{1,2048}$/.test(token))
        return invalid();
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
        Object.keys(value).sort().join(',') !== 'position,scope,v' ||
        value.v !== 1 ||
        value.scope !== scope(filters, actor) ||
        !validPosition(value.position)
      )
        return invalid();
      return value.position;
    } catch {
      return invalid();
    }
  }
}
