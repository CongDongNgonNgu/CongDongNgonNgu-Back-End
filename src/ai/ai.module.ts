import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MembershipModule } from '../membership/membership.module';
import { MembershipPolicyService } from '../membership/membership.policy';
import { FailClosedAiProviderAdapter, AiProviderRegistry } from './ai.provider';
import {
  InMemoryAiQuotaLedger,
  InMemoryAiRateLimiter,
  InMemoryAiUsageLedger,
} from './ai.usage';
import { AiRuntimeService } from './ai.runtime';
import {
  AiPostRoomService,
  AI_POST_ROOM_EXECUTOR,
  DisabledAiPostRoomExecutor,
} from './ai.post-room.service';
import {
  AI_PROVIDER_ADAPTERS,
  AI_QUOTA_LEDGER,
  AI_RATE_LIMITER,
  AI_RUNTIME_POLICY,
  AI_USAGE_LEDGER,
  AI_USAGE_POLICY_RESOLVER,
  type AiProviderAdapter,
  type AiRuntimePolicy,
} from './ai.types';

const DEFAULT_AI_RUNTIME_POLICY: AiRuntimePolicy = {
  timeoutMs: 15_000,
  maxAttempts: 2,
  retryDelayMs: 0,
};

function createFailClosedAdapters(config: ConfigService): AiProviderAdapter[] {
  const provider = config.get<string>('providers.ai') ?? 'disabled';
  return [
    new FailClosedAiProviderAdapter(
      provider === 'disabled' ? 'disabled' : 'configured',
      provider === 'disabled' ? 'disabled' : 'misconfigured',
      provider === 'disabled'
        ? 'AI provider is disabled'
        : 'No provider-specific AI adapter has been approved or configured',
    ),
  ];
}

@Module({
  imports: [MembershipModule],
  providers: [
    AiRuntimeService,
    AiPostRoomService,
    { provide: AI_POST_ROOM_EXECUTOR, useClass: DisabledAiPostRoomExecutor },
    AiProviderRegistry,
    {
      provide: AI_PROVIDER_ADAPTERS,
      inject: [ConfigService],
      useFactory: createFailClosedAdapters,
    },
    { provide: AI_USAGE_LEDGER, useFactory: () => new InMemoryAiUsageLedger() },
    { provide: AI_USAGE_POLICY_RESOLVER, useExisting: MembershipPolicyService },
    { provide: AI_QUOTA_LEDGER, useFactory: () => new InMemoryAiQuotaLedger() },
    { provide: AI_RATE_LIMITER, useFactory: () => new InMemoryAiRateLimiter() },
    { provide: AI_RUNTIME_POLICY, useValue: DEFAULT_AI_RUNTIME_POLICY },
  ],
  exports: [AiRuntimeService, AiProviderRegistry, AiPostRoomService],
})
export class AiModule {}
