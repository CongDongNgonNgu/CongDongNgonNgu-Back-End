import { describe, expect, it } from '@jest/globals';
import { InMemoryIdentityRepository } from './identity.repository';

describe('identity admin repository contract', () => {
  it('lists safe identity records with bounded filters', async () => {
    const repository = new InMemoryIdentityRepository();
    const alice = await createUser(repository, 'alice@example.com', 'Alice');
    const bob = await createUser(repository, 'bob@example.com', 'Bob');
    await repository.replaceUserRoles(alice.id, ['ADMIN']);
    await repository.replaceUserRoles(bob.id, ['MODERATOR']);

    await expect(repository.listUsers({ role: 'MODERATOR', limit: 10, offset: 0 })).resolves.toMatchObject({
      total: 1,
      items: [expect.objectContaining({ id: bob.id, roles: ['MODERATOR'] })],
    });
    await expect(repository.listUsers({ search: 'alice', limit: 10, offset: 0 })).resolves.toMatchObject({
      total: 1,
      items: [expect.objectContaining({ id: alice.id })],
    });
  });

  it('protects the last active administrator during role replacement', async () => {
    const repository = new InMemoryIdentityRepository();
    const admin = await createUser(repository, 'admin@example.com', 'Admin');
    await repository.replaceUserRoles(admin.id, ['ADMIN']);

    await expect(repository.countActiveAdministrators()).resolves.toBe(1);
    await expect(repository.replaceUserRoles(admin.id, ['USER'])).rejects.toMatchObject({
      name: 'RepositoryConflictError',
    });
    await expect(repository.findUserById(admin.id)).resolves.toMatchObject({ roles: ['ADMIN'] });
  });

  it('allows demotion when another active administrator remains', async () => {
    const repository = new InMemoryIdentityRepository();
    const first = await createUser(repository, 'first-admin@example.com', 'First');
    const second = await createUser(repository, 'second-admin@example.com', 'Second');
    await repository.replaceUserRoles(first.id, ['ADMIN']);
    await repository.replaceUserRoles(second.id, ['ADMIN']);

    await expect(repository.replaceUserRoles(first.id, ['USER'])).resolves.toMatchObject({ roles: ['USER'] });
    await expect(repository.countActiveAdministrators()).resolves.toBe(1);
  });
});

async function createUser(repository: InMemoryIdentityRepository, email: string, displayName: string) {
  return repository.createUser({
    email,
    displayName,
    passwordHash: null,
    status: 'ACTIVE',
    emailVerifiedAt: new Date(),
  });
}
