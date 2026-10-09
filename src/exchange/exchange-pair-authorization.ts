import type { PoolClient } from 'pg';
import { ExchangeFailure } from './exchange.errors';

// Internal SQL predicate for alias p; shared by pair authorization and counts.
export const EXCHANGE_ELIGIBLE_PREFERENCE_PREDICATE=`p.exchange_opt_in
  AND EXISTS (SELECT 1 FROM language_exchange_languages e WHERE e.user_id=p.user_id AND e.direction='OFFER')
  AND EXISTS (SELECT 1 FROM language_exchange_languages e WHERE e.user_id=p.user_id AND e.direction='WANT')
  AND NOT EXISTS (
    SELECT 1 FROM language_exchange_languages e
    JOIN user_languages ul ON ul.id=e.user_language_id AND ul.user_id=e.user_id
    JOIN languages l ON l.id=ul.language_id
    WHERE e.user_id=p.user_id AND (NOT l.active OR ul.visibility<>'PUBLIC'
      OR (e.direction='OFFER' AND NOT (ul.is_native OR ul.is_known))
      OR (e.direction='WANT' AND NOT ul.is_learning))
  )`;

// All pair operations take account locks before the canonical pair lock.
// Profile/preferences writers use the same account boundary.
export async function lockExchangeUsers(client: PoolClient, first: string, second: string) {
  return (await client.query(
    `SELECT id, status, email_verified_at FROM users
      WHERE id IN ($1::uuid,$2::uuid) ORDER BY id FOR UPDATE`, [first,second],
  )).rows as { id: string; status: string; email_verified_at: Date | null }[];
}

export async function authorizeConnectionPair(
  client: PoolClient,
  users: Awaited<ReturnType<typeof lockExchangeUsers>>,
  actor: string,
  target: string,
  eligible: boolean,
  request = false,
): Promise<void> {
  const required = eligible ? [actor,target] : [actor];
  if (actor === target || required.some(id => !users.some(user =>
    user.id === id && user.status === 'ACTIVE' && user.email_verified_at))) {
    throw unavailable();
  }
  if (!eligible) return;
  const result = await client.query(`
    SELECT p.user_id FROM language_exchange_preferences p
    WHERE p.user_id IN ($1::uuid,$2::uuid) AND ${EXCHANGE_ELIGIBLE_PREFERENCE_PREDICATE}
      AND (NOT $3::boolean OR p.user_id<>$2::uuid OR p.discoverable)
      `, [actor,target,request]);
  if (result.rows.length !== 2) throw unavailable();
}

function unavailable() {
  return new ExchangeFailure('EXCHANGE_PROFILE_UNAVAILABLE',404,'Buddy profile was not found');
}
