import { Injectable } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { ConfigService } from '@nestjs/config';

export interface AccessTokenClaims {
  sub: string;
  sid: string;
  roles: string[];
  iat: number;
  exp: number;
}

interface AuthTokenRuntimeConfig {
  accessSecret: string;
  accessTtlSeconds: number;
}

@Injectable()
export class AccessTokenService {
  constructor(private readonly config: ConfigService) {}

  issue(
    userId: string,
    sessionId: string,
    roles: string[],
    now = new Date(),
  ): { token: string; expiresAt: Date } {
    const auth = this.authConfig();
    const issuedAt = Math.floor(now.getTime() / 1000);
    const expiresAt = issuedAt + auth.accessTtlSeconds;
    const header = encode({ alg: 'HS256', typ: 'JWT' });
    const payload = encode({
      sub: userId,
      sid: sessionId,
      roles: [...roles],
      iat: issuedAt,
      exp: expiresAt,
    });
    const signingInput = header + '.' + payload;
    const signature = sign(signingInput, auth.accessSecret);
    return { token: signingInput + '.' + signature, expiresAt: new Date(expiresAt * 1000) };
  }

  verify(token: string, now = new Date()): AccessTokenClaims | null {
    const auth = this.authConfig();
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [headerPart, payloadPart, signaturePart] = parts;
    const expected = sign(headerPart + '.' + payloadPart, auth.accessSecret);
    const received = Buffer.from(signaturePart);
    const expectedBuffer = Buffer.from(expected);
    if (received.length !== expectedBuffer.length || !timingSafeEqual(received, expectedBuffer)) {
      return null;
    }

    try {
      const header = decode(headerPart);
      const payload = decode(payloadPart);
      const issuedAt = payload.iat;
      const expiresAt = payload.exp;
      if (header.alg !== 'HS256' || header.typ !== 'JWT') return null;
      if (
        typeof payload.sub !== 'string' ||
        typeof payload.sid !== 'string' ||
        !Array.isArray(payload.roles) ||
        !payload.roles.every((role): role is string => typeof role === 'string') ||
        typeof issuedAt !== 'number' ||
        typeof expiresAt !== 'number' ||
        !Number.isInteger(issuedAt) ||
        !Number.isInteger(expiresAt) ||
        expiresAt <= Math.floor(now.getTime() / 1000) ||
        expiresAt <= issuedAt
      ) {
        return null;
      }
      return {
        sub: payload.sub,
        sid: payload.sid,
        roles: payload.roles,
        iat: issuedAt,
        exp: expiresAt,
      };
    } catch {
      return null;
    }
  }

  private authConfig(): AuthTokenRuntimeConfig {
    const auth = this.config.get<AuthTokenRuntimeConfig>('auth');
    if (!auth?.accessSecret || !auth.accessTtlSeconds) {
      throw new Error('Auth token configuration is unavailable');
    }
    return auth;
  }
}

function sign(value: string, secret: string): string {
  return createHmac('sha256', secret).update(value).digest('base64url');
}

function encode(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function decode(value: string): Record<string, unknown> {
  const decoded = Buffer.from(value, 'base64url').toString('utf8');
  const parsed: unknown = JSON.parse(decoded);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid token object');
  }
  return parsed as Record<string, unknown>;
}
