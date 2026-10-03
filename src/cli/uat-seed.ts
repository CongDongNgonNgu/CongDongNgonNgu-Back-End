import type { RoleKey } from '../identity/identity.types';

export const UAT_SEED_CONFIRMATION = 'CONGDONGNGONNGU_PHASE18_UAT_ONLY';
export const UAT_SEED_ENVIRONMENTS = ['TEST', 'UAT'] as const;
export type UatSeedEnvironment = typeof UAT_SEED_ENVIRONMENTS[number];

const BLOCKED_DATABASE_HOST_MARKERS = ['eduai', 'giaoducso.org.vn', 'production', 'prod.'] as const;
const PASSWORD_MIN_LENGTH = 12;
const PASSWORD_MAX_LENGTH = 128;

export class UatSeedError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'UatSeedError';
  }
}

export interface ParsedUatSeedCliArgs {
  environment: UatSeedEnvironment;
  dryRun: boolean;
}

export interface UatSeedTargetInput {
  environment: UatSeedEnvironment;
  nodeEnv?: string;
  databaseUrl: string | undefined;
  expectedDatabaseHost: string | undefined;
  expectedDatabaseName: string | undefined;
  allowedDatabaseHosts: readonly string[];
  confirmation: string | undefined;
  password: string | undefined;
}

export interface UatSeedTarget {
  environment: UatSeedEnvironment;
  databaseUrl: string;
  databaseHost: string;
  databaseName: string;
  password: string;
}

export interface UatPersonaLanguage {
  code: string;
  isNative: boolean;
  isKnown: boolean;
  isLearning: boolean;
  declaredProficiency: 'NATIVE' | 'A1' | 'A2' | 'B1' | 'B2' | 'C1' | 'C2';
  isPrimaryLearningTarget: boolean;
  visibility: 'PUBLIC' | 'PRIVATE';
}

export interface UatPersonaExchange {
  enabled: boolean;
  discoverable: boolean;
  offers: readonly string[];
  wants: readonly string[];
  partnerLevels: readonly string[];
  goals: readonly string[];
  interests: readonly string[];
}

export interface UatPersona {
  key: string;
  email: string;
  displayName: string;
  timezone: string;
  roles: readonly RoleKey[];
  languages: readonly UatPersonaLanguage[];
  goals: readonly string[];
  skills: readonly ('speaking' | 'listening' | 'reading' | 'writing' | 'grammar' | 'vocabulary')[];
  interests: readonly string[];
  exchange?: UatPersonaExchange;
}

const UAT_PERSONAS: readonly UatPersona[] = [
  {
    key: 'new-user',
    email: 'uat.phase18.new-user@example.invalid',
    displayName: 'UAT Người dùng mới',
    timezone: 'Asia/Ho_Chi_Minh',
    roles: ['USER', 'MEMBER'],
    languages: [],
    goals: [],
    skills: [],
    interests: [],
  },
  {
    key: 'vietnamese-learner',
    email: 'uat.phase18.vietnamese-learner@example.invalid',
    displayName: 'UAT Vietnamese Learner',
    timezone: 'Asia/Ho_Chi_Minh',
    roles: ['USER', 'MEMBER'],
    languages: [
      language('en', { isNative: true, declaredProficiency: 'NATIVE' }),
      language('vi', { isLearning: true, declaredProficiency: 'A2', isPrimaryLearningTarget: true }),
    ],
    goals: ['conversation', 'travel'],
    skills: ['speaking', 'listening'],
    interests: ['food', 'travel'],
  },
  {
    key: 'foreign-vietnamese-learner',
    email: 'uat.phase18.foreign-vietnamese-learner@example.invalid',
    displayName: 'UAT Foreign Vietnamese Learner',
    timezone: 'America/New_York',
    roles: ['USER', 'MEMBER'],
    languages: [
      language('en', { isNative: true, declaredProficiency: 'NATIVE' }),
      language('vi', { isLearning: true, declaredProficiency: 'A1', isPrimaryLearningTarget: true }),
    ],
    goals: ['conversation', 'culture'],
    skills: ['speaking', 'listening'],
    interests: ['culture', 'travel'],
  },
  {
    key: 'english-native-buddy',
    email: 'uat.phase18.english-native-buddy@example.invalid',
    displayName: 'UAT English Native Buddy',
    timezone: 'Europe/London',
    roles: ['USER', 'MEMBER'],
    languages: [
      language('en', { isNative: true, declaredProficiency: 'NATIVE' }),
      language('vi', { isLearning: true, declaredProficiency: 'A2', isPrimaryLearningTarget: true }),
    ],
    goals: ['conversation', 'pronunciation'],
    skills: ['speaking', 'listening'],
    interests: ['music', 'travel'],
    exchange: exchange(['en'], ['vi'], ['A1', 'A2'], ['conversation'], ['travel']),
  },
  {
    key: 'vietnamese-native-buddy',
    email: 'uat.phase18.vietnamese-native-buddy@example.invalid',
    displayName: 'UAT Vietnamese Native Buddy',
    timezone: 'Asia/Ho_Chi_Minh',
    roles: ['USER', 'MEMBER'],
    languages: [
      language('vi', { isNative: true, declaredProficiency: 'NATIVE' }),
      language('en', { isLearning: true, declaredProficiency: 'B1', isPrimaryLearningTarget: true }),
    ],
    goals: ['conversation', 'writing'],
    skills: ['speaking', 'writing'],
    interests: ['culture', 'books'],
    exchange: exchange(['vi'], ['en'], ['B1', 'B2'], ['conversation'], ['culture']),
  },
  {
    key: 'contributor',
    email: 'uat.phase18.contributor@example.invalid',
    displayName: 'UAT Contributor',
    timezone: 'Asia/Ho_Chi_Minh',
    roles: ['USER', 'MEMBER', 'CONTRIBUTOR'],
    languages: [
      language('vi', { isNative: true, declaredProficiency: 'NATIVE' }),
      language('en', { isLearning: true, declaredProficiency: 'B1', isPrimaryLearningTarget: true }),
    ],
    goals: ['writing', 'community'],
    skills: ['writing', 'grammar'],
    interests: ['education', 'culture'],
  },
  {
    key: 'reviewer',
    email: 'uat.phase18.reviewer@example.invalid',
    displayName: 'UAT Reviewer',
    timezone: 'Asia/Ho_Chi_Minh',
    roles: ['USER', 'MEMBER', 'MODERATOR'],
    languages: [
      language('en', { isNative: true, declaredProficiency: 'NATIVE' }),
      language('vi', { isLearning: true, declaredProficiency: 'B2', isPrimaryLearningTarget: true }),
    ],
    goals: ['review', 'community'],
    skills: ['reading', 'grammar', 'writing'],
    interests: ['education', 'literature'],
  },
  {
    key: 'moderator',
    email: 'uat.phase18.moderator@example.invalid',
    displayName: 'UAT Moderator',
    timezone: 'Asia/Ho_Chi_Minh',
    roles: ['USER', 'MEMBER', 'MODERATOR'],
    languages: [
      language('vi', { isNative: true, declaredProficiency: 'NATIVE' }),
      language('en', { isLearning: true, declaredProficiency: 'C1', isPrimaryLearningTarget: true }),
    ],
    goals: ['safety', 'community'],
    skills: ['reading', 'writing'],
    interests: ['community', 'safety'],
  },
  {
    key: 'admin',
    email: 'uat.phase18.admin@example.invalid',
    displayName: 'UAT Admin',
    timezone: 'Asia/Ho_Chi_Minh',
    roles: ['USER', 'MEMBER', 'ADMIN'],
    languages: [
      language('vi', { isNative: true, declaredProficiency: 'NATIVE' }),
      language('en', { isLearning: true, declaredProficiency: 'C1', isPrimaryLearningTarget: true }),
    ],
    goals: ['operations', 'community'],
    skills: ['reading', 'writing'],
    interests: ['community', 'operations'],
  },
];

export function parseUatSeedCliArgs(argv: readonly string[]): ParsedUatSeedCliArgs {
  let environment: string | undefined;
  let dryRun = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--dry-run') {
      if (dryRun) throw new UatSeedError('UAT_SEED_ARGUMENT_DUPLICATE', '--dry-run may appear only once.');
      dryRun = true;
      continue;
    }
    if (argument !== '--environment') {
      throw new UatSeedError('UAT_SEED_ARGUMENT_INVALID', 'Unknown UAT seed argument.');
    }
    if (environment !== undefined) {
      throw new UatSeedError('UAT_SEED_ARGUMENT_DUPLICATE', '--environment may appear only once.');
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new UatSeedError('UAT_SEED_ARGUMENT_VALUE_REQUIRED', '--environment requires a value.');
    }
    environment = value;
    index += 1;
  }

  if (!environment) {
    throw new UatSeedError('UAT_SEED_ENVIRONMENT_REQUIRED', '--environment TEST or --environment UAT is required.');
  }
  if (environment === 'PRODUCTION' || environment.toLowerCase() === 'production' || environment.toLowerCase() === 'prod') {
    throw new UatSeedError('UAT_SEED_PRODUCTION_UNSUPPORTED', 'Production is never a supported UAT seed target.');
  }
  if (!UAT_SEED_ENVIRONMENTS.includes(environment as UatSeedEnvironment)) {
    throw new UatSeedError('UAT_SEED_ENVIRONMENT_INVALID', 'Only TEST or UAT is supported.');
  }

  return { environment: environment as UatSeedEnvironment, dryRun };
}

export function validateUatSeedTarget(input: UatSeedTargetInput): UatSeedTarget {
  if (input.nodeEnv?.toLowerCase() === 'production') {
    throw new UatSeedError('UAT_SEED_PRODUCTION_UNSUPPORTED', 'NODE_ENV=production cannot run the UAT seed.');
  }
  if (input.confirmation !== UAT_SEED_CONFIRMATION) {
    throw new UatSeedError('UAT_SEED_CONFIRMATION_REQUIRED', 'The explicit UAT-only confirmation is required.');
  }
  const password = input.password?.trim();
  if (!password || password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
    throw new UatSeedError('UAT_SEED_PASSWORD_REQUIRED', 'UAT_SEED_PASSWORD must be 12 to 128 characters.');
  }
  if (!input.databaseUrl) {
    throw new UatSeedError('UAT_SEED_DATABASE_URL_REQUIRED', 'DATABASE_URL is required for a non-dry run.');
  }
  if (!input.expectedDatabaseHost || !input.expectedDatabaseName) {
    throw new UatSeedError('UAT_SEED_DATABASE_EXPECTATION_REQUIRED', 'Expected database host and name are required.');
  }
  let url: URL;
  try {
    url = new URL(input.databaseUrl);
  } catch {
    throw new UatSeedError('UAT_SEED_DATABASE_URL_INVALID', 'DATABASE_URL must be a valid PostgreSQL URL.');
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new UatSeedError('UAT_SEED_DATABASE_URL_INVALID', 'DATABASE_URL must use PostgreSQL.');
  }
  const host = url.hostname.toLowerCase();
  const databaseName = decodeURIComponent(url.pathname.replace(/^\//u, ''));
  if (!host || !databaseName || host !== input.expectedDatabaseHost.toLowerCase()) {
    throw new UatSeedError('UAT_SEED_DATABASE_TARGET_MISMATCH', 'DATABASE_URL does not match the expected target.');
  }
  if (databaseName !== input.expectedDatabaseName) {
    throw new UatSeedError('UAT_SEED_DATABASE_TARGET_MISMATCH', 'DATABASE_URL database name does not match the expected target.');
  }
  if (!input.allowedDatabaseHosts.some((allowedHost) => allowedHost.toLowerCase() === host)) {
    throw new UatSeedError('UAT_SEED_DATABASE_HOST_NOT_ALLOWED', 'The database host is not in the explicit UAT allowlist.');
  }
  if (BLOCKED_DATABASE_HOST_MARKERS.some((marker) => host.includes(marker) || databaseName.toLowerCase().includes(marker))) {
    throw new UatSeedError('UAT_SEED_DATABASE_HOST_NOT_ALLOWED', 'The database target resembles a blocked production/external-product target.');
  }

  return {
    environment: input.environment,
    databaseUrl: input.databaseUrl,
    databaseHost: host,
    databaseName,
    password,
  };
}

export function buildUatPersonas(): readonly UatPersona[] {
  return UAT_PERSONAS.map((persona) => ({
    ...persona,
    roles: [...persona.roles],
    languages: persona.languages.map((languageItem) => ({ ...languageItem })),
    goals: [...persona.goals],
    skills: [...persona.skills],
    interests: [...persona.interests],
    ...(persona.exchange
      ? {
          exchange: {
            ...persona.exchange,
            offers: [...persona.exchange.offers],
            wants: [...persona.exchange.wants],
            partnerLevels: [...persona.exchange.partnerLevels],
            goals: [...persona.exchange.goals],
            interests: [...persona.exchange.interests],
          },
        }
      : {}),
  }));
}

function language(
  code: string,
  overrides: Partial<Omit<UatPersonaLanguage, 'code'>> = {},
): UatPersonaLanguage {
  return {
    code,
    isNative: false,
    isKnown: false,
    isLearning: false,
    declaredProficiency: 'A1',
    isPrimaryLearningTarget: false,
    visibility: 'PUBLIC',
    ...overrides,
  };
}

function exchange(
  offers: readonly string[],
  wants: readonly string[],
  partnerLevels: readonly string[],
  goals: readonly string[],
  interests: readonly string[],
): UatPersonaExchange {
  return {
    enabled: true,
    discoverable: true,
    offers,
    wants,
    partnerLevels,
    goals,
    interests,
  };
}
