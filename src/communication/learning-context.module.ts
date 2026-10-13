import { Module } from '@nestjs/common';
import { LibraryModule } from '../library/library.module';
import { LibraryService } from '../library/library.service';
import { CommunityModule } from '../community/community.module';
import { CommunityService } from '../community/community.service';
import { MessageContextResolver } from './learning-context-resolver';
@Module({
  imports: [LibraryModule, CommunityModule],
  providers: [
    {
      provide: MessageContextResolver,
      inject: [LibraryService, CommunityService],
      useFactory: (library: LibraryService, community: CommunityService) =>
        new MessageContextResolver(library, community),
    },
  ],
  exports: [MessageContextResolver],
})
export class LearningContextModule {}
