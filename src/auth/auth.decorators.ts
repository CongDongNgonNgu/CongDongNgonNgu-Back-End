import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthPrincipal } from './session/session.service';

export const ROLES_KEY = 'auth_roles';
export const Roles = (...roles: string[]) => SetMetadata(ROLES_KEY, roles);

export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthPrincipal['user'] => {
    const request = context.switchToHttp().getRequest<Request & { user?: AuthPrincipal }>();
    if (!request.user) throw new Error('Authenticated user is unavailable');
    return request.user.user;
  },
);
