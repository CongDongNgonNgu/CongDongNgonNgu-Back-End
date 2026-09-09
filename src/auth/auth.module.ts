import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IdentityModule } from '../identity/identity.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AccessTokenService } from './crypto/access-token';
import { PasswordHasher } from './crypto/password-hasher';
import { createEmailProvider, EMAIL_PROVIDER } from './email/email.provider';
import { AuthRateLimiter } from './rate-limit/rate-limiter';
import { AccessTokenGuard } from './guards/access-token.guard';
import { RolesGuard } from './guards/roles.guard';
import { SessionService } from './session/session.service';
import { OAuthService } from './oauth/oauth.service';

@Module({
  imports: [IdentityModule],
  controllers: [AuthController],
  providers: [
    OAuthService,
    AuthService,
    PasswordHasher,
    AccessTokenService,
    SessionService,
    AuthRateLimiter,
    AccessTokenGuard,
    RolesGuard,
    {
      provide: EMAIL_PROVIDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => createEmailProvider(config),
    },
  ],
  exports: [AuthService, SessionService, AccessTokenGuard, RolesGuard],
})
export class AuthModule {}
