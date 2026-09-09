import { createHash, createHmac, randomBytes } from 'node:crypto';

export function createOpaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

export function digestOpaqueToken(token: string, secret?: string): string {
  const digest = secret
    ? createHmac('sha256', secret).update(token).digest()
    : createHash('sha256').update(token).digest();
  return digest.toString('base64url');
}
