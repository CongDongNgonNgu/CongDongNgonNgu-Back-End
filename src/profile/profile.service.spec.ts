import { describe, expect, it } from '@jest/globals';
import { InMemoryIdentityRepository } from '../identity/identity.repository';
import { InMemoryProfileRepository } from './profile.repository';
import { ProfileService } from './profile.service';

describe('ProfileService', () => {
  it('supports multiple native and learning languages with one primary target', async () => {
    const { identity, service } = createService();
    const user = await createUser(identity, 'multilingual@example.com');

    const profile = await service.updateOwnProfile(user.id, {
      languages: [
        language('vi', ['native'], 'NATIVE'),
        language('en', ['native', 'known'], 'NATIVE'),
        language('ja', ['learning'], 'A1', true),
        language('fr', ['learning'], 'B1'),
      ],
    });

    expect(profile.languages.filter((item) => item.roles.includes('native'))).toHaveLength(2);
    expect(profile.languages.filter((item) => item.roles.includes('learning'))).toHaveLength(2);
    expect(profile.languages.find((item) => item.code === 'ja')?.isPrimaryLearningTarget).toBe(true);
  });

  it('changes or removes the primary learning target without corrupting other languages', async () => {
    const { identity, service } = createService();
    const user = await createUser(identity, 'primary-target@example.com');

    await service.updateOwnProfile(user.id, {
      languages: [
        language('en', ['learning'], 'A1', true),
        language('ja', ['learning'], 'A2'),
      ],
    });
    const changed = await service.updateOwnProfile(user.id, {
      languages: [
        language('en', ['learning'], 'A1'),
        language('ja', ['learning'], 'A2', true),
      ],
    });
    expect(changed.languages.find((item) => item.code === 'ja')?.isPrimaryLearningTarget).toBe(true);

    const removed = await service.updateOwnProfile(user.id, {
      languages: [
        language('en', ['learning'], 'A1'),
        language('ja', ['learning'], 'A2'),
      ],
    });
    expect(removed.languages.every((item) => !item.isPrimaryLearningTarget)).toBe(true);
  });

  it('rejects duplicate language relations and invalid native proficiency', async () => {
    const { identity, service } = createService();
    const user = await createUser(identity, 'language-validation@example.com');

    await expect(service.updateOwnProfile(user.id, {
      languages: [
        language('en', ['learning'], 'A1'),
        language('en', ['known'], 'B1'),
      ],
    })).rejects.toMatchObject({ code: 'PROFILE_DUPLICATE_LANGUAGE' });

    await expect(service.updateOwnProfile(user.id, {
      languages: [language('vi', ['native'], 'C1')],
    })).rejects.toMatchObject({ code: 'PROFILE_INVALID_PROFICIENCY' });
  });

  it('validates IANA timezones and keeps availability in local wall-clock time when timezone changes', async () => {
    const { identity, service } = createService();
    const user = await createUser(identity, 'timezone@example.com');
    const availability = [{ dayOfWeek: 1, startTime: '23:00', endTime: '24:00' }];

    await expect(service.updateOwnProfile(user.id, { timezone: 'UTC+7' }))
      .rejects.toMatchObject({ code: 'PROFILE_INVALID_TIMEZONE' });
    const before = await service.updateOwnProfile(user.id, {
      timezone: 'America/New_York',
      availability,
    });
    const after = await service.updateOwnProfile(user.id, { timezone: 'Asia/Ho_Chi_Minh' });

    expect(before.timezone).toBe('America/New_York');
    expect(after.timezone).toBe('Asia/Ho_Chi_Minh');
    expect(after.availability).toEqual(availability);
  });

  it('rejects overlapping availability but accepts adjacent windows and midnight endpoints', async () => {
    const { identity, service } = createService();
    const user = await createUser(identity, 'availability@example.com');

    const valid = await service.updateOwnProfile(user.id, {
      availability: [
        { dayOfWeek: 1, startTime: '00:00', endTime: '09:00' },
        { dayOfWeek: 1, startTime: '09:00', endTime: '24:00' },
      ],
    });
    expect(valid.availability).toHaveLength(2);

    await expect(service.updateOwnProfile(user.id, {
      availability: [
        { dayOfWeek: 1, startTime: '09:00', endTime: '11:00' },
        { dayOfWeek: 1, startTime: '10:00', endTime: '12:00' },
      ],
    })).rejects.toMatchObject({ code: 'PROFILE_AVAILABILITY_OVERLAP' });
  });

  it('returns explicit own and privacy-safe public projections', async () => {
    const { identity, service } = createService();
    const user = await createUser(identity, 'privacy@example.com');
    await service.updateOwnProfile(user.id, {
      languages: [
        language('en', ['learning'], 'B1'),
        { ...language('ja', ['learning'], 'A2'), visibility: 'PRIVATE' },
      ],
      timezone: 'Asia/Ho_Chi_Minh',
      availability: [{ dayOfWeek: 2, startTime: '08:00', endTime: '09:00' }],
    });

    const own = await service.getOwnProfile(user.id);
    expect(own.user.email).toBe(user.email);
    expect(own.availability).toHaveLength(1);
    expect(own.languages.find((item) => item.code === 'ja')?.visibility).toBe('PRIVATE');

    const publicProfile = await service.getPublicProfile(user.id);
    expect(publicProfile.user).toEqual({ id: user.id, displayName: user.displayName });
    expect(publicProfile.languages.map((item) => item.code)).toEqual(['en']);
    expect(publicProfile.languages[0]).not.toHaveProperty('visibility');
    expect(publicProfile).not.toHaveProperty('email');
    expect(publicProfile).not.toHaveProperty('timezone');
    expect(publicProfile).not.toHaveProperty('availability');
    expect(publicProfile).not.toHaveProperty('roles');
  });

  it('validates display name before changing any profile data', async () => {
    const { identity, service } = createService();
    const user = await createUser(identity, 'display-name@example.com');

    await expect(service.updateOwnProfile(user.id, {
      displayName: ' ',
      goals: ['conversation'],
    })).rejects.toMatchObject({ code: 'PROFILE_INVALID_DISPLAY_NAME' });
    expect((await service.getOwnProfile(user.id)).goals).toEqual([]);
  });

  it('searches every catalog name field through the same bounded path', async () => {
    const { service } = createService();

    expect((await service.listLanguages('Tiếng Nhật')).map((language) => language.code)).toEqual(['ja']);
    expect((await service.listLanguages('English')).map((language) => language.code)).toEqual(['en']);
    expect((await service.listLanguages('日本語')).map((language) => language.code)).toEqual(['ja']);
    expect((await service.listLanguages('한국어')).map((language) => language.code)).toEqual(['ko']);
    expect((await service.listLanguages('Français')).map((language) => language.code)).toEqual(['fr']);
    expect(await service.listLanguages('%')).toEqual([]);
  });

  it('resolves active, inactive, unknown and malformed slugs deterministically', async () => {
    const { service } = createService();

    for (const slug of [
      'vietnamese',
      'english',
      'chinese',
      'japanese',
      'korean',
      'french',
      'german',
      'spanish',
    ]) {
      await expect(service.getLanguageBySlug(slug)).resolves.toMatchObject({ slug });
    }

    await expect(service.getLanguageBySlug('missing')).rejects.toMatchObject({
      code: 'LANGUAGE_NOT_FOUND',
      status: 404,
    });
    await expect(service.getLanguageBySlug('../english')).rejects.toMatchObject({
      code: 'LANGUAGE_INVALID_SLUG',
      status: 400,
    });
  });

  it('keeps inactive languages out of discovery while reporting their slug state', async () => {
    const { service, profiles } = createService();
    await profiles.setActive('fr', false);

    expect(await service.listLanguages('français')).toEqual([]);
    await expect(service.getLanguageBySlug('french')).rejects.toMatchObject({
      code: 'LANGUAGE_INACTIVE',
      status: 404,
    });
  });

  it('builds one truthful overview contract for every active launch language', async () => {
    const { service } = createService();

    for (const slug of [
      'vietnamese',
      'english',
      'chinese',
      'japanese',
      'korean',
      'french',
      'german',
      'spanish',
    ]) {
      const overview = await service.getLanguageOverview(slug);

      expect(overview.language.slug).toBe(slug);
      expect(overview.seo.canonicalPath).toBe('/languages/' + slug);
      expect(overview.metrics).toEqual({
        learnerCount: { state: 'NOT_AVAILABLE_YET', value: null },
        contributorCount: { state: 'NOT_AVAILABLE_YET', value: null },
        resourceCount: { state: 'NOT_AVAILABLE_YET', value: null },
      });
      expect(overview.filters).toEqual({
        levels: [],
        topic: null,
        levelOptions: ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'],
        levelRequired: false,
        topicState: 'NOT_AVAILABLE_YET',
      });
      expect(overview.sections.find((section) => section.key === 'overview')).toEqual({
        key: 'overview',
        status: 'AVAILABLE',
        isNavigable: true,
        href: '/languages/' + slug,
      });
      expect(overview.sections.filter((section) => section.key !== 'overview'))
        .toHaveLength(9);
      expect(overview.sections
        .filter((section) => section.key !== 'overview')
        .every((section) => (
          section.status === 'NOT_IMPLEMENTED' &&
          section.isNavigable === false &&
          section.href === null
        ))).toBe(true);
    }
  });
});

function createService(): {
  identity: InMemoryIdentityRepository;
  profiles: InMemoryProfileRepository;
  service: ProfileService;
} {
  const identity = new InMemoryIdentityRepository();
  const profiles = new InMemoryProfileRepository();
  return { identity, profiles, service: new ProfileService(profiles, identity) };
}

async function createUser(repository: InMemoryIdentityRepository, email: string) {
  return repository.createUser({
    email,
    displayName: 'Profile User',
    passwordHash: null,
    status: 'ACTIVE',
    emailVerifiedAt: new Date(),
  });
}

function language(
  code: string,
  roles: Array<'native' | 'known' | 'learning'>,
  declaredProficiency: 'NATIVE' | 'A1' | 'A2' | 'B1' | 'B2' | 'C1' | 'C2',
  isPrimaryLearningTarget = false,
) {
  return { languageCode: code, roles, declaredProficiency, isPrimaryLearningTarget };
}
