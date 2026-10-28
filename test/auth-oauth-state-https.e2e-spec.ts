import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';

const ORIGIN = 'https://cong-dong-ngon-ngu-sigma.vercel.app';

describe('HTTPS TEST same-origin OAuth proxy contract', () => {
  let app: INestApplication;
  beforeAll(async () => {
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication();
    const config = app.get(ConfigService);
    config.set('app', { ...config.get('app'), publicAppUrl: ORIGIN, corsOrigins: [ORIGIN] });
    config.set('auth', { ...config.get('auth'), oauth: { ...config.get('auth.oauth'), google: {
      enabled: true, clientId: 'fixture-client', clientSecret: 'fixture-secret',
      redirectUri: ORIGIN + '/api/v1/auth/oauth/google/callback', scopes: ['openid', 'email', 'profile'],
      authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token', userInfoUrl: 'https://openidconnect.googleapis.com/v1/userinfo',
    } } });
    configureApp(app);
    await app.init();
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => app.close());

  it('issues Secure host-only state and preserves callback, refresh and logout through the frontend host', async () => {
    const api = request(app.getHttpServer());
    const start = await api.get('/api/v1/auth/oauth/google/start')
      .set('Host', new URL(ORIGIN).host).set('X-Forwarded-Proto', 'http').expect(302);
    const url = new URL(start.headers.location);
    expect(url.searchParams.get('redirect_uri')).toBe(ORIGIN + '/api/v1/auth/oauth/google/callback');
    const cookies = start.headers['set-cookie'] as unknown as string[];
    expect(cookies).toHaveLength(1);
    assertStateCookie(cookies[0], 600);
    jest.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'fixture-provider-token' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ sub: 'https-test-user', email: 'https-test@example.invalid', email_verified: true, name: 'TEST' })));
    const callback = await api.get('/api/v1/auth/oauth/google/callback')
      .query({ state: url.searchParams.get('state'), code: 'fixture-code' })
      .set('Host', new URL(ORIGIN).host).set('Cookie', cookies[0].split(';')[0]).expect(302);
    expect(callback.headers.location).toBe(ORIGIN + '/auth/callback?status=success');
    const sessionCookies = callback.headers['set-cookie'] as unknown as string[];
    assertStateCookie(sessionCookies.find(value => value.startsWith('cdn_oauth_state='))!, 0);
    const sessionHeader = sessionCookies.filter(value => !value.startsWith('cdn_oauth_state=')).map(value => value.split(';')[0]).join('; ');
    const csrf = sessionCookies.find(value => value.startsWith('cdn_csrf='))!.split(';')[0].slice('cdn_csrf='.length);
    const refresh = await api.post('/api/v1/auth/refresh').set('Origin', ORIGIN)
      .set('Cookie', sessionHeader).set('X-CSRF-Token', csrf).expect(201);
    const rotated = refresh.headers['set-cookie'] as unknown as string[];
    await api.post('/api/v1/auth/logout').set('Origin', ORIGIN)
      .set('Cookie', rotated.map(value => value.split(';')[0]).join('; '))
      .set('X-CSRF-Token', rotated.find(value => value.startsWith('cdn_csrf='))!.split(';')[0].slice('cdn_csrf='.length)).expect(201);
  });

  it.each([undefined, 'different-state'])('rejects missing/mismatched state and clears with Secure', async state => {
    const provider = jest.spyOn(globalThis, 'fetch');
    const callback = await request(app.getHttpServer()).get('/api/v1/auth/oauth/google/callback')
      .query({ state, code: 'fixture-code' }).set('Cookie', 'cdn_oauth_state=original-state')
      .set('X-Forwarded-Proto', 'http').expect(302);
    expect(callback.headers.location).toBe(ORIGIN + '/auth/callback?status=error&code=AUTH_OAUTH_STATE_INVALID');
    assertStateCookie((callback.headers['set-cookie'] as unknown as string[])[0], 0);
    expect(provider).not.toHaveBeenCalled();
  });
});

function assertStateCookie(cookie: string, maxAge: number): void {
  expect(cookie).toContain('; Secure');
  expect(cookie).toContain('; HttpOnly');
  expect(cookie).toContain('; SameSite=Lax');
  expect(cookie).toContain('; Path=/api/v1/auth/oauth');
  expect(cookie).toContain('; Max-Age=' + maxAge);
  expect(cookie).not.toMatch(/Domain=/i);
}
