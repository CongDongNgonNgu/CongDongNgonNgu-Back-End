import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { UserRecord } from '../../identity/identity.types';
import { ROLES_KEY } from '../auth.decorators';
import { SessionFailure } from '../session/session.service';
import type { AuthenticatedRequest } from './access-token.guard';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<string[]>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    ) ?? [];
    if (requiredRoles.length === 0) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!request.user) {
      throw new SessionFailure('AUTH_UNAUTHORIZED', 401, 'Bạn cần đăng nhập để tiếp tục');
    }
    const hasRole = requiredRoles.some((role) =>
      request.user!.user.roles.includes(role as UserRecord['roles'][number]),
    );
    if (!hasRole) {
      throw new SessionFailure('AUTH_FORBIDDEN', 403, 'Bạn không có quyền thực hiện thao tác này');
    }
    return true;
  }
}
