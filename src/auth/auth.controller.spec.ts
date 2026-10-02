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
    new ConfigService({ app: { environment: 'test' } }),
  );
}

function responseDouble(events: string[] = []) {
  return {
    append: jest.fn(() => events.push('append')),
    redirect: jest.fn(() => events.push('redirect')),
  } as unknown as Response;
}
