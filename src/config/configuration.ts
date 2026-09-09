import type { ValidatedEnvironment } from "./env.validation";

export interface RuntimeConfig {
  app: {
    environment: ValidatedEnvironment["NODE_ENV"];
    port: number;
    publicAppUrl: string;
    corsOrigins: string[];
  };
  database: {
    url: string;
  };
  auth: {
    persistence: 'postgres' | 'memory';
    accessTtlSeconds: number;
    refreshTtlSeconds: number;
    refreshCookieName: string;
    csrfCookieName: string;
    oauth: Record<string, {
      enabled: boolean;
      clientId?: string;
      clientSecret?: string;
      redirectUri?: string;
      scopes: string[];
      authorizationUrl: string;
      tokenUrl: string;
      userInfoUrl?: string;
    }>;
    accessSecret: string;
    refreshSecret: string;
    sessionStore: ValidatedEnvironment["SESSION_STORE"];
    sessionSecret?: string;
  };
  providers: {
    oauth: ValidatedEnvironment["OAUTH_PROVIDER"];
    oauthClientId?: string;
    oauthClientSecret?: string;
    oauthRedirectUri?: string;
    ai: ValidatedEnvironment["AI_PROVIDER"];
    aiApiUrl?: string;
    aiApiKey?: string;
    email: ValidatedEnvironment["EMAIL_PROVIDER"];
    emailApiUrl?: string;
    emailApiKey?: string;
    storage: ValidatedEnvironment["STORAGE_PROVIDER"];
    storageApiUrl?: string;
    storageAccessKeyId?: string;
    storageSecretAccessKey?: string;
    storageBucket?: string;
    realtime: ValidatedEnvironment["REALTIME_PROVIDER"];
    realtimeApiUrl?: string;
    realtimeApiKey?: string;
    payment: ValidatedEnvironment["PAYMENT_PROVIDER"];
    paymentApiUrl?: string;
    paymentApiKey?: string;
    paymentWebhookSecret?: string;
    redisUrl?: string;
  };
}

export function buildConfiguration(env: ValidatedEnvironment): RuntimeConfig {
  return {
    app: {
      environment: env.NODE_ENV,
      port: env.PORT,
      publicAppUrl: env.PUBLIC_APP_URL,
      corsOrigins: env.CORS_ALLOWED_ORIGINS,
    },
    database: { url: env.DATABASE_URL },
    auth: {
      persistence: env.AUTH_PERSISTENCE,
      accessTtlSeconds: env.AUTH_ACCESS_TTL_SECONDS,
      refreshTtlSeconds: env.AUTH_REFRESH_TTL_SECONDS,
      refreshCookieName: 'cdn_refresh',
      csrfCookieName: 'cdn_csrf',
      oauth: env.AUTH_OAUTH_PROVIDERS,
      accessSecret: env.JWT_ACCESS_SECRET,
      refreshSecret: env.JWT_REFRESH_SECRET,
      sessionStore: env.SESSION_STORE,
      ...(env.SESSION_SECRET ? { sessionSecret: env.SESSION_SECRET } : {}),
    },
    providers: {
      oauth: env.OAUTH_PROVIDER,
      ...(env.OAUTH_CLIENT_ID ? { oauthClientId: env.OAUTH_CLIENT_ID } : {}),
      ...(env.OAUTH_CLIENT_SECRET ? { oauthClientSecret: env.OAUTH_CLIENT_SECRET } : {}),
      ...(env.OAUTH_REDIRECT_URI ? { oauthRedirectUri: env.OAUTH_REDIRECT_URI } : {}),
      ai: env.AI_PROVIDER,
      ...(env.AI_API_URL ? { aiApiUrl: env.AI_API_URL } : {}),
      ...(env.AI_API_KEY ? { aiApiKey: env.AI_API_KEY } : {}),
      email: env.EMAIL_PROVIDER,
      ...(env.EMAIL_API_URL ? { emailApiUrl: env.EMAIL_API_URL } : {}),
      ...(env.EMAIL_API_KEY ? { emailApiKey: env.EMAIL_API_KEY } : {}),
      storage: env.STORAGE_PROVIDER,
      ...(env.STORAGE_API_URL ? { storageApiUrl: env.STORAGE_API_URL } : {}),
      ...(env.STORAGE_ACCESS_KEY_ID ? { storageAccessKeyId: env.STORAGE_ACCESS_KEY_ID } : {}),
      ...(env.STORAGE_SECRET_ACCESS_KEY ? { storageSecretAccessKey: env.STORAGE_SECRET_ACCESS_KEY } : {}),
      ...(env.STORAGE_BUCKET ? { storageBucket: env.STORAGE_BUCKET } : {}),
      realtime: env.REALTIME_PROVIDER,
      ...(env.REALTIME_API_URL ? { realtimeApiUrl: env.REALTIME_API_URL } : {}),
      ...(env.REALTIME_API_KEY ? { realtimeApiKey: env.REALTIME_API_KEY } : {}),
      payment: env.PAYMENT_PROVIDER,
      ...(env.PAYMENT_API_URL ? { paymentApiUrl: env.PAYMENT_API_URL } : {}),
      ...(env.PAYMENT_API_KEY ? { paymentApiKey: env.PAYMENT_API_KEY } : {}),
      ...(env.PAYMENT_WEBHOOK_SECRET ? { paymentWebhookSecret: env.PAYMENT_WEBHOOK_SECRET } : {}),
      ...(env.REDIS_URL ? { redisUrl: env.REDIS_URL } : {}),
    },
  };
}
