export type UserStatus = 'ACTIVE' | 'VERIFICATION_PENDING' | 'DISABLED';
export type RoleKey = 'MEMBER' | 'MODERATOR' | 'ADMIN';
export type OAuthProviderName = 'google' | 'facebook' | 'zalo' | 'apple';
export type AuthTokenPurpose = 'EMAIL_VERIFICATION' | 'PASSWORD_RESET';

export interface UserRecord {
  id: string;
  email: string;
  displayName: string;
  passwordHash: string | null;
  status: UserStatus;
  emailVerifiedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  roles: RoleKey[];
}

export interface ProviderAccountRecord {
  id: string;
  userId: string;
  provider: OAuthProviderName;
  providerSubject: string;
  providerEmail: string | null;
  providerDisplayName: string | null;
  providerAvatarUrl: string | null;
  emailVerified: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface AuthSessionRecord {
  id: string;
  userId: string;
  familyId: string;
  tokenDigest: string;
  expiresAt: Date;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  replacedById: string | null;
}

export interface AuthTokenRecord {
  id: string;
  userId: string;
  purpose: AuthTokenPurpose;
  tokenDigest: string;
  expiresAt: Date;
  consumedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

export interface OAuthTransactionRecord {
  id: string;
  provider: OAuthProviderName;
  mode: 'login' | 'register' | 'link';
  userId: string | null;
  stateDigest: string;
  expiresAt: Date;
  consumedAt: Date | null;
  createdAt: Date;
}

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function isValidEmail(value: string): boolean {
  return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}
