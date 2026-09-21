import { describe, expect, it } from '@jest/globals';
import { InMemoryIdentityRepository } from '../identity/identity.repository';
import { InMemoryProfileRepository } from '../profile/profile.repository';
import { ProfileService } from '../profile/profile.service';
import { NoopExchangeConnectionEventSink } from './exchange-connection.events';
import { InMemoryExchangeConnectionRepository } from './exchange-connection.repository';
import { InMemoryExchangePreferenceRepository } from './exchange.repository';
import { InMemoryExchangeSafetyRepository } from './exchange-safety.repository';
import { ExchangeService } from './exchange.service';

describe('ExchangeService safety reconciliation', () => {
  it('removes relationships, hides the pair, and does not restore state after unblock', async () => {
    const { identity, profiles, service, connections } = createHarness();
    const first = await createUser(identity, 'safety-first@example.com', 'First');
    const second = await createUser(identity, 'safety-second@example.com', 'Second');
    await preparePair(identity, profiles, service, first.id, second.id);

    await service.requestConnection(first.id, second.id);
    await service.blockUser(first.id, second.id);

    await expect(connections.findRelationship(first.id, second.id)).resolves.toBeNull();
    await expect(service.getEligibility(second.id, first.id)).resolves.toMatchObject({
      eligible: false,
      reasons: ['EXCHANGE_BLOCKED'],
    });
    await expect(service.getPublicBuddyProjection(second.id, first.id))
      .rejects.toMatchObject({ code: 'EXCHANGE_PROFILE_UNAVAILABLE', status: 404 });
    await expect(service.getRelationship(first.id, second.id))
      .rejects.toMatchObject({ code: 'EXCHANGE_PROFILE_UNAVAILABLE', status: 404 });

    await expect(service.unblockUser(first.id, second.id)).resolves.toMatchObject({ blocked: false });
    await expect(connections.findRelationship(first.id, second.id)).resolves.toBeNull();
    await expect(service.requestConnection(first.id, second.id)).resolves.toMatchObject({
      state: 'OUTGOING_PENDING',
    });
  });

  it('makes block win against a concurrent relationship mutation', async () => {
    const { identity, profiles, service, connections } = createHarness();
    const first = await createUser(identity, 'race-first@example.com', 'First');
    const second = await createUser(identity, 'race-second@example.com', 'Second');
    await preparePair(identity, profiles, service, first.id, second.id);
    await service.requestConnection(first.id, second.id);

    await Promise.all([
      service.blockUser(second.id, first.id),
      service.acceptConnection(second.id, first.id).catch(() => undefined),
    ]);

    await expect(connections.findRelationship(first.id, second.id)).resolves.toBeNull();
    await expect(service.getContactPermission(first.id, second.id)).resolves.toMatchObject({
      decision: 'DENIED_INELIGIBLE',
    });
  });

  it('reuses the safety decision for contact permission without exposing contact data', async () => {
    const { identity, profiles, service } = createHarness();
    const first = await createUser(identity, 'contact-first@example.com', 'First');
    const second = await createUser(identity, 'contact-second@example.com', 'Second');
    await preparePair(identity, profiles, service, first.id, second.id);

    await expect(service.getContactPermission(first.id, second.id)).resolves.toMatchObject({
      decision: 'DENIED_PERMISSION',
    });
    await service.updateOwnPreferences(second.id, { contactPermission: 'RELATIONSHIP_GATED' });
    await expect(service.getContactPermission(first.id, second.id)).resolves.toMatchObject({
      decision: 'DENIED_NOT_CONNECTED',
    });
    await service.requestConnection(first.id, second.id);
    await service.acceptConnection(second.id, first.id);
    await expect(service.getContactPermission(first.id, second.id)).resolves.toMatchObject({
      decision: 'ALLOWED',
    });

    await service.blockUser(first.id, second.id);
    await expect(service.getContactPermission(first.id, second.id)).resolves.toMatchObject({
      decision: 'DENIED_BLOCKED',
    });
    await expect(service.getContactPermission(second.id, first.id)).resolves.toMatchObject({
      decision: 'DENIED_INELIGIBLE',
    });
  });

  it('accepts bounded reports, keeps duplicate submission idempotent, and rejects self-reporting', async () => {
    const { identity, profiles, service } = createHarness();
    const reporter = await createUser(identity, 'reporter@example.com', 'Reporter');
    const target = await createUser(identity, 'reported@example.com', 'Reported');
    await preparePair(identity, profiles, service, reporter.id, target.id);

    const first = await service.reportUser(reporter.id, target.id, {
      category: 'SAFETY_CONCERN',
      context: 'Please review this interaction.',
    });
    const duplicate = await service.reportUser(reporter.id, target.id, {
      category: 'SAFETY_CONCERN',
      context: 'A different duplicate context should not create a second item.',
    });

    expect(first).toEqual({ scope: 'exchange-report', submitted: true });
    expect(duplicate).toEqual(first);
    await expect(service.reportUser(reporter.id, reporter.id, { category: 'OTHER' }))
      .rejects.toMatchObject({ code: 'EXCHANGE_SELF_REPORT' });
  });
});

function createHarness() {
  const identity = new InMemoryIdentityRepository();
  const profiles = new InMemoryProfileRepository();
  const preferences = new InMemoryExchangePreferenceRepository();
  const safety = new InMemoryExchangeSafetyRepository();
  const connections = new InMemoryExchangeConnectionRepository(safety);
  return {
    identity,
    profiles,
    connections,
    service: new ExchangeService(
      preferences,
      profiles,
      identity,
      safety,
      connections,
      new NoopExchangeConnectionEventSink(),
    ),
  };
}

async function createUser(repository: InMemoryIdentityRepository, email: string, displayName: string) {
  return repository.createUser({
    email,
    displayName,
    passwordHash: null,
    status: 'ACTIVE',
    emailVerifiedAt: new Date(),
  });
}

async function preparePair(
  identity: InMemoryIdentityRepository,
  profiles: InMemoryProfileRepository,
  service: ExchangeService,
  firstUserId: string,
  secondUserId: string,
) {
  const profileService = new ProfileService(profiles, identity);
  await profileService.updateOwnProfile(firstUserId, {
    languages: [
      { languageCode: 'vi', roles: ['native'], declaredProficiency: 'NATIVE' },
      { languageCode: 'en', roles: ['learning'], declaredProficiency: 'A1' },
    ],
  });
  await profileService.updateOwnProfile(secondUserId, {
    languages: [
      { languageCode: 'en', roles: ['known'], declaredProficiency: 'C1' },
      { languageCode: 'vi', roles: ['learning'], declaredProficiency: 'A1' },
    ],
  });
  await service.updateOwnPreferences(firstUserId, {
    exchangeOptIn: true,
    discoverable: true,
    offeredLanguageCodes: ['vi'],
    wantedLanguageCodes: ['en'],
  });
  await service.updateOwnPreferences(secondUserId, {
    exchangeOptIn: true,
    discoverable: true,
    offeredLanguageCodes: ['en'],
    wantedLanguageCodes: ['vi'],
  });
}
