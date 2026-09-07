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
    accessSecret: string;
    refreshSecret: string;
  };
  providers: {
    ai: ValidatedEnvironment["AI_PROVIDER"];
    email: ValidatedEnvironment["EMAIL_PROVIDER"];
    storage: ValidatedEnvironment["STORAGE_PROVIDER"];
    realtime: ValidatedEnvironment["REALTIME_PROVIDER"];
    payment: ValidatedEnvironment["PAYMENT_PROVIDER"];
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
      accessSecret: env.JWT_ACCESS_SECRET,
      refreshSecret: env.JWT_REFRESH_SECRET,
    },
    providers: {
      ai: env.AI_PROVIDER,
      email: env.EMAIL_PROVIDER,
      storage: env.STORAGE_PROVIDER,
      realtime: env.REALTIME_PROVIDER,
      payment: env.PAYMENT_PROVIDER,
      ...(env.REDIS_URL ? { redisUrl: env.REDIS_URL } : {}),
    },
  };
}
