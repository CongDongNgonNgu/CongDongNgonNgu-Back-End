import { describe, expect, it, jest } from '@jest/globals';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { AuthController } from './auth.controller';
import type { AuthService } from './auth.service';
import type { OAuthService } from './oauth/oauth.service';
import type { SessionService } from './session/session.service';

describe('AuthController OAuth browser state binding', () => {
  it('binds the public OAuth start redirect to a short-lived browser cookie', async () => {
    const oauth = {
      start: jest.fn<OAuthService['start']>().mockResolvedValue(
        'https://provider.example/authorize?state=browser-state',
      ),
    } as unknown as OAuthService;
    const response = responseDouble();
    const controller = controllerWith(oauth);

    await controller.oauthStart('google', undefined, response);

    expect(response.append).toHaveBeenCalledWith(
      'Set-Cookie',
      expect.stringContaining('cdn_oauth_state=browser-state'),
    );
    expect(response.redirect).toHaveBeenCalledWith(
      'https://provider.example/authorize?state=browser-state',
    );
  });

  it.each([
    ['test', 'https://cong-dong-ngon-ngu-sigma.vercel.app', true],
    ['production', 'https://congdongngonngu.vn', true],
    ['development', 'http://localhost:5173', false],
  ] as const)('uses configured transport for %s OAuth issuance and clearing', async (environment, publicAppUrl, secure) => {
    const oauth = {
      start: jest.fn<OAuthService['start']>().mockResolvedValue('https://provider.example/authorize?state=browser-state'),
      callback: jest.fn<OAuthService['callback']>(),
      callbackRedirect: jest.fn<OAuthService['callbackRedirect']>().mockReturnValue(publicAppUrl + '/auth/callback?status=error'),
    } as unknown as OAuthService;
    const controller = new AuthController({} as AuthService,
      { assertCsrfForCookie: jest.fn() } as unknown as SessionService, oauth,
      new ConfigService({ app: { environment, publicAppUrl } }));
    const start = responseDouble();
    await controller.oauthStart('google', undefined, start);
    const linked = responseDouble();
    await controller.oauthLinkStart('google', { headers: {}, user: { user: { id: 'user' }, claims: { sid: 'session' } } } as never, linked);
    const cleared = responseDouble();
    // Untrusted forwarding headers cannot override configured cookie security.
    await controller.oauthCallback('google', { state: 'browser-state', code: 'code' },
      { headers: { 'x-forwarded-proto': secure ? 'http' : 'https' } } as unknown as Request, cleared);
    expect(oauth.callback).not.toHaveBeenCalled();
    for (const response of [start, linked, cleared]) {
      const cookie = (response.append as jest.Mock).mock.calls[0][1] as string;
      expect(cookie.includes('; Secure')).toBe(secure);
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('SameSite=Lax');
      expect(cookie).toContain('Path=/api/v1/auth/oauth');
      expect(cookie).not.toMatch(/Domain=/i);
    }
    expect((start.append as jest.Mock).mock.calls[0][1]).toContain('Max-Age=600');
    expect((cleared.append as jest.Mock).mock.calls[0][1]).toContain('Max-Age=0');
  });

  it('rejects a callback state mismatch before invoking the OAuth service', async () => {
    const oauth = {
      callback: jest.fn<OAuthService['callback']>(),
      callbackRedirect: jest.fn<OAuthService['callbackRedirect']>().mockReturnValue('https://app.example/error'),
    } as unknown as OAuthService;
    const response = responseDouble();
    const controller = controllerWith(oauth);

    await controller.oauthCallback(
      'google',
      { state: 'attacker-state', code: 'authorization-code' },
      { headers: { cookie: 'cdn_oauth_state=browser-state' } } as Request,
      response,
    );

    expect(oauth.callback).not.toHaveBeenCalled();
    expect(response.redirect).toHaveBeenCalledWith('https://app.example/error');
    expect(response.append).toHaveBeenCalledWith(
      'Set-Cookie',
      expect.stringContaining('cdn_oauth_state=; Max-Age=0'),
    );
  });

  it('passes a matching callback state to the OAuth service and clears it after success', async () => {
    const oauth = {
      callback: jest.fn<OAuthService['callback']>().mockResolvedValue(
        {} as Awaited<ReturnType<OAuthService['callback']>>,
      ),
      callbackRedirect: jest.fn<OAuthService['callbackRedirect']>().mockReturnValue('https://app.example/success'),
    } as unknown as OAuthService;
    const events: string[] = [];
    const response = responseDouble(events);
    const controller = controllerWith(oauth);
    const query = { state: 'browser-state', code: 'authorization-code' };

    await controller.oauthCallback(
      'google',
      query,
      { headers: { cookie: 'cdn_oauth_state=browser-state' } } as Request,
      response,
    );

    expect(oauth.callback).toHaveBeenCalledWith('google', query, response);
    expect(response.redirect).toHaveBeenCalledWith('https://app.example/success');
    expect(response.append).toHaveBeenCalledWith(
      'Set-Cookie',
      expect.stringContaining('cdn_oauth_state=; Max-Age=0'),
    );
    expect(events).toEqual(['append', 'redirect']);
  });
});

function controllerWith(oauth: OAuthService): AuthController {
  return new AuthController(
    {} as AuthService,
    {} as SessionService,
    oauth,
    new ConfigService({ app: { environment: 'test', publicAppUrl: 'http://localhost:5173' } }),
  );
}

function responseDouble(events: string[] = []) {
  return {
    append: jest.fn(() => events.push('append')),
    redirect: jest.fn(() => events.push('redirect')),
  } as unknown as Response;
}
