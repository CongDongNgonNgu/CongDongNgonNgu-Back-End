import { describe, expect, it } from '@jest/globals';
import { normalizeEmail } from './identity.types';
import { PasswordHasher, PasswordPolicyError } from '../auth/crypto/password-hasher';

describe('identity rules', () => {
  it('normalizes email without applying provider-specific aliases', () => {
    expect(normalizeEmail('  Learner@Example.COM ')).toBe('learner@example.com');
    expect(normalizeEmail('learner+club@example.com')).toBe('learner+club@example.com');
  });

  it('rejects passwords outside the bounded, manager-friendly policy', async () => {
    const hasher = new PasswordHasher();

    await expect(hasher.hash('short')).rejects.toBeInstanceOf(PasswordPolicyError);
    await expect(hasher.hash('a'.repeat(129))).rejects.toBeInstanceOf(PasswordPolicyError);
    await expect(hasher.hash('            ')).rejects.toBeInstanceOf(PasswordPolicyError);
  });

  it('hashes and verifies a password without exposing the source password', async () => {
    const hasher = new PasswordHasher();
    const password = 'Correct horse battery staple 2026';
    const encoded = await hasher.hash(password);

    expect(encoded).not.toContain(password);
    await expect(hasher.verify(password, encoded)).resolves.toBe(true);
    await expect(hasher.verify('another password', encoded)).resolves.toBe(false);
  });
});
