import { randomUUID } from 'node:crypto';
import type {
  AuthSessionRecord,
  AuthTokenPurpose,
  AuthTokenRecord,
  OAuthProviderName,
  OAuthTransactionRecord,
  ProviderAccountRecord,
  RoleKey,
  UserRecord,
  UserStatus,
} from './identity.types';

export interface CreateUserInput {
  email: string;
  displayName: string;
  passwordHash: string | null;
  status: UserStatus;
  emailVerifiedAt?: Date | null;
}

export interface UpdateUserInput {
  displayName?: string;
  passwordHash?: string | null;
  status?: UserStatus;
  emailVerifiedAt?: Date | null;
}

export interface CreateProviderAccountInput {
  userId: string;
  provider: OAuthProviderName;
  providerSubject: string;
  providerEmail: string | null;
  providerDisplayName: string | null;
  providerAvatarUrl: string | null;
  emailVerified: boolean;
}

export interface CreateSessionInput {
  userId: string;
  familyId: string;
  tokenDigest: string;
  expiresAt: Date;
}

export interface CreateAuthTokenInput {
  userId: string;
  purpose: AuthTokenPurpose;
  tokenDigest: string;
  expiresAt: Date;
}

export interface CreateOAuthTransactionInput {
  provider: OAuthProviderName;
  mode: 'login' | 'register' | 'link';
  userId: string | null;
  sessionId: string | null;
  stateDigest: string;
  expiresAt: Date;
}

export interface ReplacementSession {
  oldDigest: string;
  replacement: CreateSessionInput;
  now: Date;
}

export type RefreshRotationResult =
  | { status: 'rotated'; session: AuthSessionRecord }
  | { status: 'replay' }
  | { status: 'invalid' };

export class RepositoryConflictError extends Error {
  constructor(message = 'Identity record conflicts with an existing record') {
    super(message);
    this.name = 'RepositoryConflictError';
  }
}

export interface IdentityRepository {
  findUserById(id: string): Promise<UserRecord | null>;
  findUserByEmail(email: string): Promise<UserRecord | null>;
  createUser(input: CreateUserInput): Promise<UserRecord>;
  updateUser(id: string, input: UpdateUserInput): Promise<UserRecord | null>;

  findProviderAccount(provider: OAuthProviderName, providerSubject: string): Promise<ProviderAccountRecord | null>;
  createProviderAccount(input: CreateProviderAccountInput): Promise<ProviderAccountRecord>;
  updateProviderAccount(id: string, input: Partial<CreateProviderAccountInput>): Promise<ProviderAccountRecord | null>;

  createAuthToken(input: CreateAuthTokenInput): Promise<AuthTokenRecord>;
  consumeAuthToken(
    tokenDigest: string,
    purpose: AuthTokenPurpose,
    now: Date,
  ): Promise<AuthTokenRecord | null>;
  revokeAuthTokens(userId: string, purpose?: AuthTokenPurpose): Promise<void>;

  createSession(input: CreateSessionInput): Promise<AuthSessionRecord>;
  findSessionById(id: string): Promise<AuthSessionRecord | null>;
  findSessionByDigest(tokenDigest: string): Promise<AuthSessionRecord | null>;
  rotateSession(input: ReplacementSession): Promise<RefreshRotationResult>;
  revokeSession(id: string, now: Date): Promise<void>;
  revokeSessionFamily(familyId: string, now: Date): Promise<void>;
  revokeAllSessions(userId: string, now: Date): Promise<void>;

  createOAuthTransaction(input: CreateOAuthTransactionInput): Promise<OAuthTransactionRecord>;
  consumeOAuthTransaction(stateDigest: string, now: Date): Promise<OAuthTransactionRecord | null>;
}

export class InMemoryIdentityRepository implements IdentityRepository {
  private readonly users = new Map<string, UserRecord>();
  private readonly usersByEmail = new Map<string, string>();
  private readonly providers = new Map<string, ProviderAccountRecord>();
  private readonly providersByIdentity = new Map<string, string>();
  private readonly tokens = new Map<string, AuthTokenRecord>();
  private readonly sessions = new Map<string, AuthSessionRecord>();
  private readonly sessionsByDigest = new Map<string, string>();
  private readonly oauthTransactions = new Map<string, OAuthTransactionRecord>();
  private readonly oauthByState = new Map<string, string>();

  async findUserById(id: string): Promise<UserRecord | null> {
    const user = this.users.get(id);
    return user ? cloneUser(user) : null;
  }

  async findUserByEmail(email: string): Promise<UserRecord | null> {
    const id = this.usersByEmail.get(email);
    return id ? this.findUserById(id) : null;
  }

  async createUser(input: CreateUserInput): Promise<UserRecord> {
    if (this.usersByEmail.has(input.email)) {
      throw new RepositoryConflictError('A normalized email already exists');
    }
    const now = new Date();
    const user: UserRecord = {
      id: randomUUID(),
      email: input.email,
      displayName: input.displayName,
      passwordHash: input.passwordHash,
      status: input.status,
      emailVerifiedAt: input.emailVerifiedAt ?? null,
      createdAt: now,
      updatedAt: now,
      roles: ['MEMBER'],
    };
    this.users.set(user.id, user);
    this.usersByEmail.set(user.email, user.id);
    return cloneUser(user);
  }

  async updateUser(id: string, input: UpdateUserInput): Promise<UserRecord | null> {
    const user = this.users.get(id);
    if (!user) return null;
    if (input.displayName !== undefined) user.displayName = input.displayName;
    if (input.passwordHash !== undefined) user.passwordHash = input.passwordHash;
    if (input.status !== undefined) user.status = input.status;
    if (input.emailVerifiedAt !== undefined) user.emailVerifiedAt = input.emailVerifiedAt;
    user.updatedAt = new Date();
    return cloneUser(user);
  }

  async findProviderAccount(
    provider: OAuthProviderName,
    providerSubject: string,
  ): Promise<ProviderAccountRecord | null> {
    const id = this.providersByIdentity.get(providerKey(provider, providerSubject));
    const account = id ? this.providers.get(id) : undefined;
    return account ? cloneProvider(account) : null;
  }

  async createProviderAccount(input: CreateProviderAccountInput): Promise<ProviderAccountRecord> {
    const key = providerKey(input.provider, input.providerSubject);
    if (this.providersByIdentity.has(key)) {
      throw new RepositoryConflictError('A provider identity already exists');
    }
    const now = new Date();
    const account: ProviderAccountRecord = {
      id: randomUUID(),
      ...input,
      createdAt: now,
      updatedAt: now,
    };
    this.providers.set(account.id, account);
    this.providersByIdentity.set(key, account.id);
    return cloneProvider(account);
  }

  async updateProviderAccount(
    id: string,
    input: Partial<CreateProviderAccountInput>,
  ): Promise<ProviderAccountRecord | null> {
    const account = this.providers.get(id);
    if (!account) return null;
    if (input.providerSubject !== undefined && input.providerSubject !== account.providerSubject) {
      const nextKey = providerKey(account.provider, input.providerSubject);
      if (this.providersByIdentity.has(nextKey)) throw new RepositoryConflictError();
      this.providersByIdentity.delete(providerKey(account.provider, account.providerSubject));
      this.providersByIdentity.set(nextKey, id);
      account.providerSubject = input.providerSubject;
    }
    if (input.providerEmail !== undefined) account.providerEmail = input.providerEmail;
    if (input.providerDisplayName !== undefined) account.providerDisplayName = input.providerDisplayName;
    if (input.providerAvatarUrl !== undefined) account.providerAvatarUrl = input.providerAvatarUrl;
    if (input.emailVerified !== undefined) account.emailVerified = input.emailVerified;
    account.updatedAt = new Date();
    return cloneProvider(account);
  }

  async createAuthToken(input: CreateAuthTokenInput): Promise<AuthTokenRecord> {
    if (this.tokens.has(input.tokenDigest)) throw new RepositoryConflictError();
    const token: AuthTokenRecord = {
      id: randomUUID(),
      ...input,
      consumedAt: null,
      revokedAt: null,
      createdAt: new Date(),
    };
    this.tokens.set(token.tokenDigest, token);
    return cloneToken(token);
  }

  async consumeAuthToken(
    tokenDigest: string,
    purpose: AuthTokenPurpose,
    now: Date,
  ): Promise<AuthTokenRecord | null> {
    const token = this.tokens.get(tokenDigest);
    if (
      !token ||
      token.purpose !== purpose ||
      token.consumedAt ||
      token.revokedAt ||
      token.expiresAt.getTime() <= now.getTime()
    ) {
      return null;
    }
    token.consumedAt = now;
    return cloneToken(token);
  }

  async revokeAuthTokens(userId: string, purpose?: AuthTokenPurpose): Promise<void> {
    for (const token of this.tokens.values()) {
      if (token.userId === userId && (!purpose || token.purpose === purpose) && !token.consumedAt) {
        token.revokedAt = new Date();
      }
    }
  }

  async createSession(input: CreateSessionInput): Promise<AuthSessionRecord> {
    if (this.sessionsByDigest.has(input.tokenDigest)) throw new RepositoryConflictError();
    const session = this.newSession(input);
    return cloneSession(session);
  }

  async findSessionById(id: string): Promise<AuthSessionRecord | null> {
    const session = this.sessions.get(id);
    return session ? cloneSession(session) : null;
  }

  async findSessionByDigest(tokenDigest: string): Promise<AuthSessionRecord | null> {
    const id = this.sessionsByDigest.get(tokenDigest);
    const session = id ? this.sessions.get(id) : undefined;
    return session ? cloneSession(session) : null;
  }

  async rotateSession(input: ReplacementSession): Promise<RefreshRotationResult> {
    const id = this.sessionsByDigest.get(input.oldDigest);
    const current = id ? this.sessions.get(id) : undefined;
    if (!current) return { status: 'invalid' };
    if (current.revokedAt) {
      if (current.replacedById) {
        await this.revokeSessionFamily(current.familyId, input.now);
        return { status: 'replay' };
      }
      return { status: 'invalid' };
    }
    if (current.expiresAt.getTime() <= input.now.getTime()) {
      current.revokedAt = input.now;
      return { status: 'invalid' };
    }
    if (current.userId !== input.replacement.userId || current.familyId !== input.replacement.familyId) {
      return { status: 'invalid' };
    }
    const replacement = this.newSession(input.replacement);
    current.revokedAt = input.now;
    current.lastUsedAt = input.now;
    current.replacedById = replacement.id;
    return { status: 'rotated', session: cloneSession(replacement) };
  }

  async revokeSession(id: string, now: Date): Promise<void> {
    const session = this.sessions.get(id);
    if (session && !session.revokedAt) session.revokedAt = now;
  }

  async revokeSessionFamily(familyId: string, now: Date): Promise<void> {
    for (const session of this.sessions.values()) {
      if (session.familyId === familyId && !session.revokedAt) session.revokedAt = now;
    }
  }

  async revokeAllSessions(userId: string, now: Date): Promise<void> {
    for (const session of this.sessions.values()) {
      if (session.userId === userId && !session.revokedAt) session.revokedAt = now;
    }
  }

  async createOAuthTransaction(input: CreateOAuthTransactionInput): Promise<OAuthTransactionRecord> {
    if (this.oauthByState.has(input.stateDigest)) throw new RepositoryConflictError();
    const transaction: OAuthTransactionRecord = {
      id: randomUUID(),
      ...input,
      consumedAt: null,
      createdAt: new Date(),
    };
    this.oauthTransactions.set(transaction.id, transaction);
    this.oauthByState.set(transaction.stateDigest, transaction.id);
    return cloneOAuthTransaction(transaction);
  }

  async consumeOAuthTransaction(stateDigest: string, now: Date): Promise<OAuthTransactionRecord | null> {
    const id = this.oauthByState.get(stateDigest);
    const transaction = id ? this.oauthTransactions.get(id) : undefined;
    if (
      !transaction ||
      transaction.consumedAt ||
      transaction.expiresAt.getTime() <= now.getTime()
    ) {
      return null;
    }
    transaction.consumedAt = now;
    return cloneOAuthTransaction(transaction);
  }

  private newSession(input: CreateSessionInput): AuthSessionRecord {
    const session: AuthSessionRecord = {
      id: randomUUID(),
      ...input,
      createdAt: new Date(),
      lastUsedAt: null,
      revokedAt: null,
      replacedById: null,
    };
    this.sessions.set(session.id, session);
    this.sessionsByDigest.set(session.tokenDigest, session.id);
    return session;
  }
}

function providerKey(provider: OAuthProviderName, subject: string): string {
  return provider + ':' + subject;
}

function cloneUser(user: UserRecord): UserRecord {
  return {
    ...user,
    emailVerifiedAt: user.emailVerifiedAt ? new Date(user.emailVerifiedAt) : null,
    createdAt: new Date(user.createdAt),
    updatedAt: new Date(user.updatedAt),
    roles: [...user.roles],
  };
}

function cloneProvider(account: ProviderAccountRecord): ProviderAccountRecord {
  return {
    ...account,
    createdAt: new Date(account.createdAt),
    updatedAt: new Date(account.updatedAt),
  };
}

function cloneToken(token: AuthTokenRecord): AuthTokenRecord {
  return {
    ...token,
    expiresAt: new Date(token.expiresAt),
    consumedAt: token.consumedAt ? new Date(token.consumedAt) : null,
    revokedAt: token.revokedAt ? new Date(token.revokedAt) : null,
    createdAt: new Date(token.createdAt),
  };
}

function cloneSession(session: AuthSessionRecord): AuthSessionRecord {
  return {
    ...session,
    expiresAt: new Date(session.expiresAt),
    createdAt: new Date(session.createdAt),
    lastUsedAt: session.lastUsedAt ? new Date(session.lastUsedAt) : null,
    revokedAt: session.revokedAt ? new Date(session.revokedAt) : null,
  };
}

function cloneOAuthTransaction(transaction: OAuthTransactionRecord): OAuthTransactionRecord {
  return {
    ...transaction,
    expiresAt: new Date(transaction.expiresAt),
    consumedAt: transaction.consumedAt ? new Date(transaction.consumedAt) : null,
    createdAt: new Date(transaction.createdAt),
  };
}
