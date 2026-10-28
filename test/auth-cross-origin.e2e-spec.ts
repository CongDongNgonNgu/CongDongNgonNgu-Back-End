import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { IDENTITY_REPOSITORY } from '../src/identity/identity.module';
import type { IdentityRepository } from '../src/identity/identity.repository';
import { SessionService } from '../src/auth/session/session.service';

const ORIGIN = 'https://congdongngonngu.vn';
const API = 'api.congdongngonngu.vn';

describe('cross-subdomain OAuth session (provider boundary simulated)', () => {
  let app: INestApplication;
  let provider: jest.SpyInstance;
  beforeAll(async () => {
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication();
    const config = app.get(ConfigService);
    config.set('app', { ...config.get('app'), corsOrigins: [ORIGIN], publicAppUrl: ORIGIN });
    config.set('auth', { ...config.get('auth'), oauth: { ...config.get('auth.oauth'), google: {
      enabled: true, clientId: 'local-client', clientSecret: 'local-provider-secret',
      redirectUri: 'https://' + API + '/api/v1/auth/oauth/google/callback',
      scopes: ['openid', 'email', 'profile'],
      authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      userInfoUrl: 'https://openidconnect.googleapis.com/v1/userinfo',
    } } });
    configureApp(app);
    await app.init();
    provider = jest.spyOn(globalThis, 'fetch');
  });
  afterAll(async () => { provider.mockRestore(); await app.close(); });

  it.each(['register', 'login', 'link'] as const)('%s callback, refresh, persistence, replay and logout', async mode => {
    const api = request(app.getHttpServer());
    const email = mode + '@cross-origin.example';
    let start;
    if (mode === 'link') {
      const user = await app.get<IdentityRepository>(IDENTITY_REPOSITORY).createUser({
        email, displayName: 'Existing account', passwordHash: null, status: 'ACTIVE', emailVerifiedAt: new Date(),
      });
      const cookies: string[] = [];
      const issued = await app.get(SessionService).issue(user, { append: (_name: string, value: string) => cookies.push(value) } as never);
      start = await api.post('/api/v1/auth/oauth/google/link/start').set('Host', API)
        .set('Origin', ORIGIN).set('Authorization', 'Bearer ' + issued.accessToken)
        .set('Cookie', cookieHeader(cookies)).set('X-CSRF-Token', value(cookies, 'cdn_csrf')).expect(201);
    } else {
      if (mode === 'login') {
        const repo = app.get<IdentityRepository>(IDENTITY_REPOSITORY);
        const user = await repo.createUser({ email, displayName: 'Existing Google', passwordHash: null, status: 'ACTIVE', emailVerifiedAt: new Date() });
        await repo.createProviderAccount({ userId: user.id, provider: 'google', providerSubject: mode,
          providerEmail: email, providerDisplayName: user.displayName, providerAvatarUrl: null, emailVerified: true });
      }
      start = await api.get('/api/v1/auth/oauth/google/start?mode=' + mode).set('Host', API).expect(302);
    }
    const state = new URL(mode === 'link' ? start.body.data.authorizationUrl : start.headers.location).searchParams.get('state')!;
    provider.mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'local-provider-access' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ sub: mode, email, email_verified: true, name: 'OAuth learner' })));
    const callback = await api.get('/api/v1/auth/oauth/google/callback').query({ state, code: 'local-code' })
      .set('Host', API).set('Cookie', cookieHeader(start.headers['set-cookie'] as unknown as string[])).expect(302);
    expect(callback.headers.location).toBe(ORIGIN + '/auth/callback?status=success');
    const cookies = callback.headers['set-cookie'] as unknown as string[];
    expect(cookies.find(cookie => cookie.startsWith('cdn_refresh='))).toContain('HttpOnly');
    for (const cookie of cookies) expect(cookie).not.toMatch(/Domain=/i);
    const old = cookieHeader(cookies);
    await api.post('/api/v1/auth/refresh').set('Host', API).set('Origin', ORIGIN).set('Cookie', old).expect(403);
    const csrf = await api.get('/api/v1/auth/csrf').set('Host', API).set('Origin', ORIGIN).set('Cookie', old).expect(200);
    const refresh = await api.post('/api/v1/auth/refresh').set('Host', API).set('Origin', ORIGIN)
      .set('Cookie', old).set('X-CSRF-Token', csrf.body.data.csrfToken).expect(201);
    const me = await api.get('/api/v1/auth/me').set('Authorization', 'Bearer ' + refresh.body.data.accessToken).expect(200);
    expect(me.body.data.email).toBe(email);
    // A reload has only the rotated cookies, with no access token in JavaScript.
    const rotated = cookieHeader(refresh.headers['set-cookie'] as unknown as string[]);
    const reloadCsrf = await api.get('/api/v1/auth/csrf').set('Origin', ORIGIN).set('Cookie', rotated).expect(200);
    const reload = await api.post('/api/v1/auth/refresh').set('Origin', ORIGIN).set('Cookie', rotated)
      .set('X-CSRF-Token', reloadCsrf.body.data.csrfToken).expect(201);
    const current = cookieHeader(reload.headers['set-cookie'] as unknown as string[]);
    const currentCsrf = value(reload.headers['set-cookie'] as unknown as string[], 'cdn_csrf');
    await api.post('/api/v1/auth/logout').set('Origin', ORIGIN).set('Cookie', current)
      .set('X-CSRF-Token', currentCsrf).expect(201);
    await api.post('/api/v1/auth/refresh').set('Origin', ORIGIN).set('Cookie', current)
      .set('X-CSRF-Token', currentCsrf).expect(401);
    await api.post('/api/v1/auth/refresh').set('Origin', ORIGIN).set('Cookie', old)
      .set('X-CSRF-Token', csrf.body.data.csrfToken).expect(401)
      .expect(({ body }) => expect(body.error.code).toBe('AUTH_REFRESH_REUSE_DETECTED'));
  });
});
function cookieHeader(cookies: string[]): string { return cookies.map(cookie => cookie.split(';')[0]).join('; '); }
function value(cookies: string[], name: string): string { return cookies.find(cookie => cookie.startsWith(name + '='))!.split(';')[0].slice(name.length + 1); }
