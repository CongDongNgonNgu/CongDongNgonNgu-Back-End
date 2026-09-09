import { Injectable } from '@nestjs/common';
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const SALT_BYTES = 16;
const KEY_BYTES = 64;
const SCRYPT_OPTIONS = {
  N: 32_768,
  r: 8,
  p: 1,
  maxmem: 64 * 1024 * 1024,
};

type ScryptParameters = { N: number; r: number; p: number };

export class PasswordPolicyError extends Error {
  constructor(message = 'Password does not meet the minimum policy') {
    super(message);
    this.name = 'PasswordPolicyError';
  }
}

@Injectable()
export class PasswordHasher {
  validate(password: string): void {
    this.assertPolicy(password);
  }

  async hash(password: string): Promise<string> {
    this.validate(password);
    const salt = randomBytes(SALT_BYTES);
    const derivedKey = await this.derive(password, salt);
    const separator = String.fromCharCode(36);
    return [
      separator + 'scrypt',
      'N=' + SCRYPT_OPTIONS.N + ',r=' + SCRYPT_OPTIONS.r + ',p=' + SCRYPT_OPTIONS.p,
      salt.toString('base64url'),
      derivedKey.toString('base64url'),
    ].join(separator);
  }

  async verify(password: string, encoded: string): Promise<boolean> {
    const prefix = String.fromCharCode(36) + 'scrypt' + String.fromCharCode(36);
    if (!encoded.startsWith(prefix)) {
      return false;
    }

    const parts = encoded.split(String.fromCharCode(36));
    if (parts.length !== 5) {
      return false;
    }

    const parameters = this.readParameters(parts[2]);
    if (!parameters) {
      return false;
    }

    let salt: Buffer;
    let expected: Buffer;
    try {
      salt = Buffer.from(parts[3], 'base64url');
      expected = Buffer.from(parts[4], 'base64url');
    } catch {
      return false;
    }

    if (salt.length !== SALT_BYTES || expected.length !== KEY_BYTES) {
      return false;
    }

    const actual = await this.derive(password, salt, parameters);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  private assertPolicy(password: string): void {
    if (typeof password !== 'string' || password.length < 12 || password.length > 128) {
      throw new PasswordPolicyError('Password must be between 12 and 128 characters');
    }
    if (password.trim().length === 0) {
      throw new PasswordPolicyError('Password must contain a non-whitespace character');
    }
  }

  private readParameters(value: string): ScryptParameters | null {
    const match = /^N=(\d+),r=(\d+),p=(\d+)$/.exec(value);
    if (!match) {
      return null;
    }

    const parameters = {
      N: Number(match[1]),
      r: Number(match[2]),
      p: Number(match[3]),
    };
    if (
      parameters.N !== SCRYPT_OPTIONS.N ||
      parameters.r !== SCRYPT_OPTIONS.r ||
      parameters.p !== SCRYPT_OPTIONS.p
    ) {
      return null;
    }
    return parameters;
  }

  private derive(
    password: string,
    salt: Buffer,
    parameters: ScryptParameters = SCRYPT_OPTIONS,
  ): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      scrypt(
        password,
        salt,
        KEY_BYTES,
        {
          N: parameters.N,
          r: parameters.r,
          p: parameters.p,
          maxmem: SCRYPT_OPTIONS.maxmem,
        },
        (error, derivedKey) => {
          if (error) {
            reject(error);
            return;
          }
          resolve(derivedKey);
        },
      );
    });
  }
}
