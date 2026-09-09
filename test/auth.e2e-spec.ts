import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { EMAIL_PROVIDER, MemoryEmailProvider } from '../src/auth/email/email.provider';
import { AuthRateLimiter } from '../src/auth/rate-limit/rate-limiter';
import { createOpaqueToken, digestOpaqueToken } from '../src/auth/crypto/token-crypto';
import { IDENTITY_REPOSITORY } from '../src/identity/identity.module';
import type { IdentityRepository } from '../src/identity/identity.repository';

describe('auth API', () => {
  let app: INestApplication;
  let agent: ReturnType<typeof request.agent>;
  let emailProvider: MemoryEmailProvider;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    agent = request.agent(app.getHttpServer());
    emailProvider = app.get<MemoryEmailProvider>(EMAIL_PROVIDER);
  });

  afterAll(async () => {
    await app.close();
  });

  it('runs register, verify, login, refresh rotation, replay protection, and logout', async () => {
    const email = 'auth-flow@example.com';
    const password = 'Correct horse battery staple 2026';

    const registration = await agent
      .post('/api/v1/auth/register')
      .send({ email, displayName: 'Auth Flow', password })
      .expect(201);
    expect(registration.body).toMatchObject({
      success: true,
      data: { verificationRequired: true },
    });

    const duplicate = await agent
      .post('/api/v1/auth/register')
      .send({ email: email.toUpperCase(), displayName: 'Other Name', password })
      .expect(201);
    expect(duplicate.body.data).toEqual({ verificationRequired: true });
    expect(emailProvider.messages).toHaveLength(1);

    await agent
      .post('/api/v1/auth/register')
      .send({ email: 'not-an-email', displayName: 'Bad', password })
      .expect(400);

    const verificationToken = emailProvider.messages[0].token;
    const verification = await agent
      .post('/api/v1/auth/verify-email')
      .send({ token: verificationToken })
      .expect(201);
    expect(verification.body.data).toEqual({ verified: true });
    await agent
      .post('/api/v1/auth/verify-email')
      .send({ token: verificationToken })
      .expect(400)
      .expect(({ body }) => expect(body.error.code).toBe('AUTH_VERIFICATION_INVALID'));

    const login = await agent
      .post('/api/v1/auth/login')
      .send({ email, password })
      .expect(201);
    const oldAccessToken = login.body.data.accessToken as string;
    const loginCookies = login.headers['set-cookie'] as unknown as string[];
    const oldRefresh = cookieValue(loginCookies, 'cdn_refresh');
    const csrf = cookieValue(loginCookies, 'cdn_csrf');
    expect(oldRefresh).toBeTruthy();
    expect(csrf).toBeTruthy();

    await agent
      .get('/api/v1/auth/me')
      .set('Authorization', 'Bearer ' + oldAccessToken)
      .expect(200)
      .expect(({ body }) => {
        expect(body.data).toMatchObject({
          email,
          displayName: 'Auth Flow',
          emailVerified: true,
        });
        expect(body.data.passwordHash).toBeUndefined();
      });

    await agent
      .get('/api/v1/auth/me?userId=another-user')
      .set('Authorization', 'Bearer ' + oldAccessToken)
      .expect(200)
      .expect(({ body }) => expect(body.data.email).toBe(email));

    const refreshed = await agent
      .post('/api/v1/auth/refresh')
      .set('X-CSRF-Token', csrf)
      .expect(201);
    const newAccessToken = refreshed.body.data.accessToken as string;
    const rotatedCookies = refreshed.headers['set-cookie'] as unknown as string[];
    const newRefresh = cookieValue(rotatedCookies, 'cdn_refresh');
    const newCsrf = cookieValue(rotatedCookies, 'cdn_csrf');
    expect(newRefresh).toBeTruthy();
    expect(newRefresh).not.toBe(oldRefresh);

    await agent
      .get('/api/v1/auth/me')
      .set('Authorization', 'Bearer ' + newAccessToken)
      .expect(200);

    await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .set('Cookie', 'cdn_refresh=' + oldRefresh + '; cdn_csrf=' + csrf)
      .set('X-CSRF-Token', csrf)
      .expect(401)
      .expect(({ body }) => expect(body.error.code).toBe('AUTH_REFRESH_REUSE_DETECTED'));

    await agent
      .post('/api/v1/auth/refresh')
      .set('X-CSRF-Token', newCsrf)
      .expect(401);

    const loginAgain = await agent
      .post('/api/v1/auth/login')
      .send({ email, password })
      .expect(201);
    await agent
      .post('/api/v1/auth/logout')
      .set('X-CSRF-Token', cookieValue(loginAgain.headers['set-cookie'] as unknown as string[], 'cdn_csrf'))
      .expect(201);
    await agent
      .get('/api/v1/auth/me')
      .set('Authorization', 'Bearer ' + loginAgain.body.data.accessToken)
      .expect(401);
  });

  it('keeps credential errors generic and enforces password, lifecycle, and rate limits', async () => {
    const api = request(app.getHttpServer());
    const email = 'policy-pending@example.com';
    const password = 'Policy password 2026';

    await api.post('/api/v1/auth/register').send({
      email,
      displayName: 'Policy Pending',
      password,
    }).expect(201);
    await api.post('/api/v1/auth/register').send({
      email: 'invalid-password@example.com',
      displayName: 'Invalid Password',
      password: 'short',
    }).expect(400);

    const wrongPassword = await api.post('/api/v1/auth/login').send({
      email,
      password: 'Wrong password 2026',
    }).expect(401);
    const missingAccount = await api.post('/api/v1/auth/login').send({
      email: 'missing-account@example.com',
      password: 'Wrong password 2026',
    }).expect(401);
    expect(wrongPassword.body.error).toEqual(missingAccount.body.error);

    await api.post('/api/v1/auth/login').send({ email, password })
      .expect(403)
      .expect(({ body }) => expect(body.error.code).toBe('AUTH_EMAIL_VERIFICATION_REQUIRED'));

    const repository = app.get<IdentityRepository>(IDENTITY_REPOSITORY);
    const pendingUser = await repository.findUserByEmail(email);
    expect(pendingUser).toBeTruthy();
    await repository.updateUser(pendingUser!.id, { status: 'DISABLED' });
    await api.post('/api/v1/auth/login').send({ email, password })
      .expect(403)
      .expect(({ body }) => expect(body.error.code).toBe('AUTH_ACCOUNT_DISABLED'));

    app.get(AuthRateLimiter).clear();
    const rateLimitedEmail = 'rate-limited@example.com';
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await api.post('/api/v1/auth/login').send({
        email: rateLimitedEmail,
        password: 'Wrong password 2026',
      }).expect(401);
    }
    await api.post('/api/v1/auth/login').send({
      email: rateLimitedEmail,
      password: 'Wrong password 2026',
    }).expect(429)
      .expect(({ body }) => expect(body.error.code).toBe('AUTH_RATE_LIMITED'));
  });

  it('rejects expired or wrong-purpose verification tokens and throttles resend', async () => {
    const api = request(app.getHttpServer());
    const repository = app.get<IdentityRepository>(IDENTITY_REPOSITORY);
    const user = await repository.createUser({
      email: 'verification-edge@example.com',
      displayName: 'Verification Edge',
      passwordHash: null,
      status: 'VERIFICATION_PENDING',
    });
    const expired = createOpaqueToken();
    await repository.createAuthToken({
      userId: user.id,
      purpose: 'EMAIL_VERIFICATION',
      tokenDigest: digestOpaqueToken(expired),
      expiresAt: new Date(Date.now() - 1000),
    });
    await api.post('/api/v1/auth/verify-email').send({ token: expired })
      .expect(400)
      .expect(({ body }) => expect(body.error.code).toBe('AUTH_VERIFICATION_INVALID'));

    const wrongPurpose = createOpaqueToken();
    await repository.createAuthToken({
      userId: user.id,
      purpose: 'PASSWORD_RESET',
      tokenDigest: digestOpaqueToken(wrongPurpose),
      expiresAt: new Date(Date.now() + 60_000),
    });
    await api.post('/api/v1/auth/verify-email').send({ token: wrongPurpose })
      .expect(400)
      .expect(({ body }) => expect(body.error.code).toBe('AUTH_VERIFICATION_INVALID'));
    await api.post('/api/v1/auth/verify-email').send({ token: 'malformed-token' }).expect(400);

    const resetUser = await repository.createUser({
      email: 'reset-expired@example.com',
      displayName: 'Reset Expired',
      passwordHash: null,
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
    });
    const expiredReset = createOpaqueToken();
    await repository.createAuthToken({
      userId: resetUser.id,
      purpose: 'PASSWORD_RESET',
      tokenDigest: digestOpaqueToken(expiredReset),
      expiresAt: new Date(Date.now() - 1000),
    });
    await api.post('/api/v1/auth/reset-password').send({
      token: expiredReset,
      password: 'Another recovery password 2026',
    }).expect(400)
      .expect(({ body }) => expect(body.error.code).toBe('AUTH_RESET_INVALID'));

    app.get(AuthRateLimiter).clear();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await api.post('/api/v1/auth/resend-verification').send({ email: user.email }).expect(201);
    }
    await api.post('/api/v1/auth/resend-verification').send({ email: user.email })
      .expect(429)
      .expect(({ body }) => expect(body.error.code).toBe('AUTH_RATE_LIMITED'));
  });

  it('enforces CSRF and origin checks on cookie-backed refresh', async () => {
    const api = request(app.getHttpServer());
    const email = 'csrf-flow@example.com';
    const password = 'CSRF flow password 2026';
    await api.post('/api/v1/auth/register').send({
      email,
      displayName: 'CSRF Flow',
      password,
    }).expect(201);
    const verificationToken = emailProvider.messages.at(-1)!.token;
    await api.post('/api/v1/auth/verify-email').send({ token: verificationToken }).expect(201);
    const login = await api.post('/api/v1/auth/login').send({ email, password }).expect(201);
    const cookies = (login.headers['set-cookie'] as unknown as string[])
      .map((cookie) => cookie.split(';')[0])
      .join('; ');
    const csrf = cookieValue(login.headers['set-cookie'] as unknown as string[], 'cdn_csrf');

    await api.post('/api/v1/auth/refresh')
      .set('Cookie', cookies)
      .set('X-CSRF-Token', 'wrong-csrf')
      .expect(403)
      .expect(({ body }) => expect(body.error.code).toBe('AUTH_CSRF_INVALID'));
    await api.post('/api/v1/auth/refresh')
      .set('Cookie', cookies)
      .set('Origin', 'https://attacker.example')
      .set('X-CSRF-Token', csrf)
      .expect(403)
      .expect(({ body }) => expect(body.error.code).toBe('AUTH_CSRF_INVALID'));
    await api.post('/api/v1/auth/refresh')
      .set('Cookie', cookies)
      .set('Origin', 'http://localhost:5173')
      .set('X-CSRF-Token', csrf)
      .expect(201);
  });

  it('keeps recovery generic and invalidates prior sessions after reset', async () => {
    const email = 'recovery-flow@example.com';
    const password = 'Recovery password 2026';
    await agent.post('/api/v1/auth/register').send({
      email,
      displayName: 'Recovery Flow',
      password,
    }).expect(201);
    const verificationToken = emailProvider.messages.at(-1)!.token;
    await agent.post('/api/v1/auth/verify-email').send({ token: verificationToken }).expect(201);
    const login = await agent.post('/api/v1/auth/login').send({ email, password }).expect(201);
    const csrf = cookieValue(login.headers['set-cookie'] as unknown as string[], 'cdn_csrf');

    const unknown = await agent.post('/api/v1/auth/forgot-password').send({
      email: 'unknown@example.com',
    }).expect(201);
    const known = await agent.post('/api/v1/auth/forgot-password').send({ email }).expect(201);
    expect(known.body.data).toEqual(unknown.body.data);
    const resetToken = emailProvider.messages.at(-1)!.token;
    await agent.post('/api/v1/auth/reset-password').send({
      token: resetToken,
      password: 'New recovery password 2026',
    }).expect(201);
    await agent.post('/api/v1/auth/reset-password').send({
      token: resetToken,
      password: 'Another password 2026',
    }).expect(400);
    await agent.get('/api/v1/auth/me').set('Authorization', 'Bearer ' + login.body.data.accessToken).expect(401);
    await agent.post('/api/v1/auth/login').send({ email, password }).expect(401);
    await agent.post('/api/v1/auth/login').send({
      email,
      password: 'New recovery password 2026',
    }).expect(201);
    void csrf;
  });

  it('fails closed for disabled providers and rejects anonymous protected access', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/auth/providers')
      .expect(200)
      .expect(({ body }) => expect(body.data.providers.every((provider: { enabled: boolean }) => !provider.enabled)).toBe(true));
    await request(app.getHttpServer())
      .get('/api/v1/auth/oauth/google/start')
      .expect(503)
      .expect(({ body }) => expect(body.error.code).toBe('AUTH_PROVIDER_DISABLED'));
    await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .expect(401);
  });
});

function cookieValue(cookies: string[], name: string): string {
  const cookie = cookies.find((item) => item.startsWith(name + '='));
  if (!cookie) return '';
  return decodeURIComponent(cookie.slice(name.length + 1).split(';')[0]);
}
