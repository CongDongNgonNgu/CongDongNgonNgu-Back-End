import { describe, expect, it, jest } from '@jest/globals';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuthPrincipal } from '../session/session.service';
import { SessionFailure } from '../session/session.service';
import { RolesGuard } from './roles.guard';

describe('RolesGuard', () => {
  it('allows routes without role metadata', () => {
    const reflector = reflectorWith([]);
    expect(new RolesGuard(reflector).canActivate(context())).toBe(true);
  });

  it('requires an authenticated principal for role-protected routes', () => {
    const reflector = reflectorWith(['MEMBER']);
    expect(() => new RolesGuard(reflector).canActivate(context())).toThrow(SessionFailure);
    expect(() => new RolesGuard(reflector).canActivate(context())).toThrow(
      expect.objectContaining({ code: 'AUTH_UNAUTHORIZED' }),
    );
  });

  it('checks roles from the server-authenticated user', () => {
    const reflector = reflectorWith(['MEMBER']);
    const principal = {
      user: { roles: ['MEMBER'] },
      claims: {},
    } as unknown as AuthPrincipal;
    expect(new RolesGuard(reflector).canActivate(context(principal))).toBe(true);

    const adminOnly = new RolesGuard(reflectorWith(['ADMIN']));
    expect(() => adminOnly.canActivate(context(principal))).toThrow(
      expect.objectContaining({ code: 'AUTH_FORBIDDEN' }),
    );
  });
});

function reflectorWith(roles: string[]): Reflector {
  return {
    getAllAndOverride: jest.fn().mockReturnValue(roles),
  } as unknown as Reflector;
}

function context(principal?: AuthPrincipal): ExecutionContext {
  return {
    getHandler: jest.fn(),
    getClass: jest.fn(),
    switchToHttp: () => ({
      getRequest: () => ({ user: principal }),
    }),
  } as unknown as ExecutionContext;
}
