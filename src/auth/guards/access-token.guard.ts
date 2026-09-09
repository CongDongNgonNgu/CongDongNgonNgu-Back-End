import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { SessionFailure, SessionService, type AuthPrincipal } from '../session/session.service';

export type AuthenticatedRequest = Request & { user?: AuthPrincipal };

@Injectable()
export class AccessTokenGuard implements CanActivate {
  constructor(private readonly sessions: SessionService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const authorization = request.headers.authorization;
    if (!authorization || !authorization.startsWith('Bearer ')) {
      throw new SessionFailure('AUTH_UNAUTHORIZED', 401, 'Bạn cần đăng nhập để tiếp tục');
    }
    const token = authorization.slice('Bearer '.length).trim();
    if (!token) throw new SessionFailure('AUTH_UNAUTHORIZED', 401, 'Bạn cần đăng nhập để tiếp tục');
    request.user = await this.sessions.authenticate(token);
    return true;
  }
}
