import type { PoolClient } from 'pg';
import type {
  ExchangeBlockMutationResult,
  ExchangeReportInput,
  ExchangeReportMutationResult,
  ExchangeSafetyRepository,
} from './exchange-safety.types';

export const EXCHANGE_SAFETY_REPOSITORY = 'EXCHANGE_SAFETY_REPOSITORY';

const BLOCK_KEY_SEPARATOR = ':';

export class InMemoryExchangeSafetyRepository implements ExchangeSafetyRepository {
  private readonly blocks = new Map<string, Date>();
  private readonly reports = new Set<string>();

  async isBlocked(firstUserId: string, secondUserId: string): Promise<boolean> {
    return this.blocks.has(blockKey(firstUserId, secondUserId))
      || this.blocks.has(blockKey(secondUserId, firstUserId));
  }

  async isBlockedBy(blockerUserId: string, blockedUserId: string): Promise<boolean> {
    return this.blocks.has(blockKey(blockerUserId, blockedUserId));
  }

  async isBlockedOnClient(
    _client: PoolClient,
    firstUserId: string,
    secondUserId: string,
  ): Promise<boolean> {
    return this.isBlocked(firstUserId, secondUserId);
  }

  async blockUser(blockerUserId: string, blockedUserId: string): Promise<ExchangeBlockMutationResult> {
    if (blockerUserId === blockedUserId) throw new Error('An exchange user cannot block themselves');
    const key = blockKey(blockerUserId, blockedUserId);
    const exists = this.blocks.has(key);
    if (!exists) this.blocks.set(key, new Date());
    return {
      targetUserId: blockedUserId,
      outcome: exists ? 'ALREADY_BLOCKED' : 'CREATED',
    };
  }

  async unblockUser(blockerUserId: string, blockedUserId: string): Promise<ExchangeBlockMutationResult> {
    const removed = this.blocks.delete(blockKey(blockerUserId, blockedUserId));
    return {
      targetUserId: blockedUserId,
      outcome: removed ? 'REMOVED' : 'NOT_BLOCKED',
    };
  }

  async submitReport(input: ExchangeReportInput): Promise<ExchangeReportMutationResult> {
    const key = [input.reporterUserId, input.targetUserId, input.category].join(BLOCK_KEY_SEPARATOR);
    const duplicate = this.reports.has(key);
    this.reports.add(key);
    return { duplicate };
  }
}

export const EXCHANGE_PAIR_ADVISORY_LOCK_SQL = `
  SELECT pg_advisory_xact_lock(
    hashtextextended(
      LEAST($1::text, $2::text) || ':' || GREATEST($1::text, $2::text),
      0
    )
  )`;

export async function lockExchangePair(
  client: PoolClient,
  firstUserId: string,
  secondUserId: string,
): Promise<void> {
  await client.query(EXCHANGE_PAIR_ADVISORY_LOCK_SQL, [firstUserId, secondUserId]);
}

function blockKey(blockerUserId: string, blockedUserId: string): string {
  return blockerUserId + BLOCK_KEY_SEPARATOR + blockedUserId;
}
