import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import { libraryFailure } from './library.errors';
export class LibraryRelatedCursor {
  private readonly key: Buffer;
  constructor(secret: string) {
    if (!secret)
      throw new Error('JWT access secret is required for related pagination');
    this.key = createHash('sha256')
      .update('CongDongNgonNgu/library-related-cursor/v1\0')
      .update(secret)
      .digest();
  }
  encode(after: string, binding: string): string {
    const nonce = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    cipher.setAAD(Buffer.from(binding));
    const payload = Buffer.concat([
      cipher.update(JSON.stringify({ v: 1, after }), 'utf8'),
      cipher.final(),
    ]);
    return Buffer.concat([nonce, cipher.getAuthTag(), payload]).toString(
      'base64url',
    );
  }
  decode(token: unknown, binding: string): string | null {
    if (token === undefined) return null;
    try {
      if (
        typeof token !== 'string' ||
        token.length < 40 ||
        token.length > 512 ||
        !/^[A-Za-z0-9_-]+$/.test(token)
      )
        throw new Error();
      const bytes = Buffer.from(token, 'base64url');
      if (bytes.toString('base64url') !== token) throw new Error();
      const cipher = createDecipheriv(
        'aes-256-gcm',
        this.key,
        bytes.subarray(0, 12),
      );
      cipher.setAAD(Buffer.from(binding));
      cipher.setAuthTag(bytes.subarray(12, 28));
      const data = JSON.parse(
        Buffer.concat([
          cipher.update(bytes.subarray(28)),
          cipher.final(),
        ]).toString('utf8'),
      );
      if (
        data.v !== 1 ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
          data.after,
        )
      )
        throw new Error();
      return data.after;
    } catch {
      libraryFailure(
        'LIBRARY_RELATED_CURSOR_INVALID',
        'The library pagination cursor is invalid',
      );
    }
  }
}
