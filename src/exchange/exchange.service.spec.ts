import { describe, expect, it } from '@jest/globals';
import { InMemoryIdentityRepository } from '../identity/identity.repository';
import { InMemoryProfileRepository } from '../profile/profile.repository';
import { ProfileService } from '../profile/profile.service';
import { NoopExchangeConnectionEventSink } from './exchange-connection.events';
import { InMemoryExchangeConnectionRepository } from './exchange-connection.repository';
import {
  InMemoryExchangePreferenceRepository,
  type ExchangePreferenceRepository,
} from './exchange.repository';
import {
  ExchangeService,
  NoopExchangeSafetyGate,
} from './exchange.service';

describe('ExchangeService', () => {
  it('defaults a new user to opt-out and non-discoverable', async () => {
    const { identity, service } = createService();
    const user = await createUser(identity, 'exchange-default@example.com');

    await expect(service.getOwnPreferences(user.id)).resolves.toMatchObject({
      scope: 'own',
      exchangeOptIn: false,
      discoverable: false,
      offeredLanguageCodes: [],
      wantedLanguageCodes: [],
      preferredPartnerLevels: [],
      matchingGoalCodes: [],
      matchingInterestCodes: [],
      timezoneVisibility: 'HIDDEN',
      availabilityVisibility: 'HIDDEN',
      contactPermission: 'NO_CONTACT',
    });
    await expect(service.getEligibility(user.id)).resolves.toMatchObject({ eligible: false });
  });

  it('stores multilingual offered and wanted selections without duplicating profile data', async () => {
    const { identity, profiles, service } = createService();
    const user = await createUser(identity, 'exchange-multilingual@example.com');
    await updateProfile(profiles, identity, user.id, {
      languages: [
        language('vi', ['native'], 'NATIVE'),
        language('en', ['known'], 'C1'),
        language('ja', ['learning'], 'A2'),
        language('fr', ['learning'], 'B1'),
      ],
      goals: ['conversation', 'travel'],
      interests: ['music'],
    });

    const updated = await service.updateOwnPreferences(user.id, {
      exchangeOptIn: true,
      discoverable: true,
      offeredLanguageCodes: ['vi', 'en'],
      wantedLanguageCodes: ['ja', 'fr'],
      preferredPartnerLevels: ['A2', 'B1'],
      matchingGoalCodes: ['conversation'],
      matchingInterestCodes: ['music'],
      timezoneVisibility: 'SUMMARY',
      availabilityVisibility: 'SUMMARY',
      contactPermission: 'RELATIONSHIP_GATED',
    });

    expect(updated).toMatchObject({
      exchangeOptIn: true,
      discoverable: true,
      offeredLanguageCodes: ['vi', 'en'],
      wantedLanguageCodes: ['ja', 'fr'],
      preferredPartnerLevels: ['A2', 'B1'],
      matchingGoalCodes: ['conversation'],
      matchingInterestCodes: ['music'],
      timezoneVisibility: 'SUMMARY',
      availabilityVisibility: 'SUMMARY',
      contactPermission: 'RELATIONSHIP_GATED',
    });
    await expect(service.getEligibility(user.id)).resolves.toMatchObject({ eligible: true });
  });

  it('requires one offered and one wanted language before enabling exchange', async () => {
    const { identity, service } = createService();
    const user = await createUser(identity, 'exchange-readiness@example.com');

    await expect(service.updateOwnPreferences(user.id, { exchangeOptIn: true }))
      .rejects.toMatchObject({ code: 'EXCHANGE_NOT_READY' });
  });

  it('accepts the same language in both directions for multilingual maintenance use', async () => {
    const { identity, profiles, service } = createService();
    const user = await createUser(identity, 'exchange-same-language@example.com');
    await updateProfile(profiles, identity, user.id, {
      languages: [language('en', ['native', 'learning'], 'NATIVE')],
    });

    await expect(service.updateOwnPreferences(user.id, {
      exchangeOptIn: true,
      offeredLanguageCodes: ['en'],
      wantedLanguageCodes: ['en'],
    })).resolves.toMatchObject({
      offeredLanguageCodes: ['en'],
      wantedLanguageCodes: ['en'],
    });
  });

  it('rejects private, inactive and role-incompatible language selections', async () => {
    const { identity, profiles, service } = createService();
    const user = await createUser(identity, 'exchange-language-validation@example.com');
    await updateProfile(profiles, identity, user.id, {
      languages: [
        language('vi', ['native'], 'NATIVE'),
        { ...language('en', ['learning'], 'A1'), visibility: 'PRIVATE' },
        language('ja', ['known'], 'B1'),
      ],
    });

    await expect(service.updateOwnPreferences(user.id, { offeredLanguageCodes: ['en'] }))
      .rejects.toMatchObject({ code: 'EXCHANGE_LANGUAGE_PRIVATE' });
    await expect(service.updateOwnPreferences(user.id, { wantedLanguageCodes: ['ja'] }))
      .rejects.toMatchObject({ code: 'EXCHANGE_LANGUAGE_NOT_WANTED' });

    await profiles.setActive('vi', false);
    await expect(service.updateOwnPreferences(user.id, { offeredLanguageCodes: ['vi'] }))
      .rejects.toMatchObject({ code: 'EXCHANGE_LANGUAGE_INACTIVE' });
  });

  it('preserves preferences on opt-out while making eligibility immediately false', async () => {
    const { identity, profiles, service } = createService();
    const user = await createUser(identity, 'exchange-opt-out@example.com');
    await updateProfile(profiles, identity, user.id, {
      languages: [
        language('vi', ['native'], 'NATIVE'),
        language('en', ['learning'], 'A1'),
      ],
    });
    await service.updateOwnPreferences(user.id, {
      exchangeOptIn: true,
      discoverable: true,
      offeredLanguageCodes: ['vi'],
      wantedLanguageCodes: ['en'],
    });

    const optedOut = await service.updateOwnPreferences(user.id, { exchangeOptIn: false });
    expect(optedOut).toMatchObject({
      exchangeOptIn: false,
      discoverable: true,
      offeredLanguageCodes: ['vi'],
      wantedLanguageCodes: ['en'],
    });
    await expect(service.getEligibility(user.id)).resolves.toMatchObject({ eligible: false });
  });

  it('returns a safe buddy projection with summaries and no contact details or exact schedule', async () => {
    const { identity, profiles, service } = createService();
    const viewer = await createUser(identity, 'exchange-viewer@example.com');
    const target = await createUser(identity, 'exchange-target@example.com');
    await updateProfile(profiles, identity, target.id, {
      languages: [
        language('vi', ['native'], 'NATIVE'),
        language('en', ['learning'], 'A1'),
      ],
      goals: ['conversation'],
      interests: ['music'],
      timezone: 'Asia/Ho_Chi_Minh',
      availability: [{ dayOfWeek: 1, startTime: '08:00', endTime: '09:00' }],
    });
    await service.updateOwnPreferences(target.id, {
      exchangeOptIn: true,
      discoverable: true,
      offeredLanguageCodes: ['vi'],
      wantedLanguageCodes: ['en'],
      matchingGoalCodes: ['conversation'],
      matchingInterestCodes: ['music'],
      timezoneVisibility: 'SUMMARY',
      availabilityVisibility: 'SUMMARY',
    });

    const projection = await service.getPublicBuddyProjection(target.id, viewer.id);
    expect(projection.user).toEqual({ id: target.id, displayName: target.displayName });
    expect(projection.languages.map((item) => item.code)).toEqual(['vi', 'en']);
    expect(projection.goals).toEqual(['conversation']);
    expect(projection.interests).toEqual(['music']);
    expect(projection.timezoneSummary).toEqual({
      visibility: 'SUMMARY',
      hasTimezone: true,
    });
    expect(projection.availabilitySummary).toEqual({
      visibility: 'SUMMARY',
      hasAvailability: true,
    });
    expect(projection).not.toHaveProperty('email');
    expect(projection).not.toHaveProperty('contact');
    expect(projection).not.toHaveProperty('availability');
    expect(projection.availabilitySummary).not.toHaveProperty('windows');
    expect(projection.relationship).toMatchObject({ state: 'NONE', canRequest: true });
  });

  it('enforces the relationship lifecycle and rejects self or ineligible requests', async () => {
    const { identity, profiles, service } = createService();
    const requester = await createNamedUser(identity, 'Requester');
    const target = await createNamedUser(identity, 'Target');
    await prepareExchangePair(identity, profiles, service, requester.id, target.id);

    await expect(service.getRelationship(requester.id, target.id)).resolves.toMatchObject({
      state: 'NONE',
      canRequest: true,
    });
    await expect(service.requestConnection(requester.id, requester.id))
      .rejects.toMatchObject({ code: 'EXCHANGE_SELF_CONNECTION' });

    const outgoing = await service.requestConnection(requester.id, target.id);
    expect(outgoing).toMatchObject({ state: 'OUTGOING_PENDING', canCancel: true });
    await expect(service.requestConnection(requester.id, target.id)).resolves.toMatchObject({
      state: 'OUTGOING_PENDING',
    });
    await expect(service.getRelationship(target.id, requester.id)).resolves.toMatchObject({
      state: 'INCOMING_PENDING',
      canAccept: true,
      canDecline: true,
    });

    await expect(service.cancelConnection(target.id, requester.id))
      .rejects.toMatchObject({ code: 'EXCHANGE_CONNECTION_ACTION_INVALID' });
    await expect(service.declineConnection(target.id, requester.id)).resolves.toMatchObject({ state: 'NONE' });

    await service.requestConnection(requester.id, target.id);
    await expect(service.cancelConnection(requester.id, target.id)).resolves.toMatchObject({ state: 'NONE' });
    await service.requestConnection(requester.id, target.id);
    await expect(service.acceptConnection(target.id, requester.id)).resolves.toMatchObject({
      state: 'CONNECTED',
      canDisconnect: true,
    });
    await expect(service.acceptConnection(target.id, requester.id)).resolves.toMatchObject({ state: 'CONNECTED' });
    await expect(service.disconnect(requester.id, target.id)).resolves.toMatchObject({ state: 'NONE' });

    const inactive = await createNamedUser(identity, 'Inactive');
    await identity.updateUser(inactive.id, { status: 'DISABLED' });
    await expect(service.requestConnection(requester.id, inactive.id))
      .rejects.toMatchObject({ code: 'EXCHANGE_PROFILE_UNAVAILABLE' });
  });

  it('converges reciprocal requests to one connected relationship', async () => {
    const { identity, profiles, service } = createService();
    const first = await createNamedUser(identity, 'First');
    const second = await createNamedUser(identity, 'Second');
    await prepareExchangePair(identity, profiles, service, first.id, second.id);

    const results = await Promise.all([
      service.requestConnection(first.id, second.id),
      service.requestConnection(second.id, first.id),
    ]);

    expect(results.map((result) => result.state)).toContain('OUTGOING_PENDING');
    expect(results.map((result) => result.state)).toContain('CONNECTED');
    await expect(service.getRelationship(first.id, second.id)).resolves.toMatchObject({
      state: 'CONNECTED',
      canDisconnect: true,
    });
  });

  it('fails closed for malformed persisted preferences', async () => {
    const identity = new InMemoryIdentityRepository();
    const profiles = new InMemoryProfileRepository();
    const user = await createUser(identity, 'exchange-malformed@example.com');
    const repository: ExchangePreferenceRepository = {
      findPreferences: async () => ({
        userId: user.id,
        exchangeOptIn: true,
        discoverable: true,
        offeredLanguageCodes: ['not-in-profile'],
        wantedLanguageCodes: ['not-in-profile'],
        preferredPartnerLevels: ['A7'] as never,
        matchingGoalCodes: [],
        matchingInterestCodes: [],
        timezoneVisibility: 'HIDDEN',
        availabilityVisibility: 'HIDDEN',
        contactPermission: 'NO_CONTACT',
        createdAt: null,
        updatedAt: null,
      }),
      listDiscoverableUserIds: async () => [user.id],
      savePreferences: async () => {
        throw new Error('not used');
      },
    };
    const service = new ExchangeService(
      repository,
      profiles,
      identity,
      new NoopExchangeSafetyGate(),
      new InMemoryExchangeConnectionRepository(),
      new NoopExchangeConnectionEventSink(),
    );

    await expect(service.getEligibility(user.id)).resolves.toMatchObject({ eligible: false });
  });

  it('discovers reciprocal partners with explainable reasons and a safe projection', async () => {
    const { identity, profiles, service } = createService();
    const viewer = await createNamedUser(identity, 'Viewer');
    const match = await createNamedUser(identity, 'Matching learner');
    const oneWay = await createNamedUser(identity, 'One way learner');
    const optedOut = await createNamedUser(identity, 'Opted out learner');
    await updateProfile(profiles, identity, viewer.id, {
      languages: [language('vi', ['native'], 'NATIVE'), language('en', ['learning'], 'A2')],
      goals: ['conversation'],
      interests: ['music'],
      timezone: 'Asia/Ho_Chi_Minh',
      availability: [{ dayOfWeek: 1, startTime: '08:00', endTime: '10:00' }],
    });
    await service.updateOwnPreferences(viewer.id, {
      exchangeOptIn: true,
      discoverable: true,
      offeredLanguageCodes: ['vi'],
      wantedLanguageCodes: ['en'],
      preferredPartnerLevels: ['C1'],
      matchingGoalCodes: ['conversation'],
      matchingInterestCodes: ['music'],
    });

    for (const user of [match, oneWay, optedOut]) {
      await updateProfile(profiles, identity, user.id, {
        languages: [
          language('en', ['known'], 'C1'),
          language('vi', ['learning'], 'A1'),
          language('ja', ['learning'], 'A1'),
        ],
        goals: ['conversation'],
        interests: ['music'],
        timezone: 'Asia/Tokyo',
        availability: [{ dayOfWeek: 1, startTime: '10:00', endTime: '12:00' }],
      });
    }
    await service.updateOwnPreferences(match.id, {
      exchangeOptIn: true,
      discoverable: true,
      offeredLanguageCodes: ['en'],
      wantedLanguageCodes: ['vi'],
      preferredPartnerLevels: ['A2'],
      matchingGoalCodes: ['conversation'],
      matchingInterestCodes: ['music'],
    });
    await service.updateOwnPreferences(oneWay.id, {
      exchangeOptIn: true,
      discoverable: true,
      offeredLanguageCodes: ['en'],
      wantedLanguageCodes: ['ja'],
    });
    await service.updateOwnPreferences(optedOut.id, {
      exchangeOptIn: false,
      discoverable: true,
      offeredLanguageCodes: ['en'],
      wantedLanguageCodes: ['vi'],
    });

    const response = await service.discover(viewer.id, { pageSize: 20 });

    expect(response.scope).toBe('exchange-discovery');
    expect(response.candidates.map((candidate) => candidate.user.id)).toEqual([match.id]);
    expect(response.candidates[0]).toMatchObject({
      user: { id: match.id, displayName: 'Matching learner' },
      normalizedScore: expect.any(Number),
      goals: ['conversation'],
      interests: ['music'],
    });
    expect(response.candidates[0].reasons.join(' ')).toEqual(expect.stringContaining('English'));
    expect(response.candidates[0].reasons.join(' ')).toEqual(expect.stringContaining('Múi giờ tương thích'));
    expect(response.candidates[0].reasons.join(' ')).toEqual(expect.stringContaining('conversation'));
    expect(response.candidates[0]).not.toHaveProperty('email');
    expect(response.candidates[0]).not.toHaveProperty('timezone');
    expect(response.candidates[0]).not.toHaveProperty('availability');
    expect(response.candidates[0]).not.toHaveProperty('timezoneSummary');
  });

  it('applies filters and paginates with deterministic ordering', async () => {
    const { identity, profiles, service } = createService();
    const viewer = await createNamedUser(identity, 'Viewer');
    await updateProfile(profiles, identity, viewer.id, {
      languages: [language('vi', ['native'], 'NATIVE'), language('en', ['learning'], 'A2')],
    });
    await service.updateOwnPreferences(viewer.id, {
      exchangeOptIn: true,
      discoverable: true,
      offeredLanguageCodes: ['vi'],
      wantedLanguageCodes: ['en'],
    });

    const candidates = await Promise.all([
      createDiscoverableCandidate(identity, profiles, service, 'A'),
      createDiscoverableCandidate(identity, profiles, service, 'B'),
      createDiscoverableCandidate(identity, profiles, service, 'C'),
    ]);
    const orderedIds = candidates.map((candidate) => candidate.id).sort((left, right) => left.localeCompare(right));

    const firstPage = await service.discover(viewer.id, {
      offeredLanguageCodes: ['en'],
      page: 1,
      pageSize: 2,
    });
    const secondPage = await service.discover(viewer.id, {
      offeredLanguageCodes: ['en'],
      page: 2,
      pageSize: 2,
    });

    expect(firstPage.pagination).toEqual({ page: 1, pageSize: 2, totalItems: 3, totalPages: 2 });
    expect(firstPage.candidates.map((candidate) => candidate.user.id)).toEqual(orderedIds.slice(0, 2));
    expect(secondPage.candidates.map((candidate) => candidate.user.id)).toEqual(orderedIds.slice(2));
    await expect(service.discover(viewer.id, { pageSize: 0 })).rejects.toMatchObject({
      code: 'EXCHANGE_INVALID_FILTERS',
    });
  });

  it('does not claim time overlap when candidate availability is absent', async () => {
    const { identity, profiles, service } = createService();
    const viewer = await createNamedUser(identity, 'Viewer');
    const candidate = await createNamedUser(identity, 'No schedule learner');
    await updateProfile(profiles, identity, viewer.id, {
      languages: [language('vi', ['native'], 'NATIVE'), language('en', ['learning'], 'A2')],
      timezone: 'Asia/Ho_Chi_Minh',
    });
    await updateProfile(profiles, identity, candidate.id, {
      languages: [language('en', ['known'], 'C1'), language('vi', ['learning'], 'A1')],
      timezone: 'Asia/Tokyo',
    });
    await service.updateOwnPreferences(viewer.id, {
      exchangeOptIn: true,
      discoverable: true,
      offeredLanguageCodes: ['vi'],
      wantedLanguageCodes: ['en'],
    });
    await service.updateOwnPreferences(candidate.id, {
      exchangeOptIn: true,
      discoverable: true,
      offeredLanguageCodes: ['en'],
      wantedLanguageCodes: ['vi'],
    });

    const response = await service.discover(viewer.id);

    expect(response.candidates).toHaveLength(1);
    expect(response.candidates[0].reasons.join(' ')).not.toContain('khoảng thời gian');
  });
});

function createService(): {
  identity: InMemoryIdentityRepository;
  profiles: InMemoryProfileRepository;
  service: ExchangeService;
} {
  const identity = new InMemoryIdentityRepository();
  const profiles = new InMemoryProfileRepository();
  const repository = new InMemoryExchangePreferenceRepository();
  return {
    identity,
    profiles,
    service: new ExchangeService(
      repository,
      profiles,
      identity,
      new NoopExchangeSafetyGate(),
      new InMemoryExchangeConnectionRepository(),
      new NoopExchangeConnectionEventSink(),
    ),
  };
}

async function createUser(repository: InMemoryIdentityRepository, email: string) {
  return repository.createUser({
    email,
    displayName: 'Exchange User',
    passwordHash: null,
    status: 'ACTIVE',
    emailVerifiedAt: new Date(),
  });
}

async function createNamedUser(repository: InMemoryIdentityRepository, displayName: string) {
  const emailSlug = displayName.toLowerCase().replace(/\s+/g, '-');

  return repository.createUser({
    email: `${emailSlug}@example.com`,
    displayName,
    passwordHash: null,
    status: 'ACTIVE',
    emailVerifiedAt: new Date(),
  });
}

async function createDiscoverableCandidate(
  identity: InMemoryIdentityRepository,
  profiles: InMemoryProfileRepository,
  service: ExchangeService,
  name: string,
) {
  const user = await createNamedUser(identity, `Candidate ${name}`);
  await updateProfile(profiles, identity, user.id, {
    languages: [language('en', ['known'], 'C1'), language('vi', ['learning'], 'A1')],
  });
  await service.updateOwnPreferences(user.id, {
    exchangeOptIn: true,
    discoverable: true,
    offeredLanguageCodes: ['en'],
    wantedLanguageCodes: ['vi'],
  });
  return user;
}

async function prepareExchangePair(
  identity: InMemoryIdentityRepository,
  profiles: InMemoryProfileRepository,
  service: ExchangeService,
  firstUserId: string,
  secondUserId: string,
) {
  await updateProfile(profiles, identity, firstUserId, {
    languages: [language('vi', ['native'], 'NATIVE'), language('en', ['learning'], 'A1')],
  });
  await updateProfile(profiles, identity, secondUserId, {
    languages: [language('en', ['known'], 'C1'), language('vi', ['learning'], 'A1')],
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

async function updateProfile(
  profiles: InMemoryProfileRepository,
  identity: InMemoryIdentityRepository,
  userId: string,
  input: Parameters<ProfileService['updateOwnProfile']>[1],
) {
  return new ProfileService(profiles, identity).updateOwnProfile(userId, input);
}

function language(
  code: string,
  roles: Array<'native' | 'known' | 'learning'>,
  declaredProficiency: 'NATIVE' | 'A1' | 'A2' | 'B1' | 'B2' | 'C1' | 'C2',
) {
  return { languageCode: code, roles, declaredProficiency };
}
