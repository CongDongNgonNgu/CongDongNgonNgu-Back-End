import {
  UAT_SEED_CONFIRMATION,
  buildUatPersonas,
  parseUatSeedCliArgs,
  validateUatSeedTarget,
} from './uat-seed';

describe('Phase 18 UAT seed contracts', () => {
  it('requires an explicit TEST or UAT target and supports a safe dry run', () => {
    expect(parseUatSeedCliArgs(['--environment', 'TEST', '--dry-run'])).toEqual({
      environment: 'TEST',
      dryRun: true,
    });
    expect(parseUatSeedCliArgs(['--environment', 'UAT'])).toEqual({
      environment: 'UAT',
      dryRun: false,
    });
  });

  it('rejects missing, duplicate, unknown and production seed arguments', () => {
    expect(() => parseUatSeedCliArgs([])).toThrow('UAT_SEED_ENVIRONMENT_REQUIRED');
    expect(() => parseUatSeedCliArgs(['--environment', 'PRODUCTION'])).toThrow('UAT_SEED_PRODUCTION_UNSUPPORTED');
    expect(() => parseUatSeedCliArgs(['--environment', 'TEST', '--environment', 'UAT']))
      .toThrow('UAT_SEED_ARGUMENT_DUPLICATE');
    expect(() => parseUatSeedCliArgs(['--environment', 'TEST', '--reset']))
      .toThrow('UAT_SEED_ARGUMENT_INVALID');
  });

  it('rejects production or unallowlisted database targets before connection', () => {
    const base = {
      environment: 'TEST' as const,
      databaseUrl: 'postgresql://seed-user:seed-password@localhost:5432/congdongngonngu_test',
      expectedDatabaseHost: 'localhost',
      expectedDatabaseName: 'congdongngonngu_test',
      allowedDatabaseHosts: ['localhost'],
      confirmation: UAT_SEED_CONFIRMATION,
      password: 'UAT-only-password-with-12-chars',
    };

    expect(() => validateUatSeedTarget({ ...base, nodeEnv: 'production' })).toThrow('UAT_SEED_PRODUCTION_UNSUPPORTED');
    expect(() => validateUatSeedTarget({ ...base, confirmation: 'wrong-confirmation' }))
      .toThrow('UAT_SEED_CONFIRMATION_REQUIRED');
    expect(() => validateUatSeedTarget({
      ...base,
      databaseUrl: 'postgresql://user:pass@remote.example/uat_test',
      expectedDatabaseHost: 'remote.example',
      expectedDatabaseName: 'uat_test',
    }))
      .toThrow('UAT_SEED_DATABASE_HOST_NOT_ALLOWED');
    expect(() => validateUatSeedTarget({ ...base, password: '' })).toThrow('UAT_SEED_PASSWORD_REQUIRED');
  });

  it('defines stable dedicated personas without storing credentials in the manifest', () => {
    const personas = buildUatPersonas();
    const keys = personas.map((persona) => persona.key);

    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual(expect.arrayContaining([
      'new-user',
      'vietnamese-learner',
      'foreign-vietnamese-learner',
      'english-native-buddy',
      'vietnamese-native-buddy',
      'contributor',
      'reviewer',
      'moderator',
      'admin',
    ]));
    expect(personas.find((persona) => persona.key === 'foreign-vietnamese-learner')).toMatchObject({
      email: 'uat.phase18.foreign-vietnamese-learner@example.invalid',
      languages: expect.arrayContaining([
        expect.objectContaining({ code: 'vi', isLearning: true }),
      ]),
    });
    expect(personas.find((persona) => persona.key === 'admin')?.roles).toEqual(
      expect.arrayContaining(['ADMIN']),
    );
    expect(personas.every((persona) => !('password' in persona))).toBe(true);
  });
});
