import type { PoolClient } from 'pg';
import { lockExchangeUsers, EXCHANGE_ELIGIBLE_PREFERENCE_PREDICATE } from '../exchange/exchange-pair-authorization';
import { lockExchangePair } from '../exchange/exchange-safety.repository';
import { conversationUnavailable } from './message-failure';

// The caller owns the transaction. Account locks serialize profile/preference
// changes; the canonical pair lock serializes connection and safety changes.
export async function lockMessagingPair(client: PoolClient, actor: string, partner: string): Promise<void> {
  const users = await lockExchangeUsers(client, actor, partner);
  await lockExchangePair(client, actor, partner);
  if (actor === partner || users.length !== 2
    || users.some(user => user.status !== 'ACTIVE' || !user.email_verified_at)) throw conversationUnavailable();
  const eligible = await client.query(`SELECT p.user_id FROM language_exchange_preferences p
    WHERE p.user_id IN ($1::uuid,$2::uuid) AND ${EXCHANGE_ELIGIBLE_PREFERENCE_PREDICATE}
      AND p.contact_permission<>'NO_CONTACT'`, [actor, partner]);
  if (eligible.rowCount !== 2) throw conversationUnavailable();
  const relationship = await client.query(`SELECT id FROM language_exchange_connections c
    WHERE c.participant_a_id=LEAST($1::uuid,$2::uuid) AND c.participant_b_id=GREATEST($1::uuid,$2::uuid)
      AND c.status='CONNECTED' AND NOT EXISTS (SELECT 1 FROM language_exchange_blocks b
        WHERE (b.blocker_user_id=$1::uuid AND b.blocked_user_id=$2::uuid)
          OR (b.blocker_user_id=$2::uuid AND b.blocked_user_id=$1::uuid))`, [actor, partner]);
  if (relationship.rowCount !== 1) throw conversationUnavailable();
}
