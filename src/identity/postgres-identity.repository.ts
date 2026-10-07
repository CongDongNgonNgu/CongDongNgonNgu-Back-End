import type { Pool, PoolClient } from 'pg';
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
import {
  type CreateAuthTokenInput,
  type CreateOAuthTransactionInput,
  type CreateProviderAccountInput,
  type CreateSessionInput,
  type CreateUserInput,
  type IdentityUserListQuery,
  type IdentityUserListResult,
  type IdentityRepository,
  type RefreshRotationResult,
  type ReplacementSession,
  type UpdateUserInput,
  RepositoryConflictError,
} from './identity.repository';

export class PostgresIdentityRepository implements IdentityRepository {
  constructor(private readonly pool: Pool) {}

  async findUsersByIds(ids: readonly string[]): Promise<UserRecord[]> {
    if (!ids.length) return [];
    const result = await this.pool.query(
      'SELECT u.*, COALESCE(array_agg(ur.role_key::text) FILTER (WHERE ur.role_key IS NOT NULL), ARRAY[]::text[]) AS roles FROM users u LEFT JOIN user_roles ur ON ur.user_id=u.id WHERE u.id=ANY($1::uuid[]) GROUP BY u.id',
      [ids],
    );
    return result.rows.map(mapUser);
  }

  async findUserById(id: string): Promise<UserRecord | null> {
    const result = await this.pool.query(
      'SELECT u.*, COALESCE(array_agg(ur.role_key::text) FILTER (WHERE ur.role_key IS NOT NULL), ARRAY[]::text[]) AS roles FROM users u LEFT JOIN user_roles ur ON ur.user_id = u.id WHERE u.id = $1 GROUP BY u.id',
      [id],
    );
    return result.rows[0] ? mapUser(result.rows[0]) : null;
  }

  async findUserByEmail(email: string): Promise<UserRecord | null> {
    const result = await this.pool.query(
      'SELECT u.*, COALESCE(array_agg(ur.role_key::text) FILTER (WHERE ur.role_key IS NOT NULL), ARRAY[]::text[]) AS roles FROM users u LEFT JOIN user_roles ur ON ur.user_id = u.id WHERE u.normalized_email = $1 GROUP BY u.id',
      [email],
    );
    return result.rows[0] ? mapUser(result.rows[0]) : null;
  }

  async createUser(input: CreateUserInput): Promise<UserRecord> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        'INSERT INTO users (email, normalized_email, display_name, password_hash, status, email_verified_at) VALUES ($1, $1, $2, $3, $4::user_status, $5) RETURNING *',
        [input.email, input.displayName, input.passwordHash, input.status, input.emailVerifiedAt ?? null],
      );
      const row = result.rows[0];
      await client.query('INSERT INTO user_roles (user_id, role_key) VALUES ($1, $2::role_key)', [row.id, 'MEMBER']);
      await client.query('COMMIT');
      return mapUser({ ...row, roles: ['MEMBER'] });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw mapRepositoryError(error);
    } finally {
      client.release();
    }
  }

  async updateUser(id: string, input: UpdateUserInput): Promise<UserRecord | null> {
    const values: unknown[] = [id];
    const updates: string[] = [];
    if (input.displayName !== undefined) {
      values.push(input.displayName);
      updates.push('display_name = $' + values.length);
    }
    if (input.passwordHash !== undefined) {
      values.push(input.passwordHash);
      updates.push('password_hash = $' + values.length);
    }
    if (input.status !== undefined) {
      values.push(input.status);
      updates.push('status = $' + values.length + '::user_status');
    }
    if (input.emailVerifiedAt !== undefined) {
      values.push(input.emailVerifiedAt);
      updates.push('email_verified_at = $' + values.length);
    }
    if (updates.length === 0) return this.findUserById(id);
    const result = await this.pool.query(
      'UPDATE users SET ' + updates.join(', ') + ', updated_at = now() WHERE id = $1 RETURNING id',
      values,
    );
    return result.rows[0] ? this.findUserById(id) : null;
  }

  async listUsers(query: IdentityUserListQuery): Promise<IdentityUserListResult> {
    const values: unknown[] = [];
    const where: string[] = [];
    const add = (value: unknown): string => {
      values.push(value);
      return '$' + values.length;
    };
    if (query.search) {
      const search = '%' + query.search.trim().toLowerCase() + '%';
      const parameter = add(search);
      where.push(`(LOWER(u.email) LIKE ${parameter} OR LOWER(u.display_name) LIKE ${parameter})`);
    }
    if (query.status) where.push('u.status = ' + add(query.status) + '::user_status');
    if (query.role) {
      where.push(`EXISTS (
        SELECT 1 FROM user_roles role_filter
        WHERE role_filter.user_id = u.id AND role_filter.role_key = ${add(query.role)}::role_key
      )`);
    }
    const filter = where.length ? ' WHERE ' + where.join(' AND ') : '';
    const countResult = await this.pool.query(
      'SELECT COUNT(*)::int AS count FROM users u' + filter,
      [...values],
    );
    const limitParameter = add(query.limit);
    const offsetParameter = add(query.offset);
    const result = await this.pool.query(
      `SELECT u.*,
              COALESCE(array_agg(ur.role_key::text ORDER BY ur.role_key::text)
                       FILTER (WHERE ur.role_key IS NOT NULL), ARRAY[]::text[]) AS roles
       FROM users u
       LEFT JOIN user_roles ur ON ur.user_id = u.id
       ${filter}
       GROUP BY u.id
       ORDER BY u.created_at DESC, u.id DESC
       LIMIT ${limitParameter} OFFSET ${offsetParameter}`,
      values,
    );
    return {
      total: Number(countResult.rows[0]?.count ?? 0),
      items: result.rows.map(mapUser),
    };
  }

  async countUsers(filters: { status?: UserStatus; role?: RoleKey } = {}): Promise<number> {
    const values: unknown[] = [];
    const where: string[] = [];
    if (filters.status) {
      values.push(filters.status);
      where.push('u.status = $' + values.length + '::user_status');
    }
    if (filters.role) {
      values.push(filters.role);
      where.push(`EXISTS (
        SELECT 1 FROM user_roles role_filter
        WHERE role_filter.user_id = u.id AND role_filter.role_key = $${values.length}::role_key
      )`);
    }
    const result = await this.pool.query(
      'SELECT COUNT(*)::int AS count FROM users u' + (where.length ? ' WHERE ' + where.join(' AND ') : ''),
      values,
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async countActiveAdministrators(): Promise<number> {
    return this.countUsers({ status: 'ACTIVE', role: 'ADMIN' });
  }

  async replaceUserRoles(id: string, roles: readonly RoleKey[]): Promise<UserRecord | null> {
    const nextRoles = [...new Set(roles)];
    if (nextRoles.length === 0) throw new RepositoryConflictError('A user must retain at least one role');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query(
        `SELECT u.status,
                EXISTS (SELECT 1 FROM user_roles current_role WHERE current_role.user_id = u.id AND current_role.role_key = 'ADMIN'::role_key) AS is_admin
           FROM users u
          WHERE u.id = $1
          FOR UPDATE`,
        [id],
      );
      if (!current.rows[0]) {
        await client.query('COMMIT');
        return null;
      }
      if (current.rows[0].status === 'ACTIVE' && current.rows[0].is_admin && !nextRoles.includes('ADMIN')) {
        const admins = await client.query(
          `SELECT u.id
             FROM users u
             INNER JOIN user_roles ur ON ur.user_id = u.id AND ur.role_key = 'ADMIN'::role_key
            WHERE u.status = 'ACTIVE'::user_status
            FOR UPDATE`,
        );
        if (admins.rows.length <= 1) {
          throw new RepositoryConflictError('The last active administrator cannot be removed');
        }
      }
      await client.query('DELETE FROM user_roles WHERE user_id = $1', [id]);
      for (const role of nextRoles) {
        await client.query(
          'INSERT INTO user_roles (user_id, role_key) VALUES ($1, $2::role_key)',
          [id, role],
        );
      }
      await client.query('UPDATE users SET updated_at = now() WHERE id = $1', [id]);
      await client.query('COMMIT');
      return this.findUserById(id);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw mapRepositoryError(error);
    } finally {
      client.release();
    }
  }

  async findProviderAccount(
    provider: OAuthProviderName,
    providerSubject: string,
  ): Promise<ProviderAccountRecord | null> {
    const result = await this.pool.query(
      'SELECT * FROM provider_accounts WHERE provider = $1::oauth_provider AND provider_subject = $2',
      [provider, providerSubject],
    );
    return result.rows[0] ? mapProvider(result.rows[0]) : null;
  }

  async createProviderAccount(input: CreateProviderAccountInput): Promise<ProviderAccountRecord> {
    try {
      const result = await this.pool.query(
        'INSERT INTO provider_accounts (user_id, provider, provider_subject, provider_email, provider_display_name, provider_avatar_url, email_verified) VALUES ($1, $2::oauth_provider, $3, $4, $5, $6, $7) RETURNING *',
        [
          input.userId,
          input.provider,
          input.providerSubject,
          input.providerEmail,
          input.providerDisplayName,
          input.providerAvatarUrl,
          input.emailVerified,
        ],
      );
      return mapProvider(result.rows[0]);
    } catch (error) {
      throw mapRepositoryError(error);
    }
  }

  async updateProviderAccount(
    id: string,
    input: Partial<CreateProviderAccountInput>,
  ): Promise<ProviderAccountRecord | null> {
    const values: unknown[] = [id];
    const updates: string[] = [];
    if (input.providerSubject !== undefined) {
      values.push(input.providerSubject);
      updates.push('provider_subject = $' + values.length);
    }
    if (input.providerEmail !== undefined) {
      values.push(input.providerEmail);
      updates.push('provider_email = $' + values.length);
    }
    if (input.providerDisplayName !== undefined) {
      values.push(input.providerDisplayName);
      updates.push('provider_display_name = $' + values.length);
    }
    if (input.providerAvatarUrl !== undefined) {
      values.push(input.providerAvatarUrl);
      updates.push('provider_avatar_url = $' + values.length);
    }
    if (input.emailVerified !== undefined) {
      values.push(input.emailVerified);
      updates.push('email_verified = $' + values.length);
    }
    if (updates.length === 0) {
      const current = await this.pool.query('SELECT * FROM provider_accounts WHERE id = $1', [id]);
      return current.rows[0] ? mapProvider(current.rows[0]) : null;
    }
    try {
      const result = await this.pool.query(
        'UPDATE provider_accounts SET ' + updates.join(', ') + ', updated_at = now() WHERE id = $1 RETURNING *',
        values,
      );
      return result.rows[0] ? mapProvider(result.rows[0]) : null;
    } catch (error) {
      throw mapRepositoryError(error);
    }
  }

  async createAuthToken(input: CreateAuthTokenInput): Promise<AuthTokenRecord> {
    try {
      const result = await this.pool.query(
        'INSERT INTO auth_tokens (user_id, purpose, token_digest, expires_at) VALUES ($1, $2::auth_token_purpose, $3, $4) RETURNING *',
        [input.userId, input.purpose, input.tokenDigest, input.expiresAt],
      );
      return mapToken(result.rows[0]);
    } catch (error) {
      throw mapRepositoryError(error);
    }
  }

  async consumeAuthToken(
    tokenDigest: string,
    purpose: AuthTokenPurpose,
    now: Date,
  ): Promise<AuthTokenRecord | null> {
    const result = await this.pool.query(
      'UPDATE auth_tokens SET consumed_at = $3 WHERE token_digest = $1 AND purpose = $2::auth_token_purpose AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > $3 RETURNING *',
      [tokenDigest, purpose, now],
    );
    return result.rows[0] ? mapToken(result.rows[0]) : null;
  }

  async revokeAuthTokens(userId: string, purpose?: AuthTokenPurpose): Promise<void> {
    if (purpose) {
      await this.pool.query(
        'UPDATE auth_tokens SET revoked_at = now() WHERE user_id = $1 AND purpose = $2::auth_token_purpose AND consumed_at IS NULL AND revoked_at IS NULL',
        [userId, purpose],
      );
      return;
    }
    await this.pool.query(
      'UPDATE auth_tokens SET revoked_at = now() WHERE user_id = $1 AND consumed_at IS NULL AND revoked_at IS NULL',
      [userId],
    );
  }

  async createSession(input: CreateSessionInput): Promise<AuthSessionRecord> {
    try {
      const result = await this.pool.query(
        'INSERT INTO auth_sessions (user_id, family_id, token_digest, expires_at) VALUES ($1, $2, $3, $4) RETURNING *',
        [input.userId, input.familyId, input.tokenDigest, input.expiresAt],
      );
      return mapSession(result.rows[0]);
    } catch (error) {
      throw mapRepositoryError(error);
    }
  }

  async findSessionById(id: string): Promise<AuthSessionRecord | null> {
    const result = await this.pool.query('SELECT * FROM auth_sessions WHERE id = $1', [id]);
    return result.rows[0] ? mapSession(result.rows[0]) : null;
  }

  async findSessionByDigest(tokenDigest: string): Promise<AuthSessionRecord | null> {
    const result = await this.pool.query('SELECT * FROM auth_sessions WHERE token_digest = $1', [tokenDigest]);
    return result.rows[0] ? mapSession(result.rows[0]) : null;
  }

  async rotateSession(input: ReplacementSession): Promise<RefreshRotationResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const currentResult = await client.query(
        'SELECT * FROM auth_sessions WHERE token_digest = $1 FOR UPDATE',
        [input.oldDigest],
      );
      const current = currentResult.rows[0] ? mapSession(currentResult.rows[0]) : null;
      if (!current) {
        await client.query('COMMIT');
        return { status: 'invalid' };
      }
      if (current.revokedAt) {
        if (current.replacedById) {
          await client.query(
            'UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, $1) WHERE family_id = $2',
            [input.now, current.familyId],
          );
          await client.query('COMMIT');
          return { status: 'replay' };
        }
        await client.query('COMMIT');
        return { status: 'invalid' };
      }
      if (
        current.expiresAt.getTime() <= input.now.getTime() ||
        current.userId !== input.replacement.userId ||
        current.familyId !== input.replacement.familyId
      ) {
        await client.query('UPDATE auth_sessions SET revoked_at = $1 WHERE id = $2', [input.now, current.id]);
        await client.query('COMMIT');
        return { status: 'invalid' };
      }
      const replacementResult = await client.query(
        'INSERT INTO auth_sessions (user_id, family_id, token_digest, expires_at) VALUES ($1, $2, $3, $4) RETURNING *',
        [
          input.replacement.userId,
          input.replacement.familyId,
          input.replacement.tokenDigest,
          input.replacement.expiresAt,
        ],
      );
      const replacement = mapSession(replacementResult.rows[0]);
      await client.query(
        'UPDATE auth_sessions SET revoked_at = $1, last_used_at = $1, replaced_by_id = $2 WHERE id = $3',
        [input.now, replacement.id, current.id],
      );
      await client.query('COMMIT');
      return { status: 'rotated', session: replacement };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw mapRepositoryError(error);
    } finally {
      client.release();
    }
  }

  async revokeSession(id: string, now: Date): Promise<void> {
    await this.pool.query(
      'UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, $1) WHERE id = $2',
      [now, id],
    );
  }

  async revokeSessionFamily(familyId: string, now: Date): Promise<void> {
    await this.pool.query(
      'UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, $1) WHERE family_id = $2',
      [now, familyId],
    );
  }

  async revokeAllSessions(userId: string, now: Date): Promise<void> {
    await this.pool.query(
      'UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, $1) WHERE user_id = $2',
      [now, userId],
    );
  }

  async createOAuthTransaction(input: CreateOAuthTransactionInput): Promise<OAuthTransactionRecord> {
    try {
      const result = await this.pool.query(
        'INSERT INTO oauth_transactions (provider, mode, user_id, session_id, state_digest, expires_at) VALUES ($1::oauth_provider, $2::oauth_transaction_mode, $3, $4, $5, $6) RETURNING *',
        [input.provider, input.mode, input.userId, input.sessionId, input.stateDigest, input.expiresAt],
      );
      return mapOAuthTransaction(result.rows[0]);
    } catch (error) {
      throw mapRepositoryError(error);
    }
  }

  async consumeOAuthTransaction(stateDigest: string, now: Date): Promise<OAuthTransactionRecord | null> {
    const result = await this.pool.query(
      'UPDATE oauth_transactions SET consumed_at = $2 WHERE state_digest = $1 AND consumed_at IS NULL AND expires_at > $2 RETURNING *',
      [stateDigest, now],
    );
    return result.rows[0] ? mapOAuthTransaction(result.rows[0]) : null;
  }
}

function mapUser(row: Record<string, unknown>): UserRecord {
  return {
    id: String(row.id),
    email: String(row.email),
    displayName: String(row.display_name),
    passwordHash: row.password_hash === null ? null : String(row.password_hash),
    status: String(row.status) as UserStatus,
    emailVerifiedAt: row.email_verified_at ? new Date(String(row.email_verified_at)) : null,
    createdAt: new Date(String(row.created_at)),
    updatedAt: new Date(String(row.updated_at)),
    roles: ((row.roles as string[] | undefined) ?? []).map((role) => role as RoleKey),
  };
}

function mapProvider(row: Record<string, unknown>): ProviderAccountRecord {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    provider: String(row.provider) as OAuthProviderName,
    providerSubject: String(row.provider_subject),
    providerEmail: row.provider_email ? String(row.provider_email) : null,
    providerDisplayName: row.provider_display_name ? String(row.provider_display_name) : null,
    providerAvatarUrl: row.provider_avatar_url ? String(row.provider_avatar_url) : null,
    emailVerified: Boolean(row.email_verified),
    createdAt: new Date(String(row.created_at)),
    updatedAt: new Date(String(row.updated_at)),
  };
}

function mapToken(row: Record<string, unknown>): AuthTokenRecord {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    purpose: String(row.purpose) as AuthTokenPurpose,
    tokenDigest: String(row.token_digest),
    expiresAt: new Date(String(row.expires_at)),
    consumedAt: row.consumed_at ? new Date(String(row.consumed_at)) : null,
    revokedAt: row.revoked_at ? new Date(String(row.revoked_at)) : null,
    createdAt: new Date(String(row.created_at)),
  };
}

function mapSession(row: Record<string, unknown>): AuthSessionRecord {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    familyId: String(row.family_id),
    tokenDigest: String(row.token_digest),
    expiresAt: new Date(String(row.expires_at)),
    createdAt: new Date(String(row.created_at)),
    lastUsedAt: row.last_used_at ? new Date(String(row.last_used_at)) : null,
    revokedAt: row.revoked_at ? new Date(String(row.revoked_at)) : null,
    replacedById: row.replaced_by_id ? String(row.replaced_by_id) : null,
  };
}

function mapOAuthTransaction(row: Record<string, unknown>): OAuthTransactionRecord {
  return {
    id: String(row.id),
    provider: String(row.provider) as OAuthProviderName,
    mode: String(row.mode) as OAuthTransactionRecord['mode'],
    userId: row.user_id ? String(row.user_id) : null,
    sessionId: row.session_id ? String(row.session_id) : null,
    stateDigest: String(row.state_digest),
    expiresAt: new Date(String(row.expires_at)),
    consumedAt: row.consumed_at ? new Date(String(row.consumed_at)) : null,
    createdAt: new Date(String(row.created_at)),
  };
}

function mapRepositoryError(error: unknown): Error {
  if (isUniqueViolation(error)) return new RepositoryConflictError();
  return error instanceof Error ? error : new Error('Identity persistence failed');
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === '23505';
}
