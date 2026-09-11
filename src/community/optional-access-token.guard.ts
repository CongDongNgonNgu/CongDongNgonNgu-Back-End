import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { SessionFailure, SessionService } from '../auth/session/session.service';
import type { AuthenticatedRequest } from '../auth/guards/access-token.guard';

@Injectable()
export class OptionalAccessTokenGuard implements CanActivate {
  constructor(private readonly sessions: SessionService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const authorization = request.headers.authorization;
    if (!authorization) return true;
    if (!authorization.startsWith('Bearer ')) {
      throw new SessionFailure('AUTH_UNAUTHORIZED', 401, 'You must provide a valid access token');
    }
    const token = authorization.slice('Bearer '.length).trim();
    if (!token) throw new SessionFailure('AUTH_UNAUTHORIZED', 401, 'You must provide a valid access token');
    request.user = await this.sessions.authenticate(token);
    return true;
  }
}
