import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { AppConfigModule } from './config/config.module';
import { HealthModule } from './health/health.module';
import { ProfileModule } from './profile/profile.module';
import { CommunityModule } from './community/community.module';

@Module({
  imports: [AppConfigModule, HealthModule, AuthModule, ProfileModule, CommunityModule],
})
export class AppModule {}
