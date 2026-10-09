import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

// A domain-separated key allows replicas to reuse the existing configured auth
// secret without exposing scan positions. Rotating that secret invalidates cursors.
export class ConnectionCursorCodec {
  private readonly key: Buffer;
  constructor(secret: string | Buffer = randomBytes(32)) {
    this.key = createHmac('sha256',secret).update('exchange-connection-scan-cursor-v1').digest();
  }

  encode(value: unknown): string {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm',this.key,nonce,{authTagLength:16});
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]);
    return Buffer.concat([Buffer.from([1]),nonce,cipher.getAuthTag(),encrypted]).toString('base64url');
  }

  decode(cursor: string): unknown {
    if (!/^[A-Za-z0-9_-]{1,512}$/.test(cursor)) throw new Error('Invalid cursor');
    const raw = Buffer.from(cursor,'base64url');
    if (raw.toString('base64url')!==cursor || raw.length<30 || raw[0]!==1) throw new Error('Invalid cursor');
    const decipher = createDecipheriv('aes-256-gcm',this.key,raw.subarray(1,13),{authTagLength:16});
    decipher.setAuthTag(raw.subarray(13,29));
    const decrypted = Buffer.concat([decipher.update(raw.subarray(29)),decipher.final()]);
    return JSON.parse(decrypted.toString('utf8')) as unknown;
  }
}
